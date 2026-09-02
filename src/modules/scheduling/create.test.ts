/**
 * Unit tests for `createScheduledTask`'s provenance capture (spec-2-1:
 * task-reminder-provenance) — confirms the exact stored `content.provenance`
 * JSON shape with and without an options.provenance value.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-scheduling-create',
    GROUPS_DIR: '/tmp/nanoclaw-test-scheduling-create/groups',
    TIMEZONE: 'UTC',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-scheduling-create';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { inboundDbPath } from '../../session-manager.js';
import { createScheduledTask, type PreparedScheduledTask, type TaskProvenance } from './create.js';

function now(): string {
  return new Date().toISOString();
}

function preparedTask(overrides: Partial<PreparedScheduledTask> = {}): PreparedScheduledTask {
  return {
    prompt: 'send a briefing',
    recurrence: null,
    script: null,
    processAfter: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('createScheduledTask provenance', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: 'ag-1', name: 'ag-1', folder: 'ag-1', agent_provider: null, created_at: now() });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  function storedContent(sessionId: string, rowId: string): Record<string, unknown> {
    const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(rowId) as { content: string };
    db.close();
    return JSON.parse(row.content) as Record<string, unknown>;
  }

  it('with no provenance option, stores content with no provenance key at all', () => {
    const { session, row } = createScheduledTask('ag-1', preparedTask({ name: 'no-prov' }));
    const content = storedContent(session.id, row.row_id);
    expect(content).toEqual({
      prompt: 'send a briefing',
      script: null,
      originSessionId: null,
    });
    expect('provenance' in content).toBe(false);
  });

  it('with an agent provenance (no reason), stores triggeredBy + at, no requesterUserId/reason keys', () => {
    const provenance: TaskProvenance = { triggeredBy: 'agent', at: '2026-09-01T00:00:00.000Z' };
    const { session, row } = createScheduledTask('ag-1', preparedTask({ name: 'agent-prov' }), { provenance });
    const content = storedContent(session.id, row.row_id);
    expect(content.provenance).toEqual({ triggeredBy: 'agent', at: '2026-09-01T00:00:00.000Z' });
  });

  it('with an agent provenance + reason, stores the reason verbatim', () => {
    const provenance: TaskProvenance = {
      triggeredBy: 'agent',
      reason: 'user asked to check every Monday',
      at: '2026-09-01T00:00:00.000Z',
    };
    const { session, row } = createScheduledTask('ag-1', preparedTask({ name: 'agent-prov-reason' }), {
      provenance,
    });
    const content = storedContent(session.id, row.row_id);
    expect(content.provenance).toEqual({
      triggeredBy: 'agent',
      reason: 'user asked to check every Monday',
      at: '2026-09-01T00:00:00.000Z',
    });
  });

  it('with a user (host-typed) provenance, stores triggeredBy: user', () => {
    const provenance: TaskProvenance = { triggeredBy: 'user', at: '2026-09-01T00:00:00.000Z' };
    const { session, row } = createScheduledTask('ag-1', preparedTask({ name: 'user-prov' }), { provenance });
    const content = storedContent(session.id, row.row_id);
    expect(content.provenance).toEqual({ triggeredBy: 'user', at: '2026-09-01T00:00:00.000Z' });
  });

  it('a provenance with requesterUserId set persists it too (shape is honored end to end)', () => {
    const provenance: TaskProvenance = {
      triggeredBy: 'user',
      requesterUserId: 'telegram:12345',
      at: '2026-09-01T00:00:00.000Z',
    };
    const { session, row } = createScheduledTask('ag-1', preparedTask({ name: 'user-id-prov' }), { provenance });
    const content = storedContent(session.id, row.row_id);
    expect(content.provenance).toEqual({
      triggeredBy: 'user',
      requesterUserId: 'telegram:12345',
      at: '2026-09-01T00:00:00.000Z',
    });
  });
});
