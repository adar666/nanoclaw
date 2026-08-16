---
title: 'Fill a Named Target in a Saved Document and Return It'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'e417131b94acb5241ad16f94e470ad6ef2ac10a2'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A document saved via `save_document` (Story 1.1) sits in memory, but a user who wants a value filled into it — a form's blank line, a table row, a PDF field — has no way to get that back short of editing it themselves.

**Approach:** Add `fill_document_field` (targets a table row in a saved `.docx`, an AcroForm field or a text-layer/scanned-page position in a saved `.pdf`, writes the value, returns a new file via `send_file`) plus `list_documents` (returns saved-document candidates by name/topic match — shared by this story's own disambiguation and Story 1.3's recall).

## Boundaries & Constraints

**Always:**
- Targets a document already in `memory/documents/` (resolved by name/topic via the same matching `list_documents` uses) — never an inbox path; never re-reads the original attachment.
- Word (`.docx`): `jszip` unzips, locates table `N` (Nth top-level `<w:tbl>`, ignoring any nested inside a cell) and row `M` within it (Nth direct `<w:tr>`), edits one cell's `<w:t>` run text, rezips. Column defaults to the row's *last* cell (the common label|value row shape); an optional `column` argument overrides.
- PDF, in priority order (row-targeting-matrix.md): (1) an AcroForm field matching `fieldName` → `pdf-lib` `form.getFieldMaybe`/`getTextField().setText()`, no page redraw; (2) a text layer with no matching field → `pdfjs-dist` groups text items into lines by y-coordinate, `lineNumber` picks one, `pdf-lib` draws the value just after that line's existing content on the same baseline — never reflow, never remove existing content; (3) no text layer (scanned) → same `pdfium` render-page-1 pattern Story 1.1 uses, agent visually estimates a pixel position, tool converts to PDF point-space and draws there.
- Text-layer PDF and scanned-PDF branches are two-call, mirroring Story 1.1's scanned-PDF pattern: a first call without `lineNumber`/`pixelX`+`pixelY` returns numbered lines (or a rendered page + pixel dimensions) for the agent to choose from; a second call on the same `document` supplies the choice plus `value` to complete the edit.
- Reuses Story 1.1's `slugify`, containment/locking/escaping helpers, and `documents.ts` module — no new file, no duplicated logic.
- `list_documents` matches a free-text query against saved slugs/filenames/descriptions; 0 matches → clear error; 1 → resolved; 2+ → numbered candidate list returned (not an error) for the agent to relay and re-call with the exact slug (AD-7). No query → returns all.
- Never resolves to more than one target ambiguously — an unresolved table/row/field/line always errors with this codebase's existing MCP error shape, never an approximate write (AD-8).
- The stored canonical copy and stored extracted text are never modified by a fill — only the delivered file changes (spine's Deferred default).

**Ask First:**
- If `pdf-lib`'s `getTextField`/`getFieldMaybe` behavior, once tested against a real AcroForm PDF, doesn't match the researched API shape (throws vs. returns undefined) closely enough to build the "list available fields on mismatch" error cleanly — HALT before working around it with something more fragile.

**Never:**
- Never attempt a nested table (a `<w:tbl>` inside a cell) — detect and error clearly rather than miscounting rows.
- Never edit or replace text already on a PDF page — overlay only adds new content in blank space near the target line/position.
- Never call `fill_document_field` on anything other than a previously-saved document (no raw inbox path input).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path, docx | Saved `.docx` with 1 table, `table:1, row:2, value:"X"` | Row 2's last cell now contains "X"; new `.docx` returned via `send_file`; rest byte-identical elsewhere | N/A |
| Docx, explicit column | Same, plus `column:1` | First cell (not last) gets the value | N/A |
| Docx, single-table row-without-table-number | Doc has exactly 1 table, only `row` given | Table 1 inferred | N/A |
| Docx, nested table | Row's cell contains a nested `<w:tbl>` | Declines clearly | MCP error text, no file returned |
| PDF, AcroForm match | Saved PDF with a field named `Name`, `fieldName:"Name", value:"X"` | Field value set via `pdf-lib`, no redraw; new PDF returned | N/A |
| PDF, AcroForm no match | `fieldName` doesn't exist on the form | Error lists the PDF's actual field names | MCP error text |
| PDF, text-layer, first call | Saved PDF with text, no `lineNumber` given | Returns a numbered list of detected lines | N/A |
| PDF, text-layer, second call | Same document, `lineNumber:3, value:"X"` | "X" drawn just after line 3's content, same baseline; new PDF returned | N/A |
| PDF, scanned, first call | Saved scanned PDF, no `pixelX`/`pixelY` | Renders page 1, returns path + pixel dimensions | N/A |
| PDF, scanned, second call | Same document, `pixelX`/`pixelY`/`value` given | Value drawn at the converted point-space position; new PDF returned | N/A |
| Ambiguous document reference | `document:"report"` matches 2+ saved docs | Numbered candidate list returned | N/A (not an error) |
| Unresolvable target | `table:9` (doesn't exist) | Declines clearly, no file written | MCP error text |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/documents.ts:86-235` -- reuse directly: `isPathInside`/`resolveInboxPath` pattern (adapt for a `memory/documents/`-scoped containment check), `slugify`/`uniqueSlug`, `withLock`, `stripControlChars`/`yamlEscape`/`escapeMarkdown`, `LOCK_STALE_MS`.
- `container/agent-runner/src/mcp-tools/documents.ts:287-433` -- `extractPdfText`/`hasTextLayer`/`renderFirstPageToPng` -- reuse for this story's own text-layer line-grouping (needs `pdfjs-dist`'s per-item `transform` matrix, not just concatenated text) and scanned-page render.
- `container/agent-runner/src/mcp-tools/documents.ts:436-624` -- `saveDocumentImpl`/`saveDocument` -- shape to mirror for `fillDocumentFieldImpl`/`fillDocumentField` and `listDocumentsImpl`/`listDocuments`, including the two-call pattern already established for scanned PDFs.
- `container/agent-runner/src/mcp-tools/index.ts:14` -- already imports `./documents.js`; no new barrel line needed (same file).
- `container/agent-runner/package.json:11-17` -- `dependencies`; add `pdf-lib`, `jszip`.
- pdf-lib (researched): `PDFDocument.load(bytes)`; `form.getFieldMaybe(name)` (non-throwing lookup) vs. `form.getTextField(name)` (throws if missing/wrong type) -- use `getFieldMaybe` to build a clean "field not found, available fields: ..." error; `pdfDoc.embedFont(StandardFonts.Helvetica)` required before `page.drawText(text, {x, y, size, font})`; PDF coordinate origin bottom-left, points, y up -- `pdfY = pageHeightPts - (pixelY/imageHeightPx)*pageHeightPts`, `pdfX = (pixelX/imageWidthPx)*pageWidthPts`; `pdfDoc.save()` returns `Uint8Array`.
- pdfjs-dist (already a dep): `content.items[i].transform` is a 6-element matrix already in PDF point-space (not pixels) -- items[].transform[4]/[5] give x/y directly; group items by rounded y (small tolerance) for line detection, sort top-to-bottom.
- OOXML tables (researched, Microsoft Open XML SDK docs): `<w:tbl>` -> `<w:tr>`* -> `<w:tc>`* -> `<w:p>`+ -> `<w:r>`* -> `<w:t>`. A `<w:tc>` can hold multiple `<w:p>` (multi-paragraph cell) and, rarely, a nested `<w:tbl>` -- must be detected and rejected, not miscounted.
- `container/skills/document-memory/SKILL.md` -- extend with `fill_document_field`/`list_documents` usage, including the two-call pattern and the disambiguation flow.

## Tasks & Acceptance

**Execution:**
- [ ] `container/agent-runner/package.json` -- add `pdf-lib`, `jszip` to `dependencies` -- write libs (AD-3)
- [ ] `container/agent-runner/bun.lock` -- regenerate via `bun install`
- [ ] `container/agent-runner/src/mcp-tools/documents.ts` -- add `docxFillCell` (table/row/nested-table detection, run-merge-aware cell replace), `pdfFillField`/`pdfFillOverlay` (AcroForm + line/pixel overlay branches), `resolveDocument` (shared slug/name matcher), `listDocumentsImpl`/`listDocuments`, `fillDocumentFieldImpl`/`fillDocumentField` -- AD-1/4/5/7/8/10
- [ ] `container/agent-runner/src/mcp-tools/documents.test.ts` -- bun:test coverage for the I/O matrix above
- [ ] `container/skills/document-memory/SKILL.md` -- extend with the two new tools' usage

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs, then all tests (new and existing) pass.
- Given a `.docx` with a table and a `.pdf` with an AcroForm field are both fixtures in the test suite, when their respective fill paths run, then the returned file differs from the original by exactly the targeted value and nothing else.

## Spec Change Log

## Design Notes

Docx column default (assumption, not in SPEC/spine): the row's *last* cell, matching the common "label | value" two-column form-row shape; `column` argument is the escape hatch for anything else. Flag to the user in the completion summary as a judgment call, not silently invented.

Two-call pattern for text-layer lines and scanned-PDF pixels mirrors Story 1.1's scanned-PDF save flow exactly (render/list, then a second call supplying the human-in-the-loop choice) — reuse that shape rather than inventing a new one.

`resolveDocument`/`listDocuments` matching: simple case-insensitive substring match against `slug`, `source-filename`, and `description` frontmatter fields is sufficient for this story's scope -- no fuzzy/ranked search needed yet.

## Verification

**Commands:**
- `cd container/agent-runner && bun test` -- expected: all pass
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

## Suggested Review Order

**Entry point & document resolution**

- Start here -- routes to docx/PDF, resolves the target document by name/topic.
  [`documents.ts:1413`](../../container/agent-runner/src/mcp-tools/documents.ts#L1413)
- Shared slug/filename/description matcher (AD-7) -- also backs `list_documents`.
  [`documents.ts:704`](../../container/agent-runner/src/mcp-tools/documents.ts#L704)

**Docx: table/row targeting**

- OOXML tokenizer -- exact-offset tree, nested-table and merged-cell aware.
  [`documents.ts:782`](../../container/agent-runner/src/mcp-tools/documents.ts#L782)
- Cell replacement -- run-merge-aware, `xml:space="preserve"` guaranteed.
  [`documents.ts:866`](../../container/agent-runner/src/mcp-tools/documents.ts#L866)
- Orchestration: table/row resolution, decline paths (nested table, gridSpan).
  [`documents.ts:920`](../../container/agent-runner/src/mcp-tools/documents.ts#L920)

**PDF: three-branch priority (row-targeting-matrix.md)**

- AcroForm field set -- no page redraw; also the auto-discovery source for the first-call response.
  [`documents.ts:1276`](../../container/agent-runner/src/mcp-tools/documents.ts#L1276)
- Text-layer line overlay -- pdfjs-dist coordinates, two-call pattern.
  [`documents.ts:1177`](../../container/agent-runner/src/mcp-tools/documents.ts#L1177)
- Scanned-page pixel overlay -- pixel→point conversion, bounds-checked.
  [`documents.ts:1241`](../../container/agent-runner/src/mcp-tools/documents.ts#L1241)
- Branch selection + document-type arg validation.
  [`documents.ts:1311`](../../container/agent-runner/src/mcp-tools/documents.ts#L1311)

**Unicode / Hebrew text support**

- Font embedding -- Helvetica + Noto Sans Hebrew via fontkit, script-detected.
  [`documents.ts:1099`](../../container/agent-runner/src/mcp-tools/documents.ts#L1099)
- Mixed-script drawing -- splits a value across fonts per run.
  [`documents.ts:1130`](../../container/agent-runner/src/mcp-tools/documents.ts#L1130)

**Tool contract & wiring**

- `list_documents` -- disambiguation data source (AD-7).
  [`documents.ts:737`](../../container/agent-runner/src/mcp-tools/documents.ts#L737)
- Barrel registration -- both new tools alongside `save_document`.
  [`documents.ts:1501`](../../container/agent-runner/src/mcp-tools/documents.ts#L1501)

**Peripherals**

- New write-path dependencies (AD-3) + Hebrew font asset.
  [`package.json`](../../container/agent-runner/package.json)
- 63-test suite covering the I/O matrix plus every patch-round fix.
  [`documents.test.ts`](../../container/agent-runner/src/mcp-tools/documents.test.ts)
- Agent-facing usage guide -- both tools, two-call pattern, disambiguation flow.
  [`SKILL.md`](../../container/skills/document-memory/SKILL.md)
- MCP tool interface doc update.
  [`agent-runner-details.md`](../../docs/agent-runner-details.md)
