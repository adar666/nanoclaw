---
title: 'Host-Sweep Exclusion for Eval Sessions'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'ebb771d8376909af858869bd9c68f0acc7efa613'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `host-sweep.ts`'s always-running 60s tick (this repo's real, live production install — the service is never stopped for an eval run) still sees eval sessions as ordinary sessions: it can duplicate-spawn a container the eval CLI already spawned (its own `isContainerRunning` state is process-local, disjoint from the eval CLI's separate process), or apply stuck/kill/retry logic meant for a real user turn to a scenario run.

**Approach:** The fix is smaller and lower-risk than the story's own name suggests — `host-sweep.ts`'s own body never needs to change. Every session `host-sweep.ts` (and `delivery.ts`, and the `ncl tasks` CLI resource) ever processes comes from exactly two shared query functions, `getActiveSessions()`/`getRunningSessions()` in `src/db/sessions.ts` — add `AND managed_by IS NULL` to both, and eval sessions (Story 1.4's marker) never enter the pipeline that drives spawn/kill/retry decisions in the first place. Verified against every real call site (`host-sweep.ts`, `delivery.ts`, `src/cli/resources/tasks.ts`) that this exclusion is safe everywhere it applies, and that `ncl sessions list` (admin visibility) uses a separate, unfiltered query untouched by this change.

## Boundaries & Constraints

**Always:**
- `src/db/sessions.ts`'s `getActiveSessions()` query becomes `SELECT * FROM sessions WHERE status = 'active' AND managed_by IS NULL`.
- `src/db/sessions.ts`'s `getRunningSessions()` query becomes `SELECT * FROM sessions WHERE container_status IN ('running', 'idle') AND managed_by IS NULL`.
- New `src/db/sessions.test.ts` (this file doesn't exist yet — `src/db/sessions.ts` currently has zero direct unit test coverage): both functions tested directly against a real temp DB — an eval-marked session (`managed_by: 'eval'`) is excluded, a normal session (`managed_by: null`) is included, mixed sets return only the normal ones. This is the "dedicated wiring test" the epic's own AC calls for (matching the AD-15 env-inheritance test precedent CLAUDE.md already documents for this exact class of gap).
- `host-sweep.ts`'s own top-of-file doc comment gains one line cross-referencing where the eval exclusion actually lives (`getActiveSessions()`) — for discoverability, since a future reader searching this file for "eval" would otherwise find nothing.
- This is a live-deploy change to code the always-running production host service executes every 60 seconds against the real install DB. Verify with the **full** `pnpm test` suite (not just the new test), matching CLAUDE.md's own standing caution for exactly this class of change.

**Ask First:**
- Whether to actually restart the live host service (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`) after this change lands — confirm with the operator before doing it; a real service restart affects the actual live household assistant mid-use. The change is inert (an unused code path) until the service picks it up on its next restart, so this isn't blocking for the commit itself.

**Never:**
- Never modifies `host-sweep.ts`'s control flow, `sweepSession()`, `decideStuckAction()`, or any of the stuck/kill/retry logic — none of it needs to change; eval sessions simply never reach it.
- Never touches `src/cli/resources/sessions.ts` (`ncl sessions list`) — confirmed it doesn't call either modified function; admin visibility into eval sessions (for debugging) is preserved by construction, not by extra code.
- Never restarts the live service as part of this story's own implementation — that's the separate, explicitly-confirmed operational step above.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Eval session, active | `managed_by: 'eval'`, `status: 'active'` | Excluded from `getActiveSessions()` | N/A |
| Normal session, active | `managed_by: null`, `status: 'active'` | Included in `getActiveSessions()`, unchanged from today | N/A |
| Eval session, running | `managed_by: 'eval'`, `container_status: 'running'` | Excluded from `getRunningSessions()` | N/A |
| Normal session, running | `managed_by: null`, `container_status: 'running'` | Included in `getRunningSessions()`, unchanged from today | N/A |
| Mixed set | Both eval and normal sessions active in the same DB | Only normal sessions returned, in existing order | N/A |

</frozen-after-approval>

## Code Map

- `src/db/sessions.ts` (`getActiveSessions`, `getRunningSessions`) — the two functions modified.
- `src/host-sweep.ts` (`sweep()` line ~160 `getActiveSessions()` call) — confirmed this is the only session-discovery entry point; no other change needed here beyond the one doc-comment line.
- `src/delivery.ts`, `src/cli/resources/tasks.ts` — the other two real call sites, confirmed safe to receive the same filtered result (verified by reading each: `delivery.ts` never spawns containers, `tasks.ts`'s `getActiveSessions()` use is the human-operator-only "no session/group specified" fallback for `ncl tasks`, where eval sessions correctly have nothing to show since they never have scheduled tasks).
- `src/cli/resources/sessions.ts` — confirmed it does NOT call either modified function (grepped all call sites project-wide); `ncl sessions list` is unaffected.
- `eval/session.ts` (`EVAL_MANAGED_BY`, Story 1.4) — the marker value this story's filter matches against.

## Tasks & Acceptance

**Execution:**
- [x] `src/db/sessions.ts` -- add `AND managed_by IS NULL` to `getActiveSessions()` and `getRunningSessions()`
- [x] `src/db/sessions.test.ts` -- new file, direct coverage for the I/O matrix above
- [x] `src/host-sweep.ts` -- one doc-comment line cross-referencing the exclusion's real location

**Acceptance Criteria:**
- Given a DB with one eval-marked session and one normal session, both `status: 'active'`, when `getActiveSessions()` runs, then it returns only the normal session.
- Given the same setup with `container_status` instead, when `getRunningSessions()` runs, then it returns only the normal session.
- Given `pnpm test` (full suite), when it runs, then all existing tests still pass — confirming no non-eval session is accidentally excluded by the added clause.

## Verification

**Commands:**
- `pnpm exec tsc --noEmit` -- expected: no errors
- `pnpm exec vitest run src/db/sessions.test.ts` -- expected: new tests pass
- `pnpm test` (full suite) -- expected: all pass, no regressions -- required, not optional, given this touches the always-running production sweep's session-discovery path

## Suggested Review Order

**The exclusion itself (entry point)**

- Start here — the filter checks specifically for `managed_by <> 'eval'`, not "any non-null value." A review finding: the original version would have silently excluded a real session from sweep/delivery if any future feature ever reused this column with a different marker.
  [`sessions.ts:133`](../../src/db/sessions.ts#L133)

- `getRunningSessions` — same fix, same reasoning; this one backs `delivery.ts`'s 1-second poll, not just the 60s sweep.
  [`sessions.ts:140`](../../src/db/sessions.ts#L140)

**Closing the self-contradiction: "admin visibility preserved" wasn't quite true**

- `ncl sessions list`/`get` never surfaced `managed_by` at all — a review finding — so an admin couldn't actually tell an eval session apart from a real one despite the doc comment's own claim. Added to the CRUD resource's visible columns.
  [`sessions.ts (CLI resource):45`](../../src/cli/resources/sessions.ts#L45)

**Tests — the exclusion, plus the fix for the broadened-blast-radius finding**

- The new "non-eval, non-null marker stays visible" test — directly regression-tests the `<> 'eval'` vs. `IS NULL` distinction above.
  [`sessions.test.ts:86`](../../src/db/sessions.test.ts#L86)

**Documentation catch-up — three spots said "not yet built"/"planned"**

- `types.ts`, `docs/db-central.md`, and the migration file's own doc comments all still described this exclusion in future tense after it shipped — fixed in all three (a review finding, easy to miss since none of them are code).
