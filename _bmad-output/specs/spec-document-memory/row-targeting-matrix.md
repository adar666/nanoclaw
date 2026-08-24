# Row/Field Targeting Matrix

CAP-3 ("fill row X with value Y") must resolve to one of four mechanisms depending on the source file, auto-detected — the user never picks a mode explicitly.

| File type | Structure found | Target mechanism | Write technique |
|---|---|---|---|
| `.docx` (Word) | Document has one or more tables | Table row, addressed as **table number + row number** | Locate the target table by number, then the target row/cell within it, set its text content directly. Rest of the document byte-identical. |
| `.docx` (Word) | No table matches the request — a plain paragraph carrying a fill-in-the-blank marker (a run of underscores, or a trailing colon/blank) | Text-line fill, addressed by **line number** (paragraph order in the document) | Replace the underscore run (or insert right after the label text if there's no underscore run) with the value. Only that one paragraph's blank changes — never a reflow of surrounding text, never a new paragraph. Discovered live in production use (real-world forms are far more often built this way than as tables). |
| `.pdf` with AcroForm fields | PDF has fillable form fields | Named/positioned form field | Set the field's value via the PDF's form-field API. No page content is redrawn. |
| `.pdf` without form fields (plain or scanned) | No structured fields; "row" means a line/position on the rendered page | Overlay by position | Never parse-and-reflow existing PDF text. Locate the target position (see Positioning below), draw the new value as new text on top of the page, save as a new PDF. Original page content is untouched underneath. |

## Selection rule

1. If the file is `.docx` and the request refers to a row/line that maps to a table → table-row path, addressed as (table number, row number).
2. If the file is `.docx` and no table matches, but a paragraph carries a fill-in-the-blank marker matching the target → text-line path, addressed by line number.
3. If the file is `.pdf` and it has AcroForm fields matching the target → form-field path.
4. Otherwise (`.pdf` with no matching form field, or a free-text line in either file type) → overlay path.

## Content extraction & positioning — hybrid approach (researched, best practice)

Applies to both CAP-1 (extracting content into memory) and CAP-3 (locating where to overlay a value on a PDF). **Amended by spec-2-1 (2026-08-24):** CAP-1's scanned-PDF *extraction* now runs `tesseract.js` (English and Hebrew) server-side on the page-1 render, in the same `save_document` call, instead of relying solely on the agent's own multimodal reading — see spec-2-1's Boundaries and Spec Change Log for the exact scope (page 1 only, PDFs only) and the empty/near-empty-OCR fallback that still uses agent vision-reading. CAP-3's *positioning* (below) is unrelated and unchanged — no OCR engine is used for locating an overlay target; that remains the agent's own visual estimate.

| Source has a text layer? | Extraction (CAP-1) | Positioning (CAP-3, for overlay) |
|---|---|---|
| Yes (Word always; PDF when present) | Direct structured text extraction | Use a PDF text-extraction API that returns per-text-item coordinates/bounding boxes (PDF points, y-axis bottom-up) to locate the target line precisely. |
| No (scanned/image-only PDF) | Render page 1 to an image; `tesseract.js` OCRs it server-side (English + Hebrew). If OCR comes back empty/near-empty, falls back to the agent itself (already multimodal) reading the content directly from the image. | The agent visually estimates the target region from the same rendered image; the estimate is converted into PDF point-coordinate space using the known page dimensions and the image's render scale factor. Unchanged by spec-2-1 — never OCR-assisted. |

Rationale (extraction, as amended): a page-1 OCR pass gives a single deterministic call and real, reproducible text instead of a transcription that varies by model turn and disappears once the render is deleted — see spec-2-1's Design Notes for the full tradeoff against the original "no new OCR engine" decision. Rationale (positioning, unchanged): 2026 industry practice for scanned-document *positioning* still favors a vision-capable LLM's own contextual estimate over trying to derive coordinates from OCR output — the agent understands document context, not just pixel-level character shapes, and this container already has a multimodal agent and existing page/image-rendering usage (`agent-browser`) to build on, so no OCR-derived-coordinate mechanism was added for this.

## Disambiguation (applies to CAP-2 and CAP-3)

When the target document is not named, or the name given matches more than one saved document, the agent presents a numbered list of candidates (drawn from memory) and waits for the user to reply with a number — it never guesses (e.g. "most recent").
