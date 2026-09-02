/**
 * Unit tests for `buildProvenanceDigest` (spec 2-4:
 * on-demand-cross-domain-digest) — one test per I/O Edge-Case Matrix row:
 * tasks with/without provenance, self-mod-log present/absent, document
 * fill-history with/without provenance, and the bad/missing --id error.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-provenance-digest',
    GROUPS_DIR: '/tmp/nanoclaw-test-provenance-digest/groups',
    TIMEZONE: 'UTC',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-provenance-digest';
const GROUP_FOLDER_DIR = `${TEST_DIR}/groups/ag-1`;

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { appendSelfModLog } from './self-mod/self-mod-log.js';
import { createScheduledTask, prepareScheduledTask, type TaskProvenance } from './scheduling/create.js';
import { buildProvenanceDigest } from './provenance-digest.js';

function now(): string {
  return new Date().toISOString();
}

function createGroup(id = 'ag-1', folder = 'ag-1'): void {
  createAgentGroup({ id, name: id, folder, agent_provider: null, created_at: now() });
  ensureContainerConfig(id);
}

function addTask(
  agentGroupId: string,
  name: string,
  provenance?: TaskProvenance,
): ReturnType<typeof createScheduledTask> {
  const prepared = prepareScheduledTask({ name, prompt: `do the ${name} thing`, processAfter: '2099-01-01T00:00:00Z' });
  return createScheduledTask(agentGroupId, prepared, { provenance });
}

function fillHistoryDir(folder = 'ag-1'): string {
  return path.join(GROUP_FOLDER_DIR.replace(/ag-1$/, folder), 'memory', 'documents', '.fill-history');
}

function writeFillHistory(slug: string, entries: unknown[], folder = 'ag-1'): void {
  const dir = fillHistoryDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(entries));
}

describe('buildProvenanceDigest', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createGroup();
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it("throws a clear error for a bad/missing group id, matching config get's precedent", () => {
    expect(() => buildProvenanceDigest('ag-does-not-exist')).toThrow(/No container config for group/);
  });

  // ── Tasks ──

  it('tasks section says so plainly when there are no active tasks', () => {
    const digest = buildProvenanceDigest('ag-1');
    expect(digest.tasks.items).toEqual([]);
    expect(digest.tasks.summary).toMatch(/no active tasks/i);
  });

  it('lists a live task with its provenance (triggered_by/reason) when present', () => {
    addTask('ag-1', 'briefing', {
      triggeredBy: 'user',
      requesterUserId: 'tg:42',
      reason: 'user asked for a weekday briefing',
      at: '2026-01-01T00:00:00.000Z',
    });

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.tasks.items).toHaveLength(1);
    const item = digest.tasks.items[0];
    expect(item.triggered_by).toBe('user');
    expect(item.requester_user_id).toBe('tg:42');
    expect(item.reason).toBe('user asked for a weekday briefing');
    expect(item.provenance_at).toBe('2026-01-01T00:00:00.000Z');
    expect(item.status).toBe('pending');
  });

  it('lists a live task with null provenance fields when it predates provenance', () => {
    addTask('ag-1', 'legacy-task', undefined);

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.tasks.items).toHaveLength(1);
    const item = digest.tasks.items[0];
    expect(item.triggered_by).toBeNull();
    expect(item.reason).toBeNull();
    expect(item.provenance_at).toBeNull();
  });

  // review round 1: tasks had no recency cap at all, and weren't sorted
  // globally across task sessions (each session's own rows were only
  // locally ordered).
  it('caps active tasks at the digest limit (10), newest first', () => {
    for (let i = 0; i < 12; i++) {
      addTask('ag-1', `task-${i}`, { triggeredBy: 'agent', at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z` });
    }

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.tasks.items).toHaveLength(10);
    // Newest (highest index, latest timestamp) first.
    expect(digest.tasks.items[0].provenance_at).toBe('2026-01-01T00:00:11.000Z');
    expect(digest.tasks.items[9].provenance_at).toBe('2026-01-01T00:00:02.000Z');
  });

  // ── Self-Mod ──

  it('self-mod section says so plainly when there is no self-mod-log.md yet', () => {
    const digest = buildProvenanceDigest('ag-1');
    expect(digest.self_mod.items).toEqual([]);
    expect(digest.self_mod.summary).toMatch(/no self-modification history/i);
  });

  it('shows the most recent self-mod-log.md entries, newest first, structured', () => {
    appendSelfModLog('ag-1', 'add_calendar', 'family calendar for scheduling');
    appendSelfModLog('ag-1', 'install_packages', 'need ffmpeg for audio transcription');

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.self_mod.items).toHaveLength(2);
    // Newest first — same ordering convention as tasks/documents.
    expect(digest.self_mod.items[0].action).toBe('install_packages');
    expect(digest.self_mod.items[0].reason).toBe('need ffmpeg for audio transcription');
    expect(digest.self_mod.items[1].action).toBe('add_calendar');
    expect(digest.self_mod.items[1].reason).toBe('family calendar for scheduling');
    expect(digest.self_mod.summary).toMatch(/2 most recent/i);
  });

  // epic retro: a line parseSelfModLogLine can't parse (hand-edited/corrupted
  // file, outside this module's control) must be skipped, not thrown or
  // silently included as garbage — same tolerant-reader posture as the
  // document/task sections use for their own malformed input.
  it('skips a self-mod-log.md line it cannot parse, keeping the valid ones', () => {
    appendSelfModLog('ag-1', 'add_calendar', 'valid entry');
    fs.appendFileSync(`${GROUP_FOLDER_DIR}/self-mod-log.md`, 'not a valid log line at all\n');

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.self_mod.items).toHaveLength(1);
    expect(digest.self_mod.items[0].action).toBe('add_calendar');
  });

  it('caps self-mod entries at the digest limit (10), newest first', () => {
    for (let i = 0; i < 15; i++) {
      appendSelfModLog('ag-1', 'add_mcp_server', `entry-${i}`);
    }

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.self_mod.items).toHaveLength(10);
    // entry-14 (last appended) sorts to the top, newest first.
    expect(digest.self_mod.items[0].reason).toBe('entry-14');
  });

  // ── Documents ──

  it('documents section says so plainly when there is no fill-history directory at all', () => {
    const digest = buildProvenanceDigest('ag-1');
    expect(digest.documents.items).toEqual([]);
    expect(digest.documents.summary).toMatch(/no document fill history/i);
  });

  it('documents section says so plainly when entries exist but none carry provenance', () => {
    writeFillHistory('form-a', [
      { timestamp: '2026-01-01T00:00:00.000Z', outputPath: '/x', target: 'field one', kind: 'fill' },
    ]);

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.documents.items).toEqual([]);
    expect(digest.documents.summary).toMatch(/no document fill history/i);
  });

  it('lists document fill-history entries with provenance, newest first, with reason', () => {
    writeFillHistory('form-a', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        outputPath: '/x',
        target: 'older field',
        kind: 'fill',
        provenance: { triggeredBy: 'agent', at: '2026-01-01T00:00:00.000Z', reason: 'older reason' },
      },
      {
        timestamp: '2026-01-02T00:00:00.000Z',
        outputPath: '/y',
        target: 'newer field',
        kind: 'fill',
        provenance: { triggeredBy: 'agent', at: '2026-01-02T00:00:00.000Z', reason: 'newer reason' },
      },
    ]);

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.documents.items).toHaveLength(2);
    expect(digest.documents.items[0].target).toBe('newer field');
    expect(digest.documents.items[0].reason).toBe('newer reason');
    expect(digest.documents.items[1].target).toBe('older field');
    expect(digest.documents.summary).toMatch(/2 most recent/i);
  });

  // review round 1 (verification-gap finding): a pre-refresh snapshot
  // carries provenance too but isn't a real fill — must be labeled, not
  // indistinguishable from an actual field-fill.
  it('labels a pre-refresh-snapshot entry distinctly from a real fill', () => {
    writeFillHistory('form-a', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        outputPath: '/snap',
        target: 'pre-refresh snapshot',
        kind: 'pre-refresh-snapshot',
        provenance: { triggeredBy: 'agent', at: '2026-01-01T00:00:00.000Z' },
      },
    ]);

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.documents.items).toHaveLength(1);
    expect(digest.documents.items[0].kind).toBe('pre-refresh-snapshot');
  });

  it('caps document digest items at the digest limit (10)', () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      timestamp: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      outputPath: `/f-${i}`,
      target: `field-${i}`,
      kind: 'fill',
      provenance: { triggeredBy: 'agent', at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` },
    }));
    writeFillHistory('form-a', entries);

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.documents.items).toHaveLength(10);
    // Newest first — the 15th (index 14, day 15) entry sorts to the top.
    expect(digest.documents.items[0].target).toBe('field-14');
  });

  // epic retro: a malformed-but-present provenance object (wrong
  // triggeredBy, missing `at`) used to drop with no trace, reintroducing a
  // gap documents.ts's own reader already fixed. Now logged, and still
  // excluded from items (indistinguishable from "no provenance" downstream).
  it('logs and skips a fill-history entry whose provenance object is malformed', () => {
    writeFillHistory('form-a', [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        outputPath: '/x',
        target: 'bad provenance field',
        kind: 'fill',
        provenance: { triggeredBy: 'not-a-valid-value', at: '2026-01-01T00:00:00.000Z' },
      },
    ]);

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.documents.items).toEqual([]);
  });

  it('tolerates a corrupted fill-history file (malformed JSON) without throwing', () => {
    const dir = fillHistoryDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not valid json');

    expect(() => buildProvenanceDigest('ag-1')).not.toThrow();
    const digest = buildProvenanceDigest('ag-1');
    expect(digest.documents.items).toEqual([]);
  });

  // ── Cross-group isolation ──

  it("never mixes another group's tasks/self-mod/document history into this digest", () => {
    createGroup('ag-2', 'ag-2');
    addTask('ag-2', 'other-group-task', { triggeredBy: 'user', at: now(), reason: 'belongs to ag-2' });
    appendSelfModLog('ag-2', 'add_calendar', 'belongs to ag-2');
    writeFillHistory(
      'form-b',
      [
        {
          timestamp: now(),
          outputPath: '/z',
          target: 'ag-2 field',
          kind: 'fill',
          provenance: { triggeredBy: 'agent', at: now(), reason: 'belongs to ag-2' },
        },
      ],
      'ag-2',
    );

    const digest = buildProvenanceDigest('ag-1');
    expect(digest.tasks.items).toEqual([]);
    expect(digest.self_mod.items).toEqual([]);
    expect(digest.documents.items).toEqual([]);
  });
});
