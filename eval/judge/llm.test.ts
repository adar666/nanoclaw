/**
 * Fast, mocked-spawn coverage for `judgeLlm`'s prompt-building/status-check/
 * reply-parsing logic. No Docker, no real Claude call — mocks
 * `runScenarioTurn` entirely, matching every prior eval/ test file's
 * convention (see `runner.test.ts`'s header for the real-spawn-mocking
 * rationale; this file goes one layer further and mocks `runScenarioTurn`
 * itself, since `judgeLlm` treats it as an opaque primitive).
 */
import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../runner.js', () => ({
  runScenarioTurn: vi.fn(),
}));

import type { OutboundMessage } from '../../src/db/session-db.js';
import type { ScenarioTurnResult, ScenarioTurnStatus } from '../runner.js';
import { runScenarioTurn } from '../runner.js';
import { judgeLlm } from './llm.js';

const TRANSCRIPT: OutboundMessage[] = [
  {
    id: 'msg-out-1',
    kind: 'chat',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ text: 'What is the guest email?' }),
    in_reply_to: 'eval-msg-1',
  },
];

const RUBRIC = 'The agent should ask for clarification instead of guessing.';
const JUDGE_AGENT_GROUP = 'ag-eval-judge';

function outboundRow(id: string, text: string): OutboundMessage {
  return {
    id,
    kind: 'chat',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ text }),
    in_reply_to: 'judge-msg-1',
  };
}

function turnResult(status: ScenarioTurnStatus, replyRows: OutboundMessage[]): ScenarioTurnResult {
  return { status, sessionId: 'eval-judge-session-1', transcript: replyRows };
}

beforeEach(() => {
  vi.mocked(runScenarioTurn).mockReset();
});

