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

const { mockExecFile, mockNotifyAgent } = vi.hoisted(() => {
  const mockExecFile = vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
    ) => {
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
  mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
    cb(null, { stdout: '[call] keyterms: <none>\nUI: http://localhost:8140\n', stderr: '' }),
  );
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

  it('refuses a second start without calling execFile again, and notifies instead', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockExecFile.mockClear();
    mockNotifyAgent.mockClear();

    await applyRecorderStart({ them: 'מישהו אחר', context: 'y' }, session);
    expect(mockExecFile).not.toHaveBeenCalled();
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

    expect(mockExecFile).toHaveBeenCalledTimes(2); // call.sh end, then the ingest
    const [stopBin, stopArgs, stopOpts] = mockExecFile.mock.calls[0]!;
    expect(stopBin).toMatch(/call\.sh$/);
    expect(stopArgs).toEqual(['end', '--no-debrief']);
    expect((stopOpts as { env?: Record<string, string> }).env?.PATH).toContain('/opt/homebrew/bin');
    const [ingestBin, ingestArgs] = mockExecFile.mock.calls[1]!;
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
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(new Error('exit 1'), {
        stdout: '',
        stderr:
          '[call] RECORDING FAILED — session produced no usable transcript.\nFATAL: audio was captured but zero utterances were transcribed.',
      }),
    );

    await applyRecorderStop({}, session);

    expect(mockExecFile).toHaveBeenCalledTimes(1); // call.sh end only — ingest never runs
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
    let call = 0;
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      call++;
      if (call === 1) return cb(null, { stdout: 'stopped\n', stderr: '' }); // call.sh end
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
