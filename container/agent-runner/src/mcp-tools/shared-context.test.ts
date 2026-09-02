/**
 * read_shared_context MCP tool — unit tests for every I/O Matrix row in
 * spec 1.1 ("Read a Fact Shared by Another Agent Group"). Uses a real temp
 * directory as the injectable `extraDir` (same pattern as documents.ts's
 * `*Impl(args, { baseDir })` functions) rather than the real
 * `/workspace/extra`, so these tests never touch the host filesystem outside
 * their own tmp root.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';

import { readSharedContextImpl, readSharedContext, WORKSPACE_EXTRA_DIR } from './shared-context.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-shared-context-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function extraDir(): string {
  return path.join(tmpRoot, 'extra');
}

function writeSharedFacts(sourceFolder: string, content: string): void {
  const dir = path.join(extraDir(), `${sourceFolder}-shared`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'shared-facts.md'), content);
}

describe('read_shared_context', () => {
  it('grant exists, file present — returns the content labeled by source folder', () => {
    writeSharedFacts('household', '- Uriel is allergic to peanuts\n- Rent is due on the 1st');

    const result = readSharedContextImpl(extraDir());

    expect(result.content[0].text).toContain('household');
    expect(result.content[0].text).toContain('Uriel is allergic to peanuts');
    expect(result.content[0].text).toContain('Rent is due on the 1st');
  });

  it('multiple grants — returns each one, each correctly labeled', () => {
    writeSharedFacts('household', 'Household fact');
    writeSharedFacts('tina', 'Tina fact');

    const result = readSharedContextImpl(extraDir());
    const text = result.content[0].text;

    expect(text).toContain('household');
    expect(text).toContain('Household fact');
    expect(text).toContain('tina');
    expect(text).toContain('Tina fact');
  });

  it('no grant at all — no /workspace/extra/*-shared/ directory exists — clean "not shared" result', () => {
    // extraDir() itself is never created.
    const result = readSharedContextImpl(extraDir());

    expect(result.content[0].text.toLowerCase()).toContain('nothing has been shared');
    expect(result.content[0].isError).toBeUndefined();
  });

  it('extra dir exists but has no *-shared subdirectories — clean "not shared" result', () => {
    fs.mkdirSync(extraDir(), { recursive: true });
    fs.mkdirSync(path.join(extraDir(), 'unrelated-mount'), { recursive: true });

    const result = readSharedContextImpl(extraDir());

    expect(result.content[0].text.toLowerCase()).toContain('nothing has been shared');
  });

  it('grant exists, file not yet written — same clean "not shared" result as no grant', () => {
    fs.mkdirSync(path.join(extraDir(), 'household-shared'), { recursive: true });
    // No shared-facts.md written inside it.

    const withFile = readSharedContextImpl(extraDir());
    const withoutGrant = readSharedContextImpl(path.join(tmpRoot, 'does-not-exist'));

    expect(withFile.content[0].text).toBe(withoutGrant.content[0].text);
  });

  it('grant-rejected-by-mount-security case (directory never materializes) is identical to no grant', () => {
    // A rejected add-mount never creates the *-shared/ directory in the
    // first place — this is just the no-grant case again from this tool's
    // point of view; nothing distinguishes it.
    const result = readSharedContextImpl(path.join(tmpRoot, 'never-existed'));

    expect(result.content[0].text.toLowerCase()).toContain('nothing has been shared');
  });

  it('path construction — only reads shared-facts.md under *-shared/ dirs, ignores other files/dirs', () => {
    fs.mkdirSync(extraDir(), { recursive: true });
    // A non-"-shared" directory sitting alongside — must be ignored even
    // though it happens to contain a same-named file.
    fs.mkdirSync(path.join(extraDir(), 'household', 'people-shared'), { recursive: true });
    fs.writeFileSync(path.join(extraDir(), 'household', 'people-shared', 'shared-facts.md'), 'should not surface');
    writeSharedFacts('household', 'real shared content');

    const result = readSharedContextImpl(extraDir());
    const text = result.content[0].text;

    expect(text).toContain('real shared content');
    expect(text).not.toContain('should not surface');
  });

  it('strips the "-shared" suffix from the label, keeping the rest of the folder name intact', () => {
    writeSharedFacts('dm-with-uriel', 'personal fact');

    const result = readSharedContextImpl(extraDir());

    expect(result.content[0].text).toContain('dm-with-uriel');
    expect(result.content[0].text).not.toContain('dm-with-uriel-shared');
  });

  it('never returns isError, even for the not-shared cases', () => {
    const result = readSharedContextImpl(extraDir());
    expect(result.content[0].isError).toBeUndefined();
  });

  // review_loop_iteration 1: empty/whitespace-only shared-facts.md is
  // treated identically to "file not yet written" — never a section with
  // an empty body.
  it('shared-facts.md exists but is empty — treated the same as file not yet written', () => {
    writeSharedFacts('household', '');

    const result = readSharedContextImpl(extraDir());

    expect(result.content[0].text.toLowerCase()).toContain('nothing has been shared');
    expect(result.content[0].text).not.toContain('household');
  });

  it('shared-facts.md exists but is whitespace-only — treated the same as file not yet written', () => {
    writeSharedFacts('household', '   \n\t\n   ');

    const result = readSharedContextImpl(extraDir());

    expect(result.content[0].text.toLowerCase()).toContain('nothing has been shared');
    expect(result.content[0].text).not.toContain('household');
  });

  it('an empty grant does not suppress a real one alongside it', () => {
    writeSharedFacts('household', '   ');
    writeSharedFacts('tina', 'Tina fact');

    const result = readSharedContextImpl(extraDir());
    const text = result.content[0].text;

    expect(text).toContain('tina');
    expect(text).toContain('Tina fact');
    expect(text).not.toContain('household');
  });

  // review_loop_iteration 1: a fixed size cap with truncation + a note,
  // never a silent full dump of an oversized shared-facts.md.
  it('shared-facts.md over the size cap is truncated with a note, not returned in full', () => {
    const oversized = 'x'.repeat(25_000);
    writeSharedFacts('household', oversized);

    const result = readSharedContextImpl(extraDir());
    const text = result.content[0].text;

    expect(text.length).toBeLessThan(oversized.length);
    expect(text).toContain('truncated');
    // The full 25,000-char run must not appear intact.
    expect(text).not.toContain(oversized);
  });

  // review_loop_iteration 1 (round 2): truncation must slice by code point,
  // not raw UTF-16 index — otherwise an astral character (e.g. emoji)
  // sitting right at the cutoff gets split into a lone, malformed surrogate.
  it('truncation near an astral character never splits a surrogate pair', () => {
    const oversized = '🎉'.repeat(15_000); // each emoji is 2 UTF-16 code units
    writeSharedFacts('household', oversized);

    const result = readSharedContextImpl(extraDir());
    const text = result.content[0].text;

    expect(text).toContain('truncated');
    // A split surrogate serializes as U+FFFD (replacement character) or an
    // unpaired surrogate — neither should ever appear.
    expect(text).not.toContain('�');
    // eslint-disable-next-line no-misleading-character-class -- deliberately matching a lone surrogate
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
  });

  it('shared-facts.md under the size cap is returned in full, with no truncation note', () => {
    const small = 'a small durable fact';
    writeSharedFacts('household', small);

    const result = readSharedContextImpl(extraDir());
    const text = result.content[0].text;

    expect(text).toContain(small);
    expect(text).not.toContain('truncated');
  });

  // Exercises the real wiring end-to-end: the exported tool's handler (not
  // just readSharedContextImpl) and the WORKSPACE_EXTRA_DIR constant it's
  // bound to, closing a coverage gap where that constant itself was never
  // exercised.
  it('WORKSPACE_EXTRA_DIR is the real mount-security path, and the tool handler uses it', async () => {
    expect(WORKSPACE_EXTRA_DIR).toBe('/workspace/extra');

    // No mounts exist at the real path in this test environment, so the
    // real handler (bound to WORKSPACE_EXTRA_DIR, not an injected tmp dir)
    // must still produce the clean "not shared" result, never an error.
    const result = await readSharedContext.handler({});

    expect(result.content[0].text).toContain('Nothing has been shared with you yet');
    expect(result.content[0].isError).toBeUndefined();
  });
});
