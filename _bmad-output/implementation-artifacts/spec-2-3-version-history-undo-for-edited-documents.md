---
title: 'Version History / Undo for Edited Documents'
type: 'feature'
created: '2026-08-24'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '0ac9d0dd714c8219d90d03c4756afa9a50a2f7d7'
---

<!-- Target: 900–1300 tokens. Above 1600 = high risk of context rot.
     Never over-specify "how" — use boundaries + examples instead.
     Cohesive cross-layer stories (DB+BE+UI) stay in ONE file.
     IMPORTANT: Remove all HTML comments when filling this template. -->

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A fill's output file (`.document-fills/${slug}-filled-...`) already accumulates on disk indefinitely today, but nothing indexes it — a user who wants an earlier fill back after a bad edit has no way to find or recall it. "Undo" can't mean reverting the *stored* document, since a fill has never touched the stored canonical copy (confirmed invariant, unrelated to and independent of Story 2.4).

**Approach:** Index every fill's output as it's written (single-call and batch alike, via the shared `fillOneDocument` helper) into a small per-document JSON history file. A new `list_document_versions` tool returns that document's ordered fill history with each still-on-disk output path — the agent resends an earlier one via the existing `send_file` tool exactly as it already does for a fresh fill. No new delivery mechanism, no change to what a fill writes or where.

## Boundaries & Constraints

