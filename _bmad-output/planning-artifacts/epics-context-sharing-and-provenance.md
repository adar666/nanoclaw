---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments:
  - _bmad-output/specs/spec-context-sharing-and-provenance/SPEC.md
  - _bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-31/ARCHITECTURE-SPINE.md
---

# nanoclaw-v2 - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for **Cross-Group Context Sharing + Provenance/Receipts**, decomposing SPEC-context-sharing-and-provenance's capabilities and the driving architecture spine's invariants into implementable stories. No PRD or UX design contract exists for this feature — SPEC.md's five-field kernel serves as the requirements source (per this project's fast-path convention, same as spec-document-memory and spec-google-calendar), and there is no UI surface (chat-only feature).

## Requirements Inventory

### Functional Requirements

FR1: An agent group can query a durable fact another agent group has explicitly agreed to share, via a new `read_shared_context` tool — the grant is operator-configured (`ncl groups config add-mount --ro`), never self-service.
FR2: When no grant exists, the grant's file hasn't been written yet, or mount-security rejected the mount, `read_shared_context` returns one clean, explicit "not shared with you" result — never an error, never fabricated content.
FR3: A source group's shareable facts live in one fixed file (`memory/shared-facts.md`), scoped to durable household facts (birthdays, sizes, preferences) — distinct from calendar, documents, or full conversational memory, each of which already has its own recall path.
FR4: Every scheduled task/reminder created via `ncl tasks create` captures a provenance record (who/what triggered it, why, when) at creation time, retrievable on demand — fixed at the series' original creation, unchanged across recurrence fires.
FR5: Every self-mod change (`add_calendar`, `install_packages`, `add_mcp_server`) records a provenance line in its group's `self-mod-log.md` at apply time, retrievable by reading that file — the agent cannot tamper with it (read-only mounted into its own container).
FR6: Every document fill/refresh write can carry an optional provenance record on its version-history entry, surfaced by the existing `list_document_versions` tool.
FR7: A user can ask "what have you automated recently and why" and get one on-demand summary federating provenance across tasks, self-mod, and documents — no periodic push, pull only.

### NonFunctional Requirements

NFR1: Cross-group access is always read-only — enforced both by the grant convention and a server-side guard (not just operator discipline) that rejects a shared-context mount unless `--ro` is passed.
NFR2: Every write to `shared-facts.md` or `self-mod-log.md` is lock-guarded/atomic — no unguarded read-then-overwrite on a file two concurrent sessions could race on.
NFR3: `self-mod-log.md` is capped at a fixed entry count, not unbounded growth.
NFR4: No provenance is backfilled — only tasks/self-mod changes/document writes made after this ships carry a provenance record.
NFR5: Real test coverage on both host (`pnpm test`) and container (`bun test`) trees; CAP-1's persona-level claim additionally gets eval-harness scenario coverage — matching this project's own industry-standard rigor bar (`project-context.md`), not scoped down to household-minimal.
NFR6: No new runtime dependencies — both capabilities compose entirely on libraries/tables/conventions already in the dependency tree.

### Additional Requirements

