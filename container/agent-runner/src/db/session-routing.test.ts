import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './connection.js';
import { getSessionRouting, getTaskSeriesId, isEvalThread } from './session-routing.js';

function seedSessionRouting(channelType: string | null, platformId: string | null, threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
  ).run(channelType, platformId, threadId);
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('getSessionRouting', () => {
  it('falls back to null fields when the table does not exist', () => {
    expect(getSessionRouting()).toEqual({ channel_type: null, platform_id: null, thread_id: null });
  });

  it('reads back what was written', () => {
    seedSessionRouting('telegram', 'telegram:99', 'chat-thread');
    expect(getSessionRouting()).toEqual({
      channel_type: 'telegram',
      platform_id: 'telegram:99',
      thread_id: 'chat-thread',
    });
  });
});

describe('getTaskSeriesId', () => {
  it('extracts the series id from a system:tasks: thread', () => {
    seedSessionRouting(null, null, 'system:tasks:daily-digest-a1b2');
    expect(getTaskSeriesId()).toBe('daily-digest-a1b2');
  });

  it('returns null for a non-task thread', () => {
    seedSessionRouting('telegram', 'telegram:99', 'chat-thread');
    expect(getTaskSeriesId()).toBeNull();
  });

  it('returns null when no session_routing row exists', () => {
    expect(getTaskSeriesId()).toBeNull();
  });
});

describe('isEvalThread', () => {
  it('is true for the bare system:eval sentinel', () => {
    seedSessionRouting(null, null, 'system:eval');
    expect(isEvalThread()).toBe(true);
  });

  it('is true for a system:eval:<scenario-id> thread', () => {
    seedSessionRouting(null, null, 'system:eval:guest-resolution-known-name');
    expect(isEvalThread()).toBe(true);
  });

  it('is false for a real chat thread', () => {
    seedSessionRouting('telegram', 'telegram:99', 'chat-thread');
    expect(isEvalThread()).toBe(false);
  });

  it('is false for a task thread — eval and task are independent, not overlapping', () => {
    seedSessionRouting(null, null, 'system:tasks:daily-digest-a1b2');
    expect(isEvalThread()).toBe(false);
  });

  it('does not match a thread that merely starts with the sentinel as a substring, not a prefix boundary', () => {
    // "system:evaluate-me" shares a prefix with "system:eval" but is not the
    // sentinel and not "system:eval:"-prefixed — must not match.
    seedSessionRouting(null, null, 'system:evaluate-me');
    expect(isEvalThread()).toBe(false);
  });

  it('is false when no session_routing row exists', () => {
    expect(isEvalThread()).toBe(false);
  });
});
