---
title: 'Document Write Provenance'
type: 'feature'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '81cf10a6edaaeb8d62d17b090ef617cd0643330a'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `list_document_versions` shows what was filled and when, but never why — a user asking "why does this document say X" has to reconstruct it from chat history.

**Approach:** `FillHistoryEntry` gains one additive optional `provenance` field, populated at write time by both existing writers (`fillOneDocument`'s completed-fill recording, `save_document`'s refresh branch). `list_document_versions` renders it when present. `fill_document_field`/`fill_document_field_batch` gain an optional `reason` argument — the one new user-facing surface this story adds.

## Boundaries & Constraints

**Always:** `provenance` uses this spec's shared shape: `{ triggeredBy: 'agent'; requesterUserId?: string; reason?: string; at: string }` (ISO-8601 UTC) — reuses the same `timestamp` value already computed for the entry's own `timestamp` field, not a second clock read. `triggeredBy` is always `'agent'` here — every MCP tool call is inherently agent-initiated, there is no host/CLI-caller path for these tools the way `ncl tasks`/self-mod have one. `provenance` is additive and optional on `FillHistoryEntry`; an entry written before this ships (or by a writer that predates it) simply has none.

**Ask First:** None — fully specified.

**Never:** `requesterUserId` is never populated — an MCP tool handler (`handler: (args) => ...`) receives only the call's `args`, no session/sender identity, the same honest scope boundary as specs 1.1/2.1/2.2. No `reason` argument on `save_document` itself — its refresh branch's snapshot entry gets `triggeredBy`/`at` only, no reason (there's no natural "why are you re-saving this" question to answer there; it's an automatic side effect of a normal save, not a directed edit). No backfill — an entry recorded before this ships has no `provenance` key, and every reader treats that as absent, never an error (matches `readFillHistory`'s existing tolerant-reader pattern for `kind`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `fill_document_field`/`_batch` call with `reason` | A completed fill, `reason` given | The recorded `FillHistoryEntry.provenance.reason` is that string | N/A |
| `fill_document_field`/`_batch` call with no `reason` | A completed fill, no `reason` given | `provenance.triggeredBy`/`.at` still recorded; `.reason` absent | N/A |
| `save_document` refresh (pre-refresh snapshot) | Refresh branch runs | `provenance.triggeredBy`/`.at` recorded, no `.reason` (not an argument on this tool) | N/A |
| Entry from before this shipped (no `provenance` key) | Pre-existing `FillHistoryEntry` | `readFillHistory` returns it with `provenance: undefined`; `list_document_versions` renders it exactly as it did before this story | Never throws |
| `list_document_versions` on an entry with `provenance.reason` | A rendered fill-history line | The line includes the reason | N/A |
| `list_document_versions` on an entry with no `provenance` (or no reason) | A rendered fill-history line | The line renders exactly as before this story — no empty "(reason: )" text | N/A |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/documents.ts:2881-2898` -- `FillHistoryEntry` interface. Add one additive optional field: `provenance?: { triggeredBy: 'agent'; requesterUserId?: string; reason?: string; at: string }`.
- `container/agent-runner/src/mcp-tools/documents.ts:2950-2999` -- `readFillHistory`'s validation/normalization `map()`. Add `provenance` to the returned shape when the raw parsed entry has a `provenance` object whose own required fields (`triggeredBy === 'agent'`, `typeof at === 'string'`) validate — anything else (missing, malformed) resolves to `undefined`, mirroring `kind`'s own tolerant-normalization precedent right above it in the same function.
- `container/agent-runner/src/mcp-tools/documents.ts:4418-4462` -- `recordCompletedFill` (the completed-fill history-recording body, shared by both `fill_document_field` and `fill_document_field_batch` via `fillOneDocument`). At its `recordFillHistory(...)` call, add `provenance: { triggeredBy: 'agent', reason: typeof args.reason === 'string' && args.reason.length > 0 ? args.reason : undefined, at: <the same timestamp already computed for this entry> }`. `args` is already in scope here — no new plumbing needed; a batch call's shared `args` (one `reason` for the whole batch, per the tool's existing "one value, applied identically to every resolved document" design) reaches every target's entry identically.
- `container/agent-runner/src/mcp-tools/documents.ts:~1871` -- `save_document`'s refresh branch, its own `recordFillHistory(...)` call. Add `provenance: { triggeredBy: 'agent', at: <the same timestamp already used for this entry> }` — no `reason` (see Boundaries).
- `container/agent-runner/src/mcp-tools/documents.ts:4566-4627` (`fillDocumentField`'s `inputSchema.properties`) -- add one new optional property: `reason: { type: 'string', description: 'Optional free-text note on why this fill is happening — recorded as provenance, surfaced by list_document_versions.' }`. Not added to `required`.
- `container/agent-runner/src/mcp-tools/documents.ts:~4839-4886` (`fillDocumentFieldBatch`'s `inputSchema.properties`) -- same new optional `reason` property, same description, applies identically to every resolved target in the batch (matches how `value`/`table`/`row` etc. already apply batch-wide).
- `container/agent-runner/src/mcp-tools/documents.ts:5022-5025` -- `listDocumentVersionsImpl`'s `lines.map(...)` rendering. Append `entry.provenance?.reason` when present: `... — ${entry.outputPath}${entry.provenance?.reason ? ' (reason: ' + entry.provenance.reason + ')' : ''}`.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- `FillHistoryEntry` gains `provenance?`; `readFillHistory` validates/normalizes it -- the additive storage change
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- `recordCompletedFill` and `save_document`'s refresh branch populate `provenance` at write time -- the two writers
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- `fill_document_field`/`fill_document_field_batch` gain the optional `reason` argument -- the one new user-facing surface
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- `listDocumentVersionsImpl` renders `provenance.reason` when present -- the read side
- [x] `container/agent-runner/src/mcp-tools/documents.test.ts` -- tests for every I/O Matrix row -- `bun test`
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- **round 1 patch**: shared `cleanReason()` (trim, non-whitespace, newline-collapse, 200-char cap); log line for malformed-but-present provenance
- [x] `container/agent-runner/src/mcp-tools/documents.test.ts` -- **round 1 patch**: whitespace-only, newline, over-length, malformed-provenance, batch-no-reason tests
- [x] `container/skills/document-memory/SKILL.md` -- **round 1 patch**: document the `reason` argument and `(reason: ...)` rendering

**Acceptance Criteria:**
- Given a `fill_document_field` call with `reason`, when `list_document_versions` runs afterward, then the corresponding line includes that reason
- Given a `fill_document_field_batch` call with `reason` across multiple documents, when each document's history is inspected, then every one recorded the same reason
- Given a completed fill with no `reason` given, when the entry is inspected, then `provenance.triggeredBy`/`.at` are set and `.reason` is absent — never an empty `(reason: )` in the rendered line
- Given a `save_document` refresh, when its snapshot entry is inspected, then `provenance.triggeredBy`/`.at` are set, no `.reason`
- Given a `FillHistoryEntry` from before this shipped, when `readFillHistory`/`list_document_versions` run, then it's handled exactly as it was before this story — no error, no fabricated provenance

## Spec Change Log

- **Round 1 review (patch-only, no bad_spec loopback):** 3-layer review found no intent/spec defects — all three layers converged on the same real findings. Applied: a shared `cleanReason()` helper (trims, requires non-whitespace content, collapses embedded newlines to spaces, caps at 200 chars — same precedent as `self-mod-log.ts`'s stored-reason cap, spec 2-2) used at the one write site that accepts a `reason` argument; a log line for `readFillHistory`'s malformed-provenance-but-present branch (mirrors the existing malformed-entry log a few lines above it); tests for whitespace-only reason, embedded newlines, over-length truncation, a malformed-but-present provenance shape, and a batch call with no reason (only the with-reason batch case was covered); `document-memory/SKILL.md` updated to mention the `reason` argument and `(reason: ...)` rendering (the capability had zero agent-facing documentation before this). Confirmed by direct code inspection, not just review claim: `fillDocumentFieldBatchImpl` already passes its whole top-level `args` (including `reason`) to every resolved target via the shared `fillOneDocument`, so the batch-wiring concern one reviewer raised was a documentation gap in the diff's visibility, not an actual bug. Deferred: the test fixture hand-duplicating the provenance type shape; `provenance.at`/`timestamp` duplication enforced only by convention; the `triggeredBy: 'agent'`-always assumption having no compiler guard.

## Design Notes

**Why `reason` on the fill tools but not `save_document`:** the fill tools are a directed, single-purpose action ("write this value here") where "why" is a natural, useful annotation — the same reasoning that gave `install_packages`/`add_calendar` a `reason` field. `save_document`'s refresh branch is a side effect of an ordinary re-save, not a distinct directed action with its own "why" — adding a `reason` argument there would be inventing a question nobody asks.

**Why `provenance.at` duplicates `entry.timestamp` for this domain specifically:** unlike tasks (where `content.provenance` is a separate concern from the row's own `timestamp` column) or self-mod (a plain-text log with no other timestamp field at all), `FillHistoryEntry` already has its own `timestamp`. `provenance.at` is redundant here by construction — kept anyway, because the point of reusing one shared shape across all three domains (spec 1.1's original framing) is that a future cross-domain reader (Story 2.4's digest) can rely on `provenance.at` existing uniformly, without special-casing the one domain where it happens to coincide with an existing field.

## Verification

**Commands:**
- `cd container/agent-runner && bun test src/mcp-tools/documents.test.ts` -- expected: all new + existing tests pass
- `cd container/agent-runner && bun run typecheck` -- expected: clean (or `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from root)

