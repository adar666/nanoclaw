---
title: 'Calendars Beyond Uriel and Devorah'
type: 'feature'
created: '2026-08-18'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'db2f7d03588dea149f42d8f27deffd81a467c509'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The four calendar tools hardcode exactly two calendars (`uriel`/`devorah`) — reaching a third (e.g. a shared family calendar) needs a code change and a rebuild.

**Approach:** Add a config-driven calendar registry (`name → calendarId`) on the per-agent-group `container_configs` DB row, materialized into `container.json` and read by the container at runtime. The existing two built-in names stay hardcoded defaults (unchanged behavior, no migration-time personal data); a registry entry with the same name overrides a built-in, and any other name extends the set. Adding a calendar becomes an `ncl groups config add-calendar` call + a restart — never a code change.

## Boundaries & Constraints

**Always:** New `calendar_registry` TEXT column on `container_configs` (JSON array, `DEFAULT '[]'` — empty, not the two built-ins, since a core-codebase migration must not hardcode personal data for every install/fork). Registry entry shape is `{ name: string, calendarId: string }` — no `ownerEmail` field (simplifying the architecture spine's original `{calendarId, ownerEmail}` sketch: nothing in the codebase consumes a separate owner-email anywhere today, `calendarId` already *is* the effective identifier Google's API needs, per this file's own existing `devorah: 'adardevora@gmail.com'` entry). At runtime, the effective calendar set is the built-in `CALENDAR_IDS` map merged with the config registry, config entries taking precedence on a name collision — this is what makes "no code change" true for the common case (the two built-ins keep working with zero config) while still allowing an override. All four tools (`create`/`list`/`update`/`delete_calendar_event`) resolve `calendar` the same way — one shared lookup, not four independent ones. The `calendar` argument's JSON-schema `enum: ['uriel', 'devorah']` is removed from all four `inputSchema`s (config loads after these schemas are captured at module-import time — see Code Map — so a static enum can't reflect it); the existing runtime "must be one of: ..." validation, now sourced from the merged registry, is the only check. New `ncl groups config add-calendar --id <group-id> --name <name> --calendar-id <calendar-id>` / `config remove-calendar --id <group-id> --name <name>` CLI subcommands, mirroring `config add-mcp-server`/`remove-mcp-server`'s exact shape (`access: 'approval'`, not `hostOnly` — this is JSON-column config, not a filesystem-boundary mount).

**Ask First:** None anticipated — this is a mechanical extension of an existing, already-established config pattern (`mcp_servers`, `additional_mounts`), not a new one.

**Never:** Do not add a per-calendar OAuth-connection concept — AD-2 already fixes OneCLI to one Google Calendar connection per project; every registry entry (built-in or config-added) reaches Google through that same one connection, via native calendar-sharing (AD-3), never a second credential. Do not build a generic "arbitrary JSON blob" escape hatch on `container_configs` — this column is named and typed like every other JSON column on that table, matching the existing convention, not a shortcut around it. Do not change how `create_calendar_event`'s idempotency guard (Story 2.1) or `recurrence` (Story 2.2) work — this story only changes calendar *selection*, not event-creation logic downstream of it. Do not add a way to add a calendar from *inside* a container (this is operator/host config, same access level as `add-mcp-server`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No config registry entries (fresh migration, empty `[]`) | A tool call names `calendar: 'uriel'` or `'devorah'` | Resolves via the built-in `CALENDAR_IDS` map, exactly as before this story | N/A |
| An operator adds a third calendar via CLI | `ncl groups config add-calendar --id <g> --name family --calendar-id family-cal@group.calendar.google.com` | Registry updated; after a restart, `calendar: 'family'` resolves and works the same as any built-in name | N/A |
| A registry entry reuses a built-in name (`uriel`) | `add-calendar --name uriel --calendar-id something-else` | The config entry overrides the built-in for that name (explicit operator intent wins) | N/A |
| A tool call names a calendar not in the built-ins or the registry | `calendar: 'family'` before it's been added | Declines with the existing "must be one of: ..." error, now listing every currently-resolvable name (built-ins + registry) | Existing error path, unchanged shape |
| `remove-calendar` on a name that was never added | `remove-calendar --name doesnotexist` | Declines clearly — no silent no-op | N/A |
| `container.json` is stale (pre-restart) and a call names a just-added calendar | Registry entry exists in DB, not yet materialized | Same "must be one of: ..." decline as a genuinely-unknown name — restart is required, matching every other config change in this table (documented in the CLI command's own description, same as `add-mcp-server`) | N/A |

</frozen-after-approval>

## Code Map

- `src/db/migrations/024-container-config-calendar-registry.ts` (new) — `ALTER TABLE container_configs ADD COLUMN calendar_registry TEXT NOT NULL DEFAULT '[]';`, mirroring `022-container-config-idle-timeout.ts`'s single-`ALTER TABLE` shape. Register in `src/db/migrations/index.ts` alongside `migration023`.
- `src/db/container-configs.ts:16` — `JSON_COLUMNS` set: add `'calendar_registry'`. `updateContainerConfigJson`'s literal-union column-name type (around `:116-126`) needs the same addition. `ensureContainerConfig` (`:55-75`) needs no change — its `INSERT OR IGNORE` only sets `agent_group_id`/`provider`/`updated_at`, relying on the column `DEFAULT`, same as every other JSON column.
- `src/types.ts` — `ContainerConfigRow` interface: add `calendar_registry: string`.
- `src/container-config.ts:34-48` — `ContainerConfig` interface: add `calendarRegistry: Array<{ name: string; calendarId: string }>`. `configFromDb()` (`:60-81`): add `calendarRegistry: JSON.parse(row.calendar_registry) as Array<{ name: string; calendarId: string }>,` alongside the other `JSON.parse(row.X)` lines.
- `src/cli/resources/groups.ts` — `presentConfig()` (`:56-75`): add `calendar_registry` to the displayed fields. Add `'config add-calendar'` / `'config remove-calendar'` subcommands, copying `'config add-mcp-server'`/`'config remove-mcp-server'`'s exact shape (`:354-400`, `access: 'approval'`, no `hostOnly`) — parse `row.calendar_registry`, mutate the array (dedupe/replace by `name` on add, filter by `name` on remove), `updateContainerConfigJson(id, 'calendar_registry', updated)`.
- `container/agent-runner/src/config.ts:12-21` — `RunnerConfig` interface: add `calendarRegistry: Array<{ name: string; calendarId: string }>`. `loadConfig()` (`:41-50`): add `calendarRegistry: (raw.calendarRegistry as RunnerConfig['calendarRegistry']) || [],` alongside the other field copies.
- `container/agent-runner/src/mcp-tools/calendar.ts:40-43` — `CALENDAR_IDS` constant stays exactly as-is (the built-in default). Add a new function, e.g. `resolveCalendarIds(): Record<string, string>` — merges `CALENDAR_IDS` with `getConfig().calendarRegistry` (reduced to a `Record`, config entries override by `name`) — called **inside each handler** (not at module top level: `getConfig()` throws until `loadConfig()` runs in `main()`, which happens after this module's top-level `registerTools([...])` call already captured the static schemas — see the import-order note below). Every one of the 12 existing `CALENDAR_IDS` references (lines ~185-188, ~649-652, ~796-799, ~1117-1120 — one triplet per tool) becomes a reference to a locally-resolved `const calendarIds = resolveCalendarIds();` at the top of each handler. Remove `enum: ['uriel', 'devorah']` from all four `inputSchema.properties.calendar` blocks (lines ~144, ~622, ~751, ~1083) — replace with a `description` explaining the calendar name is resolved against this group's registry (built-ins plus any config-added names).
- **Import-order constraint (do not violate):** `container/agent-runner/src/index.ts` imports provider modules (which transitively import `calendar.ts`, whose `registerTools([...])` call runs at module load time) *before* `main()` calls `loadConfig()`. This is why `resolveCalendarIds()` must be called lazily inside each handler body, never at module top level or inside the static `tool.inputSchema` object literal.
- `container/agent-runner/src/mcp-tools/calendar.test.ts` — has no config-mocking seam today (zero dependency on `loadConfig()`/`getConfig()`). Add one, mirroring the `createHooks`/`deleteHooks` exported-object testability pattern already used in this file (e.g. export a way to stub `resolveCalendarIds()`'s config source, or call `loadConfig()`/mutate the module's cached config directly in `beforeEach`/`afterEach` — pick whichever is less invasive once the exact shape of `resolveCalendarIds()` is settled).
- `container/skills/calendar/SKILL.md` (current version `1.4.1`) — needs a real rewrite pass, not a find/replace: frontmatter description (`:4`), the four-tools intro (`:22-25`), every per-tool `calendar` param doc (`"uriel"` or `"devorah"`, repeated per tool), the `## Two calendars, either one, from any chat` section header and body (`:136-142`+), and the Devorah-specific troubleshooting note (`:174-176`) all currently bake in "exactly two, named Uriel and Devorah." Reframe as "this group's configured calendars (at minimum Uriel's and Devorah's; an operator may add more via `ncl groups config add-calendar`)" throughout — the mechanism (native sharing, one connection) doesn't change, only the framing of "how many."

## Tasks & Acceptance

**Execution:**
- [x] `src/db/migrations/024-container-config-calendar-registry.ts` -- new migration, `calendar_registry` column, `DEFAULT '[]'` -- registered in `migrations/index.ts`
- [x] `src/db/container-configs.ts`, `src/types.ts` -- `calendar_registry` added to `JSON_COLUMNS`, `updateContainerConfigJson`'s union, `ContainerConfigRow` (also: `createContainerConfig`'s explicit INSERT column list, and the two call sites that build a full `ContainerConfigRow`/`ContainerConfig` literal — `src/backfill-container-configs.ts`, `src/db/db-v2.test.ts`, `src/provider-surfaces.test.ts` — needed the new field for type-correctness; not in the original Code Map but a direct consequence of it)
- [x] `src/container-config.ts` -- `ContainerConfig.calendarRegistry` + `configFromDb()` parsing
- [x] `src/cli/resources/groups.ts` -- `presentConfig()` shows the field; `config add-calendar`/`config remove-calendar` subcommands
- [x] `container/agent-runner/src/config.ts` -- `RunnerConfig.calendarRegistry` + `loadConfig()` parsing
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- `resolveCalendarIds()` merge function, called lazily in all four handlers; `enum` removed from all four schemas; error-message text now reflects the merged set; `calendarConfigHooks` testability seam added (mirrors `createHooks`/`deleteHooks`)
- [x] `container/agent-runner/src/mcp-tools/calendar.test.ts` -- config-mocking seam added; new tests covering all 6 I/O Matrix rows (built-in-only default, config-added third calendar, name-collision override, unknown-name decline listing the full merged set, stale-`container.json` decline, and cross-tool coverage). The "remove-calendar on a name that was never added" row is CLI-level behavior (`src/cli/resources/groups.ts`), not container-side — tested instead in `src/cli/resources/groups.test.ts`'s new `groups config add-calendar / remove-calendar` describe block, alongside the CLI-level add/remove/dedupe/override/validation cases.
- [x] `container/skills/calendar/SKILL.md` -- rewrite pass per the Code Map's note; bumped version 1.4.1 → 1.5.0
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- `resolveCalendarIds()` uses `Object.create(null)` (prototype-pollution guard) and skips empty-`calendarId` entries -- patch (review loop 1)
- [x] `container/agent-runner/src/config.ts` -- `Array.isArray` guard on `calendarRegistry` in `loadConfig()` -- patch (review loop 1)
- [x] `src/cli/resources/groups.ts` -- `config add-calendar`/`remove-calendar` trim + lowercase `--name`, trim `--calendar-id`, reject empty-after-trim -- patch (review loop 1)
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- all four tool-level `description` strings reworded off the stale "Uriel's or Devora's" framing -- patch (review loop 1)
- [x] `container/agent-runner/src/config.test.ts` (new), `src/container-config.test.ts` -- real (non-stubbed) tests for the host↔container config-plumbing path -- closes the verification-gap finding (review loop 1)
- [x] `docs/db-central.md`, `CLAUDE.md`, `container/skills/calendar/SKILL.md` -- doc fixes: new column reference, `ncl` verb list, agent-self-service framing -- patch (review loop 1)

**Acceptance Criteria:**
- Given no registry entries exist (fresh migration), when any calendar tool resolves `calendar: 'uriel'` or `'devorah'`, then it works exactly as before this story
- Given an operator runs `ncl groups config add-calendar` for a new name and restarts the group, when a tool call names that new calendar, then it resolves and the tool call succeeds the same way a built-in name does
- Given a config registry entry reuses a built-in name, when that name is resolved, then the config entry's `calendarId` wins over the built-in
- Given a tool call names a calendar that resolves to nothing (neither built-in nor registry), when the tool runs, then it declines clearly, listing every currently-resolvable name

## Spec Change Log

**Review loop 1 (patch, applied directly — no intent_gap/bad_spec, all mechanical):** three review agents (blind-hunter, edge-case-hunter, verification-gap) reviewed the full cross-cutting diff. Real findings, fixed in place: `resolveCalendarIds()`'s merge used a plain object (`{...CALENDAR_IDS}`), a latent prototype-pollution surface for a `"__proto__"`-named registry entry — switched to `Object.create(null)`; a registry entry with an empty `calendarId` was merged anyway (listed as resolvable, then failed) — now skipped; `loadConfig()` didn't guard against a non-array `calendarRegistry` in a malformed `container.json` (would throw inside the resolve loop) — added an `Array.isArray` guard; `config add-calendar`/`remove-calendar` didn't trim or reject a whitespace-only `--name`, and didn't normalize case, risking a silently-unresolvable entry from a typo — now trimmed + lowercased at write time (avoids needing case-insensitive lookup logic at resolve time); all four tools' top-level `description` strings still said "Uriel's or Devora's," stale against the already-dynamic per-argument text — reworded; `calendar.test.ts`'s I/O Matrix row 5 (CLI-level remove-nonexistent) had no cross-reference comment explaining it's covered in `groups.test.ts` instead, reading as an accidental gap — added. **Most significant finding (verification-gap):** every test in the diff stubbed `calendarConfigHooks`/mocked around the real config path — nothing exercised the actual `getConfig().calendarRegistry` line or the host-side `configFromDb`/`materializeContainerJson` round trip, meaning the feature's actual host↔container plumbing could silently regress to "always empty" with zero test failures. Closed with two new real (non-stubbed) tests: `container/agent-runner/src/config.test.ts` (new file, `loadConfig()` against a real canned `container.json` body) and a new case in `src/container-config.test.ts` (`configFromDb` round-tripping `calendar_registry` through a real test DB). Also fixed: `docs/db-central.md`'s `container_configs` reference gained the new column (plus the already-missing `idle_timeout_minutes` from migration 22, caught incidentally); `CLAUDE.md`'s `ncl` resource table now lists `config add-calendar/remove-calendar`; `SKILL.md`'s "More than two calendars" section now tells the agent it can request the command itself (subject to approval), not just describe it to a human. 6 real, low-priority findings deferred to `deferred-work.md`, all either pre-existing systemic patterns (concurrent-write races and unguarded `JSON.parse` across every `config add-X` JSON column, not unique to this story) or genuinely separate, bigger features (self-mod-style auto-restart+notify integration; `--calendar-id` format validation; hardcoded personal data in `CALENDAR_IDS`, pre-dating this story). Full suites re-verified: `pnpm test` (host) 1391 pass/110 files; `bun test` (container) 446 pass/8 skip/0 fail/29 files; both typechecks clean.

## Design Notes

The "merge, config wins on collision" resolution is the whole trick that makes "no code change, ever, for the common case" actually true: the two original calendars don't need a single row of config to keep working (empty-array default), and adding a third is purely additive — nobody has to touch or understand the built-in map to extend it. This mirrors how `mcp_servers`/`additional_mounts` already work on this same table (empty defaults, additive JSON arrays/objects, CLI subcommands to mutate).

## Verification

**Commands:**
- `pnpm exec tsc --noEmit -p .` (host) -- expected: no type errors
- `pnpm test` (host, vitest) -- expected: all existing tests pass, migration/container-config/CLI tests pass
- `cd container/agent-runner && bun test src/mcp-tools/calendar.test.ts` -- expected: all existing tests still pass, new registry tests pass
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

## Suggested Review Order

**The registry mechanism (host → container.json → container)**

- Entry point: the merge function, with the `Object.create(null)` prototype-pollution guard.
  [`calendar.ts:75`](../../container/agent-runner/src/mcp-tools/calendar.ts#L75)

- Where all four handlers call it lazily — never at module top level (see the import-order comment above it).
  [`calendar.ts:57`](../../container/agent-runner/src/mcp-tools/calendar.ts#L57)

- The new migration — the whole feature's DB foundation.
  [`024-container-config-calendar-registry.ts:1`](../../src/db/migrations/024-container-config-calendar-registry.ts#L1)

- Host-side materialization: DB row → `container.json`.
  [`container-config.ts`](../../src/container-config.ts)

- Container-side read: `container.json` → `RunnerConfig`, with the `Array.isArray` guard.
  [`config.ts:51`](../../container/agent-runner/src/config.ts#L51)

**CLI (operator/agent-facing mutation surface)**

- `config add-calendar`/`config remove-calendar`, with the trim/lowercase/validation fixes.
  [`groups.ts:403`](../../src/cli/resources/groups.ts#L403)

**Tests (the verification-gap fix — the real, non-stubbed plumbing tests)**

- Container-side: `loadConfig()` against a real canned `container.json`.
  [`config.test.ts:1`](../../container/agent-runner/src/config.test.ts#L1)

- Host-side: `configFromDb` round-tripping `calendar_registry` through a real test DB.
  [`container-config.test.ts`](../../src/container-config.test.ts)

**Docs (peripheral)**

- `SKILL.md`'s reframe from "two calendars" to "this group's configured calendars."
  [`SKILL.md:21`](../../container/skills/calendar/SKILL.md#L21)
