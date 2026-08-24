---
title: 'Trailing-Match Guard for VERDICT/SWEEP Parsing'
type: 'bugfix'
created: '2026-08-24'
status: 'done'
review_loop_iteration: 1
context: []
baseline_commit: '3ee7a8754aa67715572a7fe7494bc646fc0ed528'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A real live `pnpm eval sweep` run found a false-positive: the agent correctly refused to bulk-delete calendar events from an unidentified sender, explaining its refusal by quoting the exact required protocol phrases ("the prompt demands one of two lines ('SWEEP: REMOVED n' / 'SWEEP: CLEAN')... I'm not going to launder a refusal as either of those outcomes") — and then continued with more prose. `parseSweepReply`'s "take the last match" heuristic (added in `spec-eval-3-1-standalone-stale-event-sweep.md`'s own review cycle, specifically to defend against an agent echoing the prompt's instructions before its real answer) matched the quoted `SWEEP: CLEAN` substring and silently reported `removedCount: 0` — the exact laundering the agent explicitly refused to do, done anyway by the code that's supposed to record its answer. The same class of risk exists in `judge/llm.ts`'s identical `VERDICT_PATTERN` "last match" logic, unconfirmed live but structurally identical.

**Approach:** "Take the last match" assumed the last occurrence is always the real final answer — true for an *echoed instruction before* the real answer (the case it was built for), false for a *quoted example while explaining a refusal*, when more text follows. Both prompts already say the real answer must be the trailing content ("nothing else after it" / "the last two lines of your response") — so the fix is to only accept a match that is genuinely trailing (nothing substantial follows it, in the same text the pattern already scans), not merely the chronologically-last occurrence anywhere in the string. A new shared `eval/text-matching.ts` (`findTrailingMatch`) replaces the ad hoc `matches.at(-1)` in both `sweep.ts`'s `parseSweepReply` and `judge/llm.ts`'s verdict extraction — when no match is genuinely trailing, both correctly fall through to their existing "could not parse" throw, exactly matching what should have happened for the real refusal case that surfaced this.

## Boundaries & Constraints

**Always:**
- `eval/text-matching.ts` exports `findTrailingMatch(text: string, pattern: RegExp): RegExpMatchArray | undefined` — scans matches from the end backward, returns the first one (i.e. chronologically last) where everything after it, trimmed, is empty or only trailing punctuation (`.!?"')]`) — never a match with substantial prose following it.
- `eval/sweep.ts`'s `parseSweepReply` and `eval/judge/llm.ts`'s verdict extraction both use `findTrailingMatch` instead of `[...text.matchAll(pattern)].at(-1)`.
- When `findTrailingMatch` finds nothing (no match is genuinely trailing — including the "refused, quoted the format, then explained why" case), both call sites throw their existing "could not parse" error unchanged — a refusal is surfaced loud, not silently reported as a false verdict/clean result.
- `extractReasoning` (`judge/llm.ts`) is untouched — the real risk was specifically `VERDICT_PATTERN`'s binary pass/fail decision being computed from a quoted echo; once verdict-matching correctly throws for a non-trailing-only reply, `extractReasoning`'s own text is never reached for that call.

**Never:**
- Never changes the case-insensitivity, the `\b` word-boundary, or any other existing regex behavior of `VERDICT_PATTERN`/`SWEEP_PATTERN` — only which match is selected once found.
- Never changes `dispatchResultText`/`poll-loop.ts` or any container-side code — this is entirely a host-side (`eval/`) parsing fix.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Genuine trailing answer, no preamble | `"VERDICT: PASS\nREASONING: looks correct."` | Matches normally, unchanged from today | N/A |
| Echoed instruction as preamble, real answer trails | `"I'll reply with VERDICT: PASS or VERDICT: FAIL...\nVERDICT: FAIL\nREASONING: ..."` | Still matches the trailing occurrence — unchanged from today's existing coverage | N/A |
| Quoted format while refusing, more prose follows (the real live case) | `"...quotes both 'SWEEP: REMOVED n' and 'SWEEP: CLEAN'... I'm not going to launder a refusal..."` | No match is trailing — throws "could not parse", not a false clean/verdict result | Propagates, not swallowed |
| Trailing match with trailing punctuation/whitespace only | `"...VERDICT: PASS."` (trailing period) or `"...VERDICT: PASS\n\n"` | Still counts as trailing — matches | N/A |
| No match anywhere | Free-form prose, no protocol phrase at all | Throws "could not parse", same as today | Propagates, not swallowed |

