---
title: 'OCR Fallback for Scanned PDFs'
type: 'feature'
created: '2026-08-24'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'fb2991dcb4279c3da63224d2068456da61642b6e'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A scanned (image-only) PDF's page 1 is today read by having the agent itself visually transcribe a rendered PNG in its own multimodal turn (`save_document`'s two-call vision-fallback path). That transcription is non-deterministic, not reproducible after the render is deleted, and quality-variable — not real, structured OCR text.

**Approach:** For a PDF with no extractable text layer, run a real local OCR engine (`tesseract.js`) server-side on the already-rendered page-1 PNG inside `save_document`, and store its output as the concept file's body text directly — collapsing today's two-call agent-vision round trip into a single deterministic call for this case. Page-1-only, matching the existing scope boundary; standalone image uploads (`.jpg`/`.png`) and PDFs that already have a text layer are unaffected.

## Boundaries & Constraints

**Always:**
- OCR runs only on the page-1 PNG already produced by `renderFirstPageToPng()` — no new render path, no new page-selection logic.
- OCR'd text becomes `bodyText` in the concept file exactly where the agent-transcribed `extractedText` lands today (`documents.ts` write-out around line 652) — same file location, same frontmatter shape (`type`, `description`, `source-filename`, `saved-date`, `raw-file`); no new frontmatter field.
- The render PNG is still deleted after the concept file is written, same as today — OCR output is what persists, not the image.
- This explicitly and deliberately reverses `SPEC.md`'s "no-new-OCR-engine" decision (line 45) and spec-1-1's frozen Boundaries "Never call a dedicated OCR engine" line (line 37) for this one case — record this override in this spec's own Spec Change Log on first read by step-03/step-04, and update `SPEC.md`/`ARCHITECTURE-SPINE.md`'s Deferred section to reflect the new state once shipped (do not leave the old constraint text standing unqualified).
- `tesseract.js` is added to `container/agent-runner/package.json` dependencies and `bun.lock` regenerated — no Dockerfile change (pure JS/WASM, same pattern as `pdfjs-dist`/`@hyzyla/pdfium`).
- Existing MCP error shape (`err()`, `{ content: [...], isError: true }`) is used for any OCR failure — never a partial/silent write.

**Ask First:**
- If `tesseract.js`'s OCR confidence/output is empty or near-empty for a given render (genuinely blank or unreadable page): HALT and ask whether to fall back to the old agent-vision two-call path for that one document, or store `_(no text extracted)_` as today's placeholder already does for a failed extraction.

**Never:**
- Never OCR standalone image uploads (`.jpg`/`.jpeg`/`.png`) saved directly — out of scope for this story (title-scoped to PDFs only).
- Never OCR pages beyond page 1, or add multi-page scanned-PDF support — separately deferred, explicitly excluded here.
- Never touch the PDF-with-text-layer path (`hasTextLayer()` true) — `pdfjs-dist` extraction is unchanged.
- Never touch `fill_document_field`'s pixel→point positioning flow (unrelated write-path concern, not this story).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Scanned PDF, page 1 has readable text | PDF, `hasTextLayer()` false, page-1 render has legible content | Single `save_document` call succeeds; concept file body holds real OCR'd text; render PNG deleted | N/A |
| Scanned PDF, page 1 is genuinely blank/unreadable | PDF, `hasTextLayer()` false, OCR returns empty/near-empty | HALT per Ask First — do not silently store empty text | Ask user: fallback to agent-vision, or store placeholder |
| PDF with existing text layer | `hasTextLayer()` true | Unchanged: `pdfjs-dist` extraction, no OCR invoked | N/A |
| Standalone image upload (`.jpg`/`.png`) | Direct image save, not via PDF render | Unchanged: existing two-call agent-vision path | N/A |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/documents.ts:566` -- the `if (hasTextLayer(pdfText)) {...} else {...}` branch to modify; else-branch currently calls `renderFirstPageToPng()` (line 471) and returns a first-call message asking the agent to transcribe + call back.
- `container/agent-runner/src/mcp-tools/documents.ts:558-606` -- two-call pattern (`saveDocumentImpl`) for PDF-no-text-layer and image saves; PDF branch changes to a single deterministic call, image branch (`.jpg/.jpeg/.png`, no render step) stays two-call/unchanged.
- `container/agent-runner/src/mcp-tools/documents.ts:641-699` -- concept file write-out: frontmatter (641-648, unchanged), `bodyText` write (652, source becomes OCR output instead of agent `extractedText` for this case), render PNG cleanup (692-699, unchanged trigger point).
- `container/agent-runner/src/mcp-tools/documents.ts:85-87` -- `err()` MCP error helper, reuse for OCR failure.
- `container/agent-runner/package.json:9-20` -- add `tesseract.js` alongside existing `pdf-lib`/`pdfjs-dist`/`@hyzyla/pdfium` dependencies.
- `container/agent-runner/src/mcp-tools/documents.test.ts:390-464` -- existing scanned-PDF describe block to update; follow existing hand-rolled fixture (`buildMinimalPdf`) and `fs.mkdtempSync`-per-test conventions, no real-world fixture files.
- `_bmad-output/specs/spec-document-memory/SPEC.md:45` -- "no-new-OCR-engine" line to amend once shipped.
- `_bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-16/ARCHITECTURE-SPINE.md:177` -- Deferred-section OCR line to amend once shipped.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/package.json` -- add `tesseract.js` dependency, regenerate `bun.lock` -- pure-JS OCR engine, no Dockerfile change needed
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- collapse the PDF-no-text-layer branch to a single call: render page 1, run `tesseract.js` OCR on the PNG, use its output as `bodyText`, delete the render, write the concept file -- replaces non-deterministic agent transcription with real structured OCR text
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- on empty/near-empty OCR output, return the Ask-First prompt (fallback-or-placeholder) instead of writing silently -- prevents a silent blank save
- [x] `container/agent-runner/src/mcp-tools/documents.test.ts` -- update the scanned-PDF describe block for the new single-call flow; add a case for empty-OCR-output handling -- keeps existing coverage meaningful under the new flow
- [x] `_bmad-output/specs/spec-document-memory/SPEC.md`, `.../ARCHITECTURE-SPINE.md` -- amend the no-new-OCR-engine lines to record the override -- keeps planning docs truthful post-ship

