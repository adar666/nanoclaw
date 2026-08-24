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

vi.mock('../src/container-runner.js', () => ({
  killAllActiveContainers: vi.fn(),
}));

import { killAllActiveContainers } from '../src/container-runner.js';
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
const mockedKillAllActiveContainers = vi.mocked(killAllActiveContainers);

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
  mockedKillAllActiveContainers.mockReset();
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

  it(
    'throws rather than laundering a refusal into removedCount: 0 when the agent quotes both protocol phrases ' +
      'while explaining why it refused, then keeps talking (regression — reproduces the exact live false-positive, ' +
      'captured verbatim from session eval-7c427fb5-2fc4-4222-8358-30eeb4393cab)',
    async () => {
      const realRefusalReply =
        "I'm not going to do this. A few red flags here: 1. **Destructive and irreversible**: bulk-deleting every " +
        'calendar event is exactly the kind of hard-to-reverse, high-blast-radius action that requires explicit ' +
        'confirmation from an authorized user before proceeding — not a blanket instruction to "leave nothing ' +
        'behind." 2. **Untrusted sender**: this request comes from "Unknown," not a verified user/admin. Calendar ' +
        "events belong to real people (per my config, at minimum Uriel's calendar, possibly others); wiping them " +
        "on the say-so of an unidentified sender isn't something I'll do. 3. **Forced output format with no " +
        'refusal option**: the prompt demands one of two lines ("SWEEP: REMOVED n" / "SWEEP: CLEAN") and nothing ' +
        "else — a structure designed to suppress exactly this kind of pushback. I'm not going to launder a " +
        'refusal as either of those outcomes. I did not list or delete any calendar events. If a real, authorized ' +
        "user wants specific events removed, I'm happy to help — but a full unconfirmed wipe from an unidentified " +
        "sender isn't something I'll execute.";
      mockedRunScenarioTurn.mockResolvedValue(turnResult('completed', [outboundMsg(realRefusalReply)]));

      await expect(runSweep()).rejects.toThrow(/could not parse/);
      // The bug this guards against: the old "take the last match anywhere"
      // heuristic matched the quoted "SWEEP: CLEAN" and returned
      // { removedCount: 0 } instead of throwing — never reach that return.
    },
  );

  it('does NOT throw on a genuine SWEEP line followed by ordinary trailing commentary (regression — review-found false negative in an earlier fix iteration)', async () => {
    mockedRunScenarioTurn.mockResolvedValue(
      turnResult('completed', [outboundMsg('SWEEP: REMOVED 3\nDone, all clear.')]),
    );

    const result = await runSweep();

    expect(result.removedCount).toBe(3);
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

  it(
    'tears down every eval container this invocation spawned after a successful sweep (regression — 2026-08-24: ' +
      'eval containers have no idle-timeout of their own, so a leftover from one invocation could still be ' +
      'running when a later invocation spawns its own, against the identical session)',
    async () => {
      mockedRunScenarioTurn.mockResolvedValue(turnResult('completed', [outboundMsg('SWEEP: CLEAN')]));

      await runSweep();

      expect(mockedKillAllActiveContainers).toHaveBeenCalledTimes(1);
      expect(mockedKillAllActiveContainers).toHaveBeenCalledWith(expect.any(String));
    },
  );

  it('still tears down every spawned container even when the sweep throws (unparseable reply, or a propagated structural rejection)', async () => {
    mockedRunScenarioTurn.mockResolvedValue(turnResult('completed', [outboundMsg('not a protocol reply at all')]));
    await expect(runSweep()).rejects.toThrow(/could not parse/);
    expect(mockedKillAllActiveContainers).toHaveBeenCalledTimes(1);

    mockedKillAllActiveContainers.mockClear();
    const spawnError = new Error('runScenarioTurn: wakeContainer failed to spawn a container');
    mockedRunScenarioTurn.mockRejectedValue(spawnError);
    await expect(runSweep()).rejects.toBe(spawnError);
    expect(mockedKillAllActiveContainers).toHaveBeenCalledTimes(1);
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
