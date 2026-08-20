---
title: 'Calendar Isolation and Household people.md Mount for the Eval Group'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'a40d4f33c055dfa90f8cd1ab898c83d1a4df68a7'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The eval agent group (Story 1.1) has no calendar isolation and no guest-resolution ground truth — `resolveCalendarIds()` would let a scenario resolve `"uriel"` to `primary`, Uriel's real calendar, and the group has no memory of household people to resolve a guest name against.

**Approach:** `ensureEvalScenarioGroup()` gains two more provisioning steps: register a `calendar_registry` override `{ name: "uriel", calendarId: <EVAL_TEST_CALENDAR_ID> }` (reusing `calendar.ts`'s existing "registry wins over built-in on name collision" mechanism — no new isolation code), and read-only-mount `household`'s real `people.md` at the exact `hostPath`/`containerPath` triple already live on `dm-with-uriel`/`dm-with-partner` (verified against the real DB) and already present in `~/.config/nanoclaw/mount-allowlist.json` — no allowlist change needed. The real calendar id is an operator-provided precondition: the host process has no path to live Google Calendar credentials (only containers get those via OneCLI), so it can't create the calendar itself — it's read from `.env`'s `EVAL_TEST_CALENDAR_ID`, set once by the operator after manually creating a dedicated calendar and sharing it with the connected account.

## Boundaries & Constraints

**Always:**
- `src/container-config.ts` exports `CALENDAR_ID_RE` (moved from `src/cli/resources/groups.ts`, which now imports it from there) — single source of truth for the calendar-id shape check, and lets `eval/setup.ts` reuse it without importing `groups.ts`'s CLI-resource-registration module just for a regex.
- `eval/setup.ts` exports `ensureEvalCalendarOverride(agentGroupId): void`: resolves `EVAL_TEST_CALENDAR_ID` via `process.env.EVAL_TEST_CALENDAR_ID || readEnvFile(['EVAL_TEST_CALENDAR_ID']).EVAL_TEST_CALENDAR_ID` (exact pattern `src/config.ts` already uses). If unset, throws naming the exact manual step: create a dedicated Google Calendar, share it with the connected OneCLI account, set `EVAL_TEST_CALENDAR_ID` in `.env`. Validates the value against `CALENDAR_ID_RE`, throwing the same message shape `groups.ts`'s `add-calendar` handler uses on a bad format. Reads `getContainerConfig(agentGroupId).calendar_registry`, filters out any existing `"uriel"` entry, pushes `{ name: "uriel", calendarId }`, writes via `updateContainerConfigJson(agentGroupId, 'calendar_registry', ...)` — exact mirror of `groups.ts`'s `add-calendar` handler body.
- `eval/setup.ts` exports `ensureEvalPeopleMount(agentGroupId): void`: `hostPath = path.join(GROUPS_DIR, 'household', 'memory', 'household', 'people.md')`, `containerPath = 'household-shared/people.md'`, `readonly: true` — the exact triple already live on `dm-with-uriel`/`dm-with-partner` (confirmed via `container_configs.additional_mounts`) and already allowlisted (file-level entry, `~/.config/nanoclaw/mount-allowlist.json`). Reads `getContainerConfig(agentGroupId).additional_mounts`, dedupes by `(hostPath, containerPath)` exactly like `groups.ts`'s `add-mount` handler, pushes + writes only if not already present.
- `ensureEvalScenarioGroup()` calls both functions after `ensureAgentGroup` — one call fully provisions the eval group (identity + calendar isolation + guest-resolution memory).
- Missing/malformed `EVAL_TEST_CALENDAR_ID` is a hard failure of `ensureEvalScenarioGroup()` — no eval group is usable at all without calendar isolation confirmed, matching AD-4's "loud failure, not silent skip" stance. Never a warn-and-continue.

**Never:**
- Never creates or resolves the Google Calendar itself — that's a manual, one-time operator step outside this codebase, already made.
- Never touches `~/.config/nanoclaw/mount-allowlist.json` — the exact host path is already allowlisted from the Yulanda/Tina precedent; this story only writes the `container_configs` row.
- Never wires this into `runner.ts` or any spawn-path code — that's Story 1.4; this story only provisions config state ahead of it.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Calendar id set, valid | `.env` has a well-formed `EVAL_TEST_CALENDAR_ID` | `calendar_registry` gains the `"uriel"` override with that id | N/A |
| Calendar id missing | Unset in both `.env` and `process.env` | Nothing written | Throws, naming the manual setup step |
| Calendar id malformed | e.g. `"not-an-id"` | Nothing written | Throws, same message shape as `add-calendar`'s validation |
| Calendar override re-run (idempotent) | Override already registered | No duplicate entry, same `calendarId` | N/A |
| people.md mount, first run | No existing entry for this host/container path pair | Mount added to `additional_mounts` | N/A |
| people.md mount re-run (idempotent) | Mount already present | No duplicate entry | N/A |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/calendar.ts` (`resolveCalendarIds`, `CALENDAR_IDS`) — confirms the override-wins-on-collision mechanism this story relies on; not modified.
- `src/cli/resources/groups.ts` (`'config add-calendar'`, `'config add-mount'` handlers) — exact bodies `ensureEvalCalendarOverride`/`ensureEvalPeopleMount` mirror; `CALENDAR_ID_RE` moves out of this file.
- `src/db/container-configs.ts` (`getContainerConfig`, `updateContainerConfigJson`) — reused unmodified.
- `src/config.ts` (`GROUPS_DIR`), `src/env.ts` (`readEnvFile`) — reused unmodified.
- Real DB query (`container_configs.additional_mounts` for `dm-with-uriel`/`dm-with-partner`) confirmed the exact `hostPath`/`containerPath`/`readonly` triple to reuse.
- `~/.config/nanoclaw/mount-allowlist.json` — confirmed the household `people.md` path is already a file-level allowlist entry; no change needed here.
- `eval/setup.ts` (Story 1.1) — `ensureEvalScenarioGroup()` gains two calls after `ensureAgentGroup`.

## Tasks & Acceptance

**Execution:**
- [x] `src/container-config.ts` -- export `CALENDAR_ID_RE` -- single source of truth for the calendar-id shape check
- [x] `src/cli/resources/groups.ts` -- import `CALENDAR_ID_RE` from `container-config.ts` instead of declaring it locally -- no behavior change
- [x] `eval/setup.ts` -- `ensureEvalCalendarOverride`, `ensureEvalPeopleMount`, wired into `ensureEvalScenarioGroup` -- calendar isolation + guest-resolution memory
- [x] `eval/setup.test.ts` -- vitest coverage for the I/O matrix above (mock `readEnvFile`/`process.env` for the calendar-id cases; real temp DB for the registry/mount writes, matching Story 1.1's convention)

**Acceptance Criteria:**
- Given `EVAL_TEST_CALENDAR_ID` is set to a valid id, when `ensureEvalScenarioGroup()` runs, then `getContainerConfig(group.id).calendar_registry` contains exactly one `"uriel"` entry with that `calendarId`.
- Given `EVAL_TEST_CALENDAR_ID` is unset, when `ensureEvalScenarioGroup()` runs, then it throws before writing anything, naming the manual setup step.
- Given the calendar override already exists, when `ensureEvalCalendarOverride` runs again, then the registry still has exactly one `"uriel"` entry, not two.
- Given a fresh eval group, when `ensureEvalPeopleMount` runs, then `getContainerConfig(group.id).additional_mounts` contains `{ hostPath: <GROUPS_DIR>/household/memory/household/people.md, containerPath: "household-shared/people.md", readonly: true }`.
- Given the mount already exists, when `ensureEvalPeopleMount` runs again, then `additional_mounts` has no duplicate entry for that `(hostPath, containerPath)` pair.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors
- `pnpm exec tsc --noEmit` -- expected: no errors (container-config.ts export change is inside `src/`)
- `pnpm exec vitest run eval/` -- expected: all tests pass
- `pnpm test` (full suite) -- expected: all pass, no regressions (`groups.ts`'s `CALENDAR_ID_RE` import change touches a shared file)

## Suggested Review Order

**Calendar isolation (entry point)**

- Start here — how the real Google Calendar id gets in (operator-set `.env` precondition, not created by this code), validated, and registered as an override.
  [`setup.ts:64`](../../eval/setup.ts#L64)

- Wired into group provisioning — one call now fully isolates the group, not just creates it.
  [`setup.ts:48`](../../eval/setup.ts#L48)

**People.md mount — reuses an already-allowlisted path**

- The fail-fast check added after review: a missing source file throws loud instead of producing a mount pointing at nothing.
  [`setup.ts:114`](../../eval/setup.ts#L114)

- Exact `hostPath`/`containerPath`/`readonly` triple, verified byte-for-byte against the real `dm-with-uriel`/`dm-with-partner` DB rows.
  [`setup.ts:104`](../../eval/setup.ts#L104)

**Single source of truth — `CALENDAR_ID_RE` relocation**

- Moved out of the CLI-registration module so `eval/setup.ts` can reuse it without an awkward cross-module import.
  [`container-config.ts:43`](../../src/container-config.ts#L43)

- No behavior change — `groups.ts`'s own `add-calendar` handler now imports the same constant instead of declaring it locally.
  [`groups.ts:3`](../../src/cli/resources/groups.ts#L3)

**Tests — I/O matrix plus what review surfaced**

- Full coverage: valid/missing/malformed/whitespace/`"primary"`, idempotency, overwrite-not-append, and the ordering guarantee (mount never runs if the calendar check throws first).
  [`setup.test.ts:65`](../../eval/setup.test.ts#L65)

- The mock-scope correction — a verification-gap finding, not obvious from the code: this comment now honestly states it neuters `config.ts`'s other env-derived constants too, not just the calendar id.
  [`setup.test.ts:12`](../../eval/setup.test.ts#L12)
