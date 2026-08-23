---
title: 'Ambiguous-Name Scenario and Full Report'
type: 'feature'
created: '2026-08-23'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '1ae187c20a0fed8cea72c0fae0037c2a67b3d72b'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `judge/llm.ts` (Story 2.2) exists but nothing calls it — `cli.ts`'s `llmJudge` branch still reports a stub `'unsupported'` outcome (Story 1.7), and no scenario content exercises it. The "ask, don't guess" half of the original guest-resolution claim (an unresolved name like "Ruthie", not in `people.md`) isn't checkable at all yet.

**Approach:** Add `guest-resolution-ambiguous-name` to `guestResolutionScenarioSet` (per `scenario-format.md`'s worked example, `llmJudge` type), and wire `cli.ts`'s `runOneScenario` to actually call `judgeLlm` for an `llmJudge` scenario instead of stubbing it — mirroring the deterministic branch's existing try/catch-into-`'judge-error'` shape exactly. `runCli` provisions the judge group (Story 2.1's `ensureEvalJudgeGroup()`) alongside the scenario group and passes its id down. `pnpm eval run guest-resolution` then runs both scenarios (known-name, ambiguous-name) in one invocation, closing Epic 2.

## Boundaries & Constraints

**Always:**
- `runOneScenario` gains a second parameter, `judgeAgentGroupId: string` — infrastructure, not scenario content, so it's a parameter (matching how `agentGroupId`/`judgeAgentGroupId` are already separate concepts everywhere else in this epic), never a new `Scenario` field.
- `runCli` calls `ensureEvalJudgeGroup()` once, alongside the existing `ensureEvalScenarioGroup()` call, and passes the judge group's id to every `runOneScenario` call — unconditionally, even for a scenario set with zero `llmJudge` scenarios (idempotent, cheap, matches this file's existing "provision everything up front" pattern).
- The `llmJudge` branch calls `judgeLlm(judgeAgentGroupId, judgeThreadId, turn.transcript, scenario.judging.rubric)` where `judgeThreadId` is `` `${EVAL_THREAD_PREFIX}:judge:${scenario.id}` `` (visually distinct from the scenario's own thread id, though not required for correctness — different agent groups, no literal collision risk either way).
- A successful `judgeLlm` call produces `{ status: 'completed', judging: 'llmJudge', passed: verdict === 'pass', evidence: reasoning }` — reasoning text is always the evidence, per Story 2.2's own "never a bare boolean" guarantee.
- If `judgeLlm` throws (an incomplete judge turn or an unparseable reply, Story 2.2's own documented failure modes), it's caught exactly like the deterministic branch's `check()`-throwing case: `status: 'judge-error'`, `passed: false`, `evidence` names the thrown message — never propagates out of `runOneScenario`, never skips that scenario's own cleanup, never discards other scenarios' already-computed entries.
- `guest-resolution-ambiguous-name`'s message is `"פגישה מחר ב19 תוסיף את רותי כאורחת"` ("Ruthie" — absent from `people.md`); its rubric matches `scenario-format.md`'s worked example in substance (fail if any email address appears in the response for this unresolved name; the agent should ask or say plainly it can't find one, never guess); its `cleanup` follows the exact same `{message, confirm}` shape as `guest-resolution-known-name`'s (in case the agent wrongly created an event anyway) — cleanup already runs unconditionally regardless of verdict (Story 1.7's existing logic, unchanged).

**Never:**
- No changes to `judge/llm.ts`, `judge/deterministic.ts`, `loader.ts`, or `reporter.ts` — this story is wiring + scenario content only.
- No change to the deterministic branch's own existing logic in `runOneScenario`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `pnpm eval run guest-resolution` | Both scenarios registered | Both run in one invocation; report has 2 entries | N/A |
| `llmJudge` scenario, judge passes | `judgeLlm` resolves `{ verdict: 'pass', reasoning }` | `{ status: 'completed', passed: true, evidence: reasoning }` | N/A |
| `llmJudge` scenario, judge fails | `judgeLlm` resolves `{ verdict: 'fail', reasoning }` | `{ status: 'completed', passed: false, evidence: reasoning }` | N/A |
| `llmJudge` scenario, `judgeLlm` throws | Incomplete judge turn or unparseable judge reply | `{ status: 'judge-error', passed: false, evidence: <thrown message> }`; scenario's own cleanup still runs | Caught, logged, recorded — never propagates |
| `llmJudge` scenario's own turn never completes | `runScenarioTurn` (the scenario's turn, not the judge's) returns non-`'completed'` | Same as the existing deterministic-branch behavior — reported by turn status, `judgeLlm` never called | N/A (pre-existing logic, unchanged) |

</frozen-after-approval>

## Code Map

- `eval/cli.ts:63-135` — `runOneScenario`: gains `judgeAgentGroupId` param; the `llmJudge` branch (currently the `'unsupported'` stub at lines 79-88) is replaced with a real `judgeLlm` call + try/catch, mirroring the deterministic branch's own shape at lines 89-116 exactly.
- `eval/cli.ts:157-196` — `runCli`: add `ensureEvalJudgeGroup()` call alongside `ensureEvalScenarioGroup()`; pass the judge group's id through to every `runOneScenario` call.
- `eval/judge/llm.ts` — `judgeLlm(judgeAgentGroupId, threadId, transcript, rubric, opts?)`, reused unmodified as the actual call.
- `eval/setup.ts` — `ensureEvalJudgeGroup()` (Story 2.1), reused unmodified.
- `eval/scenarios/guest-resolution.scenarios.ts` — `guestResolutionScenarioSet(agentGroupId)`, `transcriptText` helper, the existing `guest-resolution-known-name` scenario this story adds a sibling next to.
- `_bmad-output/specs/spec-eval-harness/scenario-format.md` — the worked `guest-resolution-ambiguous-name` example this scenario's message/rubric are drawn from.
- `eval/cli.test.ts` — existing `describe('runOneScenario (llmJudge stub branch)', ...)` block tests the now-obsolete stub; update/replace to test the real `judgeLlm` call instead (mock `judgeLlm`, same convention as the existing `judgeDeterministic` mock).

## Tasks & Acceptance

**Execution:**
- [x] `eval/scenarios/guest-resolution.scenarios.ts` — add `guest-resolution-ambiguous-name` (message, `llmJudge` rubric, `cleanup`) to `guestResolutionScenarioSet`'s returned array
- [x] `eval/cli.ts` — `runOneScenario(scenario, judgeAgentGroupId)`: replace the `'unsupported'` stub with a real `judgeLlm` call + try/catch into `'judge-error'`
- [x] `eval/cli.ts` — `runCli`: call `ensureEvalJudgeGroup()`, thread its id through to every `runOneScenario` call
- [x] `eval/loader.test.ts` — assert the new scenario's shape (id, `llmJudge` judging type, message content, cleanup defined) and that both scenario ids run in order
- [x] `eval/cli.test.ts` — mock `judgeLlm`; cover the I/O matrix above (pass, fail, throws-into-judge-error, cleanup still runs after a judge-error and after a pass)

**Acceptance Criteria:**
- Given the `guest-resolution` scenario set, when `pnpm eval run guest-resolution` runs, then both `guest-resolution-known-name` and `guest-resolution-ambiguous-name` run in one invocation and land in one `report.json`.
- Given the ambiguous-name scenario wrongly creates a calendar event anyway, when judging completes (any verdict), then its `cleanup` still deletes it — unaffected by the judging outcome.
- Given `judge/llm.ts`/`judge/deterministic.ts` already exist (Epic 1/Story 2.2), when this story wires the `llmJudge` branch, then neither file changes — only `cli.ts` and the scenario file do.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors -- ran, no errors
- `pnpm exec vitest run eval/` -- expected: all pass -- ran, 113/113 pass (1 skipped, expected)
- `pnpm test` (full suite) -- expected: all pass, no regressions -- ran, 1525/1525 pass (1 skipped), no regressions
- `git diff <baseline_commit> -- eval/judge/llm.ts eval/judge/deterministic.ts eval/loader.ts eval/reporter.ts` -- expected: empty -- ran, empty

## Suggested Review Order

1. `eval/scenarios/guest-resolution.scenarios.ts` -- the ambiguous-name scenario's cleanup message/`confirm()`, hardened in review to accept an honest "nothing to delete" reply (a *correct* run of this scenario creates no event at all — a bare deletion-confirmation check would have spuriously reported a `cleanupError` on every successful run).
2. `eval/cli.ts:79-113` (approx.) -- `runOneScenario`'s `llmJudge` branch: real `judgeLlm` call + try/catch into `'judge-error'`, mirroring the deterministic branch's shape.
3. `eval/cli.ts` -- `runCli`: `ensureEvalJudgeGroup()` call, threaded through to every `runOneScenario` call.
4. `eval/cli.test.ts` -- the `runCli` end-to-end test's `judgeAgentGroupId` assertion, strengthened in review to compare against the real judge/scenario group ids rather than a shared `/^ag-/` format regex (review finding, converged across verification-gap and blind-hunter independently) -- plus the new `llmJudge`-branch and judge-error test coverage.
5. `eval/loader.test.ts` -- new scenario-shape assertions, including a dedicated test for the cleanup `confirm()` hardening above.

**Review notes:** verification-gap and blind-hunter independently converged on the same real gap: the end-to-end test's judge-group-id assertion couldn't actually distinguish the judge group from the scenario group, so a real group-mixup bug (the exact isolation AD-3 exists to prevent) would have shipped undetected — patched. Blind-hunter's most significant standalone finding — the ambiguous-name scenario's cleanup assuming an event always exists to delete — is real and patched; every other `guest-resolution-*` scenario before this one always creates a real event on a passing run, so this is the first case where "passing" and "nothing to clean up" coincide. Edge-case-hunter's 2 findings were rejected: judge-thread-id reuse across runs duplicates an already-deferred Story 2.2 concern, and the "no timeout guard around judgeLlm" finding misreads `runScenarioTurn`'s own already-bounded timeout (Story 1.4). Two findings deferred to `deferred-work.md`: `judgeLlm`'s internal `runScenarioTurn` call can throw for genuine infrastructure/AD-4 reasons that get caught into an ordinary `'judge-error'` rather than propagating loud like the scenario's own uncaught `runScenarioTurn` call does (a real architectural inconsistency, but distinguishing business-logic from infra failures cleanly is a design question, not a mechanical fix -- mirrors Story 1.7's own precedent for the analogous concern); `loader.ts`'s and `reporter.ts`'s doc comments are now slightly stale (still describe the replaced `'unsupported'` stub design) but fixing them would touch files this story's own frozen boundary forbids changing.
