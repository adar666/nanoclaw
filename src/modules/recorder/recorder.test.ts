/**
 * Recorder module tests.
 *
 * guard.ts: scoped to the dm-with-uriel agent group only, everything else
 * denied — the actual blast-radius boundary for this feature.
 * db.ts: recorder_sessions CRUD — "is one running" is the state host-sweep's
 * cap enforcement and double-start prevention both depend on.
 * apply.ts: call.sh is invoked with a fixed binary + argv array (never a
 * shell string) — them/context land only as flag values. Before trusting a
 * DB row that claims a session is active, applyRecorderStart/stopAndIngest
 * both cross-check against `call.sh status` (reconciledRunningSession) —
 * a stale row (left behind by a stop that failed partway) self-heals
 * instead of refusing every future start forever. Real double-start is
 * still rejected before ever calling execFile with `start`; stop chains
 * into the second-brain ingest and reports distinct wording for a
 * user-triggered vs. cap-triggered stop.
 *
 * mockExecFile's default response is ARGS-AWARE: a `status` call reports
 * everything running (so a session created mid-test is, by default, still
 * "genuinely active" as far as reconciliation is concerned — matching the
 * old un-reconciled behavior for every test that isn't specifically about
 * reconciliation). Tests that need the opposite (a stale, no-longer-running
 * row) override mockImplementation explicitly and must stay args-aware too
 * if they also need to control the `start`/`end`/ingest response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';

const STATUS_ALL_RUNNING = 'capture: running (pid 111)\nui: running (pid 222)\nnotes: running (pid 333)\n';
const STATUS_ALL_STOPPED = 'capture: not running\nui: not running\nnotes: not running\n';

const { mockExecFile, mockNotifyAgent } = vi.hoisted(() => {
  const mockExecFile = vi.fn(
    (
      _file: string,
      args: string[],
      _opts: unknown,
      cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
    ) => {
      if (args[0] === 'status') {
        cb(null, {
          stdout: 'capture: running (pid 111)\nui: running (pid 222)\nnotes: running (pid 333)\n',
          stderr: '',
        });
        return;
      }
      cb(null, { stdout: '[call] keyterms: <none>\nUI: http://localhost:8140\n', stderr: '' });
    },
  );
  // Real Node's child_process.execFile carries a [util.promisify.custom]
  // implementation that attaches a rejected call's stdout/stderr onto the
  // Error object — that's what apply.ts's errorDetail() relies on. Mocking
  // the whole module replaces execFile with a plain vi.fn() that has no such
  // symbol, so promisify(execFile) would otherwise fall back to generic
  // behavior and silently drop stdout/stderr on rejection. This reproduces
  // the real one so promisify(execFile) behaves identically under test.
  // Must be attached here, inside vi.hoisted() — apply.ts's own
  // `promisify(execFile)` call happens at module-import time, which (per
  // Vitest's hoisting) runs before any plain top-level statement in this
  // file, so attaching the symbol any later would be too late for
  // promisify() to ever see it. Uses Symbol.for(...) directly (matching
  // `util.promisify.custom`, verified equal to
  // Symbol.for('nodejs.util.promisify.custom')) rather than the imported
  // `promisify` binding, since regular imports haven't been evaluated yet
  // this early in Vitest's hoisting order and referencing one here throws
  // "Cannot access '...' before initialization".
  (mockExecFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = (
    file: string,
    args: string[],
    opts: unknown,
  ) =>
    new Promise((resolve, reject) => {
      mockExecFile(file, args, opts, (err: unknown, res: { stdout: string; stderr: string }) => {
        if (err) {
          Object.assign(err as object, res);
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  return { mockExecFile, mockNotifyAgent: vi.fn() };
});

vi.mock('node:child_process', () => ({ execFile: mockExecFile }));
vi.mock('../approvals/index.js', () => ({ notifyAgent: mockNotifyAgent }));

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';
import { recorderStart, recorderStop } from './guard.js';
import { createRecorderSession, getRunningRecorderSession, markRecorderSessionStopped } from './db.js';
import {
  applyRecorderStart,
  applyRecorderStop,
  reconciledRunningSession,
  stopAndIngest,
  RECORDER_MAX_DURATION_MS,
} from './apply.js';

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
  mockExecFile.mockImplementation((_file, args, _opts, cb) => {
    if (args[0] === 'status') {
      cb(null, { stdout: STATUS_ALL_RUNNING, stderr: '' });
      return;
    }
    cb(null, { stdout: '[call] keyterms: <none>\nUI: http://localhost:8140\n', stderr: '' });
  });
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
  it('invokes call.sh start with a fixed binary and them/context/topic as argv values, never a shell string', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'HoursReportWebApp' }, session);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockExecFile.mock.calls[0]!;
    expect(bin).toMatch(/call\.sh$/);
    expect(args).toEqual(['start', '--topic', 'HoursReportWebApp', '--lang', 'he', '--them', 'דניס']);
    // /opt/homebrew/bin isn't on NanoClaw's launchd job's PATH — negotiator's
    // call.sh backgrounds a bare `node run.js`, which in turn bare-spawns
    // ffmpeg — see apply.ts's SPAWN_ENV.
    expect((opts as { env?: Record<string, string> }).env?.PATH).toContain('/opt/homebrew/bin');
  });

  it('falls back to a derived topic when context is empty, rather than failing', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: '' }, session);

    const [, args] = mockExecFile.mock.calls[0]!;
    expect(args[args.indexOf('--topic') + 1]).toBe('Call with דניס');
  });

  it('resolves a known project alias to its real directory and passes --project', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x', project: 'פאפי' }, session);

    const [, args] = mockExecFile.mock.calls[0]!;
    expect(args).toContain('--project');
    expect(args[args.indexOf('--project') + 1]).toBe('pa-ai');
  });

  it('an unrecognized project alias warns and still starts, without --project', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x', project: 'שטויות' }, session);

    const [, args] = mockExecFile.mock.calls[0]!;
    expect(args).not.toContain('--project');
    expect(getRunningRecorderSession()).toBeDefined();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('Unknown project alias "שטויות"'));
  });

  it('relays the resolved project and keyterms to Telegram before confirming live', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(null, { stdout: '[call] keyterms: negotiator,BlackHole\nUI: http://localhost:8140\n', stderr: '' }),
    );
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x', project: 'פאפי' }, session);

    expect(mockNotifyAgent).toHaveBeenCalledWith(
      session,
      expect.stringMatching(/Project: "פאפי" → pa-ai.*Keyterms: negotiator,BlackHole.*Recording started/s),
    );
  });

  it('records a running recorder_sessions row and notifies success', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'HoursReportWebApp' }, session);

    const running = getRunningRecorderSession();
    expect(running?.them).toBe('דניס');
    expect(running?.context).toBe('HoursReportWebApp');
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('started'));
  });

  it('refuses a second start without calling execFile with `start` again, verifying against call.sh status first', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockExecFile.mockClear();
    mockNotifyAgent.mockClear();

    await applyRecorderStart({ them: 'מישהו אחר', context: 'y' }, session);
    expect(mockExecFile).toHaveBeenCalledTimes(1); // the reconciliation status check only
    expect(mockExecFile.mock.calls[0]![1]).toEqual(['status']);
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('already running'));
  });

  it("surfaces call.sh's own stderr verbatim on failure — not a generic message — and creates no row", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(new Error('Command failed with exit code 1'), {
        stdout: '',
        stderr: '[check] FAILED: system audio is not reaching BlackHole.\nThe other party will NOT be recorded.',
      }),
    );
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);

    expect(getRunningRecorderSession()).toBeUndefined();
    expect(mockNotifyAgent).toHaveBeenCalledWith(
      session,
      expect.stringContaining('system audio is not reaching BlackHole'),
    );
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

    expect(mockExecFile).toHaveBeenCalledTimes(3); // status check, call.sh end, then the ingest
    const [statusBin, statusArgs] = mockExecFile.mock.calls[0]!;
    expect(statusBin).toMatch(/call\.sh$/);
    expect(statusArgs).toEqual(['status']);
    const [stopBin, stopArgs, stopOpts] = mockExecFile.mock.calls[1]!;
    expect(stopBin).toMatch(/call\.sh$/);
    expect(stopArgs).toEqual(['end', '--no-debrief']);
    expect((stopOpts as { env?: Record<string, string> }).env?.PATH).toContain('/opt/homebrew/bin');
    const [ingestBin, ingestArgs] = mockExecFile.mock.calls[2]!;
    expect(ingestArgs).toContain('--dir');
    expect(ingestArgs.some((a: string) => a.includes('ingest-recorder'))).toBe(true);
    void ingestBin;

    const running = getRunningRecorderSession();
    expect(running).toBeUndefined();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('stopped'));
  });

  it('a call.sh end failure (no usable transcript) marks the row stopped, never runs ingest, and never says "ask about it"', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockExecFile.mockClear();
    mockNotifyAgent.mockClear();
    mockExecFile.mockImplementation((_file, args, _opts, cb) => {
      if (args[0] === 'status') {
        cb(null, { stdout: STATUS_ALL_RUNNING, stderr: '' });
        return;
      }
      cb(new Error('exit 1'), {
        stdout: '',
        stderr:
          '[call] RECORDING FAILED — session produced no usable transcript.\nFATAL: audio was captured but zero utterances were transcribed.',
      });
    });

    await applyRecorderStop({}, session);

    expect(mockExecFile).toHaveBeenCalledTimes(2); // status check, then call.sh end — ingest never runs
    expect(getRunningRecorderSession()).toBeUndefined(); // still marked stopped — processes ARE dead
    expect(mockNotifyAgent).toHaveBeenCalledWith(
      session,
      expect.stringContaining('FATAL: audio was captured but zero utterances were transcribed'),
    );
    expect(mockNotifyAgent).not.toHaveBeenCalledWith(
      session,
      expect.stringContaining("it's done and ready to ask about"),
    );
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
    mockExecFile.mockImplementation((_file, args, _opts, cb) => {
      if (args[0] === 'status') return cb(null, { stdout: STATUS_ALL_RUNNING, stderr: '' });
      if (args[0] === 'end') return cb(null, { stdout: 'stopped\n', stderr: '' });
      return cb(new Error('ingest crashed'), { stdout: '', stderr: '' }); // second-brain's ingest binary, not call.sh
    });

    await applyRecorderStop({}, session);

    expect(getRunningRecorderSession()).toBeUndefined(); // stop side still recorded
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('ingest into uriel.db FAILED'));
  });
});

describe('reconciledRunningSession', () => {
  it('returns undefined immediately when nothing is active, without calling call.sh status', async () => {
    const result = await reconciledRunningSession();
    expect(result).toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns the row unchanged when call.sh status confirms something is still running', async () => {
    createRecorderSession({
      id: 'rec-1',
      agent_group_id: 'ag-uriel',
      session_id: 'sess-1',
      them: 'דניס',
      context: 'x',
      started_at: new Date().toISOString(),
    });

    const result = await reconciledRunningSession();
    expect(result?.id).toBe('rec-1');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0]![1]).toEqual(['status']);
  });

  it('reconciles a stale row (call.sh status reports nothing running): marks it stopped, returns undefined', async () => {
    createRecorderSession({
      id: 'rec-1',
      agent_group_id: 'ag-uriel',
      session_id: 'sess-1',
      them: 'דניס',
      context: 'x',
      started_at: new Date().toISOString(),
    });
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => cb(null, { stdout: STATUS_ALL_STOPPED, stderr: '' }));

    const result = await reconciledRunningSession();
    expect(result).toBeUndefined();
    expect(getRunningRecorderSession()).toBeUndefined();

    const row = getDb().prepare('SELECT stop_reason, stopped_at FROM recorder_sessions WHERE id = ?').get('rec-1') as {
      stop_reason: string | null;
      stopped_at: string | null;
    };
    expect(row.stop_reason).toBe('reconciled');
    expect(row.stopped_at).not.toBeNull();
  });

  it('treats a call.sh status failure as still-running — never reconciles on an error', async () => {
    createRecorderSession({
      id: 'rec-1',
      agent_group_id: 'ag-uriel',
      session_id: 'sess-1',
      them: 'דניס',
      context: 'x',
      started_at: new Date().toISOString(),
    });
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(new Error('status crashed'), { stdout: '', stderr: '' }),
    );

    const result = await reconciledRunningSession();
    expect(result?.id).toBe('rec-1');
    expect(getRunningRecorderSession()?.id).toBe('rec-1'); // untouched
  });
});

describe('RECORDER_MAX_DURATION_MS', () => {
  it('is 3 hours', () => {
    expect(RECORDER_MAX_DURATION_MS).toBe(3 * 60 * 60 * 1000);
  });
});
