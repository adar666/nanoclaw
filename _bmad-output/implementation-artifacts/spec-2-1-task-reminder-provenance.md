---
title: 'Task/Reminder Provenance'
type: 'feature'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'be3680457ac46dbe59bc40ccbf6bc1822d6730c6'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A user asking "why do I get this reminder" has no answer today — `ncl tasks create` records only `originSessionId` (a session, not who asked or why), and nothing survives beyond that.

**Approach:** Capture one small, additive `provenance` record — who/what triggered creation, an optional agent-supplied reason, when — inside the task's existing `content` JSON blob, fixed at the series' original creation. Surface it through `ncl tasks get`/`list`. No new table, no migration.

## Boundaries & Constraints

**Always:** `provenance` uses the one shape this spec's whole initiative reuses everywhere: `{ triggeredBy: 'user' | 'agent'; requesterUserId?: string; reason?: string; at: string }` (ISO-8601 UTC). `triggeredBy` is `'agent'` when `ctx.caller === 'agent'`, `'user'` for a host-typed `ncl` command. `provenance` is captured once, at series creation, and never regenerated or overwritten by a later recurrence fire — `insertRecurrence`'s existing verbatim `content` copy already achieves this by construction, no change needed there.

**Ask First:** None — fully specified.

**Never:** No `requesterUserId` value is fabricated — `CallerContext` (`src/cli/frame.ts`) carries no user identity for either caller kind at this layer, so the field stays `undefined` for every task created through this dispatch path until a future change threads real user identity through `ncl`. No `message` field (the free-text triggering chat message) is captured in this story — no natural source exists at `ncl tasks create` time; `reason` (agent-supplied, optional, mirroring `install_packages`/`add_calendar`'s existing `reason` precedent) is the only free-text field this story adds. No backfill — a task row created before this ships has no `provenance` key, and every reader treats that as "unknown," never an error.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Agent-created task, no `--reason` | `ncl tasks create` from an agent session, no `reason` arg | `content.provenance = { triggeredBy: 'agent', at: <ISO> }` — `requesterUserId`/`reason` both absent | N/A |
| Agent-created task, with `--reason` | Same, `--reason "user asked to check every Monday"` | `content.provenance.reason` set to the given string | N/A |
| Host-typed task (operator CLI) | `ncl tasks create` with `caller: 'host'` | `content.provenance = { triggeredBy: 'user', at: <ISO> }` | N/A |
| Pre-existing task row (no `provenance` key) | A task row created before this ships | `ncl tasks get`/`list` shows provenance as absent/unknown, never throws on the missing key | N/A |
| Recurring series, second+ fire | `insertRecurrence` creates the next occurrence from a series whose first row already has `provenance` | The new row's `content.provenance` is byte-identical to the original — reflects the series' original creation, not a new "why" per fire | N/A |

</frozen-after-approval>

## Code Map

- `src/modules/scheduling/create.ts:109-135` -- `prepareScheduledTask` — no change needed (provenance isn't a scheduling-semantics concern, it rides through `createScheduledTask`'s own options).
- `src/modules/scheduling/create.ts:138-161` -- `createScheduledTask`. `options` gains `provenance?: TaskProvenance` (new exported type, the shared shape above). `content: JSON.stringify({ prompt, script, originSessionId, provenance: options?.provenance ?? undefined })` — `JSON.stringify` already drops an `undefined` value's key entirely, so an absent `provenance` produces no key at all on the stored row, not a null placeholder.
- `src/modules/scheduling/db.ts` -- `insertRecurrence` (per epic context, copies `content` verbatim) — read-only reference, confirm no change needed; this is exactly why AD-8's "fixed at creation" requirement needs no extra code.
- `src/cli/resources/tasks.ts:109-122` -- `parseContent`. Add `provenance: TaskProvenance | undefined` to the parsed/returned shape (present only when the parsed JSON has a `provenance` key of the right shape; anything else — legacy plain-string content, a hand-corrupted row — resolves to `undefined`, never a thrown error).
- `src/cli/resources/tasks.ts:124-140` -- `toOutput`. Flatten into the existing snake_case output convention (matches `origin_session_id`'s existing style): `triggered_by`, `requester_user_id`, `reason`, `provenance_at` — each `null` when `content.provenance` is absent or the specific sub-field wasn't set.
- `src/cli/resources/tasks.ts:175-195` -- `createTask`. Read a new optional `--reason` arg (`normalizeNullableString(args.reason) ?? undefined`, same helper already used for `recurrence`/`script`). Build `provenance: { triggeredBy: ctx.caller === 'agent' ? 'agent' : 'user', reason, at: new Date().toISOString() }` (`requesterUserId` omitted — not resolvable, per Boundaries) and pass it into `createScheduledTask`'s new `options.provenance`.
- `src/cli/resources/tasks.ts:293-315` -- `getTask`. Already spreads `toOutput(...)` and adds a few extra fields (`script`, `completed_runs`, etc.) — the new flattened provenance fields arrive for free via `toOutput`'s own change, no separate edit needed here beyond confirming it.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/scheduling/create.ts` -- export a `TaskProvenance` type; thread `options.provenance` into the stored `content` JSON -- the one place provenance actually gets persisted
- [x] `src/cli/resources/tasks.ts` -- `parseContent`/`toOutput` read and flatten `provenance`; `createTask` builds it from `ctx`/`--reason` and passes it through -- the capture + surface path
- [x] `src/modules/scheduling/create.test.ts` (new) -- unit tests: `createScheduledTask` with/without `provenance` in options, confirm exact stored JSON shape
- [x] `src/cli/resources/tasks.test.ts` -- tests for every I/O Matrix row: agent-created with/without `--reason`, host-created, pre-existing row without `provenance`, recurrence copies verbatim -- `pnpm test`
- [x] `src/cli/resources/tasks.ts` -- **round 1 patch**: `str()` instead of `normalizeNullableString()` for `--reason`; 120-char display cap; softened `--reason` description text
- [x] `container/agent-runner/src/mcp-tools/scheduling.instructions.md` -- **round 1 patch**: mention `--reason`
- [x] `src/cli/resources/tasks.test.ts` -- **round 1 patch**: host+reason, literal-"null", 120-char cap, malformed-provenance, explicit-null, update-preserves-provenance tests

**Acceptance Criteria:**
- Given an agent-caller `ncl tasks create` with `--reason`, when the row is inspected, then `content.provenance` has `triggeredBy: 'agent'`, the given `reason`, and an `at` timestamp
- Given a host-caller `ncl tasks create`, when the row is inspected, then `content.provenance.triggeredBy` is `'user'`
- Given a task row from before this ships (no `provenance` key), when `ncl tasks get`/`list` runs, then it returns cleanly with the new fields `null`, never throwing
- Given a recurring series' second fire, when the new occurrence row is inspected, then `content.provenance` is identical to the first occurrence's — not regenerated

## Spec Change Log

- **Round 1 review (patch-only, no bad_spec loopback):** 3-layer review found no intent/spec defects — every finding was patch, defer, or reject. Applied directly: switched `--reason` parsing from `normalizeNullableString` to `str()` (the former treats literal `"null"`/`"none"` as a clear-the-field signal — right for `--recurrence`/`--script`, wrong for free-text reason); added the same 120-char display cap `prompt` already has; softened the `--reason` arg's description (it overclaimed visibility in the human-readable `tasks list` table, which this story deliberately doesn't touch); added a `scheduling.instructions.md` mention so the agent actually knows to use `--reason`; added a naming-choice comment for `provenance_at`; added tests for the host-caller `--reason` path, literal-`"null"` reason, the 120-char cap, `parseProvenance`'s malformed-shape branches, an explicit-`null` provenance key, and `ncl tasks update` leaving provenance untouched. Deferred: `requester_user_id` staying permanently unpopulated (already an explicit, frozen Design Notes decision, not new); no way to edit `reason` after creation (real, out of this story's scope).

