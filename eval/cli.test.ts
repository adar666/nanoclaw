/**
 * Covers `cli.ts`'s own dispatch/aggregation logic — argument parsing,
 * per-scenario status/judging branching, cleanup handling, and
 * report/exit-code aggregation. `runner.ts` and `judge/deterministic.ts` are
 * mocked (no real container spawn, no real Claude call in this file — that's
 * `runner.live.test.ts`'s job, unchanged). Everything else (`loader.ts`,
 * `setup.ts`, `lock.ts`, `reporter.ts`, `session.ts`) runs for real, against
 * a real temp DB/filesystem, matching every prior eval/ test file's
 * real-DB-not-mocked convention.
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

vi.mock('./judge/deterministic.js', () => ({
  judgeDeterministic: vi.fn(),
}));

import { closeDb } from '../src/db/index.js';
import type { OutboundMessage } from '../src/db/session-db.js';
import { readEnvFile } from '../src/env.js';
import { runCli, runOneScenario } from './cli.js';
import { judgeDeterministic } from './judge/deterministic.js';
import type { Scenario } from './loader.js';
import { EVAL_LOCK_PATH } from './lock.js';
import { REPORTS_DIR } from './reporter.js';
import { runScenarioTurn } from './runner.js';

const mockedReadEnvFile = vi.mocked(readEnvFile);
const mockedRunScenarioTurn = vi.mocked(runScenarioTurn);
const mockedJudgeDeterministic = vi.mocked(judgeDeterministic);

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

/** Queues exactly two runScenarioTurn resolutions: the scenario's own turn, then its cleanup follow-up. */
function queueTurns(
  main: Awaited<ReturnType<typeof runScenarioTurn>>,
  cleanup: Awaited<ReturnType<typeof runScenarioTurn>>,
): void {
  mockedRunScenarioTurn.mockReset();
  mockedRunScenarioTurn.mockResolvedValueOnce(main).mockResolvedValueOnce(cleanup);
}

const COMPLETED_CLEANUP = {
  status: 'completed' as const,
  transcript: [outboundMsg('נמחק בהצלחה')],
  sessionId: 's-cleanup',
};

beforeEach(() => {
  // No initTestDb()/runMigrations() call here, deliberately: runCli's own
  // bootstrapDb() (this story's whole point — cli.ts reuses setup.ts's
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
  it('drives loader → runner → judge/deterministic → reporter end to end and writes a passing report', async () => {
    queueTurns(
      { status: 'completed', transcript: [outboundMsg('נוסף כאורח: adardevora@gmail.com')], sessionId: 's1' },
      COMPLETED_CLEANUP,
    );
    mockedJudgeDeterministic.mockReturnValue({ passed: true, evidence: 'adardevora@gmail.com' });

    const report = await runCli(['run', 'guest-resolution']);
    writtenReportDirs.push(path.join(REPORTS_DIR, report.runId));

    expect(report.scenarioSetName).toBe('guest-resolution');
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toEqual({
      id: 'guest-resolution-known-name',
      status: 'completed',
      judging: 'deterministic',
      passed: true,
      evidence: 'adardevora@gmail.com',
    });
    expect(process.exitCode).toBe(0);
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(2);
    expect(mockedJudgeDeterministic).toHaveBeenCalledTimes(1);

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
    expect(process.exitCode).toBe(1);
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(2); // cleanup ran despite the failing verdict
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
    expect(process.exitCode).toBe(0); // aggregate is based on `passed`, not cleanupError
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

  it('reports status "judge-error" and passed: false when check() throws, cleanup still runs, run still produces a report (regression: all 3 review layers converged on this)', async () => {
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
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(2); // cleanup still ran despite the throw
    expect(process.exitCode).toBe(1);

    const persisted = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, report.runId, 'report.json'), 'utf-8'));
    expect(persisted).toEqual(report); // the report was actually written, not lost
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
});

describe('runOneScenario (llmJudge stub branch)', () => {
  // The registered "guest-resolution" set has no llmJudge scenario to
  // exercise this through runCli end to end — a hand-built Scenario
  // exercises it directly instead.
  const llmJudgeScenario: Scenario = {
    id: 'some-llm-judge-scenario',
    agentGroupId: 'ag-llm-judge-test',
    message: 'some message',
    judging: { type: 'llmJudge', rubric: 'some rubric' },
  };

  it('reports status "unsupported", passed: false, and never calls judgeDeterministic when the turn completes', async () => {
    mockedRunScenarioTurn.mockResolvedValueOnce({
      status: 'completed',
      transcript: [outboundMsg('some reply')],
      sessionId: 's1',
    });

    const entry = await runOneScenario(llmJudgeScenario);

    expect(entry).toEqual({
      id: 'some-llm-judge-scenario',
      status: 'unsupported',
      judging: 'llmJudge',
      passed: false,
      evidence: expect.stringMatching(/epic 2/i),
    });
    expect(mockedJudgeDeterministic).not.toHaveBeenCalled();
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(1); // no cleanup defined on this scenario
  });

  it('reports the real turn status (not "unsupported") when an llmJudge scenario turn never completes', async () => {
    mockedRunScenarioTurn.mockResolvedValueOnce({ status: 'timeout', transcript: [], sessionId: 's1' });

    const entry = await runOneScenario(llmJudgeScenario);

    expect(entry.status).toBe('timeout'); // turn-completion primacy over the llmJudge-stub classification
    expect(entry.passed).toBe(false);
    expect(mockedJudgeDeterministic).not.toHaveBeenCalled();
  });

  it('still runs cleanup for an llmJudge scenario that defines one, even though judging is unsupported', async () => {
    const llmJudgeWithCleanup: Scenario = {
      ...llmJudgeScenario,
      cleanup: { message: 'delete it', confirm: () => true },
    };
    mockedRunScenarioTurn
      .mockResolvedValueOnce({ status: 'completed', transcript: [outboundMsg('some reply')], sessionId: 's1' })
      .mockResolvedValueOnce(COMPLETED_CLEANUP);

    const entry = await runOneScenario(llmJudgeWithCleanup);

    expect(entry.status).toBe('unsupported');
    expect(entry.cleanupError).toBeUndefined();
    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(2); // main turn + cleanup follow-up, despite the unsupported judging
  });
});
