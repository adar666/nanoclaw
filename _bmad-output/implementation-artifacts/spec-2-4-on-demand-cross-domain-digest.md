---
title: 'On-Demand Cross-Domain Digest'
type: 'feature'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'fe42b6efa6a13f0d8bdcbc70fa70c75fdf0dd019'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stories 2.1-2.3 each answer "why" for their own domain (tasks, self-mod, documents) separately — a user asking "what have you automated recently and why" has to check three different places.

**Approach:** One new `ncl` CLI verb, `groups provenance-digest`, federates all three existing provenance surfaces (`content.provenance` on live task series, `self-mod-log.md`'s lines, `FillHistoryEntry.provenance` across a group's saved documents) into one read-only summary, pulled on demand — no periodic push, per this initiative's architecture spine (AD-11/AD-14).

## Boundaries & Constraints

**Always:** `ncl groups provenance-digest --id <group>` is `access: 'open'` (a read, like `config get`), scoped to the caller's own group under `cli_scope: 'group'` (agent-callable, same as `tasks`/`sessions` reads already are). Each domain section is present even when it has nothing to show ("no active tasks with recorded provenance," etc.) — never silently omitted, never an error. Storage stays untouched by this story — this is a pure read/aggregation layer over the three stores Stories 2.1-2.3 already built.

**Ask First:** None — fully specified.

**Never:** No new storage, no new provenance shape — this story reads the three existing ones as-is. No periodic/proactive push (explicitly deferred per AD-11) — this verb only ever runs when called. No cross-group aggregation — one group's digest only ever reflects that group's own tasks/self-mod-log/documents.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Group has active tasks with provenance | One or more live (pending/paused) task series, some with `content.provenance` | Digest's Tasks section lists each, with `triggered_by`/`reason` when present | N/A |
| Group has no active tasks | No pending/paused task rows | Tasks section says so plainly | N/A |
| Group has a `self-mod-log.md` | File exists with N lines | Self-Mod section shows the most recent entries (capped, e.g. last 10) | N/A |
| Group has no self-mod history yet | No `self-mod-log.md` on disk | Self-Mod section says so plainly, not an error | N/A |
| Group has documents with fill-history provenance | One or more `.fill-history/*.json` files containing entries with `provenance` | Documents section lists recent entries across all documents, newest first, with `reason` when present | N/A |
| Group has no document fill history at all | No `.fill-history` directory, or none of its entries have `provenance` | Documents section says so plainly | N/A |
| `--id` for a group with no container config / doesn't exist | Bad or missing group id | Clear error, matching `config get`'s existing "No container config for group" precedent | N/A |

</frozen-after-approval>

## Code Map

