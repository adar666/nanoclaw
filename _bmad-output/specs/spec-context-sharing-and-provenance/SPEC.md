---
id: SPEC-context-sharing-and-provenance
companions: ["../../../docs/isolation-model.md", "../../planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-31/ARCHITECTURE-SPINE.md"]
sources: ["../../brainstorming/brainstorm-nanoclaw-capabilities-from-usage-2026-08-31/brainstorm-intent.md"]
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Cross-Group Context Sharing + Provenance/Receipts

## Why

**A pain to solve, for the people this system actually serves.** NanoClaw runs three isolated agent groups today — a personal DM assistant (Yulanda), a household coordination assistant, and a partner's personal DM assistant (Tina) — each with fully isolated memory. A fact one bot learns never reaches the others, so a user repeats themselves across bots by design, not by bug. Separately, everything the system does on its own — a scheduled task firing, a self-mod change applying, a document getting written — leaves no visible trail of why it happened or who/what triggered it, so a user surprised by an automated action has no way to trace it. Both gaps surfaced independently, multiple times, across an unrelated set of brainstorming techniques (see `sources:`) — the strongest repeat signal in that session. Per this project's standing context (`project-context.md`), this is built to the industry-standard bar the rest of the codebase already holds itself to, not scoped down as household-minimal.

## Capabilities

- **CAP-1**
  - **intent:** An agent group can query facts explicitly permitted to share from another agent group's memory, read-only, without a full memory merge and without breaking the default isolation between groups.
  - **success:** Given a fact recorded in group A's memory that group B is permitted to see, group B's agent retrieves and uses it within its own session with no user having supplied that fact to group B directly. Verified by a real eval-harness scenario, matching this repo's existing verification bar for persona-level behavioral claims.

- **CAP-2**
  - **intent:** Every automated system action (scheduled task creation/firing, self-mod change, document write) records a retrievable one-line trigger and requester at creation time, answerable on demand.
  - **success:** For any task, self-mod change, or document write the system makes, the user can ask why it happened and receive the recorded trigger + requester — sourced from data captured at creation time, never reconstructed after the fact.

## Constraints

- CAP-1's permission gate reuses the existing mount-allowlist mechanism (`src/modules/mount-security`) — no new trust boundary. A group's own memory stays private by default; sharing is explicit, opt-in, per source group, consistent with the isolation model's existing three levels (see companion).
- CAP-1 is read-only and one-directional per grant — a query surface, not a sync mechanism. No write-back into another group's memory.
- CAP-2 reuses existing structures (task metadata, self-mod approval log, memory provenance conventions) — no new storage subsystem, no event bus.
- Both capabilities route only through existing IO surfaces: the two-DB session split and existing MCP-tool/CLI boundaries. No new IPC channel between host and container, or between containers.
- Built to this repo's established rigor bar: real test coverage on both host (`pnpm test`) and container (`bun test`) trees, plus an eval-harness scenario for CAP-1's persona-level claim — not scoped down to "good enough for one household."

## Non-goals

- Not a full bidirectional memory merge or real-time sync across agent groups — CAP-1 stays a scoped, explicit, read-only query.
- Not retroactive — CAP-2 does not backfill provenance for tasks or changes made before this ships.
- Not a new generic pub/sub or event bus between agent groups.
- Trust-via-visible-uncertainty (a cross-cutting "ask, don't guess" persona rule), generalizing the idempotency-guard/undo patterns system-wide, and persona-tuned per-group risk profiles are explicitly out of scope for this spec — named in the source brainstorm as deliberately deferred, not dropped.

## Success signal

Against the household's real three agent groups: a fact told to one bot (e.g. Yulanda) surfaces, on query, in another permitted group (e.g. household) without the user re-telling it — demonstrated live and covered by an eval-harness scenario. Separately, a real task, self-mod change, and document write each show a correct trigger+requester when the user asks "why," demonstrated live against the running system.

## Assumptions

- Assumed CAP-1's first-cut scope is durable "family facts" (birthdays, sizes, preferences) — distinct from full conversational memory or from what calendar/documents already hold — per the source intent doc's narrowed first-cut shape.
- Assumed CAP-2's periodic digest (a recap of what's being automated and why) is in scope as part of "answerable on demand," not a separate capability — the source intent doc frames it as the natural surfacing layer for the same provenance data already captured.

## Open Questions

All three resolved by the adopted architecture spine (see `companions:`):

- ~~Which query interface should CAP-1 use~~ → a new MCP tool, `read_shared_context` (spine AD-4).
- ~~Push vs. pull for CAP-2's digest~~ → on-demand retrieval ships now (AD-8/AD-9/AD-10/AD-14); periodic push stays deferred (AD-11).
- ~~Reuse `add-mount` as-is, or a lighter verb~~ → reuses `add-mount` as-is, `--ro`-enforced (AD-2, AD-13).
