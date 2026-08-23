---
title: "Judge's Own Isolated Agent Group"
type: 'feature'
created: '2026-08-23'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'c15c24431fa951a8d7dffa5567d6101913445989'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Epic 2's LLM-judge path (Story 2.2) will need to spawn a real container that reads a transcript and grades it — but nothing yet provisions a place for that container to run that's structurally separate from the scenario group.

**Approach:** Add `ensureEvalJudgeGroup()` to `eval/setup.ts`, mirroring `ensureEvalScenarioGroup()`'s existing shape (idempotent `ensureAgentGroup` call) but as a second, distinct agent group (`eval-judge` folder) — never the scenario group (AD-3: a judge bug must never touch the scenario's own session/group state). No calendar override or `people.md` mount — the judge never resolves guests or touches Calendar, it only reads a transcript and a rubric.

## Boundaries & Constraints

**Always:**
- `ensureEvalJudgeGroup()` creates (or returns the existing) agent group with folder `eval-judge`, same idempotency contract as `ensureEvalScenarioGroup()` — safe to call every run, no duplicate row on re-run.
- A freshly created judge group has zero rows in `destinations` (AD-1, verified the same way Story 1.1 verified it for the scenario group — via `getDestinations`/`assertNoDestinations`, not merely assumed from "nothing wrote there yet").
- `eval/setup.ts`'s standalone CLI entry point (`tsx eval/setup.ts`) provisions both groups in one run — the scenario group and the judge group.

**Never:**
- `ensureEvalJudgeGroup()` never calls `ensureEvalCalendarOverride` or `ensureEvalPeopleMount` — those are scenario-specific; the judge group has no calendar registry override and no `people.md` mount.
- No `judge/llm.ts`, no judge session (`messaging_group_id: NULL` is a session-level property — Story 2.2's job when it creates the judge's actual session, mirroring `resolveEvalSession`), no container spawn — this story only provisions the agent group itself.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First run | No `eval-judge` group exists | Creates one, folder `eval-judge`, zero destinations | N/A |
| Re-run | `eval-judge` group already exists | Returns the same group, no duplicate row | N/A |
| Fresh judge group's destinations | Immediately after creation | `getDestinations(group.id)` returns `[]` | N/A |
| Scenario group untouched | `ensureEvalJudgeGroup()` called | The `eval` (scenario) group's own config/destinations are unaffected | N/A |

</frozen-after-approval>

## Code Map

- `eval/setup.ts` — `ensureAgentGroup(folder, name)` (reused as-is), `ensureEvalScenarioGroup()` (sibling function this mirrors), the CLI-entry-point `if (import.meta.url === ...)` block at the bottom (extend to also call `ensureEvalJudgeGroup()`).
- `eval/safety.ts` — `assertNoDestinations(agentGroupId)`, reused for the zero-destinations regression test.
- `src/modules/agent-to-agent/db/agent-destinations.ts` — `getDestinations(agentGroupId)`, used directly in tests (matches `setup.test.ts`'s own existing pattern for the scenario group).
- `eval/setup.test.ts` — existing test file this story adds a new `describe('ensureEvalJudgeGroup', ...)` block to, following its exact fixture/mock conventions (`TEST_ROOT`, `config.js`/`env.js` mocks, `beforeEach`/`afterEach`).

## Tasks & Acceptance

**Execution:**
- [x] `eval/setup.ts` — add `ensureEvalJudgeGroup()`: `ensureAgentGroup('eval-judge', 'Eval Harness (Judge)')`, no calendar/mount calls
- [x] `eval/setup.ts` — extend the CLI entry point to also call `ensureEvalJudgeGroup()` and log the result, alongside the existing scenario-group line
- [x] `eval/setup.test.ts` — cover the I/O matrix above: first-run creation, idempotent re-run, zero-destinations verification, scenario-group non-interference

**Acceptance Criteria:**
- Given `eval/setup.ts` runs (standalone or via `ensureEvalJudgeGroup()` directly), when it provisions eval infrastructure, then a second, separate dedicated agent group for the judge exists — distinct folder from the scenario group — with zero destinations (AD-1).
- Given `ensureEvalJudgeGroup()` is called twice, when the second call runs, then it returns the same group with no duplicate row.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors -- ran, no errors
- `pnpm exec vitest run eval/` -- expected: all pass -- ran, 87/87 pass (1 skipped, expected)
- `pnpm test` (full suite) -- expected: all pass, no regressions -- ran, 1499/1499 pass (1 skipped), no regressions

## Suggested Review Order

1. `eval/setup.ts:132-142` -- `ensureEvalJudgeGroup()`: the one new function, mirrors `ensureEvalScenarioGroup()`'s shape exactly minus calendar/mount provisioning. Doc comment reworded in review to avoid stating Story 2.2's not-yet-built behavior as present fact, and to disambiguate "AD-3" from the unrelated AD-3 in the Google-Calendar epic's own spine.
2. `eval/setup.ts:154-163` -- CLI entry point extended to provision both groups in one `tsx eval/setup.ts` run.
3. `eval/setup.test.ts` -- new `describe('ensureEvalJudgeGroup', ...)` block: first-run creation (folder, display name, zero destinations), idempotent re-run, no calendar/mount side effects, scenario-group non-interference.

**Review notes:** all 3 layers converged on a low-noise result for this small, well-bounded story — verification-gap found nothing; edge-case-hunter's 2 findings (a check-then-insert race, an unwrapped CLI-entry throw) both matched pre-existing patterns already shared by `ensureEvalScenarioGroup`/the CLI entry point's own sibling line, mitigated at the real call-site level by `withEvalLock` (Story 1.3) once Story 2.2 wires a caller in — rejected as non-novel. Blind-hunter's 13 findings were mostly process/tooling artifacts (diff-bundle format, missing sprint-status.yaml in the bundle, a misunderstanding of `review_loop_iteration` semantics) or matched existing repo conventions (bare string literals for group folders, `context: []` correctly omitting already-distilled material per the spec template's own rule, no CLAUDE.md folder-literal documentation) — rejected. 3 real findings patched: a missing `name`-field assertion, the AD-3 cross-epic ambiguity, and the present-tense-fact doc-comment wording.
