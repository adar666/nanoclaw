/**
 * Unit tests for `appendSelfModLog` (spec-2-2: self-mod-change-provenance) —
 * confirms the exact appended line shape, cap-and-trim behavior, and
 * fresh-file creation. Real filesystem under a mocked GROUPS_DIR, matching
 * the pattern already used by `modules/scheduling/create.test.ts`.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-self-mod-log/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-self-mod-log';
const GROUP_FOLDER_DIR = `${TEST_DIR}/groups/ag-1`;
const LOG_PATH = `${GROUP_FOLDER_DIR}/self-mod-log.md`;

import { createAgentGroup, closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { appendSelfModLog, readSelfModLog, SELF_MOD_LOG_CAP } from './self-mod-log.js';

function now(): string {
  return new Date().toISOString();
}

function readLines(): string[] {
  return fs
    .readFileSync(LOG_PATH, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0);
}

describe('appendSelfModLog', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'ag-1', agent_provider: null, created_at: now() });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('creates the file fresh when it does not exist yet, with one line', () => {
    expect(fs.existsSync(LOG_PATH)).toBe(false);

    appendSelfModLog('ag-1', 'add_calendar', 'family calendar for scheduling');

    expect(fs.existsSync(LOG_PATH)).toBe(true);
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z — add_calendar: family calendar for scheduling$/,
    );
  });

  it('includes the reason after a colon when one is given', () => {
    appendSelfModLog('ag-1', 'install_packages', 'need ffmpeg for audio transcription');

    const lines = readLines();
    expect(lines[0]).toContain(' — install_packages: need ffmpeg for audio transcription');
  });

  it('omits the trailing colon/reason text when no reason is given (add_mcp_server case)', () => {
    appendSelfModLog('ag-1', 'add_mcp_server', undefined);

    const lines = readLines();
    expect(lines[0]).toMatch(/ — add_mcp_server$/);
    // No trailing "action: reason" colon — only the timestamp's own colons.
    expect(lines[0].split(' — ')[1]).toBe('add_mcp_server');
  });

  it('omits the trailing colon/reason text when the reason is an empty string', () => {
    appendSelfModLog('ag-1', 'install_packages', '');

    const lines = readLines();
    expect(lines[0]).toMatch(/ — install_packages$/);
  });

  it('appends subsequent entries rather than overwriting', () => {
    appendSelfModLog('ag-1', 'add_calendar', 'first');
    appendSelfModLog('ag-1', 'add_mcp_server', undefined);

    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('add_calendar: first');
    expect(lines[1]).toMatch(/add_mcp_server$/);
  });

  it('caps at SELF_MOD_LOG_CAP entries, trimming the oldest first', () => {
    fs.mkdirSync(GROUP_FOLDER_DIR, { recursive: true });
    const preexisting = Array.from(
      { length: SELF_MOD_LOG_CAP },
      (_, i) => `2020-01-01T00:00:0${i % 10}.000Z — entry-${i}`,
    );
    fs.writeFileSync(LOG_PATH, preexisting.join('\n') + '\n');

    appendSelfModLog('ag-1', 'add_calendar', 'newest');

    const lines = readLines();
    expect(lines).toHaveLength(SELF_MOD_LOG_CAP);
    // The very first (oldest) preexisting entry is gone...
    expect(lines).not.toContain(preexisting[0]);
    // ...but the second-oldest survives, since exactly one was dropped...
    expect(lines[0]).toBe(preexisting[1]);
    // ...and the new entry is the last line.
    expect(lines[lines.length - 1]).toContain('add_calendar: newest');
  });

  it('throws when the agent group does not exist', () => {
    expect(() => appendSelfModLog('ag-does-not-exist', 'add_calendar', 'x')).toThrow(/agent group not found/);
  });

  // review round 1: a literal newline in `reason` would otherwise fragment
  // into extra "entries" — the cap/trim logic splits the file on '\n'.
  it('collapses embedded newlines in reason into spaces, never splitting into extra lines', () => {
    appendSelfModLog('ag-1', 'install_packages', 'line one\nline two\r\nline three');

    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('line one line two line three');
  });

  // review round 1: a stored line is a one-line log entry, not a document —
  // cap it the same way tasks.ts caps `reason` for display (spec 2-1).
  it('truncates a reason longer than the max stored length', () => {
    const long = 'x'.repeat(500);
    appendSelfModLog('ag-1', 'install_packages', long);

    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThan(long.length);
  });
});

// spec 2-4 (on-demand-cross-domain-digest): readSelfModLog is the Self-Mod
// section's data source.
describe('readSelfModLog', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'ag-1', agent_provider: null, created_at: now() });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('returns [] when the log file does not exist yet (no self-mod history)', () => {
    expect(fs.existsSync(LOG_PATH)).toBe(false);
    expect(readSelfModLog('ag-1')).toEqual([]);
  });

  it('returns [] for an unknown agent group, never throws', () => {
    expect(() => readSelfModLog('ag-does-not-exist')).not.toThrow();
    expect(readSelfModLog('ag-does-not-exist')).toEqual([]);
  });

  it('returns every line when there are fewer than the limit', () => {
    appendSelfModLog('ag-1', 'add_calendar', 'first');
    appendSelfModLog('ag-1', 'add_mcp_server', undefined);

    const lines = readSelfModLog('ag-1');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('add_calendar: first');
    expect(lines[1]).toMatch(/add_mcp_server$/);
  });

  it('caps at the given limit, keeping the most recent lines (newest last)', () => {
    for (let i = 0; i < 15; i++) {
      appendSelfModLog('ag-1', 'add_mcp_server', `entry-${i}`);
    }

    const lines = readSelfModLog('ag-1', 10);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain('entry-5');
    expect(lines[lines.length - 1]).toContain('entry-14');
  });

  it('defaults the limit to 10 when not passed', () => {
    for (let i = 0; i < 15; i++) {
      appendSelfModLog('ag-1', 'add_mcp_server', `entry-${i}`);
    }

    expect(readSelfModLog('ag-1')).toHaveLength(10);
  });

  // review round 1: slice(-0) === slice(0), which is the WHOLE array, not
  // none — a limit of 0 (or negative) must return nothing, not everything.
  it('returns [] for a limit of 0 or less, never the whole log', () => {
    appendSelfModLog('ag-1', 'add_calendar', 'first');
    appendSelfModLog('ag-1', 'add_mcp_server', undefined);

    expect(readSelfModLog('ag-1', 0)).toEqual([]);
    expect(readSelfModLog('ag-1', -5)).toEqual([]);
  });

  // review round 1: existsSync-then-readFileSync was a TOCTOU gap — confirm
  // a deleted-between-check-and-read file resolves to [], not a throw.
  it('never throws even if the file becomes unreadable after being written', () => {
    appendSelfModLog('ag-1', 'add_calendar', 'first');
    fs.rmSync(LOG_PATH);

    expect(() => readSelfModLog('ag-1')).not.toThrow();
    expect(readSelfModLog('ag-1')).toEqual([]);
  });
});
