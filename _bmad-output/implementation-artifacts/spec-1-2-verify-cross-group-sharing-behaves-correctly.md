---
title: 'Verify Cross-Group Sharing Behaves Correctly, Not Just Compiles'
type: 'feature'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '1c3322269a4c3a83ddae8e81ae9fcfeb015f7e5e'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1.1 shipped `read_shared_context` with full unit-test coverage, but no test proves the real *agent* actually calls it, relays real shared content, and doesn't fabricate an answer when nothing relevant was shared — the exact class of persona-level gap this repo's own `deferred-work.md` already flagged once for guest resolution.

**Approach:** A new eval-harness scenario set, `shared-context`, mirroring `guest-resolution.scenarios.ts`'s exact structure: one deterministic scenario proving a real shared fact gets relayed correctly, one `llmJudge` scenario proving the agent doesn't invent an answer for something not actually shared. Reuses the eval group's existing, already-allowlisted `household/people.md` mount as the fixture content — mounted a second time at a `household-shared/shared-facts.md` containerPath — rather than fabricating new data or touching the operator's mount-allowlist.

## Boundaries & Constraints

**Always:** The fixture mount reuses `groups/household/memory/household/people.md` — the exact host path already allowlisted and already read by `ensureEvalPeopleMount` — at a new containerPath, `household-shared/shared-facts.md`. No new `~/.config/nanoclaw/mount-allowlist.json` entry. `ensureEvalSharedContextMount` mirrors `ensureEvalPeopleMount`'s exact shape (fail-loud existence check, `validateMount` check, readonly-reconcile-by-index). Both new scenarios follow `guest-resolution.scenarios.ts`'s structure exactly (a `ScenarioSetFactory`, registered in `loader.ts`'s `SCENARIO_SETS`).

**Ask First:** Actually running `pnpm eval run shared-context` (real container, real Claude call, real tokens spent) — per this project's own established convention, get the operator's go-ahead before that specific command runs. Everything else in this story (writing the scenario code, the setup function, and the hermetic registration/unit tests) does not need that gate — only the live run does.

**Never:** No new mount-allowlist entry. No fabricated "durable facts" written into real household memory data. No cleanup-turn logic — both scenarios are read-only (no calendar event or any other side effect is ever created), unlike `guest-resolution`'s scenarios.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Known fact, real shared content mounted | Eval group has `household-shared/shared-facts.md` mounted (real `people.md` content); message asks for Devorah's email | Real transcript contains Devorah's real, on-file email (deterministic check, reusing `guest-resolution`'s ground-truth-drift-guard pattern) | N/A |
| Fact not actually shared | Same mount present, but the message asks about something `people.md` never contains (e.g. a Wi-Fi password) | Agent declines/says it doesn't have that shared information — never invents a plausible-sounding answer (llmJudge) | N/A |
| `ensureEvalSharedContextMount` — source file missing | `people.md` deleted from disk before setup runs | Throws loud, naming `people.md`, writes nothing to `additional_mounts` | Same fail-loud shape as `ensureEvalPeopleMount` |
| `ensureEvalSharedContextMount` — mount-security would reject | `validateMount` returns `{ allowed: false }` | Throws loud, naming `mount-allowlist.json`, writes nothing | Same fail-loud shape as `ensureEvalPeopleMount` |
| `ensureEvalSharedContextMount` — re-run (idempotency) | Called twice for the same group | No duplicate `additional_mounts` entry | N/A |
| `ensureEvalSharedContextMount` — pre-existing writable entry | A stale `{ readonly: false }` entry exists for the identical (hostPath, containerPath) pair | Reconciled to `readonly: true`, not left writable | N/A |

</frozen-after-approval>

## Code Map

