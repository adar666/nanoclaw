/**
 * Direct coverage of `truncateForError` — no mocking, no DB, pure function.
 * `sweep.test.ts`/`judge/llm.test.ts` already cover it indirectly through
 * their own call sites (e.g. the "truncates a pathologically long
 * unparseable reply" regression tests); this file exercises the function's
 * own contract directly, including the UTF-16 surrogate-pair fix that
 * motivated extracting it into its own shared module.
 */
import { describe, expect, it } from 'vitest';
import { truncateForError } from './error-text.js';

describe('truncateForError', () => {
  it('returns text unchanged when at or under the max length', () => {
    expect(truncateForError('short', 10)).toBe('short');
    expect(truncateForError('exactly10!', 10)).toBe('exactly10!');
  });

  it('truncates and appends a "truncated, N chars total" marker when over the max', () => {
    const text = 'x'.repeat(2000);
    const result = truncateForError(text, 500);
    expect(result).toBe(`${'x'.repeat(500)}… (truncated, 2000 chars total)`);
  });

  it('defaults to a 500-char max when none is given', () => {
    const text = 'y'.repeat(600);
    const result = truncateForError(text);
    expect(result).toBe(`${'y'.repeat(500)}… (truncated, 600 chars total)`);
  });

  it('never splits a surrogate pair at the cut point, dropping the whole character instead (regression)', () => {
    // U+1F600 (😀) is a surrogate pair in UTF-16: text.length counts it as 2
    // code units. Placed so the naive cut point (max) lands exactly between
    // the high and low surrogate.
    const emoji = '\u{1F600}'; // 😀
    const text = 'a'.repeat(9) + emoji + 'b'.repeat(10); // 9 + 2 + 10 = 21 chars
    const result = truncateForError(text, 10); // cuts right after the high surrogate at index 9

    // The lone high surrogate must NOT appear alone in the output.
    const highSurrogate = emoji.charCodeAt(0);
    expect(result.charCodeAt(9)).not.toBe(highSurrogate);
    expect(result.startsWith('a'.repeat(9))).toBe(true);
    expect(result).toContain(`(truncated, ${text.length} chars total)`);
  });

  it('cuts exactly at max when the cut point does not split a surrogate pair', () => {
    const text = 'a'.repeat(20);
    const result = truncateForError(text, 10);
    expect(result).toBe(`${'a'.repeat(10)}… (truncated, 20 chars total)`);
  });
});
