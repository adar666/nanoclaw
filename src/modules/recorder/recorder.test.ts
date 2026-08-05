/**
 * Recorder module tests.
 *
 * guard.ts: scoped to the dm-with-uriel agent group only, everything else
 * denied — the actual blast-radius boundary for this feature.
 * db.ts: recorder_sessions CRUD — "is one running" is the state host-sweep's
 * cap enforcement and double-start prevention both depend on.
 * apply.ts: run.sh is invoked with a fixed binary + argv array (never a
 * shell string) — them/context land only as flag values; double-start is
 * rejected before ever calling execFile; stop chains into the second-brain
 * ingest and reports distinct wording for a user-triggered vs. cap-triggered
 * stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';

const { mockExecFile, mockNotifyAgent } = vi.hoisted(() => ({
  mockExecFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout: 'ok\n', stderr: '' });
    },
  ),
  mockNotifyAgent: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mockExecFile }));
vi.mock('../approvals/index.js', () => ({ notifyAgent: mockNotifyAgent }));

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';
import { recorderStart, recorderStop } from './guard.js';
import { createRecorderSession, getRunningRecorderSession, markRecorderSessionStopped } from './db.js';
import { applyRecorderStart, applyRecorderStop, stopAndIngest, RECORDER_MAX_DURATION_MS } from './apply.js';

const TEST_DIR = '/tmp/nanoclaw-test-recorder';

function fakeSession(agentGroupId: string): Session {
  return {
    id: 'sess-1',
    agent_group_id: agentGroupId,
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFile.mockImplementation((_file, _args, _opts, cb) => cb(null, { stdout: 'ok\n', stderr: '' }));
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('recorder guard', () => {
  it('denies a non-agent actor', () => {
    const decision = recorderStart.decide({ actor: { kind: 'human', userId: 'u1' }, payload: {} });
    expect(decision.effect).toBe('deny');
  });

  it('denies an agent group that is not dm-with-uriel', () => {
    createAgentGroup({
      id: 'ag-other',
      name: 'Other',
      folder: 'dm-with-partner',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const decision = recorderStart.decide({ actor: { kind: 'agent', agentGroupId: 'ag-other' }, payload: {} });
    expect(decision.effect).toBe('deny');
  });

  it('allows only the dm-with-uriel agent group, never holds', () => {
    createAgentGroup({
      id: 'ag-uriel',
      name: 'Yulanda',
      folder: 'dm-with-uriel',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const startDecision = recorderStart.decide({ actor: { kind: 'agent', agentGroupId: 'ag-uriel' }, payload: {} });
    const stopDecision = recorderStop.decide({ actor: { kind: 'agent', agentGroupId: 'ag-uriel' }, payload: {} });
    expect(startDecision.effect).toBe('allow');
    expect(stopDecision.effect).toBe('allow');
  });

  it('an unrelated agent group with no matching folder at all is denied, not crashed', () => {
    const decision = recorderStart.decide({ actor: { kind: 'agent', agentGroupId: 'nonexistent' }, payload: {} });
    expect(decision.effect).toBe('deny');
  });
});

describe('recorder_sessions db', () => {
  it('has no running session initially', () => {
    expect(getRunningRecorderSession()).toBeUndefined();
  });

  it('createRecorderSession makes it the running session', () => {
    createRecorderSession({
      id: 'rec-1',
      agent_group_id: 'ag-uriel',
      session_id: 'sess-1',
      them: 'דניס',
      context: 'HoursReportWebApp',
      started_at: new Date().toISOString(),
    });
    const running = getRunningRecorderSession();
    expect(running?.id).toBe('rec-1');
    expect(running?.stopped_at).toBeNull();
  });

  it('markRecorderSessionStopped clears the running session', () => {
    createRecorderSession({
      id: 'rec-1',
      agent_group_id: 'ag-uriel',
      session_id: 'sess-1',
      them: 'דניס',
      context: '',
      started_at: new Date().toISOString(),
    });
    markRecorderSessionStopped('rec-1', new Date().toISOString(), 'user');
    expect(getRunningRecorderSession()).toBeUndefined();
  });
});

describe('applyRecorderStart', () => {
  it('invokes run.sh with a fixed binary and them/context as argv values, never a shell string', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'HoursReportWebApp' }, session);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockExecFile.mock.calls[0]!;
    expect(bin).toMatch(/run\.sh$/);
    expect(args).toEqual(['start', '--', '--lang', 'he', '--them', 'דניס', '--context', 'HoursReportWebApp']);
    // /opt/homebrew/bin isn't on NanoClaw's launchd job's PATH — negotiator's
    // run.sh backgrounds a bare `ffmpeg` spawn three levels down, which
    // would silently fail to resolve without this. See apply.ts's SPAWN_ENV.
    expect((opts as { env?: Record<string, string> }).env?.PATH).toContain('/opt/homebrew/bin');
  });

  it('records a running recorder_sessions row and notifies success', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'HoursReportWebApp' }, session);

    const running = getRunningRecorderSession();
    expect(running?.them).toBe('דניס');
    expect(running?.context).toBe('HoursReportWebApp');
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('started'));
  });

  it('refuses a second start without calling execFile again, and notifies instead', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockExecFile.mockClear();
    mockNotifyAgent.mockClear();

    await applyRecorderStart({ them: 'מישהו אחר', context: 'y' }, session);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('already running'));
  });

  it('notifies failure and does not create a row when run.sh start fails', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(new Error('device busy'), { stdout: '', stderr: '' }),
    );
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);

    expect(getRunningRecorderSession()).toBeUndefined();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('did NOT start'));
  });
});

describe('applyRecorderStop / stopAndIngest', () => {
  it('with nothing running: notifies "nothing to stop" and never calls execFile', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStop({}, session);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('nothing to stop'));
  });

  it('stops, marks the row stopped, chains into the second-brain ingest, and notifies "stopped"', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockExecFile.mockClear();
    mockNotifyAgent.mockClear();

    await applyRecorderStop({}, session);

    expect(mockExecFile).toHaveBeenCalledTimes(2); // run.sh stop, then the ingest
    const [stopBin, stopArgs, stopOpts] = mockExecFile.mock.calls[0]!;
    expect(stopBin).toMatch(/run\.sh$/);
    expect(stopArgs).toEqual(['stop']);
    expect((stopOpts as { env?: Record<string, string> }).env?.PATH).toContain('/opt/homebrew/bin');
    const [ingestBin, ingestArgs] = mockExecFile.mock.calls[1]!;
    expect(ingestArgs).toContain('--dir');
    expect(ingestArgs.some((a: string) => a.includes('ingest-recorder'))).toBe(true);
    void ingestBin;

    const running = getRunningRecorderSession();
    expect(running).toBeUndefined();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('stopped'));
  });

  it('a cap-triggered stop notifies with the auto-stop wording, distinct from a user stop', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockNotifyAgent.mockClear();

    await stopAndIngest(session, 'cap');

    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('auto-stopped'));
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('unprompted'));
  });

  it('reports an ingest failure without hiding that the stop itself succeeded', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockNotifyAgent.mockClear();
    let call = 0;
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      call++;
      if (call === 1) return cb(null, { stdout: 'stopped\n', stderr: '' }); // run.sh stop
      return cb(new Error('ingest crashed'), { stdout: '', stderr: '' }); // ingest
    });

    await applyRecorderStop({}, session);

    expect(getRunningRecorderSession()).toBeUndefined(); // stop side still recorded
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('ingest into uriel.db FAILED'));
  });
});

describe('RECORDER_MAX_DURATION_MS', () => {
  it('is 3 hours', () => {
    expect(RECORDER_MAX_DURATION_MS).toBe(3 * 60 * 60 * 1000);
  });
});
