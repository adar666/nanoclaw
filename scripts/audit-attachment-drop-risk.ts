#!/usr/bin/env node
/**
 * Audit every messaging-group wiring for a silent-attachment-loss risk:
 * `engage_mode='pattern'` with a real regex (not the `.` always-engage
 * sentinel) combined with `ignored_message_policy='drop'`.
 *
 * Why this exists (found live, 2026-08-16): a user sent an audio file with
 * no caption to a group wired with `engage_pattern: '^\\.'` (requires an
 * explicit leading dot to engage — normal for a shared group chat that
 * shouldn't respond to every message). `evaluateEngage` (src/router.ts)
 * treats the literal string `.` as a special "always engage" sentinel, but
 * ANY other pattern is a real regex tested against the message text — and
 * a bare attachment with no caption has `text: ''`, which fails to match
 * `^\.` (or almost any non-trivial pattern). With `ignored_message_policy:
 * 'drop'`, that non-engaging message — attachment included — never reaches
 * inbound.db at all. It's not staged to the container's inbox, not
 * transcribable, nothing. The user's very next message (which DOES engage,
 * e.g. ".process the file I just sent") has nothing to reference. The
 * identical scenario in a DM (engage_pattern: '.', the always-engage
 * sentinel) works fine — the asymmetry is exactly this pattern/policy
 * combination, not a code bug in attachment handling itself.
 *
 * `ignored_message_policy: 'accumulate'` (src/router.ts's own comment on
 * the branch) stages the message — attachment included, via
 * writeSessionMessage → extractAttachmentFiles — as silent context even
 * when it doesn't itself engage, so a later engaging message picks it up.
 * That's almost always what an operator actually wants for a pattern-gated
 * wiring: 'drop' silently discards non-triggering content AND ANY
 * ATTACHMENT ON IT, which is rarely the intent for a real chat (as opposed
 * to a noisy bulk-message source you genuinely want to ignore).
 *
 * This script does NOT change the wiring-creation default (drop) — that's
 * a broader behavior change with real trade-offs for wirings that
 * genuinely want strict dropping, not something to flip silently. It only
 * flags existing configuration for human review, the same heuristic
 * philosophy as audit-mount-privacy.ts and lint-group-instructions.ts.
 *
 * Usage: pnpm exec tsx scripts/audit-attachment-drop-risk.ts [path/to/v2.db]
 * Exit code: 0 = clean, 1 = findings (informational — never blocks CI).
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export interface WiringRow {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: string;
  engage_pattern: string | null;
  ignored_message_policy: string;
}

export interface Finding {
  wiringId: string;
  groupName: string;
  agentName: string;
  engagePattern: string;
}

/**
 * Pure decision function: does this wiring's engage/policy combination risk
 * silently dropping a bare (no-caption) attachment message?
 */
export function isAttachmentDropRisk(wiring: WiringRow): boolean {
  if (wiring.engage_mode !== 'pattern') return false;
  if (wiring.ignored_message_policy !== 'drop') return false;
  const pattern = wiring.engage_pattern ?? '.';
  return pattern !== '.'; // '.' is the always-engage sentinel — no risk there
}

/** Reads real wiring rows + their group/agent names, applies the pure decision function above. */
export function findAttachmentDropRisks(dbPath: string): Finding[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const wirings = db
      .prepare(
        `SELECT id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, ignored_message_policy
         FROM messaging_group_agents`,
      )
      .all() as WiringRow[];

    const findings: Finding[] = [];
    for (const wiring of wirings) {
      if (!isAttachmentDropRisk(wiring)) continue;

      const group = db
        .prepare('SELECT name FROM messaging_groups WHERE id = ?')
        .get(wiring.messaging_group_id) as { name: string | null } | undefined;
      const agent = db.prepare('SELECT name FROM agent_groups WHERE id = ?').get(wiring.agent_group_id) as
        | { name: string }
        | undefined;

      findings.push({
        wiringId: wiring.id,
        groupName: group?.name ?? wiring.messaging_group_id,
        agentName: agent?.name ?? wiring.agent_group_id,
        engagePattern: wiring.engage_pattern ?? '.',
      });
    }
    return findings;
  } finally {
    db.close();
  }
}

// CLI entry point — only runs when this file is executed directly, not when imported for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] ?? path.join(process.cwd(), 'data', 'v2.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`No DB found at ${dbPath}`);
    process.exit(2);
  }
  const findings = findAttachmentDropRisks(dbPath);
  if (findings.length === 0) {
    console.log('✅ No attachment-drop-risk wirings found.');
    process.exit(0);
  }
  for (const f of findings) {
    console.log(
      `🚨 "${f.groupName}" → ${f.agentName} (wiring ${f.wiringId}): engage_pattern "${f.engagePattern}" ` +
        `+ ignored_message_policy=drop — a bare attachment sent without a caption matching this pattern ` +
        `is silently discarded, attachment and all. Consider ignored_message_policy=accumulate instead ` +
        `(ncl wirings update --id ${f.wiringId} --ignored-message-policy accumulate) unless dropping ` +
        `non-triggering content is genuinely intended here.`,
    );
  }
  console.log(`\n${findings.length} finding(s) above — review each, this is a heuristic not a proof.`);
  process.exit(1);
}
