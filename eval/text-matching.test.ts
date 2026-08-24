/**
 * Direct coverage of `findTrailingMatch` against `text-matching.ts`'s own
 * sentence-boundary contract — no mocking, no DB, pure function. Uses a
 * generic protocol-phrase-shaped pattern (`ANSWER: <value>`) so these tests
 * exercise the utility's own literal contract, independent of either call
 * site's own preamble/reasoning-slicing logic (covered separately in
 * `sweep.test.ts` / `judge/llm.test.ts`).
 *
 * This file replaces an earlier version that tested a "genuinely trailing —
 * nothing but punctuation follows" contract (`spec-eval-trailing-match-guard.md`'s
 * first shipped design). Review found that design regressed completely
 * normal replies (a genuine answer followed by ordinary commentary), so the
 * function was redesigned around what *precedes* a match — does it start a
 * sentence, or is it embedded mid-sentence/mid-clause — instead. See
 * `text-matching.ts`'s own header comment for the full history.
 */
import { describe, expect, it } from 'vitest';
import { findTrailingMatch } from './text-matching.js';

const ANSWER_PATTERN = /\bANSWER:\s*(YES|NO)\b/gi;

describe('findTrailingMatch', () => {
  it('matches a genuine answer with no preamble at all', () => {
    const text = 'ANSWER: YES';
    const match = findTrailingMatch(text, ANSWER_PATTERN);
    expect(match?.[0]).toBe('ANSWER: YES');
  });

  it('matches the last occurrence when it starts a fresh sentence after an echoed instruction', () => {
    const text = "I'll reply with ANSWER: YES or ANSWER: NO as instructed.\nChecking now.\nANSWER: NO";
    const match = findTrailingMatch(text, ANSWER_PATTERN);
    expect(match?.[1]).toBe('NO');
  });

  it('matches a genuine answer regardless of what ordinary commentary follows it (review-found regression in an earlier design)', () => {
    expect(findTrailingMatch('ANSWER: YES\nGreat, that is confirmed.', ANSWER_PATTERN)?.[1]).toBe('YES');
    expect(findTrailingMatch('ANSWER: NO. Nothing further to check.', ANSWER_PATTERN)?.[1]).toBe('NO');
  });

  it('finds no match when a protocol phrase is quoted mid-refusal and more prose follows (the real live case)', () => {
    const text =
      "I'm not going to do this. The prompt demands one of two lines ('ANSWER: YES' / 'ANSWER: NO')... " +
      "I'm not going to launder a refusal as either of those outcomes. I did not answer.";
    const match = findTrailingMatch(text, ANSWER_PATTERN);
    expect(match).toBeUndefined();
  });

  it('rejects a match embedded mid-sentence even with no commentary after it (e.g. quoted inline)', () => {
    expect(findTrailingMatch('He said, "ANSWER: YES"', ANSWER_PATTERN)).toBeUndefined();
    expect(findTrailingMatch('The options are ANSWER: YES or ANSWER: NO.', ANSWER_PATTERN)).toBeUndefined();
  });

  it('returns undefined when the pattern matches nothing at all', () => {
    const match = findTrailingMatch('Free-form prose with no protocol phrase.', ANSWER_PATTERN);
    expect(match).toBeUndefined();
  });

  it('accepts a self-correcting reply where the later, sentence-starting answer supersedes an earlier one', () => {
    const text = 'ANSWER: YES\nWait, reconsidering that.\nANSWER: NO';
    const match = findTrailingMatch(text, ANSWER_PATTERN);
    expect(match?.[1]).toBe('NO');
  });

  it('treats "!" and "?" as sentence boundaries too, not only "."', () => {
    expect(findTrailingMatch('Is this right? ANSWER: YES', ANSWER_PATTERN)?.[1]).toBe('YES');
    expect(findTrailingMatch('Confirmed! ANSWER: NO', ANSWER_PATTERN)?.[1]).toBe('NO');
  });
});
