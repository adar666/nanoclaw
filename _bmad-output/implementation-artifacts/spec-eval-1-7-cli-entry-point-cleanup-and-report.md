---
title: 'CLI Entry Point, Cleanup, and Report'
type: 'feature'
created: '2026-08-23'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '11509f7b70d0ab9838e48740404829a7048f48e4'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stories 1.1–1.6 built every pipeline stage (`setup`/`session`/`safety`/`lock`/`runner`/`judge/deterministic`) but nothing wires them together end to end, and no scenario content exists yet — the harness has no way to actually run.

**Approach:** Add the missing pipeline pieces — `loader.ts` (scenario-set type + a small static registry), `scenarios/guest-resolution.scenarios.ts` (the real `guest-resolution-known-name` content), `reporter.ts` (writes `eval/reports/<run-id>/report.json`) — and `cli.ts`, which drives `loader → runner → judge/deterministic → reporter` under `withEvalLock` for `pnpm eval run guest-resolution`. Cleanup (deleting the event a scenario created) runs as a second real container turn on the same session, since only a container has live Calendar credentials (OneCLI) — the host process never does (same reasoning as AD-3, `EVAL_TEST_CALENDAR_ID`'s own setup).

## Boundaries & Constraints

**Always:**
- `cli.ts` supports exactly one invocation shape: `pnpm eval run <scenario-set-name>` (via a new `"eval": "tsx eval/cli.ts"` package.json script). Unknown subcommand or scenario-set name → clear error to stderr, `process.exitCode = 1`, no partial run.
- The whole run (group provisioning + every scenario + report write) runs inside one `withEvalLock(...)` call (AD-8) — matches `lock.ts`'s own docstring expectation that `cli.ts` is its first real caller.
- `loader.ts`'s `Scenario.judging` is the discriminated union from `scenario-format.md` (`deterministic` | `llmJudge`) — `cli.ts` only executes `deterministic` scenarios (Story 1.6's `judgeDeterministic`); an `llmJudge` scenario is not silently skipped — it produces a clear, distinct report entry (e.g. `status: 'unsupported'`) since `judge/llm.ts` doesn't exist until Epic 2. This is what lets Epic 2 add `judge/llm.ts` with zero changes to `loader.ts`/`runner.ts`/`reporter.ts` (epic context's own AD-5 requirement) — only `cli.ts`'s dispatch gains a new branch.
- A scenario's own thread id is `` `${EVAL_THREAD_PREFIX}:<scenario.id>` `` — one session per scenario id, so scenarios never share transcript state and re-running the same scenario id reuses (not duplicates) its session.
- A scenario whose turn does not reach `status: 'completed'` (`'failed'`/`'cancelled'`/`'timeout'`) is reported `passed: false` with evidence naming the status — `judgeDeterministic` is not called against an incomplete transcript.
- `cleanup` (when a scenario defines one) always runs, regardless of verdict or turn status — a failed/timed-out turn may still have created a real event. A `cleanup` failure is caught, logged loud (`log.error`), and recorded on that scenario's report entry (`cleanupError`) — it never throws out of `cli.ts` and never aborts remaining scenarios in the run.
- `report.json`'s `runId` is an ISO-8601 timestamp with `:` stripped, written to `eval/reports/<run-id>/report.json`. `eval/reports/` is added to `.gitignore` — run artifacts, never committed.
- `eval/setup.ts`'s `bootstrapDb` (currently module-private) is exported and reused by `cli.ts` — no second DB-init implementation.

