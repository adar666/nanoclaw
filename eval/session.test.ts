import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-eval-session-test';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-eval-session-test/data',
}));

// Calls through to the real implementation by default (every existing test
// below relies on the real filesystem/DB-schema side effects) — only the
// rollback test overrides it, via mockImplementationOnce, to simulate the
// follow-up filesystem step throwing after the DB insert already committed.
vi.mock('../src/session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/session-manager.js')>();
  return { ...actual, initSessionFolder: vi.fn(actual.initSessionFolder) };
});

import { closeDb, initTestDb, runMigrations } from '../src/db/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { getSessionsByAgentGroup } from '../src/db/sessions.js';
import { initSessionFolder } from '../src/session-manager.js';
import { EVAL_THREAD_PREFIX, resolveEvalSession } from './session.js';

const AG = 'ag-eval-session-test';

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
  createAgentGroup({
    id: AG,
    name: 'Eval Session Test',
    folder: 'eval-session-test',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('resolveEvalSession', () => {
  it('creates a session with messaging_group_id null and the exact thread id passed in', () => {
    const threadId = `${EVAL_THREAD_PREFIX}:guest-resolution-known-name`;
    const { session, created } = resolveEvalSession(AG, threadId);

    expect(created).toBe(true);
    expect(session.messaging_group_id).toBeNull();
    expect(session.thread_id).toBe(threadId);
    expect(session.agent_group_id).toBe(AG);
  });

  it('accepts the bare prefix itself, not just a "prefix:..." thread id', () => {
    const { session } = resolveEvalSession(AG, EVAL_THREAD_PREFIX);
    expect(session.thread_id).toBe(EVAL_THREAD_PREFIX);
  });

  it('is idempotent: resolving the same thread id twice returns the existing session', () => {
    const threadId = `${EVAL_THREAD_PREFIX}:repeat-me`;
    const first = resolveEvalSession(AG, threadId);
    const second = resolveEvalSession(AG, threadId);

    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    expect(getSessionsByAgentGroup(AG).filter((s) => s.thread_id === threadId)).toHaveLength(1);
  });

  it('throws before calling createSession for a non-system:eval-prefixed thread id', () => {
    expect(() => resolveEvalSession(AG, 'not-system-prefixed')).toThrow(/system:eval/);
    expect(getSessionsByAgentGroup(AG)).toHaveLength(0);
  });

  it('throws for a thread id that merely contains the prefix without the leading anchor', () => {
    expect(() => resolveEvalSession(AG, 'system:evaluation:oops')).toThrow(/system:eval/);
    expect(getSessionsByAgentGroup(AG)).toHaveLength(0);
  });

  it('rolls back (deletes) the session row when the filesystem step throws after the DB insert commits (deferred-work.md, spec-eval-1-1)', () => {
    vi.mocked(initSessionFolder).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const threadId = `${EVAL_THREAD_PREFIX}:rollback-test`;

    expect(() => resolveEvalSession(AG, threadId)).toThrow(/disk full/);

    // No orphaned row left behind for a later resolveEvalSession call to
    // find and treat as already-provisioned.
    expect(getSessionsByAgentGroup(AG).filter((s) => s.thread_id === threadId)).toHaveLength(0);
  });

  it('a later resolveEvalSession call for the same thread id after a rollback creates a fresh session rather than silently no-oping', () => {
    vi.mocked(initSessionFolder).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const threadId = `${EVAL_THREAD_PREFIX}:rollback-retry`;
    expect(() => resolveEvalSession(AG, threadId)).toThrow();

    const { session, created } = resolveEvalSession(AG, threadId);

    expect(created).toBe(true);
    expect(session.thread_id).toBe(threadId);
  });
});