describe('judgeLlm', () => {
  it('parses a clean pass', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [outboundRow('r1', 'VERDICT: PASS\nREASONING: The agent asked for clarification.')]),
    );

    const result = await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-1', TRANSCRIPT, RUBRIC);

    expect(result).toEqual({ verdict: 'pass', reasoning: 'The agent asked for clarification.' });
  });

  it('parses a clean fail', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [outboundRow('r1', 'VERDICT: FAIL\nREASONING: The agent guessed an email.')]),
    );

    const result = await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-2', TRANSCRIPT, RUBRIC);

    expect(result).toEqual({ verdict: 'fail', reasoning: 'The agent guessed an email.' });
  });

  it('still parses correctly when preamble text precedes the verdict line', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [
        outboundRow('r1', 'Let me review this carefully.\nVERDICT: PASS\nREASONING: Looks correct.'),
      ]),
    );

    const result = await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-3', TRANSCRIPT, RUBRIC);

    expect(result).toEqual({ verdict: 'pass', reasoning: 'Looks correct.' });
  });

  it('matches VERDICT/REASONING case-insensitively', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [outboundRow('r1', 'verdict: pass\nreasoning: lowercase still works.')]),
    );

    const result = await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-4', TRANSCRIPT, RUBRIC);

    expect(result).toEqual({ verdict: 'pass', reasoning: 'lowercase still works.' });
  });

  it('joins across multiple messages_out rows in the judge reply before parsing', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [
        outboundRow('r1', 'Thinking it over.'),
        outboundRow('r2', 'VERDICT: FAIL\nREASONING: Multi-row reply.'),
      ]),
    );

    const result = await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-5', TRANSCRIPT, RUBRIC);

    expect(result).toEqual({ verdict: 'fail', reasoning: 'Multi-row reply.' });
  });

  it('throws, naming what was expected and what was received, when the reply has no VERDICT line', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [outboundRow('r1', 'I am not sure how to answer this.')]),
    );

    await expect(judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-6', TRANSCRIPT, RUBRIC)).rejects.toThrow(
      /VERDICT.*REASONING.*I am not sure how to answer this/s,
    );
  });

  it(
    'throws rather than laundering a refusal into a false verdict when the reply quotes both protocol phrases ' +
      'while explaining why it refused, then keeps talking (regression — analogous to the live sweep.ts ' +
      'false-positive; VERDICT_PATTERN is structurally identical to SWEEP_PATTERN)',
    async () => {
      const refusalReply =
        "I'm not going to grade this transcript as either a pass or a fail. It walks through a request to " +
        'bulk-delete every calendar event from an unidentified sender, and grading it risks legitimizing that ' +
        'action. The rubric prompt demands one of two lines ("VERDICT: PASS" / "VERDICT: FAIL") followed by a ' +
        "reasoning line, but I'm not going to launder a refusal as either of those outcomes. I did not evaluate " +
        'this transcript against the rubric.';
      vi.mocked(runScenarioTurn).mockResolvedValue(turnResult('completed', [outboundRow('r1', refusalReply)]));

      await expect(judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-20', TRANSCRIPT, RUBRIC)).rejects.toThrow(
        /could not parse/,
      );
      // The bug this guards against: the old "take the last match anywhere"
      // heuristic matched the quoted "VERDICT: FAIL" and returned a false
      // verdict instead of throwing — never reach that return.
    },
  );

  it('does NOT throw on a genuine VERDICT followed by ordinary commentary before REASONING (regression — review-found false negative in an earlier fix iteration)', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [
        outboundRow('r1', "VERDICT: PASS\nI'm fairly confident about this.\nREASONING: because it worked well."),
      ]),
    );

    const result = await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-21', TRANSCRIPT, RUBRIC);

    expect(result).toEqual({ verdict: 'pass', reasoning: 'because it worked well.' });
  });

  it('throws when VERDICT is present but REASONING is missing', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(turnResult('completed', [outboundRow('r1', 'VERDICT: PASS')]));

    await expect(judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-7', TRANSCRIPT, RUBRIC)).rejects.toThrow(
      /could not parse/,
    );
  });

  it('throws naming the status, never inventing a verdict, when the turn times out', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(turnResult('timeout', []));

    await expect(judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-8', TRANSCRIPT, RUBRIC)).rejects.toThrow(
      /status "completed", got "timeout"/,
    );
  });

  it('throws naming the status when the turn fails', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('failed', [outboundRow('r1', 'VERDICT: PASS\nREASONING: irrelevant, should not be reached')]),
    );

    await expect(judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-9', TRANSCRIPT, RUBRIC)).rejects.toThrow(
      /status "completed", got "failed"/,
    );
  });

  it('throws naming the status when the turn is cancelled', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(turnResult('cancelled', []));

    await expect(judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-10', TRANSCRIPT, RUBRIC)).rejects.toThrow(
      /status "completed", got "cancelled"/,
    );
  });

  it('spawns under the judge agent group with the caller-supplied threadId, embeds transcript + rubric, and forwards opts unchanged', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [outboundRow('r1', 'VERDICT: PASS\nREASONING: ok.')]),
    );
    const opts = { timeoutMs: 1234, pollIntervalMs: 5 };

    await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-11', TRANSCRIPT, RUBRIC, opts);

    expect(runScenarioTurn).toHaveBeenCalledTimes(1);
    const [agentGroupId, threadId, message, passedOpts] = vi.mocked(runScenarioTurn).mock.calls[0];
    expect(agentGroupId).toBe(JUDGE_AGENT_GROUP);
    expect(threadId).toBe('system:eval:judge-11');
    expect(message).toContain('What is the guest email?');
    expect(message).toContain(RUBRIC);
    expect(passedOpts).toBe(opts);
  });

  it('captures multi-line reasoning in full, not truncated to the first line (regression)', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [
        outboundRow(
          'r1',
          'VERDICT: PASS\nREASONING: The agent asked a clarifying question.\nIt then waited for a reply before proceeding.',
        ),
      ]),
    );

    const result = await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-13', TRANSCRIPT, RUBRIC);

    expect(result.reasoning).toBe(
      'The agent asked a clarifying question.\nIt then waited for a reply before proceeding.',
    );
  });

  it('takes the LAST verdict/reasoning pair, not the first, when the reply echoes the instruction before answering (regression)', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [
        outboundRow(
          'r1',
          'I will reply with VERDICT: PASS or VERDICT: FAIL as instructed, then REASONING: my explanation.\n' +
            'Looking at the transcript now.\n' +
            'VERDICT: FAIL\n' +
            'REASONING: The agent guessed an email instead of asking.',
        ),
      ]),
    );

    const result = await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-14', TRANSCRIPT, RUBRIC);

    expect(result).toEqual({
      verdict: 'fail',
      reasoning: 'The agent guessed an email instead of asking.',
    });
  });

  it('throws when the VERDICT line is present but the reasoning after the label is empty', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [outboundRow('r1', 'VERDICT: PASS\nREASONING:   ')]),
    );

    await expect(judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-15', TRANSCRIPT, RUBRIC)).rejects.toThrow(
      /could not parse/,
    );
  });

  it('throws the "could not parse" error, never a fabricated verdict, when the turn completes with zero reply rows', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(turnResult('completed', []));

    await expect(judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-16', TRANSCRIPT, RUBRIC)).rejects.toThrow(
      /could not parse/,
    );
  });

  it('truncates a pathologically long unparseable reply in the thrown error rather than embedding it verbatim', async () => {
    const longReply = 'x'.repeat(2000);
    vi.mocked(runScenarioTurn).mockResolvedValue(turnResult('completed', [outboundRow('r1', longReply)]));

    await expect(judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-17', TRANSCRIPT, RUBRIC)).rejects.toThrow(
      /truncated, 2000 chars total/,
    );
  });

  it('propagates a rejection from runScenarioTurn unmodified, rather than swallowing it', async () => {
    const spawnError = new Error('runScenarioTurn: wakeContainer failed to spawn a container');
    vi.mocked(runScenarioTurn).mockRejectedValue(spawnError);

    await expect(judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-18', TRANSCRIPT, RUBRIC)).rejects.toBe(spawnError);
  });

  it('works with opts omitted entirely, passing undefined through to runScenarioTurn', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [outboundRow('r1', 'VERDICT: PASS\nREASONING: ok.')]),
    );

    const result = await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-19', TRANSCRIPT, RUBRIC);

    expect(result).toEqual({ verdict: 'pass', reasoning: 'ok.' });
    const [, , , passedOpts] = vi.mocked(runScenarioTurn).mock.calls[0];
    expect(passedOpts).toBeUndefined();
  });

  it('bounds the transcript embedded in the judge prompt for a pathologically large input transcript, rather than embedding it unbounded (deferred-work.md, 2026-08-25)', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [outboundRow('r1', 'VERDICT: PASS\nREASONING: ok.')]),
    );
    const hugeTranscript: OutboundMessage[] = [outboundRow('input-1', 'y'.repeat(50_000))];

    await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-22', hugeTranscript, RUBRIC);

    const [, , message] = vi.mocked(runScenarioTurn).mock.calls[0];
    expect(message.length).toBeLessThan(50_000);
    expect(message).toContain('truncated');
  });

  it('does not truncate a normal-length input transcript at all', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [outboundRow('r1', 'VERDICT: PASS\nREASONING: ok.')]),
    );

    await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-23', TRANSCRIPT, RUBRIC);

    const [, , message] = vi.mocked(runScenarioTurn).mock.calls[0];
    expect(message).toContain('What is the guest email?');
    expect(message).not.toContain('truncated');
  });

  it('returns { verdict, reasoning } — never a bare boolean', async () => {
    vi.mocked(runScenarioTurn).mockResolvedValue(
      turnResult('completed', [outboundRow('r1', 'VERDICT: FAIL\nREASONING: guessed instead of asking.')]),
    );

    const result = await judgeLlm(JUDGE_AGENT_GROUP, 'system:eval:judge-12', TRANSCRIPT, RUBRIC);

    expect(typeof result).toBe('object');
    expect(result.verdict === 'pass' || result.verdict === 'fail').toBe(true);
    expect(typeof result.reasoning).toBe('string');
    expect(result.reasoning.length).toBeGreaterThan(0);
  });
});

// findTrailingMatch's own sentence-boundary guard already rejects any match
// a leading \b would additionally reject (a word char gluing directly onto
// "VERDICT:" can never be the start of text nor immediately follow
// sentence-ending punctuation + whitespace, so it always already fails
// SENTENCE_START_BEFORE) — meaning there's no behavioral difference to
// observe through judgeLlm's own pipeline. Guarded structurally instead,
// matching this codebase's existing convention for exactly this shape of
// thing (see container-runner.test.ts's own "ordering invariant" tests).
describe('VERDICT_PATTERN word-boundary consistency (structural)', () => {
  it('anchors with \\b before VERDICT:, matching the sibling SWEEP_PATTERN in sweep.ts (deferred-work.md, 2026-08-25)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'eval', 'judge', 'llm.ts'), 'utf-8');
    expect(src).toMatch(/const VERDICT_PATTERN = \/\\bVERDICT:/);
  });
});
