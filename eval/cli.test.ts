/**
 * Covers `cli.ts`'s own dispatch/aggregation logic — argument parsing,
 * per-scenario status/judging branching, cleanup handling, and
 * report/exit-code aggregation. `runner.ts`, `judge/deterministic.ts`, and
 * `judge/llm.ts` are mocked (no real container spawn, no real Claude call in
 * this file — that's `runner.live.test.ts`'s job, unchanged). Everything
 * else (`loader.ts`, `setup.ts`, `lock.ts`, `reporter.ts`, `session.ts`) runs
 * for real, against a real temp DB/filesystem, matching every prior eval/
 * test file's real-DB-not-mocked convention.
 *
 * The registered "guest-resolution" set now has two scenarios (Story 2.3):
 * `guest-resolution-known-name` (deterministic) and
 * `guest-resolution-ambiguous-name` (llmJudge) — so every `runCli(['run',
 * 'guest-resolution'])` call in the `describe('runCli', ...)` block below
 * drives both. `queueTurns` queues the first scenario's explicit main +
 * cleanup turns, then falls back to a generic completed turn for the second
 * scenario's own main + cleanup calls (its cleanup always runs too); a
 * default `judgeLlm` mock resolution keeps that second scenario passing so
 * every pre-existing assertion about the first scenario's aggregate
 * behavior (exit code, cleanup handling) still holds unchanged.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-eval-cli-test';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-eval-cli-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-eval-cli-test/groups',
}));

// Same isolation reasoning as setup.test.ts: config.js's mocked body still
// runs its own env.js import for real, so every env-derived constant reads
// as unset here unless explicitly mocked too.
vi.mock('../src/env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./runner.js', () => ({
  runScenarioTurn: vi.fn(),
}));

vi.mock('../src/container-runner.js', () => ({
  killAllActiveContainers: vi.fn(),
  // Matches container-runner.js's own real literal — cli.ts imports this
  // constant to pass as killAllActiveContainers's required callerToken, so
  // the mock must export it too or the real code sees `undefined` in its
  // place.
  EVAL_CLI_ONESHOT_TOKEN: 'eval-cli-oneshot',
}));

vi.mock('./judge/deterministic.js', () => ({
  judgeDeterministic: vi.fn(),
}));

vi.mock('./judge/llm.js', () => ({
  judgeLlm: vi.fn(),
}));

import { killAllActiveContainers } from '../src/container-runner.js';
import { closeDb } from '../src/db/index.js';
import type { OutboundMessage } from '../src/db/session-db.js';
import { readEnvFile } from '../src/env.js';
import { dispatchEvalCli, runCli, runOneScenario } from './cli.js';
import { judgeDeterministic } from './judge/deterministic.js';
import { judgeLlm } from './judge/llm.js';
import type { Scenario } from './loader.js';
import { EVAL_LOCK_PATH } from './lock.js';
import { REPORTS_DIR } from './reporter.js';
import { runScenarioTurn } from './runner.js';
import { EVAL_THREAD_PREFIX } from './session.js';
import { ensureEvalJudgeGroup, ensureEvalScenarioGroup } from './setup.js';

const mockedReadEnvFile = vi.mocked(readEnvFile);
const mockedRunScenarioTurn = vi.mocked(runScenarioTurn);
const mockedJudgeDeterministic = vi.mocked(judgeDeterministic);
const mockedJudgeLlm = vi.mocked(judgeLlm);
const mockedKillAllActiveContainers = vi.mocked(killAllActiveContainers);

const PEOPLE_MD_PATH = `${TEST_ROOT}/groups/household/memory/household/people.md`;
const writtenReportDirs: string[] = [];

function outboundMsg(text: string): OutboundMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    kind: 'chat',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ text }),
    in_reply_to: 'eval-msg-1',
  };
}

const COMPLETED_CLEANUP = {
  status: 'completed' as const,
  transcript: [outboundMsg('נמחק בהצלחה')],
  sessionId: 's-cleanup',
};

const PASSING_LLM_VERDICT = { verdict: 'pass' as const, reasoning: 'agent asked for the email, never guessed' };

/**
 * Queues exactly two `runScenarioTurn` resolutions for
 * `guest-resolution-known-name` (main, then cleanup), then a persistent
 * fallback of `COMPLETED_CLEANUP`-shaped completed turns for every further
 * call — covers `guest-resolution-ambiguous-name`'s own main + cleanup
 * turns, which every real `runCli(['run', 'guest-resolution'])` test below
 * also drives. `judgeLlm` itself is mocked separately (`PASSING_LLM_VERDICT`
 * by default in `beforeEach`) and never inspects this fallback transcript's
 * content.
 */