</frozen-after-approval>

## Spec Change Log

**2026-08-24, during review, before merge.** The frozen Boundaries block above describes `findTrailingMatch` as accepting a match only when "everything after it, trimmed, is empty or only trailing punctuation." That was the first shipped implementation, and it was independently verified as internally consistent — but the 3-layer adversarial review (verification-gap, 2 CRITICAL findings, both confirmed) found it regressed completely normal, non-refusal replies:

- `judge/llm.ts`: `"VERDICT: PASS\nI'm fairly confident about this.\nREASONING: because it worked well."` threw "could not parse" — an ordinary sentence of confidence-commentary between VERDICT and REASONING is realistic LLM phrasing, not a refusal.
- `sweep.ts`: `"SWEEP: REMOVED 3\nDone, all clear."` threw the same way — an ordinary closing remark after a genuine, successful answer.

Neither case was covered by either file's existing 17-18 tests, so this shipped only as far as review, never to `main`.

**Root cause of the flawed first design:** "nothing after it" is not actually what distinguishes the real live bug (a protocol phrase quoted while explaining a refusal) from a genuine answer — both can have prose following them. What actually distinguishes them is *where* the match sits relative to the surrounding sentence: the live bug's quoted phrases are embedded mid-sentence (`demands one of two lines ("SWEEP: REMOVED n" / "SWEEP: CLEAN")`), never at the start of a sentence, while every genuine answer — in the original passing cases and both regressions above — starts a fresh sentence or opens the reply outright.

**Algorithm change:** `findTrailingMatch` now accepts a match when it is preceded by either the start of the text or sentence-ending punctuation (`.`/`!`/`?`) plus whitespace — never mid-sentence/mid-clause — and no longer examines what follows the match at all. This is a strictly better solution to the same frozen Problem/Approach (an embedded quote-while-refusing is still correctly rejected; a genuine trailing answer is still correctly accepted), not a change of intent — so the fix proceeds under this Change Log entry rather than a fresh spec. The I/O matrix's "trailing punctuation only" row and Task list still hold as literal outcomes (a period after a genuine match is harmless either way); the Boundaries' description of *why* is the part corrected here.

**Also discovered during this same investigation (informs the design, not a boundary change):** `container/agent-runner/src/poll-loop.ts`'s `writeAutoLog` collapses every whitespace run — including newlines — to a single space before a reply is ever persisted. Real production text reaching either parser therefore never contains newlines; a line-based ("is this match on its own line") redesign was considered and rejected for this reason before the sentence-boundary design was adopted instead.

## Code Map

- `eval/sweep.ts` — `SWEEP_PATTERN`, `parseSweepReply` (the exact function that produced the live false-positive: `eval/reports` from the `pnpm eval sweep` run on 2026-08-24, agent reply captured in `messages_out` for session `eval-7c427fb5-2fc4-4222-8358-30eeb4393cab`).
- `eval/judge/llm.ts` — `VERDICT_PATTERN`, the `judgeLlm` verdict-matching block; `extractReasoning` (unchanged, referenced for why it doesn't need the same fix).
- New: `eval/text-matching.ts` — `findTrailingMatch`, shared by both.

## Tasks & Acceptance

**Execution:**
- [x] `eval/text-matching.ts` — `findTrailingMatch(text, pattern)`
- [x] `eval/text-matching.test.ts` — cover the I/O matrix above directly against the function
- [x] `eval/sweep.ts` — `parseSweepReply` uses `findTrailingMatch`
- [x] `eval/sweep.test.ts` — add a regression test reproducing the exact live false-positive shape (quoted format mid-refusal, more prose after) — expect a throw, not `removedCount: 0`
- [x] `eval/judge/llm.ts` — verdict extraction uses `findTrailingMatch`
- [x] `eval/judge/llm.test.ts` — add the analogous regression test for `judgeLlm`

**Acceptance Criteria:**
- Given the exact real reply captured from the live `pnpm eval sweep` run (quotes both protocol phrases while refusing, then continues explaining), when `parseSweepReply` runs, then it throws "could not parse" rather than returning `removedCount: 0`.
- Given a genuine, protocol-compliant trailing answer (with or without an echoed-instruction preamble), when either `parseSweepReply` or `judgeLlm`'s verdict extraction runs, then behavior is unchanged from today — no regression on the cases already covered by Stories 2.2/3.1's own tests.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors
- `pnpm exec vitest run eval/` -- expected: all pass, including new regression tests
- `pnpm test` (full host suite) -- expected: all pass, no regressions