From `ARCHITECTURE-SPINE.md` (finalized 2026-08-31, reviewer-gated: lint clean, reality-checked against real source with zero mismatches, reconciled against SPEC.md, adversarially reviewed — 11 real findings, all fixed before finalization, see the spine's own memlog):

- **AD-1** No new communication path — CAP-1 reads only through an existing mount-security-validated mount; CAP-2 writes only into existing per-session/per-group storage.
- **AD-2** CAP-1's grant reuses `ncl groups config add-mount --ro` as-is — no new grant primitive, `--ro` mandatory (enforced by AD-13, not just documented).
- **AD-3** Shareable facts live at `memory/shared-facts.md`, OKF frontmatter, scoped to durable facts only, lock-guarded writes.
- **AD-4** New MCP tool `read_shared_context` in `container/agent-runner/src/mcp-tools/shared-context.ts`, `registerTools([...])` convention, sibling `*.instructions.md`.
- **AD-5** containerPath convention: `<source-group-folder>-shared/shared-facts.md` (filename included, matching `eval/setup.ts`'s existing `household-shared/people.md` precedent).
- **AD-6** No grant, grant-without-file, and mount-security-rejected all collapse to one clean "not shared" result for the agent; the operator-facing diagnostic stays the existing mount-security `WARN` log.
- **AD-7** One provenance shape everywhere: `{ triggeredBy, requesterUserId?, message?, reason?, at }` (ISO-8601 UTC).
- **AD-8** Task provenance is additive on `messages_in.content.provenance`, fixed at series creation, reuses the pre-existing `originSessionId` rather than duplicating it, no backfill.
- **AD-9** Self-mod provenance is a new, capped, `withLock`-guarded, read-only-mounted per-group log (`self-mod-log.md`) — a conscious, narrow deviation from SPEC.md's literal "reuse `pending_approvals`" wording, surfaced for sign-off (see spine's own note).
- **AD-10** Document provenance is one additive optional field on `FillHistoryEntry`, no backfill.
- **AD-11** Pull/on-demand retrieval ships now; periodic push digest is deferred.
- **AD-12** CAP-1's behavioral claim gets a real eval-harness scenario set (`eval/scenarios/shared-context.scenarios.ts`), matching `guest-resolution.scenarios.ts`'s precedent.
- **AD-13** `config add-mount`'s handler gains one guard clause rejecting a `*-shared/` containerPath unless `--ro` is passed — closes the RW-by-default footgun in code.
- **AD-14** An on-demand digest surface federates AD-8/AD-9/AD-10's three retrieval paths into one "why" query.

Operational note (spine Deferred): this spec needs **both** rebuild paths, not one — AD-4 (container-side, new MCP tool) needs only a fresh container spawn on next wake; AD-8/AD-9/AD-13 (`src/cli/resources/tasks.ts`, `src/modules/self-mod/apply.ts`, `src/cli/resources/groups.ts`) are host-side `src/**` edits needing `pnpm run build` + a service restart.

### UX Design Requirements

N/A — no UX design contract exists and none is needed. This feature has no UI surface; all interaction is conversational, through channels already wired.

### FR Coverage Map

| Requirement | Capability | Governing AD(s) |
| --- | --- | --- |
| FR1 | CAP-1 | AD-1, AD-2, AD-4, AD-5, AD-13 |
| FR2 | CAP-1 | AD-6 |
| FR3 | CAP-1 | AD-3 |
| NFR1, NFR2 | CAP-1 | AD-2, AD-3, AD-13 |
| NFR5 (CAP-1 half) | CAP-1 | AD-12 |
| FR4 | CAP-2 | AD-7, AD-8 |
| FR5 | CAP-2 | AD-7, AD-9 |
| FR6 | CAP-2 | AD-7, AD-10 |
| FR7 | CAP-2 | AD-11, AD-14 |
| NFR3 | CAP-2 | AD-9 |
| NFR4 | CAP-2 | AD-8, AD-9, AD-10 |
| NFR5 (CAP-2 half), NFR6 | CAP-1, CAP-2 | (real test coverage on every story; no new deps, verified in spine's Stack section) |

## Epic List

### Epic 1: Cross-Group Context Sharing
Any agent group can ask "what does the household already know about X" and get a real answer from another group's explicitly-shared facts — without the user repeating themselves across bots. Standalone: usable the moment it ships, independent of Epic 2.
**FRs covered:** FR1, FR2, FR3

### Epic 2: Provenance & Receipts for Automated Actions
A user can always ask "why did this happen" — for a reminder that fired, a self-mod change that applied, or a document that got written — and get a real, trustworthy answer instead of having to reconstruct it from memory. Standalone: usable the moment it ships, independent of Epic 1 (different files, different domain).
**FRs covered:** FR4, FR5, FR6, FR7

### FR Coverage Map

FR1: Epic 1 - Query a fact shared by another agent group
FR2: Epic 1 - Clean "not shared" result when there's no grant
FR3: Epic 1 - Shared-facts file convention and content scope
FR4: Epic 2 - Task/reminder provenance
FR5: Epic 2 - Self-mod change provenance
FR6: Epic 2 - Document write provenance
FR7: Epic 2 - On-demand cross-domain digest

## Epic 1: Cross-Group Context Sharing

Any agent group can read a durable fact another group has explicitly agreed to share, through one new MCP tool reading a mount-security-gated file. Story order: the core read path first (de-risks the actual mechanism, including the containerPath-convention fix and the RW-footgun fix the reviewer gate caught), then the behavioral verification that proves it works as a real persona-level claim, not just code.

### Story 1.1: Read a Fact Shared by Another Agent Group

As a NanoClaw user talking to any of my agents,
I want that agent to check what another of my agents already knows before asking me to repeat myself,
So that I don't have to re-tell the same fact to every bot.

**Acceptance Criteria:**

**Given** an operator has run `ncl groups config add-mount --container-path <source-folder>-shared/shared-facts.md --ro` to share group A's `memory/shared-facts.md` with group B, and `ncl groups restart` has applied it
**When** a user in group B asks something the shared fact answers
**Then** group B's agent calls `read_shared_context`, which reads `/workspace/extra/<source-folder>-shared/shared-facts.md` and returns its content, and the agent answers without the user having told group B directly (FR1, AD-1, AD-2, AD-4, AD-5)

**Given** the same `add-mount` call is attempted without `--ro`
**When** `config add-mount`'s handler validates it
**Then** it rejects the request outright — a shared-context-convention containerPath (`*-shared/`) is never allowed read-write (NFR1, AD-13)

**Given** no grant exists for the requesting group pair, or a grant exists but `shared-facts.md` hasn't been written yet, or mount-security rejected the mount
**When** `read_shared_context` runs
**Then** all three cases return the identical, explicit "not shared with you" result — never an error, never fabricated content; the mount-security rejection case is still diagnosable by an operator via the existing `WARN` log in `nanoclaw.error.log` (FR2, AD-6)

**Given** a source group writes or edits `memory/shared-facts.md`
**When** the write happens
**Then** it goes through the same `withLock`/atomic-write discipline as the sibling document-memory feature's shared-file writes — no unguarded read-then-overwrite (NFR2, AD-3)

**Given** `memory/shared-facts.md`'s intended scope
**When** a source group's agent decides what belongs in it
**Then** it's durable household facts only (birthdays, sizes, preferences, similarly stable data) — never a dump of conversational memory, calendar, or document content, each of which already has its own recall path (FR3, AD-3)

### Story 1.2: Verify Cross-Group Sharing Behaves Correctly, Not Just Compiles

As the operator of this system,
I want CAP-1's actual chat behavior verified against a real agent and container, not just unit-tested code,
So that "the agent resolves shared facts correctly, and declines rather than guesses when it can't" is a checked claim, not an assumption — matching this project's existing bar for persona-level claims (guest resolution).

**Acceptance Criteria:**

**Given** `eval/scenarios/shared-context.scenarios.ts`, following the existing `ScenarioSetFactory` convention (`guest-resolution.scenarios.ts` as precedent)
**When** it's registered in `eval/loader.ts`'s `SCENARIO_SETS`
**Then** it provides a deterministic scenario asserting the real, on-file shared fact is what the agent returns when a grant exists — not a fabricated or approximate answer (AD-12)

**Given** the same scenario set
**When** a request targets a group pair with no grant
**Then** an `llmJudge` scenario asserts the agent declines/asks rather than guessing or inventing an answer (AD-12)

**Given** `pnpm eval run shared-context`
**When** it's run against the real household agent groups
**Then** both scenarios pass with real evidence — same live-verification bar SPEC.md's success signal requires (NFR5, spine Deferred's live-verification note)

## Epic 2: Provenance & Receipts for Automated Actions

A user can ask why any automated action happened and get a real answer, sourced from data captured at the moment it happened — never reconstructed after the fact. Story order follows the three domains independently (each touches distinct files, none depends on the others to ship), then the digest that federates all three, which necessarily comes last since it reads what the first three stories produce.

### Story 2.1: Task/Reminder Provenance

As a NanoClaw user,
I want to know why a reminder or scheduled task exists when I ask,
So that a verbal "stop reminding me" doesn't leave me confused about a reminder I don't remember setting up.

**Acceptance Criteria:**

**Given** a task/reminder created via `ncl tasks create` (from an agent's chat turn or the CLI directly)
**When** the row is inserted
**Then** `content.provenance` captures `{ triggeredBy, requesterUserId?, message?, reason?, at }` (AD-7) at creation time, alongside the pre-existing `prompt`/`script`/`originSessionId` fields — `requesterUserId` is additive, never replacing `originSessionId` (FR4, AD-8)

**Given** a task created before this ships
**When** its provenance is queried
**Then** no provenance is fabricated or backfilled — it's simply absent (NFR4, AD-8)

**Given** a recurring series fires more than once
**When** `insertRecurrence` creates the next occurrence
**Then** `content.provenance` stays exactly what it was at the series' original creation — this is the defined scope (why the series exists), not a per-fire bug; "what happened on this specific firing" is answered separately by the pre-existing `run-log.ts`/`task_log` entry for that run (AD-8)

**Given** a user asks why a task exists
**When** they run (or the agent runs on their behalf) `ncl tasks get`
**Then** the provenance is visible in the output (FR4, AD-11)

### Story 2.2: Self-Mod Change Provenance

As a NanoClaw user or admin,
I want to see why and by whom a self-mod change (a new package, a new MCP server, a new calendar) was applied,
So that I can trust my agent's self-modification history instead of it being an invisible black box.

**Acceptance Criteria:**

**Given** `applyAddCalendar` (and its self-mod-family siblings `install_packages`, `add_mcp_server`) applies an approved change
**When** the apply handler runs, host-side, in `src/modules/self-mod/apply.ts`
**Then** it appends one line (AD-7's shape) to `groups/<folder>/self-mod-log.md`, in the same file-per-group markdown-log style `run-log.ts` already established for tasks (FR5, AD-9)

**Given** repeated self-mod activity over time
**When** `self-mod-log.md` grows
**Then** it's capped at a fixed entry count (`SELF_MOD_LOG_CAP`), oldest entries trimmed first — not unbounded growth (NFR3, AD-9)

**Given** the file is written host-side only
**When** the container for that same agent group spawns
**Then** `self-mod-log.md` is mounted **read-only** into it — the same convention already applied to `CLAUDE.md`/`container.json` — so the agent can never tamper with its own audit trail (AD-9)

**Given** every write to this shared per-group file
**When** two concurrent applies could theoretically race
**Then** the write goes through the same `withLock`/atomic-write discipline as `shared-facts.md` (NFR2, AD-9)

**Given** a self-mod change applied before this ships
**When** its provenance is queried
**Then** nothing is fabricated or backfilled — that history simply predates this feature (NFR4, AD-9)

### Story 2.3: Document Write Provenance

As a NanoClaw user,
I want to see why a saved document was filled or refreshed the way it was,
So that I can trust what's in my document memory without having to remember every edit myself.

**Acceptance Criteria:**

**Given** `fillOneDocument` or `save_document`'s refresh path writes a new `FillHistoryEntry`
**When** the entry is recorded
**Then** it gets one additive optional `provenance` field (AD-7's shape) (FR6, AD-10)

**Given** an entry written before this ships (no `provenance` field)
**When** `readFillHistory` reads it back
**Then** it remains valid — same tolerant-reader/backward-compat handling `readFillHistory` already applies to pre-`kind` entries (NFR4, AD-10)

**Given** a user asks to see a document's version history
**When** `list_document_versions` runs
**Then** it renders `provenance` for each entry that has it (FR6, AD-11)

### Story 2.4: On-Demand Cross-Domain Digest

As a NanoClaw user,
I want to ask "what have you automated recently and why" in one place,
So that I don't have to separately check tasks, self-mod, and document history to get the full picture.

**Acceptance Criteria:**

**Given** Stories 2.1, 2.2, and 2.3 have each shipped their own retrieval surface
**When** a user asks the digest question
**Then** one query surface (CLI verb or MCP tool — implementation choice left to this story, per the spine's own deferral) reads across `content.provenance` (tasks), `self-mod-log.md` (self-mod), and `FillHistoryEntry.provenance` (documents) and returns one federated summary (FR7, AD-14)

**Given** the digest is explicitly pull-only
**When** this story ships
**Then** no periodic/proactive push mechanism is built — asking is always what triggers it (AD-11)

**Given** one or more domains have no provenance to show (e.g. no self-mod activity yet)
**When** the digest runs
**Then** it says so plainly for that domain rather than erroring or omitting it silently

## Reviewer Gate Note

Findings from all 4 parallel reviewer-gate passes on `ARCHITECTURE-SPINE.md` (reconcile-vs-spec, rubric-walk, reality-check, adversarial) are folded directly into the ACs above, not left as separate follow-up items — each AC that traces to a fix (the `--ro` guard in Story 1.1, the containerPath precedent match in Story 1.1, the read-only self-mod-log mount in Story 2.2, the stale-recurrence-provenance scope clarification in Story 2.1, the digest in Story 2.4) exists specifically because the gate caught something. See `_bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-31/reviews/` for the full review files and the spine's own `.memlog.md` for the fix-by-fix record.
