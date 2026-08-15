import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { collectCapabilityKeywords, findPersonaCapabilityConflicts, lintAllGroups } from './lint-group-instructions.js';

describe('findPersonaCapabilityConflicts (pure)', () => {
  it('flags a paragraph that both denies access and mentions a real capability keyword', () => {
    const text = `## Photos and PDFs

You have no direct access to a photo or PDF someone sends here — files
route to a private per-sender log, checked only in a nightly sync.`;
    const findings = findPersonaCapabilityConflicts('household', text, ['transcribe_audio', 'audio-report']);
    expect(findings).toHaveLength(0); // neither keyword token appears in this paragraph's text
  });

  it('flags when the paragraph text actually contains the capability keyword fragment', () => {
    const text = `## Audio files

You have no direct access to transcribe audio someone sends here.`;
    const findings = findPersonaCapabilityConflicts('household', text, ['transcribe_audio']);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      groupFolder: 'household',
      denialPhrase: 'no direct access',
      matchedCapability: 'transcribe',
    });
  });

  it('does not flag a paragraph with a denial phrase but no capability keyword nearby', () => {
    const text = `You cannot see other households' private data. That's by design.`;
    const findings = findPersonaCapabilityConflicts('household', text, ['transcribe_audio', 'audio-report']);
    expect(findings).toHaveLength(0);
  });

  it('does not flag a paragraph that mentions a capability but has no denial language', () => {
    const text = `Use transcribe_audio for any audio file someone sends.`;
    const findings = findPersonaCapabilityConflicts('household', text, ['transcribe_audio']);
    expect(findings).toHaveLength(0);
  });

  it('ignores capability keyword tokens that are too short to be meaningful (<=3 chars)', () => {
    const text = `You cannot use the app for that.`;
    const findings = findPersonaCapabilityConflicts('household', text, ['app']);
    expect(findings).toHaveLength(0);
  });

  it('scans every paragraph independently, not just the first', () => {
    const text = `First paragraph, nothing interesting here.

Second paragraph: you have no access to transcribe_audio-style features.`;
    const findings = findPersonaCapabilityConflicts('household', text, ['transcribe_audio']);
    expect(findings).toHaveLength(1);
    expect(findings[0].paragraph).toContain('Second paragraph');
  });
});

describe('collectCapabilityKeywords', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-group-instructions-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts tool names from *.instructions.md filenames and skill directory names', () => {
    const mcpToolsDir = path.join(tmpDir, 'mcp-tools');
    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(mcpToolsDir, { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'audio-report'), { recursive: true });
    fs.writeFileSync(path.join(mcpToolsDir, 'transcribe-audio.instructions.md'), '# instructions');
    fs.writeFileSync(path.join(mcpToolsDir, 'transcribe-audio.ts'), '// not an instructions file');

    const keywords = collectCapabilityKeywords(mcpToolsDir, skillsDir);
    expect(keywords).toContain('transcribe-audio');
    expect(keywords).toContain('audio-report');
    expect(keywords).not.toContain('transcribe-audio.ts');
  });

  it('returns an empty list when neither directory exists', () => {
    const keywords = collectCapabilityKeywords(path.join(tmpDir, 'nope'), path.join(tmpDir, 'also-nope'));
    expect(keywords).toEqual([]);
  });
});

describe('lintAllGroups (integration, real fs)', () => {
  let tmpDir: string;
  let groupsDir: string;
  let mcpToolsDir: string;
  let skillsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-group-instructions-integration-'));
    groupsDir = path.join(tmpDir, 'groups');
    mcpToolsDir = path.join(tmpDir, 'mcp-tools');
    skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.mkdirSync(mcpToolsDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads every groups/*/instructions.prepend.md and reports the household-style conflict', () => {
    fs.writeFileSync(path.join(mcpToolsDir, 'transcribe-audio.instructions.md'), '# instructions');
    fs.mkdirSync(path.join(groupsDir, 'household'));
    fs.writeFileSync(
      path.join(groupsDir, 'household', 'instructions.prepend.md'),
      'You have no direct access to transcribe-audio-style capabilities here.',
    );
    fs.mkdirSync(path.join(groupsDir, 'clean-group'));
    fs.writeFileSync(path.join(groupsDir, 'clean-group', 'instructions.prepend.md'), 'Nothing to see here.');

    const findings = lintAllGroups(groupsDir, mcpToolsDir, skillsDir);
    expect(findings).toHaveLength(1);
    expect(findings[0].groupFolder).toBe('household');
  });

  it('skips group folders with no instructions.prepend.md', () => {
    fs.mkdirSync(path.join(groupsDir, 'no-instructions-folder'));
    const findings = lintAllGroups(groupsDir, mcpToolsDir, skillsDir);
    expect(findings).toEqual([]);
  });

  it('returns empty when groupsDir does not exist', () => {
    const findings = lintAllGroups(path.join(tmpDir, 'missing'), mcpToolsDir, skillsDir);
    expect(findings).toEqual([]);
  });
});