## Suggested Review Order

**Storage shape**

- Entry point: `provenance` added to the shared history-entry type.
  [`documents.ts:2886`](../../container/agent-runner/src/mcp-tools/documents.ts#L2886)

- The reason-cleaning guard added after round 1 (trim, newline-collapse, length cap).
  [`documents.ts:2937`](../../container/agent-runner/src/mcp-tools/documents.ts#L2937)

- Tolerant read-side validation, including the round-1 log line for a malformed-but-present shape.
  [`documents.ts:2993`](../../container/agent-runner/src/mcp-tools/documents.ts#L2993)

**Write path — the one new user-facing surface**

- Where `reason` actually gets captured into provenance.
  [`documents.ts:4487`](../../container/agent-runner/src/mcp-tools/documents.ts#L4487)

**Read path**

- `list_document_versions`' rendering.
  [`documents.ts:5052`](../../container/agent-runner/src/mcp-tools/documents.ts#L5052)

**Peripherals — tests and docs**

- Full I/O-matrix + round-1 regression coverage.
  [`documents.test.ts`](../../container/agent-runner/src/mcp-tools/documents.test.ts)

- Agent-facing documentation, added in round 1 (had none before).
  [`document-memory/SKILL.md`](../../container/skills/document-memory/SKILL.md)