function queueTurns(
  main: Awaited<ReturnType<typeof runScenarioTurn>>,
  cleanup: Awaited<ReturnType<typeof runScenarioTurn>>,
): void {
  mockedRunScenarioTurn.mockReset();
  mockedRunScenarioTurn.mockResolvedValueOnce(main).mockResolvedValueOnce(cleanup);
  mockedRunScenarioTurn.mockResolvedValue(COMPLETED_CLEANUP);
}

beforeEach(() => {
  // No initTestDb()/runMigrations() call here, deliberately: runCli's own
  // bootstrapDb() (Story 1.7's whole point — cli.ts reuses setup.ts's
  // exported DB-init path, not a second implementation) creates and
  // migrates a fresh file DB under the mocked DATA_DIR on every call.
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(`${TEST_ROOT}/groups/household/memory/household`, { recursive: true });
  fs.writeFileSync(PEOPLE_MD_PATH, '# People\n\n- Devorah: adardevora@gmail.com\n');
  process.env.EVAL_TEST_CALENDAR_ID = 'eval-test@group.calendar.google.com';
  mockedReadEnvFile.mockReturnValue({});
  mockedRunScenarioTurn.mockReset();
  mockedJudgeDeterministic.mockReset();
  mockedJudgeLlm.mockReset();
  mockedJudgeLlm.mockResolvedValue(PASSING_LLM_VERDICT);
  mockedKillAllActiveContainers.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  delete process.env.EVAL_TEST_CALENDAR_ID;
  process.exitCode = undefined;
  for (const dir of writtenReportDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runCli', () => {
  it('drives loader → runner → judge/deterministic|judge/llm → reporter end to end, running both guest-resolution scenarios in one invocation and writing one report', async () => {
    queueTurns(
      { status: 'completed', transcript: [outboundMsg('נוסף כאורח: adardevora@gmail.com')], sessionId: 's1' },
      COMPLETED_CLEANUP,
    );
    mockedJudgeDeterministic.mockReturnValue({ passed: true, evidence: 'adardevora@gmail.com' });

    const report = await runCli(['run', 'guest-resolution']);
    writtenReportDirs.push(path.join(REPORTS_DIR, report.runId));

    expect(report.scenarioSetName).toBe('guest-resolution');
    expect(report.entries).toHaveLength(2);
    expect(report.entries[0]).toEqual({
      id: 'guest-resolution-known-name',
      status: 'completed',
      judging: 'deterministic',
      passed: true,
      evidence: 'adardevora@gmail.com',
    });
    expect(report.entries[1]).toEqual({
      id: 'guest-resolution-ambiguous-name',
      status: 'completed',
      judging: 'llmJudge',
      passed: true,
      evidence: PASSING_LLM_VERDICT.reasoning,
    });
    expect(process.exitCode).toBe(0);
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(4); // 2 scenarios × (main + cleanup)
    expect(mockedJudgeDeterministic).toHaveBeenCalledTimes(1);
    expect(mockedJudgeLlm).toHaveBeenCalledTimes(1);

    // judgeLlm's own call shape, per the spec's "Always" bullet: a distinct
    // judge thread id, the completed scenario turn's transcript, and the
    // scenario's own rubric — never a hardcoded judge agent group. Asserted
    // against the *real* judge/scenario group ids (both idempotent, safe to
    // re-resolve after the run) rather than a shared `/^ag-/` id-format regex
    // (review finding, converged across 2 layers) — the regex can't tell the
    // judge group's id apart from the scenario group's own, so a real
    // group-mixup bug in runCli's wiring — the exact isolation AD-3 exists to
    // prevent — would have shipped with this test still green.
    const [judgeAgentGroupId, judgeThreadId, transcriptArg, rubricArg] = mockedJudgeLlm.mock.calls[0];
    const scenarioGroup = ensureEvalScenarioGroup();
    const judgeGroup = ensureEvalJudgeGroup();
    expect(judgeAgentGroupId).toBe(judgeGroup.id);
    expect(judgeAgentGroupId).not.toBe(scenarioGroup.id);
    expect(judgeThreadId).toBe(`${EVAL_THREAD_PREFIX}:judge:guest-resolution-ambiguous-name`);
    expect(Array.isArray(transcriptArg)).toBe(true);
    expect(typeof rubricArg).toBe('string');

    const persisted = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, report.runId, 'report.json'), 'utf-8'));
    expect(persisted).toEqual(report);
  });

  it('reports passed: false and a non-zero exit code when the deterministic check fails, cleanup still runs', async () => {
    queueTurns(
      { status: 'completed', transcript: [outboundMsg('לא נמצאה כתובת מייל')], sessionId: 's1' },
      COMPLETED_CLEANUP,
    );
    mockedJudgeDeterministic.mockReturnValue({ passed: false, evidence: 'no email found in reply' });

    const report = await runCli(['run', 'guest-resolution']);
    writtenReportDirs.push(path.join(REPORTS_DIR, report.runId));

    expect(report.entries[0].passed).toBe(false);
    expect(report.entries[0].evidence).toBe('no email found in reply');
    expect(report.entries[0].cleanupError).toBeUndefined();
    expect(process.exitCode).toBe(1); // aggregate fails even though the second (llmJudge) scenario passes
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(4); // cleanup ran despite the failing verdict
  });

  it('reports a timed-out turn as passed: false naming the timeout, never calls judgeDeterministic, cleanup still runs', async () => {
    queueTurns({ status: 'timeout', transcript: [], sessionId: 's1' }, COMPLETED_CLEANUP);

    const report = await runCli(['run', 'guest-resolution']);
    writtenReportDirs.push(path.join(REPORTS_DIR, report.runId));

    expect(report.entries[0].status).toBe('timeout');
    expect(report.entries[0].passed).toBe(false);
    expect(report.entries[0].evidence).toMatch(/timeout/);
    expect(report.entries[0].cleanupError).toBeUndefined();
    expect(mockedJudgeDeterministic).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('records a cleanupError (never throws out of cli.ts) when the cleanup follow-up does not confirm, keeping the scenario verdict intact', async () => {
    queueTurns(
      { status: 'completed', transcript: [outboundMsg('נוסף כאורח: adardevora@gmail.com')], sessionId: 's1' },
      { status: 'completed', transcript: [outboundMsg('לא הצלחתי למחוק')], sessionId: 's1' }, // no confirmation word
    );
    mockedJudgeDeterministic.mockReturnValue({ passed: true, evidence: 'adardevora@gmail.com' });

    const report = await runCli(['run', 'guest-resolution']);
    writtenReportDirs.push(path.join(REPORTS_DIR, report.runId));

    expect(report.entries[0].passed).toBe(true); // cleanup outcome doesn't flip the scenario verdict
    expect(report.entries[0].cleanupError).toMatch(/did not confirm/);
    // Exit code 2: every verdict passed, but at least one scenario's cleanup
    // didn't confirm success — distinct from 1 (an actual verdict failure)
    // and 0 (fully clean), so a caller scripting on exit code alone can tell
    // "clean" apart from "passed, but check cleanup" (deferred-work.md finding).
    expect(process.exitCode).toBe(2);
  });

  it('records a cleanupError when the cleanup turn itself fails/times out', async () => {
    queueTurns(
      { status: 'completed', transcript: [outboundMsg('נוסף כאורח: adardevora@gmail.com')], sessionId: 's1' },
      { status: 'failed', transcript: [], sessionId: 's1' },
    );
    mockedJudgeDeterministic.mockReturnValue({ passed: true, evidence: 'adardevora@gmail.com' });

    const report = await runCli(['run', 'guest-resolution']);
    writtenReportDirs.push(path.join(REPORTS_DIR, report.runId));

    expect(report.entries[0].cleanupError).toMatch(/turn status: failed/);
  });

  it('reports status "judge-error" and passed: false when the deterministic check() throws, cleanup still runs, run still produces a report (regression: all 3 review layers converged on this)', async () => {
    queueTurns(
      { status: 'completed', transcript: [outboundMsg('נוסף כאורח: adardevora@gmail.com')], sessionId: 's1' },
      COMPLETED_CLEANUP,
    );
    const boom = new Error('scenario-authoring bug: check() dereferenced undefined');
    mockedJudgeDeterministic.mockImplementation(() => {
      throw boom;
    });

    const report = await runCli(['run', 'guest-resolution']);
    writtenReportDirs.push(path.join(REPORTS_DIR, report.runId));

    expect(report.entries[0].status).toBe('judge-error');
    expect(report.entries[0].passed).toBe(false);
    expect(report.entries[0].evidence).toMatch(/scenario-authoring bug/);
    expect(report.entries[0].cleanupError).toBeUndefined(); // cleanup ran and confirmed, unaffected by the judging throw
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(4); // both scenarios' cleanups still ran despite the throw
    expect(process.exitCode).toBe(1);

    const persisted = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, report.runId, 'report.json'), 'utf-8'));
    expect(persisted).toEqual(report); // the report was actually written, not lost
  });

  it('reports status "judge-error" and passed: false when judgeLlm throws for the ambiguous-name scenario, its own cleanup still runs, the known-name scenario entry is unaffected', async () => {
    queueTurns(
      { status: 'completed', transcript: [outboundMsg('נוסף כאורח: adardevora@gmail.com')], sessionId: 's1' },
      COMPLETED_CLEANUP,
    );
    mockedJudgeDeterministic.mockReturnValue({ passed: true, evidence: 'adardevora@gmail.com' });
    const boom = new Error("judgeLlm: could not parse the judge's reply");
    mockedJudgeLlm.mockRejectedValueOnce(boom);

    const report = await runCli(['run', 'guest-resolution']);
    writtenReportDirs.push(path.join(REPORTS_DIR, report.runId));

    expect(report.entries).toHaveLength(2);
    expect(report.entries[0].passed).toBe(true); // unaffected by the second scenario's judging throw
    expect(report.entries[1]).toEqual({
      id: 'guest-resolution-ambiguous-name',
      status: 'judge-error',
      judging: 'llmJudge',
      passed: false,
      evidence: expect.stringContaining('could not parse'),
    });
    expect(report.entries[1].cleanupError).toBeUndefined(); // cleanup still ran and confirmed despite the throw
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(4); // both scenarios' cleanups still ran
    expect(process.exitCode).toBe(1);

    const persisted = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, report.runId, 'report.json'), 'utf-8'));
    expect(persisted).toEqual(report);
  });

  it('throws for an unregistered scenario-set name before withEvalLock ever acquires — no lock file, no runner call', async () => {
    await expect(runCli(['run', 'nonexistent'])).rejects.toThrow(/unknown scenario set|unregistered/i);

    expect(fs.existsSync(EVAL_LOCK_PATH)).toBe(false);
    expect(mockedRunScenarioTurn).not.toHaveBeenCalled();
  });

  it('throws a usage error for a missing scenario-set-name argument, touching nothing', async () => {
    await expect(runCli(['run'])).rejects.toThrow(/usage/i);
    expect(mockedRunScenarioTurn).not.toHaveBeenCalled();
  });

  it('throws a usage error for an unsupported subcommand, touching nothing', async () => {
    await expect(runCli(['list', 'guest-resolution'])).rejects.toThrow(/usage/i);
    expect(mockedRunScenarioTurn).not.toHaveBeenCalled();
  });

  it('throws a usage error for trailing extra arguments, touching nothing', async () => {
    await expect(runCli(['run', 'guest-resolution', 'extra-arg'])).rejects.toThrow(/usage/i);
    expect(mockedRunScenarioTurn).not.toHaveBeenCalled();
  });

  it(
    'tears down every eval container this invocation spawned exactly once after a successful run (regression — ' +
      '2026-08-24: eval containers have no idle-timeout of their own, so a leftover from one invocation could ' +
      'still be running when the next one spawns its own, against the identical session)',
    async () => {
      queueTurns(
        { status: 'completed', transcript: [outboundMsg('נוסף כאורח: adardevora@gmail.com')], sessionId: 's1' },
        COMPLETED_CLEANUP,
      );
      mockedJudgeDeterministic.mockReturnValue({ passed: true, evidence: 'adardevora@gmail.com' });

      const report = await runCli(['run', 'guest-resolution']);
      writtenReportDirs.push(path.join(REPORTS_DIR, report.runId));

      expect(mockedKillAllActiveContainers).toHaveBeenCalledTimes(1);
      expect(mockedKillAllActiveContainers).toHaveBeenCalledWith(expect.any(String), 'eval-cli-oneshot');
    },
  );

  it('still tears down every spawned container, still propagates the error, and writes a partial report (aborted: true) before rethrowing rather than leaving zero diagnostic trail, when a scenario turn itself throws (a genuine AD-4 structural failure, not a per-scenario outcome)', async () => {
    const boom = new Error('runScenarioTurn: wakeContainer failed to spawn a container');
    mockedRunScenarioTurn.mockReset();
    mockedRunScenarioTurn.mockRejectedValueOnce(boom);
    const before = fs.existsSync(REPORTS_DIR) ? fs.readdirSync(REPORTS_DIR) : [];

    await expect(runCli(['run', 'guest-resolution'])).rejects.toBe(boom);

    expect(mockedKillAllActiveContainers).toHaveBeenCalledTimes(1);

    const after = fs.existsSync(REPORTS_DIR) ? fs.readdirSync(REPORTS_DIR) : [];
    const newDirs = after.filter((d) => !before.includes(d));
    expect(newDirs).toHaveLength(1);
    writtenReportDirs.push(path.join(REPORTS_DIR, newDirs[0]));

    const persisted = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, newDirs[0], 'report.json'), 'utf-8'));
    expect(persisted.scenarioSetName).toBe('guest-resolution');
    expect(persisted.aborted).toBe(true);
    expect(persisted.abortError).toBe(boom.message);
    expect(persisted.entries).toEqual([]); // the throw happened on the very first scenario, before any entry was pushed
  });

  it('reuses the exact same threadId for the cleanup turn as the main turn — a regression here would silently run cleanup in a fresh, context-free session', async () => {
    queueTurns(
      { status: 'completed', transcript: [outboundMsg('נוסף כאורח: adardevora@gmail.com')], sessionId: 's1' },
      COMPLETED_CLEANUP,
    );
    mockedJudgeDeterministic.mockReturnValue({ passed: true, evidence: 'adardevora@gmail.com' });

    const report = await runCli(['run', 'guest-resolution']);
    writtenReportDirs.push(path.join(REPORTS_DIR, report.runId));

    const [, mainThreadId] = mockedRunScenarioTurn.mock.calls[0];
    const [, cleanupThreadId] = mockedRunScenarioTurn.mock.calls[1];
    expect(cleanupThreadId).toBe(mainThreadId);
    expect(mainThreadId).toBe(`${EVAL_THREAD_PREFIX}:guest-resolution-known-name`);
  });
});

