---
title: 'Stamp a Saved Signature into a Saved PDF'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '5bc347e'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `save_signature` (Story 1.6) gives a user a reusable, cleaned-up signature image, but there's no way to actually use it — signing a filled form still means printing, hand-signing, and rescanning. `fill_document_field` can already draw text at any of a PDF's three target kinds (AcroForm field, text-layer line, scanned-page pixel position); it has no way to draw an image at those same targets.

**Approach:** Add an optional `signatureName` argument to `fill_document_field`. When given on a PDF document, it resolves `memory/signatures/<name>.png`, embeds it via `pdf-lib`, and draws it at whichever of the three existing PDF targets the call already resolves to — reusing each target's existing position-resolution logic, not inventing a fourth. A text `value` may be given alongside `signatureName` to draw both (image + text, e.g. a date) in one call. This story is **PDF only** — `.docx`/`.doc` signature embedding is a deliberately separate, later story (user-mandated sequential build with independent verification between the two).

## Boundaries & Constraints

**Always:**
- New optional `signatureName` argument on `fill_document_field`'s existing schema (no new tool).
- `signatureName` resolves to `memory/signatures/<signatureName>.png` under the calling session's `baseDir` — **exact filename match only** (no fuzzy/topic matching, unlike `document`). On a miss, decline with a clear error that lists the `.png` base names actually present in `memory/signatures/` (or says none are saved yet) — never guesses or silently skips.
- `signatureName` only applies to a `.pdf` document. Given against a `.docx` or `.doc` document, decline clearly: signature stamping into Word documents is a separate, not-yet-built story — never attempt it, never silently ignore `signatureName` and fall through to a text-only fill.
- `signatureName` reuses the **same target resolution** `fillPdf`'s existing three branches already compute — it does not add a fourth target kind or change priority order (AcroForm field wins if `fieldName` given; else text-layer line if `lineNumber` given; else scanned-page pixel position if `pixelX`/`pixelY` given). A first call with `signatureName` but no target argument gets the exact same discovery response (field names / detected lines / render-and-report-dimensions) the text-only path already returns for that document — discovery behavior is unmodified.
- Image placement per target:
  - **AcroForm field**: use the field's own widget rectangle (`form.getField(fieldName).acroField.getWidgets()[0].getRectangle()`) to size and center the image within that rect, preserving the source PNG's natural aspect ratio (scale to fit, never stretch/distort). The field's text is left unset — the field itself is not filled with a value when stamping an image into it.
  - **Text-layer line**: same `(drawX, target.y)` anchor point `pdfFillLine`'s existing text draw already computes (`target.endX + gapPt`, `target.y`) — image's bottom-left corner anchors there, drawn upward from the baseline.
  - **Scanned-page pixel position**: same `(pdfX, pdfY)` conversion `pdfFillPixel`'s existing text draw already computes from `pixelX`/`pixelY` — image's bottom-left corner anchors there.