- `src/db/sessions.ts` -- `getSessionsByAgentGroup(agentGroupId)` (already exported) — the digest's task-provenance query enumerates this group's sessions with this, then filters to ones whose `thread_id` is a task thread (mirrors `src/cli/resources/tasks.ts`'s own `isTaskThread`/`selectedSessions` shape, but as new code in the new module below — `tasks.ts`'s own query helpers are module-private, not exported, so this reads the same `messages_in` shape independently rather than reaching into that file's internals).
- `src/session-manager.ts` -- `inboundDbPath`, `withInboundDb` (already exported, already used by `tasks.ts`) — reused directly to open each task session's `inbound.db` read-only and query `kind='task' AND status IN ('pending','paused')`, one row per `series_id` (same `GROUP BY series_id` shape as `tasks.ts`'s `selectLiveTasks`), parsing `content.provenance` the same way spec 2-1's `parseProvenance` does (this story re-implements that same small parse, since `tasks.ts`'s `parseProvenance` is module-private).
- `src/modules/self-mod/self-mod-log.ts` -- new exported `readSelfModLog(agentGroupId: string, limit = 10): string[]` — resolves the group's folder the same way `appendSelfModLog` already does (`getAgentGroup` → `GROUPS_DIR/<folder>/self-mod-log.md`), returns the most recent `limit` lines (or `[]` if the file doesn't exist), never throws.
- `src/modules/provenance-digest.ts` -- NEW FILE. `export function buildProvenanceDigest(agentGroupId: string): ProvenanceDigest` — the federation point. Calls the task-provenance query above, `readSelfModLog`, and a new document-fill-history reader (below); returns one structured object with three sections. **Cross-runtime note (same accepted tradeoff as specs 1.1/1.2/2.2's `-shared`/`WORKSPACE_EXTRA_DIR` convention):** the document-history reader independently re-encodes `documents.ts`'s `.fill-history/<slug>.json` shape (host `src/**` and container `container/agent-runner/src/**` are separate packages/runtimes — no shared TS import is possible) — reads only the fields this digest needs (`timestamp`, `target`, `provenance`), tolerant of anything else, mirroring `readFillHistory`'s own tolerant-reader posture rather than assuming a rigid shape.
- `src/cli/resources/groups.ts:130` (`customOperations`) -- new entry, `'provenance-digest'`: `{ access: 'open', description: '...', handler: async (args) => { const id = args.id as string; if (!id) throw new Error('--id is required'); return buildProvenanceDigest(id); } }` — mirrors `'config get'`'s exact shape (line 307-317) as the closest precedent for a simple, open, `--id`-scoped read.
- `src/timezone.ts` -- `formatLocalTime`/`resolveGroupTimezone` (already used by `calendar.ts`) — the digest's human-rendered timestamps use these, per this project's own Timestamps convention (storage stays ISO, display renders in the group's timezone); raw ISO stays available too for `--json` callers.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/self-mod/self-mod-log.ts` -- add `readSelfModLog` -- the self-mod section's data source
- [x] `src/modules/provenance-digest.ts` (new) -- `buildProvenanceDigest`, federating all three domains per Code Map
- [x] `src/cli/resources/groups.ts` -- register `'provenance-digest'` as a new `customOperations` entry -- the callable surface
- [x] `src/modules/provenance-digest.test.ts` (new) -- unit tests for every I/O Matrix row
- [x] `src/modules/self-mod/self-mod-log.test.ts` -- extend for `readSelfModLog` (exists/missing/capped-at-limit)
- [x] `src/cli/resources/groups.test.ts` -- extend for the new `groups-provenance-digest` dispatch: happy path + bad/missing `--id` -- `pnpm test`
- [x] `src/modules/provenance-digest.ts` -- **round 1 patch**: `TASK_DIGEST_LIMIT` + global sort; try/catch around per-session task queries; `log.warn` on real document-read failures; `kind`/`provenance_at` added to `DocumentDigestItem`; summary wording fixed; `truncate()` guarded for `max <= 3`
- [x] `src/modules/self-mod/self-mod-log.ts` -- **round 1 patch**: `readSelfModLog` — TOCTOU fix, `limit <= 0` guard
- [x] `src/modules/provenance-digest.test.ts`, `self-mod-log.test.ts` -- **round 1 patch**: task-cap/sort, pre-refresh-snapshot-labeling, limit-0, and unreadable-file tests
- [x] `CLAUDE.md` -- **round 1 patch**: add `provenance-digest` to the Admin CLI table

**Acceptance Criteria:**
- Given a group with an active task carrying `content.provenance`, when `ncl groups provenance-digest --id <group>` runs, then the Tasks section shows it with its `reason` (when present)
- Given a group with self-mod history, when the digest runs, then the Self-Mod section shows the most recent entries from `self-mod-log.md`
- Given a group with document fill history carrying `provenance`, when the digest runs, then the Documents section shows recent entries with `reason` (when present)
- Given a group with nothing recorded in one or more domains, when the digest runs, then each empty domain says so plainly — never omitted, never an error
- Given a bad/missing `--id`, when the digest runs, then it fails with a clear error, not a crash

## Spec Change Log

- **Round 1 review (patch-only, no bad_spec loopback):** 3-layer review found no intent/spec defects; the two auto-derived judgment calls (task querying re-implemented rather than exported from `tasks.ts`; document-history reader duplicating `documents.ts`'s shape) both held up under review. Real findings, all fixed: the Tasks section had no recency cap at all (unlike Self-Mod/Documents, each capped at 10) and wasn't sorted globally across task sessions — added `TASK_DIGEST_LIMIT` and a newest-first sort; a locked/corrupted/schema-mismatched task session DB would have thrown and taken down the whole digest — wrapped in try/catch, matching the tolerant posture the self-mod/document readers already had; document-history read failures (permissions, real I/O errors — not a missing directory) were silently swallowed with no log trace — added `log.warn` calls, same posture as this codebase's mount-rejection precedent; `readSelfModLog` had a TOCTOU gap (`existsSync` then `readFileSync` as two steps) and a `limit <= 0` bug (`slice(-0)` returns everything, not nothing) — both fixed; `provenance.at` was read and validated for documents but then discarded (`TaskDigestItem` exposes it, `DocumentDigestItem` didn't) — added; a `pre-refresh-snapshot` entry carries `provenance` too and was indistinguishable from a real fill in the digest — added a `kind` field, labeled the same way `list_document_versions` already does; summary wording ("N recent...") implied a complete count when none of these sections can tell if more exist beyond their own cap — reworded to "N most recent... (up to N shown)"; `CLAUDE.md`'s Admin CLI table was missing the new verb — added. Deferred: the self-mod section's plain-text-vs-structured asymmetry (a real but deliberate consequence of AD-9's own plain-text choice); no MCP-tool fallback for `cli_scope: disabled` groups (matches this codebase's existing pattern for every other `ncl`-only capability). Not added: a dedicated cross-group-`--id`-rejection test — verification-gap confirmed this is already-tested, generic dispatch/guard logic (`dispatch.test.ts:449`) that automatically covers every `groups` command, not something specific to this story.

## Design Notes

**Why a new `ncl` verb, not an MCP tool:** two of the three domains (self-mod-log.md, task provenance in `inbound.db`) are already host-side concerns reachable only through the host process — an MCP tool (container-side, Bun) would need a second cross-runtime read path for those, duplicating logic on both sides instead of once. The one host-side verb reads all three domains directly: tasks via the DB (host has direct SQLite access to every session's `inbound.db`), self-mod-log.md via the host filesystem (it's a real file under `groups/<folder>/`, not exclusively a container-internal path — Docker bind-mounts an existing host directory, it doesn't create a copy), and document fill-history via the same host filesystem (`groups/<folder>/memory/documents/.fill-history/*.json` are real files on the host disk too). This resolves the spine's own open implementation-choice question (AD-14) in favor of the CLI, consistent with `cli_scope: 'group'` already making `ncl` the agent's normal way to reach cross-cutting, non-MCP-tool-shaped capabilities.

**Task provenance re-implemented rather than reusing `tasks.ts` internals:** `tasks.ts`'s `parseProvenance`/`selectLiveTasks`/`isTaskThread` are all module-private. Exporting them purely for this one new caller would be a larger refactor of already-shipped, well-tested code than this story's narrow aggregation purpose warrants — the small amount of re-implemented query/parse logic here is simple and directly tested against the same real schema.

**Recency caps, not full history:** self-mod (last 10 lines) and document fill-history (recent entries, newest-first) are capped for the same reason `self-mod-log.md`/`FillHistoryEntry` themselves are already capped (20 each) — a digest answering "what have you automated *recently*" doesn't need a user's entire lifetime history in one call.

## Verification

**Commands:**
- `pnpm test -- provenance-digest.test.ts` -- expected: new tests pass
- `pnpm test -- self-mod-log.test.ts` -- expected: all new + existing tests pass
- `pnpm test -- groups.test.ts` -- expected: all new + existing tests pass
- `pnpm exec tsc --noEmit -p .` -- expected: clean

## Suggested Review Order

**Federation point — the whole story's payoff**

- Entry point: reads all three domains, never throws except on a bad group id.
  [`provenance-digest.ts:291`](../../src/modules/provenance-digest.ts#L291)

**The three domain readers — round 1's real fixes live here**

- Tasks: the round-1 recency cap + global sort + per-session try/catch.
  [`provenance-digest.ts:147`](../../src/modules/provenance-digest.ts#L147)

- Documents: cross-runtime re-encoding of `documents.ts`'s shape, round-1's `kind`/`provenance_at`/logging fixes.
  [`provenance-digest.ts:207`](../../src/modules/provenance-digest.ts#L207)

- Self-mod: the round-1 TOCTOU and `limit <= 0` fixes.
  [`self-mod-log.ts:63`](../../src/modules/self-mod/self-mod-log.ts#L63)

**Callable surface**

- The new `ncl groups provenance-digest` verb, mirroring `config get`'s exact shape.
  [`groups.ts:319`](../../src/cli/resources/groups.ts#L319)

**Peripherals — tests and docs**

- Full I/O-matrix + round-1 regression coverage.
  [`provenance-digest.test.ts`](../../src/modules/provenance-digest.test.ts)

- `CLAUDE.md`'s Admin CLI table, updated in round 1.