describe('runOneScenario (llmJudge branch)', () => {
  // Hand-built rather than routed through the real registered
  // "guest-resolution" set — gives finer-grained control over
  // pass/fail/throw cases without needing separate scenario-set fixtures,
  // and covers the I/O matrix directly at the `runOneScenario` level.
  const JUDGE_AGENT_GROUP_ID = 'ag-llm-judge-test';
  const llmJudgeScenario: Scenario = {
    id: 'some-llm-judge-scenario',
    agentGroupId: 'ag-scenario-under-test',
    message: 'some message',
    judging: { type: 'llmJudge', rubric: 'some rubric' },
  };

  it('reports status "completed", passed: true, evidence = reasoning when judgeLlm resolves a pass verdict', async () => {
    mockedRunScenarioTurn.mockResolvedValueOnce({
      status: 'completed',
      transcript: [outboundMsg('some reply')],
      sessionId: 's1',
    });
    mockedJudgeLlm.mockResolvedValueOnce({ verdict: 'pass', reasoning: 'no email was guessed' });

    const entry = await runOneScenario(llmJudgeScenario, JUDGE_AGENT_GROUP_ID);

    expect(entry).toEqual({
      id: 'some-llm-judge-scenario',
      status: 'completed',
      judging: 'llmJudge',
      passed: true,
      evidence: 'no email was guessed',
    });
    expect(mockedJudgeDeterministic).not.toHaveBeenCalled();
    expect(mockedJudgeLlm).toHaveBeenCalledWith(
      JUDGE_AGENT_GROUP_ID,
      `${EVAL_THREAD_PREFIX}:judge:some-llm-judge-scenario`,
      [expect.objectContaining({ id: expect.any(String) })],
      'some rubric',
    );
  });

  it('reports status "completed", passed: false, evidence = reasoning when judgeLlm resolves a fail verdict', async () => {
    mockedRunScenarioTurn.mockResolvedValueOnce({
      status: 'completed',
      transcript: [outboundMsg('some reply with an email: guest@example.com')],
      sessionId: 's1',
    });
    mockedJudgeLlm.mockResolvedValueOnce({ verdict: 'fail', reasoning: 'the agent invented an email address' });

    const entry = await runOneScenario(llmJudgeScenario, JUDGE_AGENT_GROUP_ID);

    expect(entry).toEqual({
      id: 'some-llm-judge-scenario',
      status: 'completed',
      judging: 'llmJudge',
      passed: false,
      evidence: 'the agent invented an email address',
    });
  });

  it('reports status "judge-error", passed: false, evidence naming the thrown message when judgeLlm throws — never propagates out of runOneScenario', async () => {
    mockedRunScenarioTurn.mockResolvedValueOnce({
      status: 'completed',
      transcript: [outboundMsg('some reply')],
      sessionId: 's1',
    });
    const boom = new Error('judgeLlm: judge turn did not complete — expected status "completed", got "timeout"');
    mockedJudgeLlm.mockRejectedValueOnce(boom);

    const entry = await runOneScenario(llmJudgeScenario, JUDGE_AGENT_GROUP_ID);

    expect(entry.status).toBe('judge-error');
    expect(entry.judging).toBe('llmJudge');
    expect(entry.passed).toBe(false);
    expect(entry.evidence).toContain('judge turn did not complete');
  });

  it('still runs cleanup after a judgeLlm throw, unaffected by the judging outcome — a wrongly-created event is still deleted', async () => {
    const llmJudgeWithCleanup: Scenario = {
      ...llmJudgeScenario,
      cleanup: { message: 'delete it', confirm: () => true },
    };
    mockedRunScenarioTurn
      .mockResolvedValueOnce({ status: 'completed', transcript: [outboundMsg('some reply')], sessionId: 's1' })
      .mockResolvedValueOnce(COMPLETED_CLEANUP);
    mockedJudgeLlm.mockRejectedValueOnce(new Error('judgeLlm: could not parse the judge reply'));

    const entry = await runOneScenario(llmJudgeWithCleanup, JUDGE_AGENT_GROUP_ID);

    expect(entry.status).toBe('judge-error');
    expect(entry.cleanupError).toBeUndefined(); // cleanup ran and confirmed
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(2); // main turn + cleanup follow-up
  });

  it('still runs cleanup for an llmJudge scenario when judging passes', async () => {
    const llmJudgeWithCleanup: Scenario = {
      ...llmJudgeScenario,
      cleanup: { message: 'delete it', confirm: () => true },
    };
    mockedRunScenarioTurn
      .mockResolvedValueOnce({ status: 'completed', transcript: [outboundMsg('some reply')], sessionId: 's1' })
      .mockResolvedValueOnce(COMPLETED_CLEANUP);
    mockedJudgeLlm.mockResolvedValueOnce({ verdict: 'pass', reasoning: 'fine' });

    const entry = await runOneScenario(llmJudgeWithCleanup, JUDGE_AGENT_GROUP_ID);

    expect(entry.status).toBe('completed');
    expect(entry.passed).toBe(true);
    expect(entry.cleanupError).toBeUndefined();
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(2);
  });

  it('reports the real turn status (not judgeLlm-derived) when an llmJudge scenario turn never completes, never calls judgeLlm', async () => {
    mockedRunScenarioTurn.mockResolvedValueOnce({ status: 'timeout', transcript: [], sessionId: 's1' });

    const entry = await runOneScenario(llmJudgeScenario, JUDGE_AGENT_GROUP_ID);

    expect(entry.status).toBe('timeout'); // turn-completion primacy over the llmJudge classification
    expect(entry.passed).toBe(false);
    expect(mockedJudgeLlm).not.toHaveBeenCalled();
    expect(mockedJudgeDeterministic).not.toHaveBeenCalled();
  });
});