**Acceptance Criteria:**
- Given a scanned PDF with no text layer and a legible page 1, when `save_document` runs, then it completes in a single call and the concept file body holds real OCR'd text recallable via `list_documents`/`Read`.
- Given a scanned PDF whose page-1 render OCRs to empty/near-empty, when `save_document` runs, then it halts and asks the user rather than silently storing blank text.
- Given a PDF with an existing text layer, when `save_document` runs, then behavior is byte-for-byte unchanged (no OCR invoked).
- Given a standalone `.jpg`/`.png` image save, when `save_document` runs, then the existing two-call agent-vision path is unchanged.

## Spec Change Log

- 2026-08-24 (implementation, override recorded per this spec's own frozen Boundaries instruction): this spec deliberately reverses two previously-frozen decisions — `SPEC.md`'s Constraints line 45 ("hybrid, no-new-OCR-engine approach ... No Tesseract-class OCR engine dependency") and spec-1-1's frozen Boundaries "Never call a dedicated OCR engine." Both are amended in place (not left standing unqualified) to record that `tesseract.js` now OCRs a scanned PDF's page-1 render server-side in `save_document`, scoped exactly as this spec's Boundaries describe (page 1 only, PDFs only, never images) — the old agent-vision transcription path is preserved only as the Ask-First fallback for the empty/near-empty-OCR edge case. `ARCHITECTURE-SPINE.md`'s Deferred-section OCR line (which anticipated this exact revisit condition — "revisit only if the vision-fallback approach demonstrably fails") is likewise updated to mark this as shipped rather than left as an open deferral.

- 2026-08-24 (implementation, live-verified, not spelled out by the frozen Boundaries text): two real integration gaps surfaced only by actually running `tesseract.js` under this codebase's Bun runtime, neither hypothetical: (1) `tesseract.js`'s Node worker computes its own `workerPath` from its own module's `__dirname`, but `import('tesseract.js')` under Bun resolves through Bun's global package cache rather than this project's on-disk `node_modules` — the resulting path has no project `node_modules` among its ancestors, so the spawned worker thread's own `require('regenerator-runtime/runtime')` fails with "Cannot find module", reproduced live. Fixed by passing `workerPath` explicitly, anchored at `documents.ts`'s own real file location (`ocrPngText` in `documents.ts`). (2) Without an explicit `cachePath`, tesseract.js writes `<lang>.traineddata` into `process.cwd()` — pointed instead at a dedicated `.ocr-cache/` directory under `baseDir` (mirroring the existing `.document-renders/` convention) so it doesn't land loose in the agent's workspace and a second OCR call in the same group reuses the already-downloaded language data. Neither gap is visible from tesseract.js's own docs or from a "does the import work" smoke check alone — both were found by actually spawning a worker and recognizing an image under `bun run` before writing the automated test suite (which mocks `tesseract.js` for speed/determinism/no-network, per `documents.test.ts`'s own comment on that choice — the real wiring was verified separately, standalone, outside the mocked suite).

- 2026-08-24 (implementation, disclosed as a real, not-fully-resolved risk rather than silently accepted): `eng.traineddata` (a few MB) is fetched from a public CDN (`cdn.jsdelivr.net`) on the first OCR call for a given `.ocr-cache/` directory — a genuinely new runtime dependency on outbound network access that none of this tool's other extraction paths (`pdfjs-dist`, `@hyzyla/pdfium`, `word-extractor`, `unzip`) have, since those ship their own binary/WASM assets inside the npm package itself. This does not violate the spec's "no Dockerfile change" constraint (that constraint is about the code dependency, which is genuinely zero-Dockerfile-change) or the file's own "no external API/credential" framing (no auth token involved, a plain anonymous CDN GET) — but it is a materially different risk profile from the `pdfium`-precedent this spec's Design Notes cites, worth knowing about rather than assuming OCR is exactly as self-contained as page rendering already is. Not fixed (no offline-bundled traineddata option was added) — flagged for the operator to weigh, not resolved unilaterally.

- 2026-08-24 (step-04 review — blind-hunter/edge-case-hunter/verification-gap layers plus two operator scope decisions — all findings classified `patch`, applied directly, no new spec/intent work): **Operator decision, item 1**: OCR now covers English *and* Hebrew (`createWorker('eng+heb', ...)`, `heb.traineddata` confirmed live to flow through the same CDN/cache mechanism as `eng.traineddata`) rather than English-only — `ocrPngText`'s doc comment, `SPEC.md`'s CAP-1 intent and amended Constraints, `row-targeting-matrix.md`, and `SKILL.md`/the `save_document` tool description are all updated to say so. **Real gap closed, item 2**: the frozen Boundaries' own "empty or near-empty" language wasn't actually implemented — only exact-empty (`ocrText.length === 0`) routed to the Ask-First halt, so a garbage single-character OCR result from a blank/noisy page would have silently saved as if it were real content. Added `isNearEmptyOcrText` (trimmed-non-whitespace-length floor of 3; tesseract's per-call `confidence` was considered but judged unnecessary plumbing given the floor alone resolves the gap) and routed near-empty through the identical halt as full-empty, with a `mockOcrResult = { text: '.' }` regression test. **Real gap closed, item 3**: a genuine OCR *engine failure* (as opposed to a successful-but-empty OCR) left the render PNG orphaned in `.document-renders` forever — there's no follow-up flow for that case (unlike the Ask-First halt, which deliberately keeps the render), so it's now deleted (best-effort) before the `err()` return. **Hardening, items 4-6**: the combined `createWorker` + `worker.recognize()` call is now bounded by a single 60s `withTimeout` (covers a stuck first-time traineddata fetch, which happens inside `createWorker()` itself, not deferred to `recognize()`); `worker.terminate()` in the `finally` block is wrapped in its own try/catch (logged, not propagated) so a terminate failure can never mask the real result/error; `createWorker` module-shape resolution now throws a clear "tesseract.js module shape unexpected" error instead of an opaque TypeError if both the named and default export are missing. **Test hardening, item 7**: the `tesseract.js` mock now captures the actual `createWorker` call args (`lastCreateWorkerCall`) instead of ignoring them, with a new test asserting `langs === 'eng+heb'`, `workerPath` resolves to a real on-disk file (`fs.existsSync`), and `cachePath` equals the expected `.ocr-cache` directory under `baseDir` — closing the gap where a broken Bun-specific wiring computation could have shipped with a fully green (but non-verifying) suite. **Doc parity, items 8-10**: `row-targeting-matrix.md`'s "no new OCR-engine dependency" framing (which `SPEC.md`'s amended CAP-1 directly references) is brought in line with the shipped CAP-1/CAP-3 split — extraction now OCR-assisted, positioning still not; a `.ocr-cache/` retention note (reusable, never deleted per-call, unlike `.document-renders`) was added next to `ocrPngText`'s existing render-cleanup documentation so the asymmetry reads as deliberate; `ARCHITECTURE-SPINE.md`'s "Shipped by spec-2-1" Deferred-section note is revised to state the actual final scope (eng+heb, a real near-empty threshold, still page-1-only) rather than reading as an unconditional closure of the original deferred item. **Reviewed and explicitly rejected as false positives, not acted on**: a flag that `bun.lock` wasn't updated alongside `package.json` (verified false — it was, the reviewed diff just excluded it from what reviewer subagents were shown); a flag that the hardcoded `workerPath` (`node_modules/tesseract.js/src/worker-script/node/index.js`) is a risky src-vs-dist assumption (verified false — tesseract.js's own `package.json` declares `"main": "src/index.js"`, so `src/` is the package's genuine shipped Node runtime layout). **Routed to `deferred-work.md` by operator decision, not sent as a patch to this round**: no integrity pin on the CDN traineddata fetch; a rare concurrent-first-download cache race. Re-verified after this round: `cd container/agent-runner && bun test` (full suite) and `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, both clean.

## Design Notes

This intentionally narrows scope to PDF page-1 OCR only, collapsing the two-call flow to one call for that specific case — it does not touch the two-call flow for standalone image uploads, since those aren't renders of a known single page and the story is titled/scoped to PDFs. `tesseract.js` was chosen over an apt-installed `tesseract-ocr` + wrapper because it needs zero Dockerfile change (matches this codebase's `pdfjs-dist`/`@hyzyla/pdfium` precedent) versus a pinned apt package plus an npm wrapper (the heavier `libreoffice-writer`-class cost).

## Verification

**Commands:**
- `cd container/agent-runner && bun test src/mcp-tools/documents.test.ts` -- expected: all scanned-PDF cases pass, including the new empty-OCR-output case
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

**Manual checks (if no CLI):**
- Save a real scanned PDF through a live container session; confirm the concept file body holds legible OCR text and the render PNG under `.document-renders/` is gone afterward.

## Suggested Review Order

**OCR core — the single-call replacement for agent-vision transcription**

- Entry point: the branch that used to always ask the agent to transcribe now OCRs inline and only asks on a real Ask-First case.
  [`documents.ts:680`](../../container/agent-runner/src/mcp-tools/documents.ts#L680)

- The OCR call itself: `eng+heb` worker, Bun-specific `workerPath`/`cachePath` wiring, single 60s timeout wrapping worker init + recognition.
  [`documents.ts:576`](../../container/agent-runner/src/mcp-tools/documents.ts#L576)

- Near-empty threshold: closes the gap where a garbage single-character OCR result would have silently saved as real content.
  [`documents.ts:614`](../../container/agent-runner/src/mcp-tools/documents.ts#L614)

- Ask-First halt message: triggers on near-empty (not just exact-empty), keeps the render on disk for the vision-fallback follow-up.
  [`documents.ts:712`](../../container/agent-runner/src/mcp-tools/documents.ts#L712)

- Follow-up-call branch: same path, now reached only after a real Ask-First halt rather than on every scanned PDF.
  [`documents.ts:731`](../../container/agent-runner/src/mcp-tools/documents.ts#L731)

**Failure hardening — patch-round additions**

- Genuine OCR engine failure now cleans up its orphaned render instead of leaving it stranded in `.document-renders`.
  [`documents.ts:709`](../../container/agent-runner/src/mcp-tools/documents.ts#L709)

- `withTimeout` reused (not reinvented) from this file's existing `.doc`-extraction timeout pattern.
  [`documents.ts:346`](../../container/agent-runner/src/mcp-tools/documents.ts#L346)

**Test verification of the Bun-specific wiring itself, not just its outcomes**

- Mock now captures real `createWorker` call args and asserts `workerPath` resolves on disk and `cachePath` is correct — closes the "green suite, broken wiring" blind spot a reviewer flagged.
  [`documents.test.ts:48`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L48)

- Regression test for the near-empty gap: a single stray character now takes the halt path, not the save path.
  [`documents.test.ts:467`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L467)

- Regression test for the render-cleanup-on-failure fix.
  [`documents.test.ts:583`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L583)

**Planning-doc parity — recording the deliberate override rather than leaving stale text**

- `SPEC.md`'s CAP-1 intent and amended Constraints now state eng+heb and the real near-empty fallback condition.
  [`SPEC.md:18`](../specs/spec-document-memory/SPEC.md#L18)

- `row-targeting-matrix.md`'s CAP-1/CAP-3 split: extraction is now OCR-assisted, positioning explicitly is not and was never touched.
  [`row-targeting-matrix.md:21`](../specs/spec-document-memory/row-targeting-matrix.md#L21)

- `ARCHITECTURE-SPINE.md`'s Deferred entry marked shipped, with the actual residual scope spelled out rather than an unconditional closure.
  [`ARCHITECTURE-SPINE.md:177`](../planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-16/ARCHITECTURE-SPINE.md#L177)

**Peripheral — agent-facing persona guidance**

- `SKILL.md`'s three-outcome rewrite so the agent doesn't assume every scanned PDF still needs its own reading.
  [`SKILL.md:27`](../../container/skills/document-memory/SKILL.md#L27)
