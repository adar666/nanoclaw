---
title: 'Scaffold the Isolated Eval Agent Group and Safety Checks'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '29fb1ad260bb79183a16dd617f27ab9cc3f3c023'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The Agent Evaluation Harness needs somewhere safe to run scenarios — a real agent group whose sessions structurally cannot leak a reply into a live chat. Nothing like it exists yet; every existing agent group has an origin chat.

**Approach:** A new top-level `eval/` package (mirrors `scripts/`: imports host modules directly, run via `tsx`, no separate `package.json`). `eval/setup.ts` idempotently creates one dedicated agent group (folder `eval`) reusing the exact `createAgentGroup` + `initGroupFilesystem` pattern `src/cli/resources/groups.ts`'s own `create` handler already uses. `eval/session.ts` provides a session-creation helper that hardcodes `messaging_group_id: null` (no parameter can override it — safety by construction, not by convention) and validates a `system:eval`-prefixed thread id, reusing `findSystemSession`/`createSession`/`initSessionFolder` the same way `resolveTaskSession` already does for scheduled tasks. `eval/safety.ts` adds the one check that construction *can't* close: destinations can be added later by unrelated code, so `assertNoDestinations` is a real runtime guard future stories call before spawning anything.

## Boundaries & Constraints

**Always:**
- `eval/setup.ts` exports `ensureAgentGroup(folder, name): AgentGroup` — check `getAgentGroupByFolder(folder)` first; if found, call `initGroupFilesystem(existing)` (repairs a missing workspace) and return it; else `id = \`ag-${randomUUID()}\``, `createAgentGroup(...)`, `initGroupFilesystem(...)`, return the new row. Exact mirror of `groups.ts`'s `create` handler (`src/cli/resources/groups.ts:155-178`).
- `ensureEvalScenarioGroup()` wraps it: `ensureAgentGroup('eval', 'Eval Harness (Scenario)')`. Leave a one-line comment noting Epic 2 Story 2.1 adds `ensureEvalJudgeGroup()` (folder `eval-judge`) alongside it — do not build the judge group now.
- `eval/session.ts` exports `EVAL_THREAD_PREFIX = 'system:eval'` and `resolveEvalSession(agentGroupId, threadId): { session: Session; created: boolean }`. Throw if `threadId` is not `EVAL_THREAD_PREFIX` or doesn't start with `` `${EVAL_THREAD_PREFIX}:` ``. Otherwise mirror `resolveTaskSession` (`src/session-manager.ts`) exactly: `findSystemSession` first, else build a `Session` with `id: \`eval-${randomUUID()}\``, `messaging_group_id: null`, `container_status: 'stopped'`, `agent_provider: null`, `last_active: null`, `created_at: new Date().toISOString()`, then `createSession(...)` + `initSessionFolder(agentGroupId, id)`.
- `eval/safety.ts` exports `assertNoDestinations(agentGroupId): void` — `getDestinations(agentGroupId).length > 0` throws a clear, named error (AD-4: loud failure, not silent skip).
- New `eval/tsconfig.json` (mirrors `container/agent-runner/tsconfig.json`'s standalone-config shape, `noEmit: true`, `include: ["eval/**/*"]`) + `package.json` script `"typecheck:eval": "tsc -p eval/tsconfig.json --noEmit"` — `eval/` is otherwise invisible to `pnpm exec tsc --noEmit` (root tsconfig's `include` is `src/**/*` only) and to `pnpm test` (`vitest.config.ts`'s `include` needs `'eval/**/*.test.ts'` added).
- `eval/setup.ts` calls `initDb(path.join(DATA_DIR, 'v2.db'))` then `runMigrations(db)` before any DB call, matching `scripts/init-first-agent.ts`'s own bootstrap.

**Ask First:**
- Whether to wire a CI job step for `pnpm run typecheck:eval` now — default to **not** touching `.github/workflows/ci.yml` in this story (every PR is affected by a CI change); flag it as a natural fast-follow instead.

**Never:**
- Never creates a session, container, or any spawn-path code in this story — no `runner.ts` exists yet (Story 1.4). `resolveEvalSession` is exercised only by this story's own unit tests, calling it directly.
- Never adds the judge agent group (`eval-judge`) — Epic 2, Story 2.1.
- Never touches `container_configs` (calendar override, mounts) — Story 1.2.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First run | No `eval` folder agent group exists | New group created, zero `agent_destinations` rows, filesystem scaffolded | N/A |
| Re-run (idempotent) | `eval` group already exists | Same group returned, no duplicate row, `initGroupFilesystem` re-run defensively | N/A |
| Valid eval session | `threadId = "system:eval:guest-resolution-known-name"` | Session created with `messaging_group_id: null`, that exact `thread_id` | N/A |
| Invalid thread id | `threadId = "not-system-prefixed"` | Nothing created | Throws, naming the expected prefix |
| Destinations present | A destination row exists for the eval group | — | `assertNoDestinations` throws, naming the count |
| Destinations empty | Fresh eval group, never had a destination | — | `assertNoDestinations` returns silently |

</frozen-after-approval>

## Code Map

- `src/cli/resources/groups.ts:155-178` — the `create` handler's idempotent-group-creation pattern (`getAgentGroupByFolder` → `createAgentGroup` + `initGroupFilesystem`); `eval/setup.ts` mirrors this exactly, not a new pattern.
- `src/session-manager.ts` (`resolveTaskSession`, `findSystemSession` import from `src/db/sessions.ts`, `initSessionFolder`) — the closest existing precedent for a `messaging_group_id: null` + `system:`-prefixed-thread session; `eval/session.ts`'s `resolveEvalSession` is the same shape, parameterized by an explicit thread id instead of a task series id.
- `src/modules/agent-to-agent/db/agent-destinations.ts` (`getDestinations`) — reused as-is for `assertNoDestinations`; no new destinations code.
- `src/db/agent-groups.ts`, `src/group-init.ts`, `src/db/connection.ts` (`initDb`), `src/db/migrations/index.ts` (`runMigrations`), `src/config.ts` (`DATA_DIR`, `GROUPS_DIR`) — reused unmodified.
- `scripts/init-first-agent.ts` — reference only, for the `initDb`/`runMigrations` bootstrap sequence a standalone `tsx`-run script needs.
- `container/agent-runner/tsconfig.json` — reference shape for the new standalone `eval/tsconfig.json`.
- `vitest.config.ts` — add `'eval/**/*.test.ts'` to `include`.

## Tasks & Acceptance

**Execution:**
- [x] `eval/tsconfig.json` -- new standalone typecheck config for `eval/` -- makes `eval/` typecheckable without disturbing the host's `src`-only build/dist pipeline
- [x] `package.json` -- add `"typecheck:eval": "tsc -p eval/tsconfig.json --noEmit"` -- discoverable command, matches the container's own separate-typecheck precedent
- [x] `vitest.config.ts` -- add `'eval/**/*.test.ts'` to `include` -- otherwise this story's own tests never run under `pnpm test`
- [x] `eval/setup.ts` -- `ensureAgentGroup`, `ensureEvalScenarioGroup`, DB bootstrap -- idempotent group creation
- [x] `eval/session.ts` -- `EVAL_THREAD_PREFIX`, `resolveEvalSession` -- construction-enforced null origin + validated thread id
- [x] `eval/safety.ts` -- `assertNoDestinations` -- the one runtime-checked (not construction-enforced) AD-4 guard
- [x] `eval/setup.test.ts`, `eval/session.test.ts`, `eval/safety.test.ts` -- vitest coverage for the I/O matrix above, against a real temp `better-sqlite3` DB (matching this project's existing DB-layer test convention — no mocking the DB itself)

**Acceptance Criteria:**
- Given `eval/setup.ts` has not run, when `ensureEvalScenarioGroup()` is called, then a group with folder `eval` exists and `getDestinations(group.id)` returns `[]`.
- Given the group already exists, when `ensureEvalScenarioGroup()` runs again, then `getAllAgentGroups().filter(g => g.folder === 'eval').length === 1`.
- Given a valid `system:eval:...` thread id, when `resolveEvalSession` runs, then the returned session has `messaging_group_id === null` and the exact thread id passed in.
- Given a non-`system:eval`-prefixed thread id, when `resolveEvalSession` runs, then it throws before calling `createSession`.
- Given an agent group with a destination row, when `assertNoDestinations` runs against it, then it throws; given zero destination rows, it returns without throwing.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors
- `pnpm exec vitest run eval/` -- expected: all new tests pass
- `pnpm exec tsc --noEmit` -- expected: unaffected (root tsconfig still excludes `eval/`, confirming no accidental coupling)
- `pnpm test` (full suite) -- expected: all pass, no regressions -- required because `vitest.config.ts`'s shared `include` array was edited, which every existing test in the repo depends on

## Suggested Review Order

**Idempotent group creation (entry point)**

- Start here — the idempotent-creation pattern every other file assumes, mirrored exactly from production's own `create` handler.
  [`setup.ts:25`](../../eval/setup.ts#L25)

- The one concrete group this story ships; a one-line comment marks where Epic 2's judge group attaches later.
  [`setup.ts:44`](../../eval/setup.ts#L44)

- Standalone CLI entry point — only fires on direct `tsx` execution, never on import.
  [`setup.ts:56`](../../eval/setup.ts#L56)

**Safety by construction — the session helper**

- `messaging_group_id: null` is hardcoded with no override parameter — the core of this story's safety claim.
  [`session.ts:26`](../../eval/session.ts#L26)

- Thread-id validation throws before any DB call reached — invalid input never gets as far as `createSession`.
  [`session.ts:27`](../../eval/session.ts#L27)

**Safety by runtime check — the one thing construction can't close**

- Destinations are a separate table unrelated code can populate later; this is the guard future spawn code must call first.
  [`safety.ts:14`](../../eval/safety.ts#L14)

**Build wiring — makes `eval/` visible to typecheck and tests**

- Standalone tsconfig, not `extends`-based — inheriting the root config's `rootDir` breaks on `eval/`'s cross-tree imports into `src/**` (verified empirically, reverted after landing).
  [`tsconfig.json:1`](../../eval/tsconfig.json#L1)

- New script, discoverable alongside the container's own separate-typecheck precedent.
  [`package.json:16`](../../package.json#L16)

- `eval/**/*.test.ts` added so this story's own tests actually run under `pnpm test`.
  [`vitest.config.ts:14`](../../vitest.config.ts#L14)

**Tests — the I/O matrix, one file per module**

- Idempotency + zero-destinations-on-creation coverage.
  [`setup.test.ts:28`](../../eval/setup.test.ts#L28)

- Null-origin, valid/invalid thread-id, and the substring-prefix trap (`system:evaluation:` must not pass).
  [`session.test.ts:36`](../../eval/session.test.ts#L36)

- Throws-vs-silent coverage for the one runtime guard.
  [`safety.test.ts:25`](../../eval/safety.test.ts#L25)

