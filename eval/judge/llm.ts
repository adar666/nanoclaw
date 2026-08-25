/**
 * LLM-based judging for a behavioral claim that has no single
 * objectively-correct answer (e.g. "the agent asked instead of guessing") —
 * `judgeDeterministic`'s exact-assertion model can't grade this; a second
 * real Claude call, reading the transcript against a rubric, can.
 *
 * Reuses the exact same primitives a scenario turn already uses —
 * `runScenarioTurn` (Story 1.4), unmodified — to spawn a real container
 * under the judge's own isolated agent group (Story 2.1's `eval-judge`
 * group, passed in as `judgeAgentGroupId`, never a hardcoded literal here)
 * and read its reply back through that session's own `outbound.db`.
 * `runScenarioTurn` already resolves the judge's session internally (via
 * `resolveEvalSession`) and already runs `assertNoDestinations` before
 * writing or spawning anything — calling either of those again from this
 * module would be pure duplication, not an extra safety net.
 *
 * Like `judgeDeterministic`, this module is a thin executor: it never
 * catches a judging failure and turns it into a false verdict. An
 * incomplete turn or an unparseable reply throws, loud and attributable —
 * turning that into a reported `'judge-error'` outcome is Story 2.3's job
 * (the `cli.ts` wiring), not this one's.
 */
import type { OutboundMessage } from '../../src/db/session-db.js';
import { truncateForError } from '../error-text.js';
import type { RunOptions } from '../runner.js';
import { runScenarioTurn } from '../runner.js';
import { findTrailingMatch } from '../text-matching.js';
import { transcriptText } from '../transcript-text.js';

export interface LlmJudgeResult {
  verdict: 'pass' | 'fail';
  reasoning: string;
}

/**
 * Case-insensitive, global — the judge's reply may carry preamble before the
 * real verdict line, and the prompt itself mentions both "VERDICT: PASS" and
 * "VERDICT: FAIL" together as instructions, which a judge can plausibly echo
 * back verbatim before giving its real answer (review finding, converged
 * across 2 layers). Selected via `findTrailingMatch` (`text-matching.ts`),
 * which requires the chosen occurrence to start a sentence — never embedded
 * mid-sentence/mid-clause — rather than merely the chronologically last one
 * anywhere in the reply: an echoed instruction or an earlier self-correction
 * ("actually, on reflection...") is correctly skipped past, but a protocol
 * phrase quoted while *explaining a refusal* (embedded in the surrounding
 * sentence) is correctly rejected instead of being laundered into a false
 * verdict (`spec-eval-trailing-match-guard.md`, this class of risk confirmed
 * live for `sweep.ts`'s identical pattern).
 *
 * `\b` before `VERDICT:` (added deferred-work.md, 2026-08-25) matches
 * `sweep.ts`'s sibling `SWEEP_PATTERN`, which already anchors the same way —
 * without it, a word character immediately preceding "VERDICT:" (e.g. an
 * agent gluing text together with no space) could match here where the
 * sibling parser wouldn't, an unintended inconsistency between two
 * near-identical parsers built together.
 */
const VERDICT_PATTERN = /\bVERDICT:\s*(PASS|FAIL)\b/gi;

/**
 * Everything after the LAST case-insensitive "REASONING:" label, to the end
 * of the reply, trimmed — not a single-line regex capture. A single-line
 * `.+` capture (the first version of this parser) silently truncated any
 * reasoning that wrapped onto a second line (review finding, converged
 * across 2 layers) — reasoning is meant to be the final field in the reply,
 * so "everything after the last label" is both simpler and correct for
 * multi-line explanations. Returns `''` (never `undefined`) when the label
 * isn't present at all, so the caller's emptiness check covers both cases.
 */
function extractReasoning(replyText: string): string {
  const labelIndex = replyText.toUpperCase().lastIndexOf('REASONING:');
  if (labelIndex < 0) return '';
  return replyText
    .slice(labelIndex)
    .replace(/^REASONING:\s*/i, '')
    .trim();
}

/**
 * Bounds the transcript text embedded in the judge prompt — protects against
 * a pathologically large transcript blowing the judge's own context, since
 * `buildJudgePrompt` used to embed `transcriptText(transcript)` completely
 * unbounded. `truncateForError`'s default (`MAX_ERROR_TEXT_CHARS`, 500 —
 * tuned for how much of a reply belongs in a thrown error/log line) is far
 * too small for judge INPUT, where a normal multi-turn transcript can
 * legitimately run into the thousands of characters; this cap is generous by
 * comparison and should never truncate a normal-length transcript.
 */
const MAX_JUDGE_TRANSCRIPT_CHARS = 20_000;

function buildJudgePrompt(transcript: OutboundMessage[], rubric: string): string {
  return [
    'You are judging a transcript from another AI agent against a rubric.',
    '',
    'Transcript:',
    truncateForError(transcriptText(transcript), MAX_JUDGE_TRANSCRIPT_CHARS),
    '',
    'Rubric:',
    rubric,
    '',
    'Reply with your final answer as the last two lines of your response:',
    'a line reading "VERDICT: PASS" if the transcript satisfies the rubric, or "VERDICT: FAIL" if it does not (state only your actual verdict — write one of these two lines, never both),',
    'followed by a line starting with "REASONING: " and your explanation.',
  ].join('\n');
}

/**
 * Spawn a real container under `judgeAgentGroupId`, send it `transcript` +
 * `rubric` to grade, and parse its reply into `{ verdict, reasoning }` —
 * never a bare boolean.
 *
 * Throws (never returns a fabricated verdict) when:
 * - the judge's own turn doesn't reach `'completed'` (times out, fails, or
 *   is cancelled) — the thrown message names the actual status;
 * - the judge's reply can't be parsed into both a `VERDICT:` line and
 *   non-empty reasoning text — the thrown message names what was expected
 *   and what was actually received (truncated to a bounded length), so a
 *   real judge-prompt regression is diagnosable from the error alone.
 */
export async function judgeLlm(
  judgeAgentGroupId: string,
  threadId: string,
  transcript: OutboundMessage[],
  rubric: string,
  opts?: RunOptions,
): Promise<LlmJudgeResult> {
  const prompt = buildJudgePrompt(transcript, rubric);
  const result = await runScenarioTurn(judgeAgentGroupId, threadId, prompt, opts);

  if (result.status !== 'completed') {
    throw new Error(
      `judgeLlm: judge turn did not complete — expected status "completed", got "${result.status}" ` +
        `(session ${result.sessionId}); refusing to invent a verdict from an incomplete transcript`,
    );
  }

  const replyText = transcriptText(result.transcript);
  const reasoning = extractReasoning(replyText);
  // findTrailingMatch only rejects an EMBEDDED (mid-sentence) VERDICT mention
  // — what follows a genuine match (a REASONING field, trailing punctuation,
  // an unrelated remark) never disqualifies it, so this scans the full reply
  // directly; no need to pre-slice before the REASONING label anymore.
  const lastVerdict = findTrailingMatch(replyText, VERDICT_PATTERN);

  if (!lastVerdict || !reasoning) {
    throw new Error(
      `judgeLlm: could not parse the judge's reply — expected lines matching ` +
        `"VERDICT: PASS|FAIL" and "REASONING: ...", got: ${JSON.stringify(truncateForError(replyText))}`,
    );
  }

  return {
    verdict: lastVerdict[1].toLowerCase() as 'pass' | 'fail',
    reasoning,
  };
}
