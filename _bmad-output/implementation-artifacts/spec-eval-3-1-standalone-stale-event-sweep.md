---
title: 'Standalone Stale-Event Sweep'
type: 'feature'
created: '2026-08-23'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '661c6ad76e309ad569f40687575d81a842d0db07'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A scenario's own per-run `cleanup` (Epic 1/2) only fires on a clean exit — a crashed or interrupted run can leave a real event behind on the eval-test calendar indefinitely, with nothing to find or remove it.

**Approach:** `eval/sweep.ts`'s `runSweep()` reuses the exact same "host never touches Calendar directly" pattern Story 1.7's cleanup already established: it sends a real message to the scenario agent group's container (the one with the eval-test calendar override, Story 1.2) instructing it to find and delete every event on its own calendar, then parses a fixed-format reply for what was removed. Wired into `cli.ts` as `pnpm eval sweep`, alongside the existing `run` subcommand — `runCli`'s own signature/behavior is untouched; a small top-level dispatcher at the bottom of `cli.ts` routes `sweep` to `runSweep()` instead.

## Boundaries & Constraints

**Always:**
- `runSweep(): Promise<SweepResult>` where `SweepResult = { removedCount: number; agentReplyText: string }`. Runs entirely inside `withEvalLock(...)` (AD-8, reusing `lock.ts` unmodified) — the whole operation (group provisioning + the sweep turn) is one locked critical section, same shape as `runCli`'s own.
- Calls `ensureEvalScenarioGroup()` (Story 1.2) — never a new group, never the judge group (Story 2.1 has no calendar access at all).
- Sends the sweep instruction as a real message via `runScenarioTurn` on a dedicated thread id (`` `${EVAL_THREAD_PREFIX}:sweep` ``, distinct from any scenario's own thread id) — reused unmodified, same primitive every prior story's real turn uses.
- The sweep prompt instructs the agent to list every event on its calendar, delete each one, and reply with **exactly one line**: `SWEEP: REMOVED <n>` (a non-negative integer) or `SWEEP: CLEAN` if there was nothing to delete.
- Parsing takes the **last** matching `SWEEP: REMOVED <n>` or `SWEEP: CLEAN` occurrence in the reply, not the first — same "final-answer-wins" mitigation as `judge/llm.ts` (Story 2.2) against the agent echoing the prompt's own instruction text before its real answer.
- If the turn doesn't reach `'completed'`, or the reply can't be parsed into either form, `runSweep` throws — never silently reports `removedCount: 0` for an outcome it couldn't actually verify.
- `cli.ts`'s bottom-of-file dispatcher recognizes exactly two subcommands, `run` and `sweep`; anything else is one clear, combined usage error naming both.
- Console output reports the parsed count (or "already clean") plus the agent's own raw reply text, matching this codebase's own console-reporting granularity elsewhere in `cli.ts`.

**Never:**
- Never opens a raw Calendar API connection, or any `better-sqlite3` handle against `data/v2.db`, from the host process — Calendar access only ever happens inside the container, via the exact same `runScenarioTurn` primitive every other real turn in this epic uses.
- No changes to `runCli`'s own existing signature, behavior, or tests — `sweep` is purely additive dispatch at the bottom of `cli.ts`.
- No changes to `reporter.ts`'s `Report`/`ScenarioReportEntry` shapes — a sweep is not a scenario run and doesn't produce a `report.json`; console reporting only, per the epic's own AC wording ("reports what was removed," not "writes a report file").

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `pnpm eval sweep`, orphaned events exist | Agent replies `SWEEP: REMOVED 3` | `{ removedCount: 3, agentReplyText }`; console reports 3 removed | N/A |
| `pnpm eval sweep`, calendar already clean | Agent replies `SWEEP: CLEAN` | `{ removedCount: 0, agentReplyText }`; console reports "already clean," no writes implied | N/A |
| Reply echoes the instruction before answering | Preamble contains both `SWEEP: REMOVED` and `SWEEP: CLEAN` phrasing, real answer is last | Last occurrence wins, matching `judge/llm.ts`'s own precedent | N/A |
| Reply is unparseable | Neither pattern matches | Throws, naming what was expected and what was received | Propagates, not swallowed |
| Turn never completes | `runScenarioTurn` returns a non-`'completed'` status | Throws, naming the status — never reports `removedCount: 0` for an unverified outcome | Propagates, not swallowed |
| A scenario run currently holds the lock | `withEvalLock` contention | `runSweep` fails loud with `lock.ts`'s existing timeout error, never proceeds without the lock | Propagates (pre-existing `withLock` behavior, Story 1.3, unmodified) |
| `pnpm eval <anything else>` | Unknown subcommand | One clear usage error naming both `run` and `sweep` | Thrown before any lock/session/container touched |

</frozen-after-approval>

## Code Map

- `eval/lock.ts` — `withEvalLock<T>(fn, opts?)`, reused unmodified (Story 1.3).
- `eval/runner.ts` — `runScenarioTurn(agentGroupId, threadId, message, opts?)`, reused unmodified (Story 1.4) as the actual Calendar-touching mechanism, same as Story 1.7's cleanup and Story 2.2's `judgeLlm`.
- `eval/setup.ts` — `ensureEvalScenarioGroup()` (Story 1.2), reused unmodified.
- `eval/session.ts` — `EVAL_THREAD_PREFIX`, reused to build the sweep's own thread id.
- `eval/judge/llm.ts` — the "take the last match" parsing pattern (`VERDICT_PATTERN`, `extractReasoning`) this story's own `SWEEP:`-line parser mirrors directly — same echoed-instruction risk, same mitigation.
- `eval/scenarios/guest-resolution.scenarios.ts` — `transcriptText` helper shape (parse-or-skip-malformed-rows over `messages_out` content), reused in spirit for reading the sweep turn's own reply.
- `eval/cli.ts` — the bottom-of-file `if (import.meta.url === ...)` main-module guard, extended to dispatch `run` vs `sweep`; `runCli`'s own body is untouched.

## Tasks & Acceptance

**Execution:**
- [x] `eval/sweep.ts` — `SweepResult`, `runSweep()`: builds the sweep prompt, calls `withEvalLock(() => ensureEvalScenarioGroup + runScenarioTurn(...))`, parses the reply (last-match, both patterns), throws on incomplete turn or unparseable reply
- [x] `eval/sweep.test.ts` — cover the I/O matrix above; mocks `runScenarioTurn` (no real container spawn, matching every prior eval/ test file's convention)
- [x] `eval/cli.ts` — bottom-of-file dispatcher (`dispatchEvalCli`): `run` → existing `runCli(argv)` unchanged, `sweep` → `runSweep()`, anything else → one combined usage error
- [x] `eval/cli.test.ts` — add coverage for the new dispatcher's routing (does not touch `runCli`'s own existing test suite)

**Acceptance Criteria:**
- Given orphaned events on the eval-test calendar, when `pnpm eval sweep` runs, then it finds and removes them and reports what was removed.
- Given the eval-test calendar is already clean, when `sweep.ts` runs, then it's a safe no-op — reports nothing removed, makes no writes (per the agent's own `SWEEP: CLEAN` reply — no separate host-side write path exists to make one anyway).
- Given a scenario run currently holds the lock, when `sweep.ts` attempts to acquire its own, then it fails loud with a clear message rather than racing the in-progress run.
- Given `sweep.ts` runs, when it operates, then it never touches Uriel's real household/personal calendars — only the eval-test calendar id, via the same AD-7 registry override every other story in this epic reuses.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors -- ran, no errors
- `pnpm exec vitest run eval/` -- expected: all pass -- ran, 135/135 pass (1 skipped, expected)
- `pnpm test` (full suite) -- expected: all pass, no regressions -- ran, 1547/1547 pass (1 skipped), no regressions
- `git diff <baseline_commit> -- eval/runner.ts eval/lock.ts eval/setup.ts eval/loader.ts eval/reporter.ts eval/judge/` -- expected: empty -- ran, empty

