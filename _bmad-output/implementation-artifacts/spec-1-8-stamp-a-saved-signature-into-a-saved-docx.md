---
title: 'Stamp a Saved Signature into a Saved .docx'
type: 'feature'
created: '2026-08-17'
status: 'in-progress'
review_loop_iteration: 0
context: []
baseline_commit: 'd4427e4'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 1.7 gave PDF documents signature stamping via `signatureName`; `.docx`/`.doc` documents currently decline that argument outright (they were explicitly out of scope for 1.7, by user-mandated sequencing). There's no way to sign a saved Word document.

**Approach:** Extend `signatureName` to `.docx` (and, for free, `.doc` via the existing unmodified `.doc`→`.docx` conversion delegation in `fillDoc`). Unlike a PDF (absolute-position drawing), a `.docx` is flow-layout text — there is no natural "position" to draw an image at outside the document's own paragraph/run structure. So the image is embedded as a new OOXML media part and inserted as an **additional run**, never a replacement for existing text, at the same target `fillDocx` already resolves (table cell or fill-in-the-blank line). This is materially harder than the PDF story: it requires writing three new zip parts in sync (`word/media/imageN.png`, a new relationship in `word/_rels/document.xml.rels`, and a content-type default in `[Content_Types].xml`) rather than only splicing `word/document.xml`.

## Boundaries & Constraints