**Never:**
- `cli.ts`/`reporter.ts`/`loader.ts` never open a raw `better-sqlite3` handle against `data/v2.db` (AD-2, same as every prior story) — DB access stays inside `runner.ts`/`session.ts`/`setup.ts`.
- Cleanup never calls the Google Calendar API directly from the host process — the host has no path to live Calendar credentials (only containers, via OneCLI). It always goes through `runScenarioTurn` again, on the same thread, as a real follow-up message the agent handles with its own calendar tools.
- No Epic 2 code (`judge/llm.ts`, judge agent group) is added here — the `llmJudge` branch is a stub that reports clearly, not an implementation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Known scenario set, deterministic scenario passes | `pnpm eval run guest-resolution`, agent replies mentioning `adardevora@gmail.com` | Report entry `passed: true`, `evidence` includes the matched email; console prints a pass line | N/A |
| Deterministic scenario fails | Agent's reply never mentions the expected email | Report entry `passed: false` with evidence showing what was actually said | N/A |
| Unknown scenario-set name | `pnpm eval run nonexistent` | Clear stderr error naming the unknown set, `exitCode 1`, no session/container touched | Thrown before `withEvalLock` acquires |
| Turn times out | `runScenarioTurn` returns `status: 'timeout'` | Report entry `passed: false`, evidence names the timeout — `judgeDeterministic` not invoked | N/A |
| `cleanup` throws | Agent's deletion follow-up doesn't confirm | Report entry gets `cleanupError`; run continues to the next scenario and still writes a report | Logged via `log.error`, never thrown out of `cli.ts` |
| Two concurrent invocations | A second `pnpm eval run ...` while one is mid-run | Second call blocks on `withEvalLock`, then proceeds once the first releases (or times out per `lock.ts`'s own budget) | `withLock`'s existing timeout error |

</frozen-after-approval>

## Code Map

- `eval/setup.ts` -- `ensureEvalScenarioGroup()` (group provisioning, reused as-is), `bootstrapDb()` (export it — currently private, only used in this file's own CLI-entry branch).
- `eval/session.ts` -- `EVAL_THREAD_PREFIX` (thread-id prefix reused to build each scenario's own thread id).
- `eval/runner.ts` -- `runScenarioTurn(agentGroupId, threadId, message, opts?)` -- called once per scenario turn, and again (same thread) for cleanup's own follow-up message.
- `eval/judge/deterministic.ts` -- `judgeDeterministic(transcript, check)`, `DeterministicCheck` type -- reused unmodified for the `deterministic` judging branch.
- `eval/lock.ts` -- `withEvalLock<T>(fn, opts?)` -- wraps the entire `cli.ts` run.
- `src/db/session-db.ts` -- `OutboundMessage` -- reused unmodified as the transcript element type, same as Story 1.6.
- `_bmad-output/specs/spec-eval-harness/scenario-format.md` -- the schema this story's `Scenario` type and the worked `guest-resolution-known-name` example are drawn from directly.
- `package.json` -- add `"eval": "tsx eval/cli.ts"` script (mirrors `"typecheck:eval"`'s existing precedent of a `tsx`/`eval/`-scoped script).
- `.gitignore` -- add `eval/reports/`.

## Tasks & Acceptance

**Execution:**
- [x] `eval/setup.ts` -- export `bootstrapDb` (drop the `function` → `export function`) -- `cli.ts` needs the same DB-init path, not a second implementation
- [x] `eval/loader.ts` -- `Scenario`, `ScenarioCleanup`, `ScenarioSet` types; a static `SCENARIO_SETS: Record<string, ScenarioSet>` registry; `loadScenarios(name, agentGroupId)` -- throws a clear error for an unregistered name
- [x] `eval/scenarios/guest-resolution.scenarios.ts` -- exports the `guest-resolution-known-name` scenario as a `ScenarioSet` factory, per `scenario-format.md`'s worked example: message `"פגישה מחר ב19 תוסיף את דבורה כאורחת"`, deterministic `check` scanning the transcript's `content` text for `adardevora@gmail.com`, `cleanup` sending a same-thread deletion follow-up and confirming it in the reply text
- [x] `eval/reporter.ts` -- `Report`, `ScenarioReportEntry` types; `writeReport(report)` -- creates `eval/reports/<run-id>/` and writes `report.json`; `makeRunId(date)` -- ISO-8601, `:` stripped
- [x] `eval/cli.ts` -- parses `run <scenario-set-name>`; under `withEvalLock`: `ensureEvalScenarioGroup()` → `loadScenarios` → per-scenario `runScenarioTurn` → (deterministic only) `judgeDeterministic` → cleanup (caught, logged, recorded) → console line per scenario → `writeReport`; sets `process.exitCode` from the aggregate pass/fail
- [x] `package.json` -- add the `"eval"` script
- [x] `.gitignore` -- add `eval/reports/`
- [x] `eval/loader.test.ts`, `eval/reporter.test.ts` -- cover the I/O matrix above (registry lookup/unknown-name, report file shape/run-id format)
- [x] `eval/cli.test.ts` -- cover `cli.ts`'s own dispatch/aggregation logic with `runner.ts`/`judge/deterministic.ts` mocked (no real container spawn in this test file — that's `runner.live.test.ts`'s job, unchanged)

**Acceptance Criteria:**
- Given the scenario set `guest-resolution.scenarios.ts` with `guest-resolution-known-name`, when `pnpm eval run guest-resolution` runs, then `cli.ts` drives loader → runner → judge/deterministic → reporter end to end and prints a console summary.
- Given a scenario's `cleanup` field, when judging completes (pass or fail), then the created calendar event is deleted via a real follow-up container turn; a cleanup failure is reported explicitly, never silently swallowed.
- Given the run completes, when `reporter.ts` writes output, then it saves `eval/reports/<run-id>/report.json` (ISO-8601 timestamp, `:` stripped) with per-scenario verdict + evidence.
- Given the scenario asserts against household's real recorded email for "Devorah", when the scenario passes, then the report shows the actual resolved email as evidence.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors -- ran, no errors
- `pnpm exec vitest run eval/` -- expected: all pass (new loader/reporter/cli tests + all prior eval/ tests, `runner.live.test.ts` still self-gated/skipped) -- ran, 83/83 pass (1 skipped, expected)
- `pnpm test` (full suite) -- expected: all pass, no regressions -- ran, 1495 pass / 1 skipped, no regressions (one transient recorder-domain failure during the first full-suite run reproduced the exact pre-existing flakiness pattern already documented for Story 1.5; re-ran 3x clean, confirmed environmental, not caused by this story)
- `pnpm exec tsc --noEmit -p .` -- ran, no errors
- `prettier --check eval/` -- ran clean (also fixed an unrelated pre-existing formatting gap in `eval/runner.live.test.ts`, dating to Story 1.4, found incidentally)
- Manual/operator-gated: `pnpm run test:eval-live` and a real `pnpm eval run guest-resolution` are NOT run as part of this story's own verification — both cost real tokens/API calls and need explicit operator go-ahead plus a confirmed `EVAL_TEST_CALENDAR_ID`, per this session's standing rule.

## Suggested Review Order

1. `eval/cli.ts:88-113` -- `runOneScenario`'s judging + cleanup flow, including the try/catch added in review around `judgeDeterministic` (all 3 review layers independently converged on this: an uncaught `check()` throw used to abort the whole run, skip that scenario's own cleanup, and discard every other scenario's already-computed report entry).
2. `eval/cli.ts:138-170` -- `runCli`: lock-wrapped pipeline, end-of-run summary line (added in review), exit-code aggregation.
3. `eval/loader.ts` -- `Scenario`/`ScenarioCleanup`/`ScenarioJudging`/`ScenarioSet` types, the `SCENARIO_SETS` registry, and `loadScenarios`'s `hasOwnProperty` guard (added in review, closes an inherited-prototype-property edge case on the registry lookup).
4. `eval/scenarios/guest-resolution.scenarios.ts` -- the real scenario content; `confirm`'s negation-aware cleanup check (hardened in review — a bare substring match on the confirmation word would false-positive on an honest "not deleted" reply).
5. `eval/reporter.ts` -- `Report`/`ScenarioReportEntry` shapes, including the new `'judge-error'` status value and the corrected `evidence` doc comment.
6. `eval/cli.test.ts`, `eval/loader.test.ts`, `eval/reporter.test.ts` -- full test coverage, including the two review-added regression tests (`judge-error` path, `llmJudge` scenario with a `cleanup` field).

**Review notes:** All 3 layers independently converged on the `judgeDeterministic`-throwing gap (edge-case-hunter and verification-gap explicitly; blind-hunter's cleanup/verdict-independence findings are adjacent) — the strongest convergence signal seen this epic, patched directly. Blind-hunter's Windows-path-comparison finding was rejected as matching an already-shipped, unflagged pattern in `setup.ts` for a macOS/Linux/Docker-only deployment target. The "EVAL_LOCK_PATH not test-isolated" finding was empirically disproven with a disposable probe test (`vi.mock` hoisting correctly isolates the module-level constant) before being rejected. Three findings were logged to `deferred-work.md` as real but out of this story's scope: cleanup failures not affecting exit code (a deliberate tradeoff), a genuine `runScenarioTurn` structural failure losing prior scenarios' report entries (a bigger design question than a mechanical patch), and no `list`/`--help` subcommand (would violate this story's own frozen "one invocation shape" boundary).
