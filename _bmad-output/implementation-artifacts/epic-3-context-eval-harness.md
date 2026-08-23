# Epic 3 Context: Clean Up After a Crash

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

An operator can run `pnpm eval sweep` at any time — independent of any in-progress or completed scenario run — to find and remove orphaned events left on the eval-test calendar by a crashed or interrupted run, with a safe no-op when the calendar is already clean. This is a standalone safety-net tool: it exists because a scenario's own per-run cleanup (Epic 1) only fires on a clean exit, and a crash or interruption mid-run can leave real test events behind on the eval-test calendar indefinitely with no other mechanism to find them. Epic 3 is a single story and does not require Epic 2.

## Stories

- Story 3.1: Standalone stale-event sweep

## Requirements & Constraints

- The sweep must find and remove orphaned eval-test-calendar events left behind by a crashed or interrupted run, independent of any single scenario's own per-run cleanup.
- Running the sweep against a calendar with orphaned events removes them and reports what was removed; running it against an already-clean calendar is a safe no-op — no writes, nothing reported as removed.
- The sweep must never touch Uriel's real household/personal calendars — only the dedicated eval-test calendar id.
- The sweep is invoked on demand (`pnpm eval sweep`), with no CI or scheduled-job dependency — same on-demand-only posture as the rest of the harness (real Claude/API cost considerations don't apply here since sweep itself makes no model calls, but the harness overall is bounded to on-demand use by design).
- Two concurrent invocations must not race: a sweep overlapping an in-progress scenario run must fail loud with a clear message rather than proceeding, not silently skip or silently corrupt shared state.

## Technical Decisions

- `sweep.ts` is its own CLI entry point, standalone from the `cli.ts run` pipeline — not part of `loader → runner → judge → reporter`. It talks directly to the eval-test calendar.
- **Reuses AD-7's calendar isolation**: the eval-test calendar id is the same one registered in the eval agent group's `calendar_registry` override (`{ name: "uriel", calendarId: <eval-test-calendar-id> }`, set up in Epic 1 Story 1.2). `sweep.ts` operates against that same calendar id — no separate calendar-isolation code, no new override mechanism.
- **Reuses AD-8's lock**: `sweep.ts` acquires its own lock via the same `lock.ts` module built in Epic 1 Story 1.3 (mtime-based stale-lock pattern from `container/agent-runner/src/mcp-tools/documents.ts`'s `withLock()`/`LOCK_STALE_MS`), before doing anything else. If a scenario run currently holds the lock, `sweep.ts`'s acquisition attempt fails immediately with a clear "another eval run is in progress" style message — it never proceeds to race the in-progress run's shared workspace state.
- No new dependency, no new runtime — same stack as the rest of `eval/` (TypeScript/Node host runtime, `better-sqlite3` 11.10.0 pinned, `tsx` ^4.19.0). `eval/` never opens its own raw `better-sqlite3` handle against `data/v2.db`'s tables; any DB interaction goes through existing host module functions only (this sweep is calendar-API-facing, not DB-facing, so this mostly doesn't apply here beyond the general convention).
- Structural placement: `eval/sweep.ts`, alongside `eval/lock.ts` which it depends on.

## Cross-Story Dependencies

- Depends on Epic 1 Story 1.2 (calendar isolation / eval-test calendar id registered via the AD-7 override) — the sweep needs a concrete eval-test calendar id to operate against.
- Depends on Epic 1 Story 1.3 (`lock.ts`, the run-exclusivity lock) — the sweep reuses this module directly rather than implementing its own locking.
- Does not depend on Epic 2 (LLM judge) at all — the sweep makes no judging calls and doesn't touch the judge agent group.
