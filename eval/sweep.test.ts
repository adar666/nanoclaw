/**
 * Fast, mocked-spawn coverage for `runSweep`'s prompt-building/status-check/
 * reply-parsing logic and its lock/provisioning wiring — mocks
 * `runScenarioTurn` entirely, matching every prior eval/ test file's
 * convention (see `judge/llm.test.ts`'s header for the same rationale; this
 * story's own module treats `runScenarioTurn` as an opaque primitive the
 * same way). `lock.ts`, `setup.ts` (`ensureEvalScenarioGroup`, `bootstrapDb`)
 * run for real against a real temp DB/filesystem, matching `cli.test.ts`'s
 * own real-DB-not-mocked convention.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-eval-sweep-test';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-eval-sweep-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-eval-sweep-test/groups',
}));

// Same isolation reasoning as setup.test.ts/cli.test.ts: config.js's mocked
// body still runs its own env.js import for real, so every env-derived
// constant reads as unset here unless explicitly mocked too.
vi.mock('../src/env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./runner.js', () => ({
  runScenarioTurn: vi.fn(),
}));

import { closeDb } from '../src/db/index.js';
import type { OutboundMessage } from '../src/db/session-db.js';
import { readEnvFile } from '../src/env.js';
import { EVAL_LOCK_PATH } from './lock.js';
import { runScenarioTurn } from './runner.js';
import { EVAL_THREAD_PREFIX } from './session.js';
import { ensureEvalScenarioGroup } from './setup.js';
import { runSweep } from './sweep.js';

const mockedReadEnvFile = vi.mocked(readEnvFile);
const mockedRunScenarioTurn = vi.mocked(runScenarioTurn);

const PEOPLE_MD_PATH = `${TEST_ROOT}/groups/household/memory/household/people.md`;

function outboundMsg(text: string): OutboundMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    kind: 'chat',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ text }),
    in_reply_to: 'eval-msg-sweep',
  };
}

function turnResult(
  status: 'completed' | 'failed' | 'cancelled' | 'timeout',
  transcript: OutboundMessage[],
  sessionId = 'sweep-session-1',
): Awaited<ReturnType<typeof runScenarioTurn>> {
  return { status, transcript, sessionId };
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(`${TEST_ROOT}/groups/household/memory/household`, { recursive: true });
  fs.writeFileSync(PEOPLE_MD_PATH, '# People\n\n- Devorah: adardevora@gmail.com\n');
  process.env.EVAL_TEST_CALENDAR_ID = 'eval-test@group.calendar.google.com';
  mockedReadEnvFile.mockReturnValue({});
  mockedRunScenarioTurn.mockReset();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  delete process.env.EVAL_TEST_CALENDAR_ID;
});

describe('runSweep', () => {
  it('reports { removedCount, agentReplyText } when the agent replies SWEEP: REMOVED <n>', async () => {
    mockedRunScenarioTurn.mockResolvedValue(turnResult('completed', [outboundMsg('SWEEP: REMOVED 3')]));

    const result = await runSweep();

    expect(result).toEqual({ removedCount: 3, agentReplyText: 'SWEEP: REMOVED 3' });
  });

  it('reports removedCount: 0 when the agent replies SWEEP: CLEAN (safe no-op)', async () => {
    mockedRunScenarioTurn.mockResolvedValue(turnResult('completed', [outboundMsg('SWEEP: CLEAN')]));

    const result = await runSweep();

    expect(result).toEqual({ removedCount: 0, agentReplyText: 'SWEEP: CLEAN' });
  });

  it('takes the LAST SWEEP: match, not the first, when the reply echoes the instruction before answering', async () => {
    mockedRunScenarioTurn.mockResolvedValue(
      turnResult('completed', [
        outboundMsg(
          'I will reply with "SWEEP: REMOVED <n>" or "SWEEP: CLEAN" as instructed.\n' +
            'Checking the calendar now.\n' +
            'SWEEP: REMOVED 2',
        ),
      ]),
    );

    const result = await runSweep();

    expect(result.removedCount).toBe(2);
  });

  it('takes the LAST match even when it is a different pattern than an earlier one (a self-correcting reply: REMOVED then CLEAN)', async () => {
    mockedRunScenarioTurn.mockResolvedValue(
      turnResult('completed', [
        outboundMsg(
          'SWEEP: REMOVED 3\n' + 'Wait, looking again those were already deleted in a prior run.\n' + 'SWEEP: CLEAN',
        ),
      ]),
    );

    const result = await runSweep();

    expect(result.removedCount).toBe(0); // the later, corrected claim wins — same "final answer wins" reasoning either direction
  });

  it('throws for an implausibly large removed count rather than silently reporting a precision-lossy number', async () => {
    mockedRunScenarioTurn.mockResolvedValue(turnResult('completed', [outboundMsg(`SWEEP: REMOVED ${'9'.repeat(30)}`)]));

    await expect(runSweep()).rejects.toThrow(/implausible removed count/);
  });

  it('joins across multiple messages_out rows before parsing', async () => {
    mockedRunScenarioTurn.mockResolvedValue(
      turnResult('completed', [outboundMsg('Deleting events now.'), outboundMsg('SWEEP: REMOVED 5')]),
    );

    const result = await runSweep();

    expect(result.removedCount).toBe(5);
    expect(result.agentReplyText).toBe('Deleting events now.\nSWEEP: REMOVED 5');
  });

  it('matches SWEEP:/REMOVED/CLEAN case-insensitively', async () => {
    mockedRunScenarioTurn.mockResolvedValue(turnResult('completed', [outboundMsg('sweep: removed 1')]));

    const result = await runSweep();

    expect(result.removedCount).toBe(1);
  });

  it('throws, naming what was expected and what was received, when the reply is unparseable', async () => {
    mockedRunScenarioTurn.mockResolvedValue(turnResult('completed', [outboundMsg('I looked but I am not sure.')]));

    await expect(runSweep()).rejects.toThrow(/SWEEP: REMOVED.*SWEEP: CLEAN.*not sure/s);
  });

  it('truncates a pathologically long unparseable reply in the thrown error rather than embedding it verbatim', async () => {
    const longReply = 'x'.repeat(2000);
    mockedRunScenarioTurn.mockResolvedValue(turnResult('completed', [outboundMsg(longReply)]));

    await expect(runSweep()).rejects.toThrow(/truncated, 2000 chars total/);
  });

  it('throws naming the status, never reporting removedCount: 0, when the turn times out', async () => {
    mockedRunScenarioTurn.mockResolvedValue(turnResult('timeout', []));

    await expect(runSweep()).rejects.toThrow(/status "completed", got "timeout"/);
  });

  it('throws naming the status when the turn fails', async () => {
    mockedRunScenarioTurn.mockResolvedValue(
      turnResult('failed', [outboundMsg('SWEEP: REMOVED 1')]), // even a parseable reply must not be trusted
    );

    await expect(runSweep()).rejects.toThrow(/status "completed", got "failed"/);
  });

  it('throws naming the status when the turn is cancelled', async () => {
    mockedRunScenarioTurn.mockResolvedValue(turnResult('cancelled', []));

    await expect(runSweep()).rejects.toThrow(/status "completed", got "cancelled"/);
  });

  it('propagates a rejection from runScenarioTurn unmodified, rather than swallowing it', async () => {
    const spawnError = new Error('runScenarioTurn: wakeContainer failed to spawn a container');
    mockedRunScenarioTurn.mockRejectedValue(spawnError);

    await expect(runSweep()).rejects.toBe(spawnError);
  });

  it('spawns under the scenario agent group (never the judge group) on a dedicated sweep thread id, distinct from any scenario/judge thread id', async () => {
    mockedRunScenarioTurn.mockResolvedValue(turnResult('completed', [outboundMsg('SWEEP: CLEAN')]));

    await runSweep();

    expect(mockedRunScenarioTurn).toHaveBeenCalledTimes(1);
    const [agentGroupId, threadId, message] = mockedRunScenarioTurn.mock.calls[0];
    const scenarioGroup = ensureEvalScenarioGroup();
    expect(agentGroupId).toBe(scenarioGroup.id);
    expect(threadId).toBe(`${EVAL_THREAD_PREFIX}:sweep`);
    expect(threadId).not.toMatch(/:judge:/);
    expect(typeof message).toBe('string');
    expect(message).toMatch(/SWEEP: REMOVED/);
    expect(message).toMatch(/SWEEP: CLEAN/);
  });

  it("fails loud with lock.ts's existing timeout error when a scenario run currently holds the lock, never proceeding without it", async () => {
    fs.mkdirSync(`${TEST_ROOT}/groups/eval`, { recursive: true });
    fs.writeFileSync(EVAL_LOCK_PATH, 'some-other-holder-pid', { flag: 'wx' });

    await expect(runSweep()).rejects.toThrow(/Timed out waiting for lock/);
    expect(mockedRunScenarioTurn).not.toHaveBeenCalled();
  }, 10_000);
});
