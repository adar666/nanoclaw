/**
 * Host-sweep exclusion for eval sessions (AD-6 `managed_by` marker, Story 1.5).
 *
 * `getActiveSessions()` and `getRunningSessions()` are the sole session-
 * discovery entry points for `host-sweep.ts`, `delivery.ts`, and
 * `ncl tasks`'s no-session fallback — an eval-marked session must never be
 * returned by either, so it never enters the spawn/kill/retry pipeline
 * that eval scenario runs manage themselves in a separate process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { createAgentGroup } from './agent-groups.js';
import { createSession, getActiveSessions, getRunningSessions } from './sessions.js';
import type { Session } from '../types.js';

function makeGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  const session: Session = {
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
    managed_by: null,
    ...overrides,
  };
  createSession(session);
  return session;
}

describe('getActiveSessions / getRunningSessions — eval exclusion', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    makeGroup('ag-1');
  });
  afterEach(() => {
    closeDb();
  });

  it('excludes an eval-marked session from getActiveSessions', () => {
    makeSession({ id: 'eval-1', status: 'active', managed_by: 'eval' });
    const sessions = getActiveSessions();
    expect(sessions.find((s) => s.id === 'eval-1')).toBeUndefined();
  });

  it('includes a normal (managed_by: null) session in getActiveSessions, unchanged from today', () => {
    makeSession({ id: 'normal-1', status: 'active', managed_by: null });
    const sessions = getActiveSessions();
    expect(sessions.find((s) => s.id === 'normal-1')).toBeDefined();
  });

  it('excludes an eval-marked session from getRunningSessions', () => {
    makeSession({ id: 'eval-2', container_status: 'running', managed_by: 'eval' });
    const sessions = getRunningSessions();
    expect(sessions.find((s) => s.id === 'eval-2')).toBeUndefined();
  });

  it('includes a normal (managed_by: null) session in getRunningSessions, unchanged from today', () => {
    makeSession({ id: 'normal-2', container_status: 'running', managed_by: null });
    const sessions = getRunningSessions();
    expect(sessions.find((s) => s.id === 'normal-2')).toBeDefined();
  });

  it('returns only non-eval sessions from a mixed set (no ordering guarantee — neither query has ORDER BY)', () => {
    makeSession({ id: 'normal-a', status: 'active', container_status: 'running', managed_by: null });
    makeSession({ id: 'eval-a', status: 'active', container_status: 'running', managed_by: 'eval' });
    makeSession({ id: 'normal-b', status: 'active', container_status: 'idle', managed_by: null });
    makeSession({ id: 'eval-b', status: 'active', container_status: 'idle', managed_by: 'eval' });

    const active = getActiveSessions();
    expect(active.map((s) => s.id).sort()).toEqual(['normal-a', 'normal-b']);

    const running = getRunningSessions();
    expect(running.map((s) => s.id).sort()).toEqual(['normal-a', 'normal-b']);
  });

  it('includes a session with a non-eval, non-null managed_by value — the filter targets "eval" specifically, not "any marker"', () => {
    // A review finding: the original filter (`managed_by IS NULL`) would
    // have silently excluded ANY marked session, not just eval ones — a
    // future feature reusing this column with a different value would
    // vanish from sweep/delivery with no error. The fix checks specifically
    // for 'eval', so a hypothetical other marker stays visible.
    makeSession({ id: 'other-marker', status: 'active', container_status: 'running', managed_by: 'some-future-thing' });

    expect(getActiveSessions().find((s) => s.id === 'other-marker')).toBeDefined();
    expect(getRunningSessions().find((s) => s.id === 'other-marker')).toBeDefined();
  });
});
