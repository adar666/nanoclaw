---
title: 'Deterministic Judging'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 1
context: []
baseline_commit: 'b6cfe949bee0933ce51763d507073294764f4852'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1.4 captures a scenario's transcript; nothing yet turns that into a pass/fail verdict for a scenario with a single objectively-correct answer.

**Approach:** `eval/judge/deterministic.ts`'s `judgeDeterministic(transcript, check)` is a thin, pure, domain-agnostic executor (AD-5): the domain-specific assertion logic (`check`) is a plain function the scenario file itself defines and provides — this module never knows or cares what a "guest-resolution" check looks like, it just calls whatever function it's handed against the captured transcript and returns the result. Operates purely on the already-captured `transcript` (`OutboundMessage[]`, Story 1.4's own output) — not a live second call against Google Calendar or any other external API. `scenario-format.md`'s field description offers "outbound.db content / real API state" as two options; the real API option isn't chosen here because it would break CAP-2's own reproducibility requirement ("the same captured transcript always yields the same pass/fail") — API state can change between the transcript being captured and any later re-judging, and the host process has no path to live Calendar credentials anyway (only containers get those via OneCLI, same reasoning as Story 1.2's `EVAL_TEST_CALENDAR_ID`). A scenario author who needs external state to factor into a verdict must get it into the transcript some other way — out of scope for this generic executor.

## Boundaries & Constraints

**Always:**
- `eval/judge/deterministic.ts` exports:
  - `interface DeterministicCheckContext { transcript: OutboundMessage[] }` (`OutboundMessage` from `src/db/session-db.js`, reused unmodified).
  - `interface DeterministicJudgeResult { passed: boolean; evidence?: unknown }` — `evidence` is optional so a bare boolean-returning check still works, but present whenever the check function provides it, on a pass or a fail (Story 1.7's own report needs to show real evidence like a resolved email even on a passing scenario, not just on failure).
  - `type DeterministicCheck = (ctx: DeterministicCheckContext) => boolean | DeterministicJudgeResult`.
  - `function judgeDeterministic(transcript: OutboundMessage[], check: DeterministicCheck): DeterministicJudgeResult` — calls `check({ transcript })`; a bare `boolean` return is normalized to `{ passed: <value> }` (no evidence); an object return passes through unchanged.
- Pure function, no I/O, no `Date.now()`/randomness of its own — judging the exact same `(transcript, check)` pair twice must produce byte-identical results, satisfying CAP-2's reproducibility requirement by construction, not by a runtime guarantee needing separate enforcement.
- If `check` itself throws, `judgeDeterministic` does not catch it — propagates to the caller. A throwing check is a scenario-authoring bug; swallowing it would silently turn a broken check into a false verdict rather than a loud, attributable failure. (Story 1.7's own CLI/reporter, not built yet, decides how to surface a thrown error across a multi-scenario run — out of scope here.)

**Never:**
- Never calls any external API (Google Calendar or otherwise) — transcript-only, per the reproducibility reasoning above.
- Never invokes Claude or any other model — CAP-2's "zero model-call variance in the judging step itself" is satisfied by this module simply never making one.
- Never writes an actual scenario's `check` function (e.g. the guest-resolution one from `scenario-format.md`'s worked example) — that's domain-specific scenario content, Story 1.7's scope (`scenarios/guest-resolution.scenarios.ts`), not this generic executor.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Check returns `true` | Bare boolean | `{ passed: true }`, no evidence | N/A |
| Check returns `false` | Bare boolean | `{ passed: false }`, no evidence | N/A |
| Check returns an object with evidence, passing | `{ passed: true, evidence: {...} }` | Passed through unchanged | N/A |
| Check returns an object with evidence, failing | `{ passed: false, evidence: {...} }` | Passed through unchanged — evidence present on the failure, not just a bare `false` | N/A |
| Same transcript, judged twice | Identical `(transcript, check)` pair, two separate calls | Byte-identical `DeterministicJudgeResult` both times | N/A |
| Check throws | A scenario-authoring bug | Exception propagates, not swallowed | Caller's responsibility (Story 1.7, not built) |

</frozen-after-approval>

## Code Map

- `src/db/session-db.ts` (`OutboundMessage`) — reused unmodified as the transcript element type.
- `eval/runner.ts` (`ScenarioTurnResult.transcript`, Story 1.4) — the real caller-side data this module will eventually receive (wiring is Story 1.7's job, not this story's).
- `_bmad-output/specs/spec-eval-harness/scenario-format.md` — the worked example (`createdEventAttendeesInclude('adardevora@gmail.com')`) that motivated the "transcript-only, not live API" design decision above.

## Tasks & Acceptance

**Execution:**
- [x] `eval/judge/deterministic.ts` -- `DeterministicCheckContext`, `DeterministicJudgeResult`, `DeterministicCheck`, `judgeDeterministic`
- [x] `eval/judge/deterministic.test.ts` -- coverage for the I/O matrix above

**Acceptance Criteria:**
- Given a `check` returning `true`, when `judgeDeterministic` runs, then it returns `{ passed: true }`.
- Given a `check` returning `{ passed: false, evidence: {...} }`, when `judgeDeterministic` runs, then the returned result's `evidence` matches what the check provided, not just a bare boolean.
- Given the same `(transcript, check)` pair, when `judgeDeterministic` is called twice, then both results are deep-equal.
- Given a `check` that throws, when `judgeDeterministic` runs, then the exception propagates unchanged, not swallowed or converted to a failed verdict.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors -- ran, no errors
- `pnpm exec vitest run eval/` -- expected: all pass -- ran, 10/10 pass (`eval/judge/`)
- `pnpm test` (full suite) -- expected: all pass, no regressions -- ran, 1470 pass / 1 skipped (eval-live self-gate, expected)

## Suggested Review Order

1. `eval/judge/deterministic.ts:42-59` -- `judgeDeterministic`'s runtime guard (added in review): rejects a non-boolean/non-`{passed:boolean}` return with a `TypeError` instead of silently mis-shaping a verdict. `DeterministicCheck`'s type already blocks this for any typechecked scenario file; the guard is defense-in-depth for a function whose output is reported as ground truth.
2. `eval/judge/deterministic.ts:1-40` -- exported types + module doc comment (AD-5 domain-agnostic executor, transcript-only/no-live-API reasoning, deliberate synchronous-only constraint noted on `DeterministicCheck`).
3. `eval/judge/deterministic.test.ts` -- 10 tests: bare boolean (pass/fail), object with/without evidence (pass/fail), double-call determinism, thrown-error propagation, call-shape spy (exactly once, exactly `{transcript}`), 2 malformed-return guard tests.

**Review notes:** two findings from the blind-hunter review pass ("duplicate `DeterministicCheck` declaration," "missing semicolon") were artifacts of a transcription error in that review dispatch's prompt, not present in the shipped file -- confirmed against the file directly, no fix applicable. Two findings converging across edge-case-hunter and blind-hunter (malformed `check` return: non-object/missing-`passed`) were patched via the runtime guard above. Remaining findings (scenario metadata in context, judge/ barrel export) logged to `deferred-work.md` as premature -- no scenario loader or second `judge/` module exists yet.
