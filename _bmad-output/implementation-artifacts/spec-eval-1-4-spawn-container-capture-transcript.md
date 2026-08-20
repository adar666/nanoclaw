---
title: 'Spawn the Real Container and Capture the Outbound Transcript'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '46f710f80833f347e5814ba6eca881eb748058ee'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing yet actually runs a scenario. The safety substrate (Stories 1.1–1.3) exists but is never exercised against a real container.

**Approach:** `eval/runner.ts`'s `runScenarioTurn(agentGroupId, threadId, message, opts?)` drives one real turn end to end, entirely via existing host functions (AD-2): `resolveEvalSession` → `assertNoDestinations` (before any spawn, AD-4) → `writeSessionMessage` → `wakeContainer` → poll `processing_ack`/`messages_out` on the session's own `outbound.db` until the specific message reaches a terminal status → return the captured transcript filtered by `in_reply_to`, so a reused session (same scenario id run twice) never leaks a prior run's messages into a new capture. `eval/session.ts` (Story 1.1) gains the AD-6 exclusion marker this requires: a new `sessions.managed_by` column (migration), set to `'eval'` by `resolveEvalSession`.

**Test strategy (explicit, not left implicit):** `eval/runner.test.ts` is fast and mocks `wakeContainer` — it seeds `outbound.db` directly to simulate a container's response and verifies the polling/timeout/transcript-filtering/marker logic deterministically, no Docker, no API cost, runs in the normal `pnpm test` suite. `eval/runner.live.test.ts` is a genuinely separate, explicitly-gated real end-to-end test (real container, real Claude call, real tokens spent) — excluded from `vitest.config.ts`'s default `include` and from CI, run only via a new `pnpm run test:eval-live` the operator triggers deliberately.

## Boundaries & Constraints