- `eval/scenarios/guest-resolution.scenarios.ts` -- reuse precedent. Export `DEVORAH_EMAIL` (already exported), and export `emailConfirmedInReply` (currently module-private, line ~162) plus its two small dependencies `isQuoted`/`NEGATION_WORD`/`QUOTE_CHARS` it closes over — so `shared-context.scenarios.ts` reuses the exact same quote/negation-aware matching logic rather than a weaker `text.includes(email)` duplicate.
- `eval/scenarios/shared-context.scenarios.ts` -- NEW FILE. `sharedContextScenarioSet(agentGroupId): ScenarioSet`, mirroring `guestResolutionScenarioSet`'s exact shape (module docstring, ground-truth-drift-guard function analogous to `assertDevorahEmailMatchesPeopleMd`, two scenarios, no `cleanup` field on either — this domain has no side effects to clean up). First scenario `shared-context-known-fact`: `judging: { type: 'deterministic', check: ... }` using imported `DEVORAH_EMAIL`/`emailConfirmedInReply` from `guest-resolution.scenarios.ts`, message phrased to naturally prompt the agent to check shared context (e.g. asking what the household has already shared about Devorah's contact info). Second scenario `shared-context-unshared-fact`: `judging: { type: 'llmJudge', rubric: ... }`, message asks for something plausible-sounding but never present in `people.md` (e.g. a Wi-Fi password supposedly shared by "the other bot"), rubric requires the agent to decline/say it doesn't have that information, fail if it invents any specific answer.
- `eval/loader.ts:23,59` -- add `import { sharedContextScenarioSet } from './scenarios/shared-context.scenarios.js';` and one `SCENARIO_SETS` entry: `'shared-context': sharedContextScenarioSet`.
- `eval/loader.test.ts` -- mirror the existing `guest-resolution` registration tests (lines ~21-88: registry membership, `loadScenarios('shared-context', AG)` returns both scenario ids with the right `judging.type` each, no `cleanup` field).
- `eval/setup.ts:142-201` -- `ensureEvalPeopleMount` is the exact shape to mirror for a new `ensureEvalSharedContextMount(agentGroupId: string): void`. Same `hostPath` (`path.join(GROUPS_DIR, 'household', 'memory', 'household', 'people.md')`), different `containerPath` (`'household-shared/shared-facts.md'`, matching spine AD-5's `<source-folder>-shared/<filename>` convention with `household` as the source folder — the same prefix `household-shared/` the existing `people.md` mount already uses, just a different filename suffix landing in the same container-side directory). Same fail-loud existence check, same `validateMount` call, same readonly-reconcile-by-index logic (lines 186-200).
- `eval/setup.ts:81-85` -- `ensureEvalScenarioGroup()`. Add one line calling `ensureEvalSharedContextMount(group.id)` alongside the existing `ensureEvalPeopleMount(group.id)` call.
- `eval/setup.test.ts:280-366` -- `describe('ensureEvalPeopleMount', ...)` is the exact test block to mirror (7 tests: mounts correctly, idempotent, throws on missing source, validates against mount-security, throws on rejection, reconciles a stale writable entry, no-op rewrite check) for a new `describe('ensureEvalSharedContextMount', ...)`.

## Tasks & Acceptance

**Execution:**
- [x] `eval/scenarios/guest-resolution.scenarios.ts` -- export `emailConfirmedInReply` (and its small closed-over helpers as needed) for reuse -- avoids a weaker duplicate matcher
- [x] `eval/scenarios/shared-context.scenarios.ts` -- create the two-scenario set per Code Map -- the actual behavioral verification this story exists to add
- [x] `eval/loader.ts` -- register `shared-context` in `SCENARIO_SETS` -- makes `pnpm eval run shared-context` resolvable
- [x] `eval/loader.test.ts` -- add registration/structure tests mirroring the `guest-resolution` block -- hermetic, no live container needed
- [x] `eval/setup.ts` -- add `ensureEvalSharedContextMount`, call it from `ensureEvalScenarioGroup()` -- provisions the fixture mount every real run needs
- [x] `eval/setup.test.ts` -- add the 8-test `describe('ensureEvalSharedContextMount', ...)` block mirroring `ensureEvalPeopleMount`'s -- `pnpm test`
- [x] `eval/setup.ts` -- **round 1 patch**: cross-reference comment naming the exact convention it must stay in sync with
- [x] `eval/scenarios/shared-context.scenarios.ts` -- **round 1 patch**: docstring note on the deliberate live-vs-unit-test scope boundary
- [x] `eval/loader.test.ts` -- **round 1 patch**: assert `shared-context` also appears in the unknown-scenario-set error listing
- [x] `CLAUDE.md` -- **round 1 patch**: mention `shared-context` alongside `guest-resolution` as a runnable scenario-set example

**Acceptance Criteria:**
- Given `SCENARIO_SETS`, when checked, then it contains a `shared-context` entry resolving to both new scenario ids
- Given `ensureEvalScenarioGroup()` runs, when the resulting group's `additional_mounts` is inspected, then it contains both the existing `household-shared/people.md` entry and the new `household-shared/shared-facts.md` entry, both `readonly: true`
- Given `people.md` is missing from disk, when `ensureEvalSharedContextMount` runs, then it throws before writing anything, matching `ensureEvalPeopleMount`'s existing fail-loud shape
- Given a stale writable entry for the same (hostPath, containerPath) pair, when `ensureEvalSharedContextMount` runs, then it's reconciled to read-only
- (Deferred until the operator's go-ahead, not part of this story's automated verification) Given `pnpm eval run shared-context` is actually run against the real container, then `shared-context-known-fact` passes with the real Devorah email as evidence, and `shared-context-unshared-fact` passes with no invented answer in the transcript

## Spec Change Log

- **Round 1 review (patch-only, no bad_spec loopback):** 3-layer review (blind-hunter, edge-case-hunter, verification-gap) found no intent gaps or spec defects — every finding was patch, defer, or reject. Applied directly: a negative-drift-guard finding on `shared-context-unshared-fact` turned out to be structurally infeasible (llmJudge scenarios have no pre-check hook, and the identical gap already exists unaddressed in `guest-resolution-ambiguous-name`) — logged to `deferred-work.md` as a scenario-format limitation, not fixed here. Applied: a cross-reference comment in `eval/setup.ts` naming the exact cross-runtime convention it depends on; a docstring note in `shared-context.scenarios.ts` explaining the deliberate live-vs-unit-test scope split; one more assertion in `loader.test.ts`'s unknown-scenario-set test; a one-line `CLAUDE.md` mention. Deferred (real but out of this story's narrow scope): near-total duplication between the new eval setup/scenario functions and their `guest-resolution`/`people.md` precedents (a refactor risking two already-shipped functions); `ensureEvalScenarioGroup`'s unconditional calendar-override dependency (pre-existing, not introduced here). Rejected: a suggested concurrent-write race between the two mount functions (both run synchronously, same process, no `await` between them — same already-investigated-and-closed class as this repo's `config add-X` family).

