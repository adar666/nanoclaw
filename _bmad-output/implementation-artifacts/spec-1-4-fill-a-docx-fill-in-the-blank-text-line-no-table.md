---
title: 'Fill a Docx Fill-In-The-Blank Text Line (No Table)'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'f2fba353945e4006e9e98fd997a26f2738c1f3a3'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1.2's `fill_document_field` only knows how to fill a Word table cell. Live production use (real household forms) showed most real-world docx forms aren't tables at all — they're plain paragraphs with an underscore blank (`שם: ___________`) or a trailing label. Those documents currently get "This document has no tables to fill" and nothing more.

**Approach:** Add a second `.docx` targeting mode — text-line fill — that only applies when no table matches. Same two-call discovery pattern `fill_document_field` already uses for PDF text-layer lines: a first call (no `row`/`lineNumber`) returns a numbered list of detected fill-in-the-blank paragraphs when the document has no tables; a second call with `lineNumber` + `value` fills one.

## Boundaries & Constraints

**Always:**
- Table-row targeting (Story 1.2, unchanged) always wins when the document has tables and `row` (or `table`+`row`) is given — text-line mode only activates when the document has zero tables, or the caller supplies `lineNumber` instead of `row`.
- A "fill-in-the-blank" paragraph is one whose text (own runs only, not descendants of a `<w:tbl>`) contains a run of 3+ literal `_` characters, or ends with `:` with nothing meaningful after it. Detection scans top-level body paragraphs in document order — table-internal paragraphs are never candidates here (those are the existing table-row path's job).
- Discovery call (neither `row`/`table` nor `lineNumber` given): always scans for fill-in-the-blank paragraphs *regardless of whether the document also has tables* — a document mixing both gets a response naming both possibilities (the table-row prompt, plus the numbered blank-line list) so the agent can pick either targeting mode, never just the table prompt with the blank lines invisible to it.
- Fill call (`lineNumber` + `value` given): if the paragraph has an underscore run, replace exactly that run's text with `value`; if it has no underscore run but ends in a bare colon, insert a new run right after the paragraph's last existing run containing the value. Only that one paragraph changes — every other paragraph, including any tables, is byte-identical in the output.
- `lineNumber` becomes a shared argument name between `.docx` (this story) and `.pdf` (Story 1.2) — the argument-type validation (`DOCX_ONLY_ARGS`/`PDF_ONLY_ARGS`) must stop treating it as PDF-exclusive without breaking Story 1.2's existing PDF-only rejection of `fieldName`/`pixelX`/`pixelY` against a `.docx`.
- Reuses Story 1.1/1.2's existing helpers (`parseOoxmlTree`, `treeIsWellFormed`, `writeFillOutput`, the shared `err()`/`ok()` shapes, `stripControlChars`-backed `xmlEscapeText`) — no parallel OOXML reader.

**Never:**
- Never attempts text-line fill on a paragraph that's a descendant of a table — that's table-row targeting's job even if the same document also has non-table paragraphs.
- Never guesses a target when no fill-in-the-blank marker is found anywhere and no table matches either — declines clearly (AD-8), same as today's "no tables to fill" case but reworded to also say no fillable line was found.
- Never fills more than one paragraph per call, and never touches a paragraph inside a table via this path.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Discovery, no tables | Saved `.docx` with no tables, 2+ paragraphs carrying underscore blanks | First call (no `lineNumber`) returns a numbered list of candidate lines | N/A |
| Fill, underscore blank | Same document, second call with `lineNumber` + `value` | The matched underscore run is replaced with `value`; rest of document byte-identical; new `.docx` returned | N/A |
| Fill, trailing-colon blank (no underscores) | A paragraph ending `תאריך:` with nothing after it | Value inserted as a new run right after the paragraph's last run | N/A |
| Document has both tables and blank-line paragraphs | Saved `.docx` with 1 table and 1 non-table blank paragraph, `row` given | Table-row path (Story 1.2) runs, text-line mode never considered | N/A |
| Document has both tables and blank-line paragraphs | Same document, `lineNumber` given instead of `row` | Text-line path runs against the non-table paragraph, table untouched | N/A |
| Document has both tables and blank-line paragraphs | Same document, bare discovery call (no `row`/`table`/`lineNumber`) | Response names both: the table-row prompt AND the numbered blank-line list | N/A |
| No table, no fill-in-the-blank marker found anywhere | Saved `.docx` with plain prose, no underscores, no bare trailing colons | Declines clearly | MCP error text, no file written |
| `lineNumber` out of range | Discovery found 2 lines, caller passes `lineNumber: 5` | Declines clearly, states how many lines were found | MCP error text |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/documents.ts:929-1007` -- `fillDocx`; entry point to extend. Currently `row` is unconditionally required (`935-936`) before any table-existence check — this must become conditional: `row`/`table` given → existing table path unchanged; `lineNumber` given → new text-line fill path; neither given → discovery (table-count prompt if tables exist, else scan for blank-line candidates).
- `container/agent-runner/src/mcp-tools/documents.ts:778-927` -- `XmlNode`/`parseOoxmlTree`/`treeIsWellFormed`/`nodeContainsTag`/`collectDescendants`/`replaceCellText`/`insertRunIntoCell`/`writeFillOutput` -- all reusable as-is. `replaceCellText`/`insertRunIntoCell` operate on a `t`-node list or a cell node respectively; the new text-line path needs the same splice logic against a paragraph's own `t` descendants (excluding any inside a nested `w:tbl`, which can't occur for a top-level body paragraph anyway) -- likely a thin wrapper or direct reuse, not a new splice algorithm.
- `container/agent-runner/src/mcp-tools/documents.ts:257-281` -- `docxXmlToText`/`decodeXmlEntities` (Story 1.1's simpler read-path regex reader) -- reference only, not reused directly (that reader works on raw XML strings, not the `XmlNode` tree this story needs for precise splicing); shows the existing `<w:p>`/`<w:t>` regex shape as prior art.
- `container/agent-runner/src/mcp-tools/documents.ts:1000-1050` (approx, PDF section) -- `PdfLine` interface, `pdfExtractLinesAllPages`, `pdfListLines` -- the shape to mirror for the new docx-side discovery response (numbered candidate list, same two-call UX).
- `container/agent-runner/src/mcp-tools/documents.ts:1363-1419` -- `DOCX_ONLY_ARGS`/`PDF_ONLY_ARGS`/`presentArgNames` and the dispatch that rejects wrong-file-type args -- `lineNumber` must move from PDF-exclusive to shared; `row`/`table`/`column` stay docx-only; `fieldName`/`pixelX`/`pixelY` stay PDF-only.
- `container/agent-runner/src/mcp-tools/documents.ts:1421` (approx) -- `fillDocumentField`'s `inputSchema` -- description text needs to explain the new discovery behavior for a table-less docx (currently only documents the table-row shape).
- `container/skills/document-memory/SKILL.md` -- the docx fill section needs the new text-line mode documented, including that table-row targeting still wins when both apply, mirroring the existing PDF two-call documentation style already in the file.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- restructure `fillDocx`'s entry logic (row/lineNumber/discovery branching), add paragraph-level fill-in-the-blank detection + splice, move `lineNumber` to shared arg validation
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- update `fillDocumentField`'s tool description for the new docx discovery flow
- [x] `container/agent-runner/src/mcp-tools/documents.test.ts` -- bun:test coverage for the I/O matrix above
- [x] `container/skills/document-memory/SKILL.md` -- document the new text-line fill mode and the table-priority rule

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs, then all tests (new and existing) pass, including every existing Story 1.2/1.3 test unmodified in behavior.
- Given a `.docx` with both a table and a non-table blank paragraph, when `fill_document_field` is called with `row` vs. with `lineNumber`, then the two calls target different parts of the document as described in the I/O matrix, never the wrong one.

## Spec Change Log

- 2026-08-16 (code review, bad_spec self-resolved under blanket automator delegation for this epic run — no genuine ambiguity to loop back on, 2 of 3 review lenses independently converged on the same gap): the original frozen Boundaries text scoped bare-discovery listing to "document has no tables" only, so a document mixing a table with non-table blank paragraphs never surfaced the blank lines to the agent at all — it only ever got the table-row prompt, with no way to discover valid `lineNumber`s for the blanks that actually exist, directly contradicting this same spec's own "never guess, ask" principle. **KEEP:** every other targeting/priority rule (table wins when `row` is given, `lineNumber` wins when given instead) is unaffected and correct as designed — only the *bare-discovery* response for a mixed document was too narrow. Boundaries + I/O matrix amended above to require the discovery response to name both possibilities.

## Design Notes

Paragraph "line number" addressing is 1-indexed, document order, top-level body paragraphs only (never inside a `<w:tbl>`) — consistent with AD-5's row addressing being 1-indexed and PDF's `lineNumber` being 1-indexed. No new numbering convention introduced.

Underscore-run detection: scan a paragraph's `t`-descendant text (concatenated, matching the existing run-fragmentation-aware pattern `replaceCellText`/`docxXmlToText` already handle) for `/_{3,}/`. If found within a single `<w:t>` node, splice that node exactly like `replaceCellText` does for a table cell. If the underscore run is fragmented across multiple runs (rare but possible, mirrors the multi-run-per-cell case already documented as a known limitation in Story 1.2), the same first-run-wins/blank-the-rest behavior documented for `replaceCellText` applies — no new precedent needed.

## Verification

**Commands:**
- `cd container/agent-runner && bun test` -- expected: all pass
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

## Suggested Review Order

- Start here -- entry logic branching (row/table vs lineNumber vs discovery), mixed-doc discovery, mutual-exclusivity errors.
  [`documents.ts:1149`](../../container/agent-runner/src/mcp-tools/documents.ts#L1149)
- Discovery response -- names both the table prompt and blank-line candidates for a mixed document.
  [`documents.ts:1091`](../../container/agent-runner/src/mcp-tools/documents.ts#L1091)
- Multi-blank detection -- one candidate per underscore run, not just the first.
  [`documents.ts:994`](../../container/agent-runner/src/mcp-tools/documents.ts#L994)
- Colon-label false-positive guard.
  [`documents.ts:1023`](../../container/agent-runner/src/mcp-tools/documents.ts#L1023)
- The actual fill -- underscore-run splice or colon-insert with the new leading space.
  [`documents.ts:1119`](../../container/agent-runner/src/mcp-tools/documents.ts#L1119)
- Tab/`<w:br/>`-aware paragraph text (discovery listing readability).
  [`documents.ts:964`](../../container/agent-runner/src/mcp-tools/documents.ts#L964)
- Colon-insert formatting fix.
  [`documents.ts:1105`](../../container/agent-runner/src/mcp-tools/documents.ts#L1105)
- Agent-facing usage guide -- text-line mode, table priority, the known shared-run-label-loss caveat.
  [`SKILL.md`](../../container/skills/document-memory/SKILL.md)
- New Deferred entries.
  [`ARCHITECTURE-SPINE.md`](../../planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-16/ARCHITECTURE-SPINE.md)
- 19-test addition covering the full I/O matrix plus every patch-round fix.
  [`documents.test.ts`](../../container/agent-runner/src/mcp-tools/documents.test.ts)