**Always:**
- New migration (`025-sessions-managed-by.ts`) adds `sessions.managed_by TEXT` (nullable, no default — existing rows/callers unaffected). Registered in `migrations/index.ts`'s array; `src/db/schema.ts`'s reference copy updated to match (that file is documentation only, not executed).
- `src/types.ts`'s `Session` interface gains `managed_by?: string | null` (optional — every existing `Session` object literal across the host compiles unchanged). `src/db/sessions.ts`'s `createSession` binds it with an explicit `session.managed_by ?? null` default so callers that omit the field don't hit a "missing named parameter" error from `better-sqlite3`.
- `eval/session.ts`'s `resolveEvalSession` sets `managed_by: 'eval'` on the `Session` object it builds — the AD-6 marker `host-sweep.ts`'s own exclusion (Story 1.5) will filter on. This story does not touch `host-sweep.ts` itself.
- `eval/runner.ts` exports `runScenarioTurn(agentGroupId: string, threadId: string, message: string, opts?: RunOptions): Promise<ScenarioTurnResult>`. Flow, in order: `resolveEvalSession` (Story 1.1) → `assertNoDestinations(agentGroupId)` (Story 1.1, AD-4 — before any spawn) → `writeSessionMessage(agentGroupId, sessionId, { id: <generated>, kind: 'chat', timestamp, content: message, trigger: 1 })` (`src/session-manager.ts`) → `wakeContainer(session)` (`src/container-runner.ts`) → poll `openOutboundDb(agentGroupId, sessionId)` (`src/session-manager.ts`) for `processing_ack WHERE message_id = <the generated id>` reaching a terminal status (`'completed' | 'failed' | 'cancelled'`) or `opts.timeoutMs` elapsing (default `300_000`, `opts.pollIntervalMs` default `1_000` — both overridable, same testability rationale as Story 1.3's `LockOptions`) → on completion, read `messages_out WHERE in_reply_to = <the generated id>` and return it as the transcript.
- `ScenarioTurnResult` shape: `{ status: 'completed' | 'failed' | 'cancelled' | 'timeout'; transcript: OutboundMessage[]; sessionId: string }` — `'timeout'` is this module's own outcome (the poll loop gave up), distinct from the container-reported terminal statuses.
- `eval/runner.test.ts`: `vi.mock('../src/container-runner.js', ...)` stubs `wakeContainer` to resolve `true` without spawning anything; each test writes its own fake `processing_ack`/`messages_out` rows directly into a real temp `outbound.db` (via `ensureSchema`/`openOutboundDbRw`, matching Story 1.1/1.2's real-DB-not-mocked convention for everything except the spawn boundary itself) to simulate what a real container would have written.
- `eval/runner.live.test.ts`: no mocking at all — calls `runScenarioTurn` for real against the real `eval` agent group (`ensureEvalScenarioGroup()` first) with a trivial scripted message, asserts a real transcript comes back. New `package.json` script `"test:eval-live": "vitest run eval/runner.live.test.ts"`. `vitest.config.ts`'s `eval/**/*.test.ts` include entry is narrowed to exclude `*.live.test.ts` (e.g. `eval/**/!(*.live).test.ts`, or an explicit `exclude` entry — whichever glob form `vitest` actually honors, verify empirically before committing to the syntax, matching Story 1.2's own empirically-verified `eval/tsconfig.json` fix). CLAUDE.md's "Running and verifying" section gets one line documenting `test:eval-live` and that it costs real tokens.

**Ask First:**
- If `EVAL_TEST_CALENDAR_ID` isn't actually set in `.env` when `test:eval-live` is run, that's expected to fail loud (Story 1.2's own hard-failure design) — not something this story works around. Confirm with the operator before actually running `test:eval-live` for the first time, since it's a real, billed action.

**Never:**
- Never wires `runScenarioTurn` into a CLI entry point — that's Story 1.7. This story is the callable primitive only.
- Never adds `test:eval-live` to `.github/workflows/ci.yml` — no real credentials exist in CI, and it costs real money on every run.
- Never touches `host-sweep.ts` — Story 1.5's exclusion filter is what actually reads the `managed_by` marker; this story only writes it.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Turn completes normally | Container processes the message, writes `processing_ack: completed` + a reply row | `status: 'completed'`, `transcript` contains that reply | N/A |
| Container reports failure | `processing_ack: failed` for the message | `status: 'failed'`, transcript reflects whatever was written before failure | N/A |
| Poll timeout | `processing_ack` never reaches a terminal status within `timeoutMs` | `status: 'timeout'` | No throw — a timeout is a real, reportable scenario outcome, not an exceptional condition |
| Reused session, second run | Session already has older `messages_out` rows from a prior run of the same scenario id | Transcript contains only rows where `in_reply_to` matches this run's own message id | N/A |
| Destinations present | `assertNoDestinations` would throw for this agent group | `runScenarioTurn` throws before writing the message or waking anything | Propagates `assertNoDestinations`'s own error |

</frozen-after-approval>

## Code Map

- `src/container-runner.ts` (`wakeContainer`) — reused unmodified; the actual spawn.
- `src/session-manager.ts` (`writeSessionMessage`, `openOutboundDb`) — reused unmodified.
- `src/db/schema.ts` (`OUTBOUND_SCHEMA`) — `processing_ack`/`messages_out` column reference for the poll query.
- `src/db/sessions.ts` (`createSession`) — gains the `managed_by ?? null` default binding.
- `src/types.ts` (`Session`) — gains optional `managed_by`.
- `eval/session.ts` (`resolveEvalSession`, Story 1.1) — sets `managed_by: 'eval'`.
- `eval/safety.ts` (`assertNoDestinations`, Story 1.1) — called before spawn.
- `src/db/migrations/024-container-config-calendar-registry.ts`, `023-voice-always-engage.ts` — pattern for the new migration.
- `src/delivery.ts` (`getDueOutboundMessages` import site) — reference for how the host itself reads `messages_out`; `runner.ts`'s own poll query is a direct raw query against the already-open `outbound.db` handle (per-session file, not the central DB — AD-2's "no raw handles" constraint is about `data/v2.db` only).

## Tasks & Acceptance

**Execution:**
- [x] `src/db/migrations/025-sessions-managed-by.ts` -- `ALTER TABLE sessions ADD COLUMN managed_by TEXT` -- the AD-6 marker column
- [x] `src/db/migrations/index.ts` -- register migration025
- [x] `src/db/schema.ts` -- add `managed_by` to the reference copy of the `sessions` table
- [x] `src/types.ts` -- `Session.managed_by?: string | null`
- [x] `src/db/sessions.ts` -- `createSession` binds `managed_by ?? null`
- [x] `eval/session.ts` -- `resolveEvalSession` sets `managed_by: 'eval'`
- [x] `eval/runner.ts` -- `runScenarioTurn`, `RunOptions`, `ScenarioTurnResult`
- [x] `eval/runner.test.ts` -- fast, mocked-spawn coverage for the I/O matrix above
- [x] `eval/runner.live.test.ts` -- real end-to-end test, excluded from the default suite
- [x] `package.json` -- `"test:eval-live": "vitest run eval/runner.live.test.ts"`
- [x] `vitest.config.ts` -- exclude `*.live.test.ts` from the default `eval/**/*.test.ts` include
- [x] `CLAUDE.md` -- document `test:eval-live` and its real cost

**Acceptance Criteria:**
- Given a scenario's message and a mocked container response reaching `processing_ack: completed`, when `runScenarioTurn` runs, then it returns `status: 'completed'` with the transcript containing exactly the rows whose `in_reply_to` matches the message it wrote.
- Given the same session already has older `messages_out` rows from a prior run, when `runScenarioTurn` runs again, then the returned transcript excludes them.
- Given `processing_ack` never reaches a terminal status, when `opts.timeoutMs` elapses, then `runScenarioTurn` returns `status: 'timeout'` without throwing.
- Given the eval agent group has a destination row, when `runScenarioTurn` runs, then it throws before `writeSessionMessage`/`wakeContainer` are ever called.
- Given `pnpm test` (the default suite), when it runs, then `eval/runner.live.test.ts` is not collected — confirmed by its absence from the test-file list, not just "it happened not to fail."
- Given `pnpm run test:eval-live` is actually invoked (a real, billed, manual action — confirm with the operator first), when it completes, then a real transcript comes back from a real container turn.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors
- `pnpm exec tsc --noEmit` -- expected: no errors (touches `src/types.ts`, `src/db/sessions.ts`, a new migration, `src/db/schema.ts`)
- `pnpm exec vitest run eval/` -- expected: all pass; confirm `eval/runner.live.test.ts` is NOT among the collected files
- `pnpm test` (full suite) -- expected: all pass, no regressions
- `pnpm run test:eval-live` -- NOT run automatically as part of this story's own verification; confirm with the operator before running it manually

## Suggested Review Order

**The critical fix: `test:eval-live` couldn't run its own test (entry point)**

- Start here — a review layer *empirically proved* vitest's `exclude` blocks a file even as an explicit CLI path, so the original `exclude`-based design made the live test unreachable by its own dedicated script.
  [`vitest.config.ts:12`](../../vitest.config.ts#L12)

- The fix: self-gate via `skipIf` instead of config-level `exclude` — collected by the default suite (shows as skipped, zero cost), actually runs only when `EVAL_LIVE_TEST` is set.
  [`runner.live.test.ts:35`](../../eval/runner.live.test.ts#L35)

**Safety-ordering fixes in `runScenarioTurn`**

- `assertNoDestinations` now runs before `resolveEvalSession`, not after — a failed check no longer leaves an orphaned session row behind.
  [`runner.ts:86`](../../eval/runner.ts#L86)

- `wakeContainer`'s return value is now checked — a spawn failure fails fast instead of silently polling for the full 5-minute timeout.
  [`runner.ts:99`](../../eval/runner.ts#L99)

- The poll loop's off-by-one: a completion written right at the deadline is no longer reported as `'timeout'`.
  [`runner.ts:119`](../../eval/runner.ts#L119)

**The AD-6 marker — typo-proofing and backfill**

- `EVAL_MANAGED_BY` constant so the literal `'eval'` string exists exactly once, not re-typed at each call site.
  [`session.ts:27`](../../eval/session.ts#L27)

- The session-reuse branch now backfills the marker if a pre-existing session predates it — defensive, not currently reachable, but closes a real latent gap cheaply.
  [`session.ts:45`](../../eval/session.ts#L45)

**Tests — regressions for the fixes above, plus what review surfaced**

- `runner.test.ts` gained: `'cancelled'` status coverage, spawn-failure-fails-fast, opts validation, a `managed_by` DB-round-trip assertion, and a stronger destination-guard assertion (no session created at all, matching the new ordering). Also fixed the fixture's `seq` to use odd numbers, matching the documented host-even/container-odd convention.
  [`runner.test.ts:151`](../../eval/runner.test.ts#L151)