**Always:**
- The stored canonical raw file and stored extracted text remain untouched by this story — same invariant `fill_document_field`/`fill_document_field_batch` already guarantee; this story only indexes files those tools already produce.
- History is recorded at the shared `fillOneDocument` level so both `fill_document_field` and `fill_document_field_batch` are covered automatically, with no per-tool duplication.
- One history entry per completed fill only (the same `FILL_SUCCESS_MARKER` signal Story 2.2 already uses to distinguish a real completion from a discovery/prompt response) — a discovery call or a per-item batch failure never gets a history entry.
- History file: `memory/documents/.fill-history/<slug>.json`, a capped array (newest last) of `{ timestamp, outputPath, target }` — `target` is a short human-readable description of what was filled (e.g. `"row 2"`, `"fieldName: Date"`), reusing whatever targeting args were given on that call.
- Capped at 20 entries per document (oldest dropped first) — bounds index growth; dropping an entry from the index does not delete its underlying `.document-fills` file (retention/cleanup of that directory stays the separate, already-tracked `deferred-work.md` concern this story doesn't touch).
- `list_document_versions` verifies each entry's `outputPath` still exists on disk (`fs.existsSync`) before listing it — a manually-deleted or otherwise-missing file is dropped from the response, never returned as recoverable.
- Same document-resolution semantics as every other tool in this file (`resolveDocument`'s 0/1/2+ handshake) — never a new matching mechanism.
- No new delivery mechanism — the tool never calls `send_file`; the agent relays a chosen output path exactly as it already does after a fresh fill.

**Ask First:**
- None — scope was resolved by explicit operator decision (index existing fill outputs, independent of Story 2.4) before drafting.

**Never:**
- Never modify the stored canonical raw file or stored extracted text — this story only reads/indexes what fills already produce.
- Never delete or clean up `.document-fills` files — that stays the separate, already-logged deferred-work.md concern.
- Never build any dependency on Story 2.4 (auto-refresh stored text after an edit) — this story ships fully independent of it, per operator decision.
- Never invent a second "restore" tool — listing already returns a real, sendable path; the agent uses the existing `send_file` tool directly.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Document with 3 prior fills | `list_document_versions({ document: "report" })` | Ordered list (oldest to newest) of 3 entries, each with timestamp, target, and output path | N/A |
| Document never filled | `list_document_versions({ document: "letter" })` | Empty history reported plainly — not an error | N/A |
| A listed output file was manually deleted | History has an entry whose `outputPath` no longer exists | That entry is silently dropped from the response — never listed as recoverable | N/A |
| History exceeds the cap | 21st fill on the same document | Oldest entry dropped from the JSON index; its `.document-fills` file is untouched on disk (just no longer indexed) | N/A |
| A batch fill (`fill_document_field_batch`) completes | One target in a batch call succeeds | That target gets its own history entry, same as a single-call fill | N/A |
| A discovery/prompt call or per-item batch failure | No `FILL_SUCCESS_MARKER` in the result | No history entry recorded | N/A |
| Document name ambiguous or not found | `document` matches 0 or 2+ saved documents | Same `resolveDocument` handshake every other tool uses | `err()`, same wording precedent |

</frozen-after-approval>

## Code Map

- `documents.ts:2827` `fillOneDocument` -- hook history recording immediately after a completed fill (post-`FILL_SUCCESS_MARKER` check), before returning -- single choke point covering both callers.
- `documents.ts:1673-1679` `writeFillOutput` -- the exact output path this story records; no change to this function itself.
- `documents.ts:1179` `matchDocuments`/`resolveDocument` -- reused unchanged for `list_document_versions`'s `document` argument.
- `documents.ts:88-94` `ok()`/`err()` helpers, reused throughout.
- New: a small `recordFillHistory(baseDir, slug, entry)` / `readFillHistory(baseDir, slug)` pair colocated in `documents.ts`, following the existing locked read-modify-write convention already used for `memory/index.md`.
- `documents.test.ts` -- existing fixture/`opts()` conventions to follow for the new describe block.
- `container/skills/document-memory/SKILL.md` -- new section teaching when to call `list_document_versions` and how to relay/resend a chosen entry via `send_file`.
- `_bmad-output/specs/spec-document-memory/SPEC.md` -- next CAP entry after CAP-7.

## Tasks & Acceptance

**Execution:**
- [x] `documents.ts` -- add `recordFillHistory`/`readFillHistory` (capped-array JSON read-modify-write under `.fill-history/<slug>.json`) -- the new index
- [x] `documents.ts` `fillOneDocument` -- call `recordFillHistory` immediately after a completed-fill result is confirmed (via `FILL_SUCCESS_MARKER`), before returning -- automatic coverage for both single and batch callers
- [x] `documents.ts` -- add `listDocumentVersionsImpl`/`listDocumentVersions: McpToolDefinition` (resolve `document`, read history, filter to still-existing paths, return ordered report) -- the new capability
- [x] `documents.ts` `registerTools([...])` -- register alongside the existing five
- [x] `documents.test.ts` -- new describe block covering every I/O Matrix row
- [x] `container/skills/document-memory/SKILL.md` -- section teaching when/how to call `list_document_versions` and resend a chosen entry
- [x] `_bmad-output/specs/spec-document-memory/SPEC.md` -- add the new CAP entry (CAP-8)

**Acceptance Criteria:**
- Given a document filled three times, when `list_document_versions` runs, then all three are returned in order with real, still-sendable output paths.
- Given a user wants to undo the last change, when the agent lists versions and resends the second-most-recent entry via `send_file`, then the user receives the pre-last-edit output.
- Given a document that was only ever discovery-called (no completed fill), when `list_document_versions` runs, then it reports an empty history, not an error.
- Given a batch fill completed one of its targets, when `list_document_versions` runs for that document, then the batch-produced fill appears in its history identically to a single-call fill.

## Spec Change Log

- Implementation fills in two details the spec left as boundaries without prescribing exact shape: (1) the `target` string's exact format is derived mechanically from whichever targeting args (`row`/`table`/`column`, `lineNumber`, `fieldName`, `pixelX`/`pixelY`, `signatureName`) were present on the call -- e.g. `"row 2"`, `"row 2, table 1"`, `"fieldName: Date"`, `"line 3"`, `"pixel (120, 340)"`, with `", signature: <name>"` appended when a signature was stamped; (2) `recordFillHistory`'s lock is per-document-slug (`.fill-history/.<slug>.lock`), not one shared lock across all documents in the group, so concurrent fills of two different saved documents never contend with each other -- still the same `withLock` AD-11 convention the spec pointed at for `memory/index.md`, just scoped one level finer.
- A fill-history write failure (e.g. a disk error) is caught and logged, never surfaced as a fill failure -- the real output file is already written and the response already confirms it by the time history recording runs, so a logging-layer error must not retroactively turn a successful fill into an error response.
- Step-04 review (blind-hunter, edge-case-hunter, verification-gap layers) found six patch-level gaps, all applied directly: (1) **atomicity** -- `recordFillHistory`'s write is now temp-file-then-`fs.renameSync` (not a direct `writeFileSync` onto the live path), because a process kill mid-write would otherwise leave the JSON file truncated, and `readFillHistory`'s own "corrupted index -> empty history" handling would then silently wipe every prior entry rather than just fail to add the new one; the atomic rename also makes `list_document_versions`'s unlocked `readFillHistory` read safe by construction. (2) **display timezone** -- `listDocumentVersionsImpl` now renders each entry's timestamp via `formatLocalTime(entry.timestamp, TIMEZONE)` (the same helper/import path `calendar.ts` already uses for agent-facing text), per CLAUDE.md's Timestamps convention; the JSON index itself still stores raw ISO. (3) **value in target** -- `describeFillTarget` now appends the written value (whitespace-collapsed, capped at 60 chars with an ellipsis) to the location description, e.g. `row 1 = "third"` instead of bare `row 1` -- three successive fills of the same field are otherwise indistinguishable in the report except by timestamp/position, which undermines the SKILL.md's own "pick by target description" guidance; this extends the original frozen-spec examples (`"row 2"`, `"fieldName: Date"`), which were illustrative, not a strict format contract. (4)+(5) **corruption/extraction-miss logging** -- `readFillHistory` now logs when it hits a genuinely malformed index (non-array JSON, unparseable JSON, or an array with dropped malformed entries) so that's distinguishable in `nanoclaw.log` from the normal "file doesn't exist yet" case (which still logs nothing); `fillOneDocument` now logs the (should-be-unreachable) case where a completed fill's result text doesn't match `extractFillOutputPath`'s regex, so a future copy-text drift wouldn't silently and invisibly stop recording history. (6) **cap semantics comment** -- a one-line comment on `FILL_HISTORY_CAP` now clarifies it caps raw index entries, not "still-recoverable" ones (a manually-deleted entry still occupies a slot until pushed out by a newer fill, even though `list_document_versions` filters it from what it shows). Test coverage added for all of the above plus the three review-flagged gaps: a fill-history write failure (forced via a file occupying the `.fill-history` directory's path, not a permission-bit toggle -- portable, doesn't depend on non-root execution) doesn't mask the fill's own success response; `list_document_versions` handles a non-array JSON history file and a mixed valid/malformed-entry array gracefully; two concurrent `fillDocumentFieldImpl` calls against the same document both survive in history (exercises the per-slug lock's actual serialization, not just its presence). Three other review findings were explicitly not actioned per the coordinator's classification: `.document-fills` retention/cleanup (deliberate, already-tracked deferred-work.md scope), a regex-drift regression test for `extractFillOutputPath` (already covered indirectly by every existing history test), and tagging entries batch- vs single-call-produced (scope creep beyond this spec).

## Design Notes

"Undo" is deliberately reframed as "recall and resend an earlier already-produced output," not "revert stored state" — the stored document was never touched by a fill in the first place (Story 1.2 onward), and this story stays independent of Story 2.4 (which would change that) per explicit operator decision. This also means Story 2.4, if built later, needs to re-examine this story's own invariant list before assuming it can safely start mutating the stored copy — the two remain a real cross-story dependency even though this one no longer blocks on the other.

## Verification

**Commands:**
- `cd container/agent-runner && bun test src/mcp-tools/documents.test.ts` -- expected: all version-history cases pass alongside the existing fill suites
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

**Manual checks (if no CLI):**
- Fill a real saved document twice through a live container session, call `list_document_versions`, confirm both entries list with real paths, and confirm resending the first one via `send_file` returns the pre-second-edit file.

## Suggested Review Order

**History core — the reframe: index existing outputs, never touch stored state**

- Entry point: history recording hooked at the single choke point both fill tools funnel through.
  [`documents.ts:3004`](../../container/agent-runner/src/mcp-tools/documents.ts#L3004)

- `list_document_versions`: resolves, reads, filters to still-existing paths, reports oldest-to-newest.
  [`documents.ts:3525`](../../container/agent-runner/src/mcp-tools/documents.ts#L3525)

- `recordFillHistory`/`readFillHistory`: capped, locked read-modify-write over the JSON index.
  [`documents.ts:1786`](../../container/agent-runner/src/mcp-tools/documents.ts#L1786)

**Review-round hardening — the one real data-loss risk, and the visibility gaps around it**

- Atomic write (temp file + rename) — closes the crash-mid-write risk that would otherwise silently wipe a document's entire history.
  [`documents.ts:1786`](../../container/agent-runner/src/mcp-tools/documents.ts#L1786)

- Localized timestamps and value-in-target — both display/UX fixes from the review round.
  [`documents.ts:2796`](../../container/agent-runner/src/mcp-tools/documents.ts#L2796)

**Test verification of the review-round fixes**

- Write-failure doesn't mask a successful fill; corrupted/malformed history handled gracefully; concurrent same-document fills both survive.
  [`documents.test.ts:4250`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L4250)

**Baseline I/O-matrix coverage**

- Three fills in order, manually-deleted entry dropped, cap-exceeded, batch-fill parity, discovery/failure records nothing.
  [`documents.test.ts:4115`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L4115)

**Peripheral — agent-facing guidance and planning-doc parity**

- `SKILL.md`'s new "Undoing a bad edit" section.
  [`SKILL.md:369`](../../container/skills/document-memory/SKILL.md#L369)

- `SPEC.md`'s CAP-8 entry and the new Non-goals line clarifying "undo" never reverts stored state.
  [`SPEC.md:45`](../specs/spec-document-memory/SPEC.md#L45)
