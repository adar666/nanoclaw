#!/usr/bin/env node
/**
 * Lint every group's `instructions.prepend.md` for blanket capability-denial
 * language that might contradict a tool the group actually has wired in.
 *
 * Why this exists: found live (2026-08-15) — `groups/household/instructions.prepend.md`
 * had a "Photos and PDFs" section written before the `transcribe_audio` tool
 * existed. Its prose ("You have no direct access to a photo or PDF someone
 * sends here") was general enough that the agent generalized it to audio
 * files too, even though a brand-new tool had just been wired in
 * specifically for that case. No test can prove a persona document and a
 * tool roster "agree" — this is a heuristic flag for human review, not a
 * prover. A false positive is expected and fine; a false negative (missing
 * a real contradiction) is the actual risk this defends against.
 *
 * Method:
 *   1. Collect every capability keyword this group's container actually has:
 *      tool/module names from every `container/agent-runner/src/mcp-tools/*.instructions.md`
 *      file (all groups get all of them — see claude-md-compose.ts's
 *      auto-discovery) plus every skill name under `container/skills/`.
 *   2. Scan the group's `instructions.prepend.md` for denial phrases
 *      ("no access", "cannot", "not available", "no way to", "don't have
 *      access", "have no path to").
 *   3. For each denial-phrase sentence, check whether any capability
 *      keyword appears in that same sentence's neighborhood (same
 *      paragraph). If so, flag it — worth a human re-reading whether that
 *      denial still describes reality now that the tool exists.
 *
 * Usage: pnpm exec tsx scripts/lint-group-instructions.ts [groups-dir]
 * Exit code: 0 = clean, 1 = findings (informational — this never blocks CI).
 */
import fs from 'fs';
import path from 'path';

export interface Finding {
  groupFolder: string;
  paragraph: string;
  denialPhrase: string;
  matchedCapability: string;
}

const DENIAL_PHRASES = [
  'no access',
  'no direct access',
  'cannot',
  "can't",
  'not available',
  'no way to',
  "don't have access",
  'have no path to',
  'no path to the',
];

/** Extracts capability keywords from every *.instructions.md under mcpToolsDir + every skill dir name under skillsDir. */
export function collectCapabilityKeywords(mcpToolsDir: string, skillsDir: string): string[] {
  const keywords = new Set<string>();

  if (fs.existsSync(mcpToolsDir)) {
    for (const entry of fs.readdirSync(mcpToolsDir)) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (match) keywords.add(match[1]);
    }
  }

  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) keywords.add(entry.name);
    }
  }

  return [...keywords];
}

/** Splits markdown into paragraphs (blank-line separated) for locality checks. */
function splitParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Pure scan: given one group's instructions text and the capability
 * keyword list, find paragraphs that both deny access AND mention a real
 * capability (by keyword fragment match, case-insensitive, keyword tokens
 * split on non-alphanumeric so "transcribe_audio" also matches "transcribe").
 */
export function findPersonaCapabilityConflicts(
  groupFolder: string,
  instructionsText: string,
  capabilityKeywords: string[],
): Finding[] {
  const findings: Finding[] = [];
  const keywordTokens = capabilityKeywords.flatMap((k) => k.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  for (const paragraph of splitParagraphs(instructionsText)) {
    const lower = paragraph.toLowerCase();
    const denialPhrase = DENIAL_PHRASES.find((p) => lower.includes(p));
    if (!denialPhrase) continue;

    const matchedCapability = keywordTokens.find((token) => token.length > 3 && lower.includes(token));
    if (matchedCapability) {
      findings.push({ groupFolder, paragraph, denialPhrase, matchedCapability });
    }
  }

  return findings;
}

/** Reads every group's instructions.prepend.md (groups/<folder>/instructions.prepend.md) and runs the scan against each. */
export function lintAllGroups(groupsDir: string, mcpToolsDir: string, skillsDir: string): Finding[] {
  const capabilityKeywords = collectCapabilityKeywords(mcpToolsDir, skillsDir);
  const findings: Finding[] = [];

  if (!fs.existsSync(groupsDir)) return findings;

  for (const entry of fs.readdirSync(groupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const instructionsPath = path.join(groupsDir, entry.name, 'instructions.prepend.md');
    if (!fs.existsSync(instructionsPath)) continue;

    const text = fs.readFileSync(instructionsPath, 'utf-8');
    findings.push(...findPersonaCapabilityConflicts(entry.name, text, capabilityKeywords));
  }

  return findings;
}

// CLI entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] ?? process.cwd();
  const findings = lintAllGroups(
    path.join(root, 'groups'),
    path.join(root, 'container', 'agent-runner', 'src', 'mcp-tools'),
    path.join(root, 'container', 'skills'),
  );

  if (findings.length === 0) {
    console.log('✅ No persona/capability conflicts flagged.');
    process.exit(0);
  }

  for (const f of findings) {
    console.log(
      `🚨 groups/${f.groupFolder}/instructions.prepend.md — paragraph denies "${f.denialPhrase}" but mentions ` +
        `capability keyword "${f.matchedCapability}":\n   "${f.paragraph.slice(0, 200)}${f.paragraph.length > 200 ? '…' : ''}"\n`,
    );
  }
  console.log(`${findings.length} finding(s) above — review each, this is a heuristic not a proof.`);
  process.exit(1);
}