- Image sizing: a fixed max-height constant (not a new argument, not configurable this story) with the source PNG's natural aspect ratio preserved — width is derived, never independently set. Pick a value reasonable for a signature next to a line of ~11pt text (a small multiple of that, not a full-page image) — implementer's exact constant, documented in Design Notes/code comment, no "Ask First" needed for the number itself.
- If `value` is also given alongside `signatureName` for the same call, draw the text immediately beside the image (same baseline/y, x offset by the image's drawn width + the existing `gapPt` convention) using the existing `embedTextFonts`/`drawUnicodeText` helpers unmodified — one new PDF, one call, both marks.
- Reuses `pdf-lib`'s `pdfDoc.embedPng(bytes)` (already a project dependency, no new package) — no new image-handling library.
- Every successful stamp writes the existing `FILL_SUCCESS_MARKER` (`'New file at '`) convention in its `ok()` text, same as every other completed fill — so `.doc`'s disclosure-gating and any other marker-sensitive logic keeps working unmodified.

**Ask First:**
- If `pdf-lib`'s AcroForm widget-rectangle API differs materially from `getWidgets()[0].getRectangle()` in the currently-pinned version (`1.17.1`, already in this project) — research and adapt; only HALT if no way exists to read a field's on-page rectangle at all.

**Never:**
- Never attempts `.docx`/`.doc` signature stamping in this story.
- Never fuzzy-matches a `signatureName` the way `document` is matched — exact filename only.
- Never distorts/stretches the signature image off its source aspect ratio.
- Never fills an AcroForm field's text value when stamping an image into it (image and text-fill are mutually exclusive for that one field in one call, though a *different* field/line could still receive `value` alone in a separate call).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stamp an AcroForm field | Saved PDF with a form field, `fieldName` + `signatureName` (saved) | Image embedded at the field's widget rect, field text left unset, new PDF returned | N/A |
| Stamp a text-layer line | Saved PDF, text layer, `lineNumber` + `signatureName` | Image drawn at the same anchor a text draw would use for that line | N/A |
| Stamp a scanned page | Saved PDF, no text layer, `pixelX`/`pixelY` + `signatureName` | Image drawn at the pixel-converted position | N/A |
| Stamp + date together | Any PDF target + `signatureName` + `value` | Image drawn at target position; text drawn beside it, same call | N/A |
| Unknown signature name | `signatureName` doesn't match any file in `memory/signatures/` | Declines, lists actual saved signature names (or "none saved yet") | MCP error text |
| Signature on a `.docx`/`.doc` | `signatureName` given, document is Word | Declines clearly — not supported yet, future story | MCP error text |
| No target given, `signatureName` present | First call, no fieldName/lineNumber/pixelX+pixelY | Same discovery response the text-only path already returns (unmodified) | N/A |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/documents.ts:1860-1893` (`pdfFillAcroForm`) -- add an image-draw branch: when `signatureName` is given, resolve+embed the PNG, get the field's widget rectangle via `form.getField(fieldName).acroField.getWidgets()[0].getRectangle()`, draw scaled/centered within it on the underlying page (`pdfDoc.getPages()` — need to resolve which page the widget's on; `pdf-lib`'s `PDFAcroField`/widget typically exposes this via the annotation dict, or fall back to iterating pages looking for the widget — research at implementation time), skip `textField.setText(value)`/`form.updateFieldAppearances(...)` for the image case.
- `container/agent-runner/src/mcp-tools/documents.ts:1761-1793` (`pdfFillLine`) -- add the image-draw branch using the same `drawX`/`target.y` anchor already computed; draw text beside it only if `value` is also given (offset by the drawn image width).
- `container/agent-runner/src/mcp-tools/documents.ts:1825-1858` (`pdfFillPixel`) -- same pattern: image at `(pdfX, pdfY)`, optional text beside it.
- `container/agent-runner/src/mcp-tools/documents.ts:1895-1936` (`fillPdf`) -- read `args.signatureName`, resolve the PNG file once (shared helper, not duplicated three times), pass it down into whichever of the three branches the existing dispatch already picks.
- `container/agent-runner/src/mcp-tools/documents.ts:2104-2105` (`DOCX_ONLY_ARGS`/`PDF_ONLY_ARGS`) -- reference only; `signatureName` is PDF-only but the existing `PDF_ONLY_ARGS`/`DOCX_ONLY_ARGS` gate (`fillDocumentFieldImpl:2144-2154`) already routes by `meta.ext` before `fillPdf`/`fillDocx`/`fillDoc` are called — add `signatureName` to `PDF_ONLY_ARGS` so a `.docx`/`.doc` call with `signatureName` gets the existing, unmodified "these arguments don't apply to a .docx document" decline for free, matching the frozen Boundaries' Word-decline requirement without new code.
- New helper `resolveSignaturePng(baseDir, name)` -- exact-match lookup under `memory/signatures/`, returns the PNG bytes or a listing-based error message; placed near the top of the PDF-fill section, called once from `fillPdf`.
- `container/agent-runner/src/mcp-tools/documents.ts:2172-2239` (`fillDocumentField` tool definition) -- add `signatureName` to `inputSchema.properties`, update the tool `description` to mention image stamping.
- `container/skills/document-memory/SKILL.md` -- add a short section on stamping a saved signature into a PDF, referencing `save_signature` for how one gets saved first, and stating plainly that `.docx` stamping isn't available yet.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- `resolveSignaturePng` helper; image-draw branches in `pdfFillAcroForm`/`pdfFillLine`/`pdfFillPixel`; `signatureName` added to `PDF_ONLY_ARGS` and the tool's `inputSchema`
- [x] `container/agent-runner/src/mcp-tools/documents.test.ts` -- bun:test coverage for the I/O matrix above (real PDF fixtures + a real saved-signature PNG fixture, real `pdf-lib` embed/draw, decoded/inspected output — not a mocked pipeline)
- [x] `container/skills/document-memory/SKILL.md` -- document signature stamping for PDFs, explicit that `.docx` isn't supported yet

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs, then all tests pass, including real embed-and-draw round-trips for all three target kinds plus the image+text-together case.
- Given a real container build, when a user asks to stamp a saved signature into a saved PDF via chat, then the returned PDF visibly contains the signature at the correct location and nothing else in the document changed.

## Spec Change Log

- 2026-08-17 (implementation, unstated-but-implied behavior, not a deviation): for the AcroForm target, `value` given alongside `signatureName` draws the text directly on the page beside the image (offset by `FILL_GAP_PT`), since the field's own text is explicitly off-limits when stamping an image — consistent with the I/O matrix's "any PDF target + signatureName + value" row and the general Boundary, just not spelled out for this specific target. No Change Log entry needed for the substance; noted here for the record per standing instruction to flag resolved ambiguities.

- 2026-08-17 (code review — blind-hunter/edge-case-hunter/verification-gap, 5 patch findings applied, rest deferred): the AcroForm image branch's widget→page resolution fallback (`/P` ref match → single-page shortcut → `/Annots`-array scan) was the "genuinely tricky" area the spec's own Design Notes flagged, and shipped with zero real coverage in the first round — every fixture was single-page, so only the trivial shortcut ever ran. Added a real 2-page fixture with the target field's widget on page 2, exercised both the `/P`-ref fast path and (by stripping `/P` post-construction) the `/Annots`-scan fallback — both now assert the image lands on page 2, not page 1. `pdfFillLine`/`pdfFillPixel`'s image branches previously scaled to a fixed height with **unbounded derived width** and only checked the anchor x-position against the page edge, not the drawn image's actual bounding box — a wide-aspect signature near an edge could draw partially/fully off-page with no error; now checks both axes of the scaled image against the page's real bounds before drawing, declining clearly otherwise (this also surfaced that several of the first round's own tests were themselves silently drawing off the top of their fixture page — fixed by adjusting those anchors, not a production bug). `pdfFillAcroForm`'s image branch previously operated on `field.acroField.getWidgets()[0]` for *any* field type with no widget-count check — a checkbox/radio/dropdown field, or a text field with more than one widget (legal per spec), silently picked an arbitrary position; now shares the pre-existing `form.getTextField(fieldName)` type validation with the text-fill path and additionally requires exactly one widget, declining clearly for either violation. A degenerate (`zero-area or corner-reversed`) widget `/Rect` previously produced an invisible or mirrored draw while still reporting success; now declines before drawing. The `/Annots`-array scan's `annots.lookup(i, PDFDict)` call previously threw uncaught on a non-dereferenceable entry (a legal-but-atypical malformed PDF), surfacing as a generic top-level error instead of the intended clean message — now wrapped, skips a bad entry and falls through to the existing decline if nothing else matches. **Deferred, not fixed** (logged to `ARCHITECTURE-SPINE.md`'s Deferred section): page rotation (`/Rotate`) is never consulted by the image draw (pre-existing limitation shared with text fills, not new to this story); no test decodes the embedded image's actual pixel content (placement/non-distortion is verified via content-stream geometry, not pixel fidelity of the embed round-trip — `pdf-lib`'s `embedPng` is low-risk enough not to warrant it now); cosmetic success-message wording differs across the three PDF targets; `signatureName` combined with both `fieldName` and `lineNumber` in one call is untested but behaves per the pre-existing (already-silent) priority order, not a new gap. **Verified independently**, not just self-reported: re-ran `cd container/agent-runner && bun test` (298 pass, 7 skip, 0 fail) and `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (clean) myself after the patch round, before accepting the implementer's report.

## Design Notes

For the AcroForm widget-rectangle-to-page mapping: `pdf-lib`'s `PDFAcroField.getWidgets()` returns `PDFWidgetAnnotation[]`, each with `.getRectangle()` (page-space `{x, y, width, height}`) and typically a `P` (page) dict reference, or the field's containing page can be found by matching the widget against each page's `Annots` array if `P` isn't reliably populated — this codebase's existing `pdfFillAcroForm` already loads `pdfDoc.getForm()`/`form.getTextField(fieldName)` successfully for text fields, so the same field lookup extends naturally; only the page-resolution and rectangle read are new. If `pdf-lib`'s API for this proves awkward, `form.getField(fieldName).acroField.dict` inspection or iterating `pdfDoc.getPages()` and checking each page's annotation refs against the widget's own ref are reasonable fallbacks — pick whichever is cleanest, this is exactly the kind of small adaptation the spec's "Ask First" clause pre-clears without needing to halt.

A max-height around 40-50pt (roughly the height of 3-4 lines of 11pt body text) is a reasonable default for "a signature next to a line" — small enough not to dominate a page, large enough to be visibly legible. Not a hard requirement, implementer's call within that ballpark.

Test fixtures: for the AcroForm case, extend this file's existing `buildPdfWithFormField`-style fixture builder (or whatever the current equivalent is called — check `documents.test.ts` for the pattern Story 1.2 already established) rather than hand-rolling PDF bytes from scratch. For the signature PNG fixture, a small real PNG (a handful of non-white pixels, matching Story 1.6's own fixture-building convention) is sufficient — the point under test is placement and non-distortion, not signature *quality*.