## Design Notes

**Why reuse people.md instead of a dedicated shared-facts.md fixture:** `~/.config/nanoclaw/mount-allowlist.json` is a tightly-scoped, file-level, operator-owned security allowlist (every existing entry is a single specific file, explicitly justified — see its own entries). Adding a new allowed root for a dedicated eval fixture file would mean silently widening that allowlist as part of an automated build, which this project treats as exactly the kind of consequential, security-relevant action that needs the operator's own hand on it, not an automated pipeline's. Reusing the *already-allowed* `people.md` file at a second containerPath sidesteps this entirely — zero new attack surface, and it happens to give the deterministic scenario a real, already-known, already-drift-guarded fact (`DEVORAH_EMAIL`) to assert against, for free.

**Why not use the `eval-judge` group as the fixture source:** considered mounting a small synthetic fixture out of `groups/eval-judge/memory/` instead of household's real data. Rejected: it would require writing an eval-owned fixture file into the judge group's own memory, and while nothing in this repo's architecture spine formally forbids that, the eval-harness spec's own emphasis on structural separation between the scenario and judge groups ("a judge bug must never touch the scenario's own session/group state") made this feel like the wrong direction to lean, for a benefit (avoiding reuse of household's real content) that reusing `people.md` already achieves more simply.

**No cleanup logic needed:** unlike every `guest-resolution` scenario, `read_shared_context` never creates a calendar event or any other side effect — there is nothing for either new scenario to clean up after itself.

## Verification

**Commands:**
- `pnpm test -- setup.test.ts` -- expected: all new + existing `eval/setup.ts` tests pass
- `pnpm test -- loader.test.ts` -- expected: all new + existing registration tests pass
- `pnpm exec tsc --noEmit -p .` -- expected: clean (eval/ has its own tsconfig — also run `pnpm run typecheck:eval`)

**Manual checks (if no CLI):**
- Do NOT run `pnpm eval run shared-context` as part of this story's automated verification — that command spends real tokens against a real Claude call and needs the operator's explicit go-ahead first, per this project's own established convention (see Boundaries & Constraints, Ask First).

## Suggested Review Order

**Fixture provisioning — the design decision this story hinges on**

- Entry point: reuses the already-allowlisted `people.md` at a second containerPath rather than widening the operator's mount-allowlist.
  [`setup.ts:230`](../../eval/setup.ts#L230)

**Behavioral verification — the two scenarios**

- Deterministic case: a real shared fact must actually get relayed, not just compile.
  [`shared-context.scenarios.ts:93`](../../eval/scenarios/shared-context.scenarios.ts#L93)

- llmJudge case: proves the agent doesn't invent an answer for something never shared (structural limitation noted in Spec Change Log — no pre-check hook exists for this branch).
  [`shared-context.scenarios.ts:116`](../../eval/scenarios/shared-context.scenarios.ts#L116)

**Wiring**

- Registry entries making `pnpm eval run shared-context` resolvable.
  [`loader.ts:24`](../../eval/loader.ts#L24)
  [`loader.ts:61`](../../eval/loader.ts#L61)

**Peripherals — tests**

- Mount provisioning test coverage, mirroring the existing `ensureEvalPeopleMount` block.
  [`setup.test.ts:374`](../../eval/setup.test.ts#L374)