## Design Notes

**Why `requesterUserId` stays unpopulated in this story:** `CallerContext` (`src/cli/frame.ts`) is deliberately thin — an agent caller carries `sessionId`/`agentGroupId`/`messagingGroupId`, never a resolved end-user identity, and a host caller carries nothing but `caller: 'host'`. Threading a real user id through would mean a real, separate change to the dispatch layer itself (resolving the sender of whichever chat message prompted the agent to call `ncl tasks create` — not available at this layer today). Leaving the field structurally present but always empty here is honest about the gap rather than inventing a value or silently dropping the field from AD-7's shared shape.

**Why no `message` field:** unlike `triggeredBy`/`reason`, there's no natural plumbing at `ncl tasks create` time carrying the literal chat text that prompted the call — adding one would mean either a new CLI argument the agent has to remember to pass verbatim (redundant with `--reason`, which already captures the "why" in the agent's own words) or deeper session-log integration out of this story's scope.

## Verification

**Commands:**
- `pnpm test -- create.test.ts` -- expected: new scheduling tests pass (adjust filename if folded into an existing file)
- `pnpm test -- tasks.test.ts` -- expected: all new + existing task tests pass
- `pnpm exec tsc --noEmit -p .` -- expected: clean

## Suggested Review Order

**Shared shape — the type this whole initiative reuses**

- Entry point: `TaskProvenance`, the one shape every domain in this spec writes.
  [`create.ts:42`](../../src/modules/scheduling/create.ts#L42)

- Where it's actually persisted, additive on the existing `content` JSON.
  [`create.ts:152`](../../src/modules/scheduling/create.ts#L152)

**Capture + surface path**

- Defensive parsing: a malformed/legacy row resolves to absent, never throws.
  [`tasks.ts:114`](../../src/cli/resources/tasks.ts#L114)

- Flattened into the existing snake_case output convention, with the round-1 display cap and naming-choice comment.
  [`tasks.ts:146`](../../src/cli/resources/tasks.ts#L146)

- Where `--reason`/`ctx.caller` actually become a provenance record (round 1: `str()` fix for the literal-"null" bug).
  [`tasks.ts:211`](../../src/cli/resources/tasks.ts#L211)

**Peripherals — tests and docs**

- Full I/O-matrix + round-1 regression coverage.
  [`tasks.test.ts:355`](../../src/cli/resources/tasks.test.ts#L355)

- Agent-facing guidance so the capability actually gets used.
  [`scheduling.instructions.md:25`](../../container/agent-runner/src/mcp-tools/scheduling.instructions.md#L25)