## Verification

**Commands:**
- `cd container/agent-runner && bun test` -- expected: all pass
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors
- `./container/build.sh build` -- expected: succeeds (no new dependency this story — `pdf-lib` is already present)

## Suggested Review Order

- Start here -- dispatch, resolves `signatureName` once for whichever target the existing priority order picks.
  [`documents.ts:2094`](../../container/agent-runner/src/mcp-tools/documents.ts#L2094)
- Signature PNG resolution -- exact-match lookup, path-safety.
  [`documents.ts:1790`](../../container/agent-runner/src/mcp-tools/documents.ts#L1790)
- AcroForm target -- widget/page resolution (the trickiest part), field-type/widget-count validation, degenerate-rect guard.
  [`documents.ts:1976`](../../container/agent-runner/src/mcp-tools/documents.ts#L1976)
- Text-layer line target -- off-page bounding-box check.
  [`documents.ts:1834`](../../container/agent-runner/src/mcp-tools/documents.ts#L1834)
- Scanned-page pixel target -- same off-page check.
  [`documents.ts:1919`](../../container/agent-runner/src/mcp-tools/documents.ts#L1919)
- Test suite -- start with the multi-page widget resolution and off-page-edge blocks, the two review-round additions worth the closest look.
  [`documents.test.ts:2745`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L2745), [`documents.test.ts:2638`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L2638)
- Agent-facing usage guide.
  [`SKILL.md`](../../container/skills/document-memory/SKILL.md)
