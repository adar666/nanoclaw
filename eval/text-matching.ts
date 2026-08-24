/**
 * Shared "genuine final answer, not a quoted/embedded mention" selection,
 * extracted from `sweep.ts`'s `parseSweepReply` and `judge/llm.ts`'s verdict
 * extraction after a real live `pnpm eval sweep` false-positive
 * (`spec-eval-trailing-match-guard.md`).
 *
 * Two design iterations before this one, both found by review before ever
 * shipping, are worth recording here so a future editor doesn't re-walk the
 * same dead ends:
 *
 * 1. **"Take the last match anywhere in the text."** The original bug: an
 *    agent quoting a protocol phrase while *explaining a refusal* ("the
 *    prompt demands one of two lines ('SWEEP: REMOVED n' / 'SWEEP: CLEAN')
 *    ... I'm not going to launder a refusal as either of those outcomes")
 *    has the quoted phrase as the chronologically-last match, so it got
 *    selected as if it were the real answer — laundering a refusal into a
 *    false `SWEEP: CLEAN` / `VERDICT: PASS` result.
 * 2. **"Last match with nothing but trailing punctuation after it, anywhere
 *    in the remaining text."** Fixed (1), but review found two real
 *    regressions before shipping: a genuinely successful reply with an
 *    ordinary closing remark ("SWEEP: REMOVED 3\nDone, all clear.") or a
 *    sentence of commentary before the next field ("VERDICT: PASS\nI'm
 *    fairly confident about this.\nREASONING: ...") now threw
 *    "could not parse" — completely normal LLM phrasing, not a refusal.
 *    Worse: this repo's own container-side `writeAutoLog`
 *    (`container/agent-runner/src/poll-loop.ts`) collapses every whitespace
 *    run — newlines included — into a single space before a reply is ever
 *    persisted, so by the time either parser sees real production text
 *    there are no newlines left to reason about "the rest of the reply" at
 *    all; a naive line-based redesign would have been just as broken as
 *    (2), only unable to tell the difference at all once collapsed.
 *
 * The distinguishing feature that actually holds across every case above:
 * the real live bug's quoted phrases are each embedded *mid-sentence*
 * (preceded by `demands one of two lines ("` / `" / "`), never at the start
 * of a sentence — while every genuine answer, in both the original passing
 * tests and the two regressions review found, starts a fresh sentence (or
 * opens the reply outright). What follows a genuine match — trailing
 * punctuation, a whole new sentence of commentary, a REASONING field — never
 * had to be constrained once "is this match embedded mid-sentence" is
 * checked instead; only what *precedes* the match matters.
 */

/** A match must sit at the very start of the text, or right after a sentence-ending `.`/`!`/`?` plus whitespace — never mid-sentence/mid-clause. */
const SENTENCE_START_BEFORE = /(?:^|[.!?]\s+)$/;

/**
 * Scans `pattern`'s matches against `text` from the end backward, returning
 * the first one encountered (i.e. the chronologically last) that starts a
 * sentence — nothing but sentence-ending punctuation and whitespace (or
 * nothing at all) immediately precedes it. What follows the match is never
 * examined: a genuine answer may be followed by trailing punctuation, an
 * unrelated remark, or another field (`REASONING: ...`) without
 * disqualifying it — only an *embedded, mid-sentence* mention (quoted,
 * parenthetical, or narrated) is rejected. Returns `undefined` when no match
 * qualifies, including when `pattern` matches nothing at all.
 *
 * `pattern` must carry the global flag (`g`) — same requirement
 * `String.prototype.matchAll` itself already enforces natively.
 */
export function findTrailingMatch(text: string, pattern: RegExp): RegExpMatchArray | undefined {
  const matches = [...text.matchAll(pattern)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const start = match.index ?? 0;
    const before = text.slice(0, start);
    if (SENTENCE_START_BEFORE.test(before)) {
      return match;
    }
  }
  return undefined;
}