describe('dispatchEvalCli (Story 3.1)', () => {
  // "sweep" routes to the real `runSweep()` (`./sweep.js`, not mocked in this
  // file) — it drives `runScenarioTurn` (mocked above, same as every other
  // test in this file) under the real `withEvalLock`/`ensureEvalScenarioGroup`
  // path, exactly like a real `pnpm eval sweep` invocation would.
  it('routes "sweep" to runSweep(), returning its SweepResult', async () => {
    mockedRunScenarioTurn.mockReset();
    mockedRunScenarioTurn.mockResolvedValueOnce({
      status: 'completed',
      transcript: [outboundMsg('SWEEP: REMOVED 2')],
      sessionId: 's-sweep',
    });

    const result = await dispatchEvalCli(['sweep']);

    expect(result).toEqual({ removedCount: 2, agentReplyText: 'SWEEP: REMOVED 2' });
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(1);
    const [, threadId] = mockedRunScenarioTurn.mock.calls[0];
    expect(threadId).toBe(`${EVAL_THREAD_PREFIX}:sweep`);
  });

  it('routes "run" to the existing runCli(argv), unchanged', async () => {
    queueTurns(
      { status: 'completed', transcript: [outboundMsg('נוסף כאורח: adardevora@gmail.com')], sessionId: 's1' },
      COMPLETED_CLEANUP,
    );
    mockedJudgeDeterministic.mockReturnValue({ passed: true, evidence: 'adardevora@gmail.com' });

    const report = await dispatchEvalCli(['run', 'guest-resolution']);
    writtenReportDirs.push(path.join(REPORTS_DIR, (report as Awaited<ReturnType<typeof runCli>>).runId));

    expect(report).toMatchObject({ scenarioSetName: 'guest-resolution' });
    expect(process.exitCode).toBe(0);
  });

  it('rejects with one usage error naming both "run" and "sweep" for an unknown subcommand, touching nothing (no lock file either)', async () => {
    await expect(dispatchEvalCli(['bogus'])).rejects.toThrow(/run.*sweep|sweep.*run/is);
    expect(mockedRunScenarioTurn).not.toHaveBeenCalled();
    expect(fs.existsSync(EVAL_LOCK_PATH)).toBe(false);
  });

  it('rejects with one usage error naming both "run" and "sweep" when no subcommand is given, touching nothing (no lock file either)', async () => {
    await expect(dispatchEvalCli([])).rejects.toThrow(/run.*sweep|sweep.*run/is);
    expect(mockedRunScenarioTurn).not.toHaveBeenCalled();
    expect(fs.existsSync(EVAL_LOCK_PATH)).toBe(false);
  });

  it('rejects for "sweep" with a trailing extra argument, matching run\'s own strictness about extra args', async () => {
    await expect(dispatchEvalCli(['sweep', 'extra-arg'])).rejects.toThrow(/usage/i);
    expect(mockedRunScenarioTurn).not.toHaveBeenCalled();
  });

  it("a bad subcommand's throw is a genuine promise rejection, not a synchronous throw that would escape the entry point's own .catch() (regression: all 3 review layers converged on this)", async () => {
    // Mirrors the real CLI entry point's own exact call shape
    // (`dispatchEvalCli(argv).catch(handler)`) — a bare `expect(() =>
    // ...).toThrow()` on the call itself would pass whether the throw is
    // synchronous or a rejection, so it can't verify this specific fix.
    // Calling `.catch` directly on the returned value proves `dispatchEvalCli`
    // never throws synchronously — a real synchronous throw here would blow
    // up this very line, before `.catch` could even be attached to it.
    let caught: unknown;
    await dispatchEvalCli(['bogus']).catch((err) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/run.*sweep|sweep.*run/is);
  });

  it('a "sweep" run never calls writeReport or creates anything under eval/reports/ — a sweep is not a scenario run', async () => {
    mockedRunScenarioTurn.mockReset();
    mockedRunScenarioTurn.mockResolvedValueOnce({
      status: 'completed',
      transcript: [outboundMsg('SWEEP: CLEAN')],
      sessionId: 's-sweep-2',
    });
    const before = fs.existsSync(REPORTS_DIR) ? fs.readdirSync(REPORTS_DIR) : [];

    await dispatchEvalCli(['sweep']);

    const after = fs.existsSync(REPORTS_DIR) ? fs.readdirSync(REPORTS_DIR) : [];
    expect(after).toEqual(before);
  });
});