## Suggested Review Order

1. `eval/cli.ts` -- `dispatchEvalCli`, now `async` (review finding, converged across all 3 review layers — the single strongest convergence signal this whole session): a plain function's own synchronous `throw` for a bad subcommand would have escaped the entry point's `dispatchEvalCli(argv).catch(...)` handler entirely, crashing as a raw uncaught exception instead of the clean `eval: <message>` handling every other error path in this file gets. Also gained the same extra-argv strictness `run`'s own `parseArgs` already had, for `sweep`.
2. `eval/sweep.ts` -- `runSweep()`, `parseSweepReply`: the "take the last match" parsing strategy (mirrors `judge/llm.ts`'s own precedent directly), a left word-boundary added to `SWEEP_PATTERN`, a `Number.isSafeInteger` guard on the parsed count, `log.error` calls on both failure paths, and truncated console output on the success path for symmetry with the already-truncated error path.
3. `eval/cli.test.ts` -- the `dispatchEvalCli` block: fixed to `await expect(...).rejects.toThrow(...)` now that the function is properly async (the old synchronous `toThrow` wrapper would not have failed either way and couldn't have caught the bug above), a new test using the exact `.catch()`-chained shape the real entry point uses, lock-file-never-created assertions added to the existing usage-error tests, a new `sweep`-extra-arg test, and a new test confirming a sweep never writes to `eval/reports/`.
4. `eval/sweep.test.ts` -- 15 tests total: the original 13 plus 2 added in review (a mixed-type last-match case, an implausible-removed-count case).

**Review notes:** all 3 review layers independently converged on the same critical bug — `dispatchEvalCli`'s non-`async` declaration meant its own synchronous throw for a bad subcommand would never reach the entry point's `.catch()` handler, crashing the whole process instead of reporting cleanly. This is the strongest convergence signal seen across all 11 stories in this initiative, and the fix was the highest priority of this review cycle. Verification-gap and edge-case-hunter also both independently flagged the `sweep`-subcommand's missing extra-argv validation. One finding (a UTF-16 surrogate-pair truncation edge case) was deferred rather than patched, since it's a pre-existing pattern shared verbatim with `judge/llm.ts` and fixing only one copy would leave the two inconsistent. Several findings were rejected as based on a flawed comparison to `runCli`'s own exit-code handling (`runSweep`'s success/failure exit-code behavior is already correct by construction — every throw path already sets `process.exitCode = 1` via the entry point's generic catch handler) or as correct, deliberately-forgiving parser behavior rather than a gap (`SWEEP: REMOVED 0` accepted as CLEAN-equivalent).

This story closes the entire 11-story eval-harness initiative (Epics 1–3, all done).
