import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-eval-teardown-test';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-eval-teardown-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-eval-teardown-test/groups',
}));

let mockRunningSessionIds = new Set<string>();
vi.mock('../src/container-runner.js', () => ({
  isContainerRunning: (sessionId: string) => mockRunningSessionIds.has(sessionId),
}));

import { closeDb } from '../src/db/index.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { createSession, getSession, getSessionsByAgentGroup } from '../src/db/sessions.js';
import { sessionDir } from '../src/session-manager.js';
import type { Session } from '../src/types.js';
import { EVAL_THREAD_PREFIX, resolveEvalSession } from './session.js';
import { bootstrapDb } from './setup.js';
import { decommissionEvalHarness, pruneEvalSessions } from './teardown.js';

function makeGroup(folder: 'eval' | 'eval-judge'): string {
  const id = `ag-${folder}-test`;
  createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() });
  fs.mkdirSync(path.join('/tmp/nanoclaw-eval-teardown-test/groups', folder), { recursive: true });
  return id;
}

/** A real eval session, with its own on-disk session dir, via the same path a real run creates one. */
function makeEvalSession(agentGroupId: string, scenarioId: string): Session {
  const { session } = resolveEvalSession(agentGroupId, `${EVAL_THREAD_PREFIX}:${scenarioId}`);
  return session;
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  // A real file DB under the mocked DATA_DIR, NOT initTestDb()'s in-memory
  // one — pruneEvalSessions/decommissionEvalHarness call bootstrapDb()
  // themselves (same reasoning as runCli's/runSweep's own first line: a
  // standalone invocation needs to be able to init its own DB), which would
  // silently swap out an in-memory DB out from under every fixture this
  // file's own tests set up first. Calling it here too is exactly what a
  // real caller does implicitly and is safe/idempotent against the same
  // underlying file either way.
  bootstrapDb();
  mockRunningSessionIds = new Set();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('pruneEvalSessions', () => {
  it('deletes every eval-managed session (DB row + on-disk dir) across both provisioned groups', async () => {
    const evalGroup = makeGroup('eval');
    const judgeGroup = makeGroup('eval-judge');
    const s1 = makeEvalSession(evalGroup, 'guest-resolution-known-name');
    const s2 = makeEvalSession(judgeGroup, 'judge:guest-resolution-ambiguous-name');
    expect(fs.existsSync(sessionDir(evalGroup, s1.id))).toBe(true);
    expect(fs.existsSync(sessionDir(judgeGroup, s2.id))).toBe(true);

    const result = await pruneEvalSessions();

    expect(result).toEqual({ removedSessions: 2, skippedRunning: [] });
    expect(getSession(s1.id)).toBeUndefined();
    expect(getSession(s2.id)).toBeUndefined();
    expect(fs.existsSync(sessionDir(evalGroup, s1.id))).toBe(false);
    expect(fs.existsSync(sessionDir(judgeGroup, s2.id))).toBe(false);
    // The groups themselves are untouched — pnpm eval run works immediately again.
    expect(getAgentGroup(evalGroup)).toBeDefined();
    expect(getAgentGroup(judgeGroup)).toBeDefined();
  });

  it('leaves a non-eval-managed session in the same group alone (defense in depth — should never actually occur in practice)', async () => {
    const evalGroup = makeGroup('eval');
    const evalSession = makeEvalSession(evalGroup, 'some-scenario');
    const strayId = 'sess-not-eval-managed';
    createSession({
      id: strayId,
      agent_group_id: evalGroup,
      messaging_group_id: null,
      thread_id: 'system:not-eval',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
      managed_by: null,
    });

    const result = await pruneEvalSessions();

    expect(result.removedSessions).toBe(1);
    expect(getSession(evalSession.id)).toBeUndefined();
    expect(getSession(strayId)).toBeDefined();
  });

  it('skips (never deletes) a session whose container is currently marked running', async () => {
    const evalGroup = makeGroup('eval');
    const running = makeEvalSession(evalGroup, 'running-scenario');
    const idle = makeEvalSession(evalGroup, 'idle-scenario');
    mockRunningSessionIds.add(running.id);

    const result = await pruneEvalSessions();

    expect(result.removedSessions).toBe(1);
    expect(result.skippedRunning).toEqual([running.id]);
    expect(getSession(running.id)).toBeDefined();
    expect(fs.existsSync(sessionDir(evalGroup, running.id))).toBe(true);
    expect(getSession(idle.id)).toBeUndefined();
  });

  it('is a silent no-op when neither group has ever been provisioned', async () => {
    const result = await pruneEvalSessions();
    expect(result).toEqual({ removedSessions: 0, skippedRunning: [] });
  });
});

describe('decommissionEvalHarness', () => {
  it('deletes sessions, the agent_groups rows, and the workspace directories for both groups', async () => {
    const evalGroup = makeGroup('eval');
    const judgeGroup = makeGroup('eval-judge');
    const s1 = makeEvalSession(evalGroup, 'some-scenario');
    const s2 = makeEvalSession(judgeGroup, 'judge:some-scenario');

    const result = await decommissionEvalHarness();

    expect(result.removedSessions).toBe(2);
    expect(result.removedGroups.sort()).toEqual(['eval', 'eval-judge']);
    expect(result.skippedRunning).toEqual([]);
    expect(getSession(s1.id)).toBeUndefined();
    expect(getSession(s2.id)).toBeUndefined();
    expect(getAgentGroup(evalGroup)).toBeUndefined();
    expect(getAgentGroup(judgeGroup)).toBeUndefined();
    expect(getAgentGroupByFolder('eval')).toBeUndefined();
    expect(getAgentGroupByFolder('eval-judge')).toBeUndefined();
    expect(fs.existsSync(path.join('/tmp/nanoclaw-eval-teardown-test/groups', 'eval'))).toBe(false);
    expect(fs.existsSync(path.join('/tmp/nanoclaw-eval-teardown-test/groups', 'eval-judge'))).toBe(false);
  });

  it('leaves a group fully provisioned (not partially decommissioned) when one of its sessions is still running', async () => {
    const evalGroup = makeGroup('eval');
    const running = makeEvalSession(evalGroup, 'running-scenario');
    mockRunningSessionIds.add(running.id);

    const result = await decommissionEvalHarness();

    expect(result.removedGroups).toEqual([]);
    expect(result.skippedRunning).toEqual([running.id]);
    expect(getAgentGroup(evalGroup)).toBeDefined(); // group NOT deleted — still has a live session
    expect(getSession(running.id)).toBeDefined();
    expect(fs.existsSync(path.join('/tmp/nanoclaw-eval-teardown-test/groups', 'eval'))).toBe(true);
  });

  it('decommissioning, then a fresh ensureEvalScenarioGroup-style re-provision, works cleanly (recoverable, not a one-way door)', async () => {
    const evalGroup = makeGroup('eval');
    makeEvalSession(evalGroup, 'some-scenario');
    await decommissionEvalHarness();
    expect(getAgentGroupByFolder('eval')).toBeUndefined();

    // A fresh provision under the same folder must not collide with
    // anything left behind by the old (now-deleted) group.
    const freshId = 'ag-eval-fresh';
    createAgentGroup({ id: freshId, name: 'eval', folder: 'eval', agent_provider: null, created_at: new Date().toISOString() });
    expect(getAgentGroupByFolder('eval')!.id).toBe(freshId);
    expect(getSessionsByAgentGroup(freshId)).toEqual([]);
  });
});