**Always:**
- `signatureName` (already added to `fill_document_field`'s schema in Story 1.7) now also applies to `.docx` and `.doc` documents — remove it from the stale `PDF_ONLY_ARGS` gate (it is no longer PDF-exclusive; `fieldName`/`pixelX`/`pixelY` remain PDF-only).
- Resolution (`resolveSignaturePng`, from Story 1.7) is reused unmodified — same exact-filename-match lookup under `memory/signatures/`, same miss-listing error shape.
- Target resolution is **exactly** `fillDocx`'s existing dispatch, unmodified — table-row targeting wins when `row`/`table` is given; fill-in-the-blank-line targeting when `lineNumber` is given (or neither and no table exists); the existing `usesTablePath`/`lineNumberArg` mutual-exclusion error, `gridSpan` decline, nested-table decline, and "table has no matching row/cell" errors all still apply unchanged before an image branch is ever reached.
- Image placement, both targets: the drawing run is **inserted**, **never replaces** existing content.
  - Table-cell target: append the image run into the target cell's last paragraph (or a new paragraph if the cell has none) — same insertion point `insertRunIntoCell` already uses for a cell with no `<w:t>`, but now used unconditionally for an image (regardless of whether the cell already has text) rather than only when the cell is empty.
  - Fill-in-the-blank-line target: append the image run immediately after the target paragraph — same insertion point `insertRunAfterParagraph` already uses.
- New zip parts, written together in one call (all three or none — never a `.docx` with an orphaned media file, a dangling relationship, or a missing content-type default):
  - `word/media/image<n>.png` — the resolved signature PNG bytes, `<n>` chosen to not collide with any existing `word/media/imageN.png` already in the zip.
  - A new `<Relationship Id="rId<m>" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image<n>.png"/>` appended into `word/_rels/document.xml.rels` — `<m>` chosen to not collide with any existing `rId` in that file.
  - `[Content_Types].xml` gets a `<Default Extension="png" ContentType="image/png"/>` entry added **only if** no PNG default (or PNG-specific override) already exists — never a duplicate.
- Image sizing: fixed max-height (EMU units; 1pt = 12700 EMU — same ballpark constant as Story 1.7's `SIGNATURE_MAX_HEIGHT_PT`, converted), aspect ratio preserved from the source PNG's natural pixel dimensions (read via `pngjs`, already a dependency since Story 1.6) — width is derived, never independently set, never distorted.
- `value` alongside `signatureName` for the same call inserts an additional text run (existing `xmlEscapeText`/run-construction convention) immediately after the image run, same paragraph.
- `.doc` gets this "for free" through the existing, completely unmodified `fillDoc` → `fillDocx` delegation (Story 1.5) — no new `.doc`-specific code. The existing docx-output disclosure note (`withDocConversionNote`) still applies unchanged.
- Every successful stamp writes the existing `FILL_SUCCESS_MARKER` (`'New file at '`) convention in its `ok()` text.
- The produced `.docx` must remain a well-formed, openable Word document — any pre-existing media parts/relationships/content-types in the source are left untouched, only new entries are added.

**Ask First:**
- If the exact `<w:drawing>`/`<wp:inline>`/`<a:graphic>`/`<pic:pic>` XML shape needs adjustment beyond straightforward research to render correctly in real Word/LibreOffice (namespace declarations, required child elements) — research against the OOXML spec and known-good examples; only HALT if no working inline-image XML shape can be found at all.

**Never:**
- Never replaces/overwrites existing table-cell or paragraph text when stamping an image — always an additional, inserted run.
- Never reuses an existing `rId` or `word/media/imageN.png` filename already present in the source `.docx` — always picks the next free identifier for both.
- Never adds a duplicate PNG content-type default if one already exists.
- Never writes a new `.doc`-specific code path — `.doc` support is entirely inherited via the unmodified conversion delegation.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stamp a table cell | Saved `.docx` with a table, `row`/`table` + `signatureName` | Image run appended into the cell's last paragraph; existing cell text (if any) untouched | N/A |
| Stamp a fill-in-the-blank line | Saved `.docx`, no table match, `lineNumber` + `signatureName` | Image run inserted right after the target paragraph | N/A |
| Stamp + date together | Any `.docx` target + `signatureName` + `value` | Image run inserted, text run inserted right after it, same paragraph | N/A |
| Stamp a `.doc` | Saved `.doc`, `signatureName` + a target | Converts to `.docx` once (existing pipeline), stamps the converted file, discloses `.docx`-output as usual | N/A |
| Unknown signature name | `signatureName` doesn't match any file | Declines, lists actual saved signature names | MCP error text |
| `.docx` already has an image (media/imageN.png exists) | Source `.docx` has a pre-existing embedded image | New image gets a non-colliding filename/rId; the pre-existing image's own relationship/media/content-type entries are untouched | N/A |
| `.docx` has no `[Content_Types].xml` PNG default yet | First-ever image in this `.docx` | A PNG default entry is added once | N/A |
| Malformed target (gridSpan, nested table, wrong row/table) | Same pre-existing decline conditions `fillDocx` already has | Same existing decline behavior, unmodified by this story | MCP error text |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/documents.ts:2104-2105` (`DOCX_ONLY_ARGS`/`PDF_ONLY_ARGS`) -- remove `'signatureName'` from `PDF_ONLY_ARGS` (added there in Story 1.7, now stale — it applies to both extensions).
- `container/agent-runner/src/mcp-tools/documents.ts:1790` (`resolveSignaturePng`) -- reuse unmodified.
- `container/agent-runner/src/mcp-tools/documents.ts:1227-1239` (`insertRunIntoCell`) -- reference shape for the table-cell image insertion point; the new image-insertion helper mirrors its "append into last paragraph, or new paragraph if none" logic but is called unconditionally (not gated on "cell has no `<w:t>`").
- `container/agent-runner/src/mcp-tools/documents.ts:1428` (`insertRunAfterParagraph`) -- reference shape for the fill-in-the-blank-line image insertion point.
- `container/agent-runner/src/mcp-tools/documents.ts:1472-1580` (`fillDocx`) -- add `signatureName` handling: resolve it once near the top (same place `value`/`row`/`lineNumberArg` are parsed), thread it into both the table-row branch and the `fillDocxTextLine` call.
- `container/agent-runner/src/mcp-tools/documents.ts:1442-1470` (`fillDocxTextLine`) -- add a `signaturePng` parameter; when present, insert the image run (+ optional text run) after the target paragraph instead of/alongside the existing text-replace logic.
- New helpers (placed near the docx-write helpers, e.g. after `insertRunIntoCell`): `nextRelationshipId(relsXml)`, `nextMediaImageNumber(zip)`, `addImageRelationship(relsXml, id, target)`, `ensurePngContentType(contentTypesXml)`, `buildDrawingRunXml(relId, widthEmu, heightEmu, docPrId)`, `nextDocPrId(xml)`, `readPngDimensions(bytes)` (via `pngjs`, reusing the Story 1.6 import pattern).
- `fillDocx`'s existing `zip.file('word/document.xml', newXml); const outBytes = await zip.generateAsync(...)` write sequence (two call sites, table-row and text-line) -- when a signature is being stamped, also read+patch `word/_rels/document.xml.rels` and `[Content_Types].xml` via `zip.file(...)` before `generateAsync`, and write the new `word/media/imageN.png` part.
- `container/agent-runner/src/mcp-tools/documents.test.ts` -- new coverage per the I/O matrix; a real produced `.docx` should be inspectable (unzip the output, parse each modified part) to confirm well-formedness, not just "no error thrown."
- `container/skills/document-memory/SKILL.md` -- extend the signature-stamping section to cover `.docx`/`.doc`, removing the "not supported yet for Word" note from Story 1.7.

## Tasks & Acceptance

**Execution:**
- [ ] `container/agent-runner/src/mcp-tools/documents.ts` -- remove stale `PDF_ONLY_ARGS` entry; new zip-part helpers; image-insertion branches in `fillDocx`/`fillDocxTextLine`
- [ ] `container/agent-runner/src/mcp-tools/documents.test.ts` -- bun:test coverage for the I/O matrix above (real `.docx`/`.doc` fixtures + a real saved-signature PNG fixture, real zip round-trip inspection — not a mocked pipeline)
- [ ] `container/skills/document-memory/SKILL.md` -- document `.docx`/`.doc` signature stamping

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs, then all tests pass, including a real produced `.docx` that's unzipped and inspected (media part present, relationship present and correctly targeted, content-type default present, `word/document.xml` contains the new drawing run) — not just "the call returned ok()".
- Given a real container build, when a user asks to stamp a saved signature into a saved `.docx` via chat, then the returned file opens as a valid Word document with the signature visibly present and nothing else changed.

## Spec Change Log

(none yet — record here if implementation surfaces a genuine deviation from the frozen Boundaries above)

## Design Notes

The canonical minimal inline-image OOXML run shape (verified against the OOXML/ECMA-376 spec and widely-documented in practice):

```xml
<w:r>
  <w:drawing>
    <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="{widthEmu}" cy="{heightEmu}"/>
      <wp:effectExtent l="0" t="0" r="0" b="0"/>
      <wp:docPr id="{docPrId}" name="Picture {docPrId}"/>
      <wp:cNvGraphicFramePr>
        <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
      </wp:cNvGraphicFramePr>
      <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:nvPicPr>
              <pic:cNvPr id="{docPrId}" name="Picture {docPrId}"/>
              <pic:cNvPicPr/>
            </pic:nvPicPr>
            <pic:blipFill>
              <a:blip r:embed="{relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
              <a:stretch><a:fillRect/></a:stretch>
            </pic:blipFill>
            <pic:spPr>
              <a:xfrm><a:off x="0" y="0"/><a:ext cx="{widthEmu}" cy="{heightEmu}"/></a:xfrm>
              <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            </pic:spPr>
          </pic:pic>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing>
</w:r>
```

Declaring `xmlns:wp`/`xmlns:a`/`xmlns:pic`/`xmlns:r` inline on the elements that introduce each prefix (rather than assuming the document root already declares them) makes the run self-contained regardless of what the source `.docx`'s root `<w:document>` element happens to declare — safer than relying on every possible producer's root namespace set.

`docPrId` must not collide with any existing `<wp:docPr id="...">` in the document (Word/LibreOffice can misbehave with duplicate ids) — scan `word/document.xml` for the current max and use max+1, defaulting to 1 if none found.

`nextRelationshipId`/`nextMediaImageNumber`: both scan their respective source (`word/_rels/document.xml.rels`'s `Id="rId(\d+)"` occurrences; the zip's existing `word/media/image(\d+)\.` filenames) for the current max numeric suffix and return max+1 (defaulting sensibly, e.g. 1, if none exist yet).

EMU conversion: `1 point = 12700 EMU`. Pick a max-height constant in points matching Story 1.7's `SIGNATURE_MAX_HEIGHT_PT` ballpark (e.g. the same 45pt), convert once: `heightEmu = maxHeightPt * 12700`, `widthEmu = heightEmu * (pngWidthPx / pngHeightPx)`.

Test fixtures: extend this file's existing `.docx` zip-based fixture builders (used throughout Stories 1.1/1.2/1.4) with a helper that, after producing the fill output, unzips it (reusing the same `unzip`/`jszip`-based reading this file already does elsewhere) and asserts on the real XML content of `word/_rels/document.xml.rels`, `[Content_Types].xml`, and `word/media/`, not just that `zip.generateAsync` didn't throw. For a "pre-existing image" fixture, hand-build a minimal `.docx` whose `word/media/` already has an `image1.png` and whose rels file already has an `rId1` image relationship, confirming the new entries land as `image2.png`/the next free `rId` without touching the first.

## Verification

**Commands:**
- `cd container/agent-runner && bun test` -- expected: all pass
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors
- `./container/build.sh build` -- expected: succeeds (no new dependency this story — `jszip`/`pngjs` already present)

## Suggested Review Order

(filled in at story completion, once real line numbers exist)
