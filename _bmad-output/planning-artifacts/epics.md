---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments:
  - _bmad-output/specs/spec-document-memory/SPEC.md
  - _bmad-output/specs/spec-document-memory/row-targeting-matrix.md
  - _bmad-output/specs/spec-document-memory/brownfield.md
  - _bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-16/ARCHITECTURE-SPINE.md
---

# nanoclaw-v2 - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for **Document Memory + Fill-In Editing**, decomposing SPEC-document-memory's capabilities and the driving architecture spine's invariants into implementable stories. No PRD or UX design contract exists for this feature — SPEC.md's five-field kernel serves as the requirements source (per this project's fast-path convention), and there is no UI surface (chat-only feature).

## Requirements Inventory

### Functional Requirements

FR1: When a user sends a Word or PDF attachment and asks to save/remember it, the agent stores the file and its extracted text content in the agent group's memory, with a summary entry in `memory/index.md`. For a PDF with no text layer, extraction falls back to the agent reading the rendered page image directly.
FR2: A user can ask about a previously saved document's content at any later point, and the agent answers from the stored memory/index entry and extracted text rather than requiring the file again. If the reference is ambiguous, the agent presents a numbered list of candidates and the user picks by number.
FR3: A user can name a target inside a specific saved document — a Word table row (table number + row number), a Word fill-in-the-blank text line (line number, when no table matches — added post-launch after live use showed most real forms aren't tables), a PDF form field, or a PDF text line/position — plus a value, and the agent produces an updated copy of the document with that value applied, delivered back in chat. If the target document is ambiguous, the same numbered disambiguation as FR2 applies first.
FR4: A user can save and fill a legacy `.doc` (binary Word 97-2003) file the same as a `.docx` — save/recall extracts its text directly; a fill request converts it to `.docx` first (LibreOffice headless, one-time) then reuses FR3's `.docx` targeting, always returning `.docx` (never a reconstructed `.doc`), disclosed to the user.
FR5: A user can send an image of their handwritten signature and have the agent strip its near-white background to transparent, crop it tightly to its own bounding box, and store it as a named, reusable signature asset under the requesting agent group's memory — so it can be referenced by name in a later fill request instead of resending the image.
FR6: A user can ask the agent to stamp a saved signature (optionally together with a text value like a date) into a specific saved document, at the same target a text-only fill would use — for a PDF: an AcroForm field, a text-layer line, or a pixel position on a scanned page. (`.docx` stamping is a separate, later story — see spine AD-14/Constraints for the sequencing decision.)

### NonFunctional Requirements

NFR1: PDF value-filling uses the overlay/stamp technique when no AcroForm field matches — never parses and reflows PDF text in place.
NFR2: Row/field targeting auto-detects among three mechanisms (Word table row, PDF AcroForm field, PDF overlay-by-position) — the user never picks a mode.
NFR3: Content extraction and overlay positioning use a hybrid approach — a text layer (Word always; PDF when present) is read directly; no text layer falls back to the agent's own multimodal reading of a rendered page image. No new OCR-engine dependency.
NFR4: Saved documents and their extracted content live under the requesting agent group's `memory/` tree — never the separate, tenant-scoped second-brain media-ingestion pipeline (`src/media-ingestion.ts`).
NFR5: Editing returns the updated file through the existing `send_file` MCP tool / outbox delivery path — no new outbound delivery mechanism.
NFR6: Shipping requires new dependencies in the agent-runner base image (no docx/pdf library exists today) and a container image rebuild + service restart.
NFR7: When the target saved document is ambiguous, the agent presents a numbered list and waits for a pick — it never guesses (e.g. "most recent").

### Additional Requirements

- **AD-1** New MCP tools (`save_document`, `list_documents`, `fill_document_field`) live in a new `container/agent-runner/src/mcp-tools/documents.ts`, registered via the existing `McpToolDefinition` + `registerTools()` convention, wired with one barrel import in `mcp-tools/index.ts`.
- **AD-2** Document parsing/writing runs synchronously in-container (Bun) inside the tool handler — not via the host fire-and-forget pattern `transcribe-audio.ts` uses.
- **AD-3** `pdf-lib` (1.17.1), `pdfjs-dist` (~6.2.108), `@hyzyla/pdfium` (2.1.13), `jszip` (3.10.1) are added to `container/agent-runner/package.json` — baked into the shared base image via the Dockerfile's existing `bun install` layer, not the per-group `install_packages` self-mod flow.
- **AD-4** PDF write: AcroForm field present → `pdf-lib` sets it (no page redraw); otherwise → overlay-write, never reflow. Vision-fallback content reading and position estimation happen in the agent's own multimodal turn, never inside the tool; the tool owns pixel→point coordinate conversion, passing the agent the image's exact rendered pixel dimensions in the same turn.
- **AD-5** Word cell edits: `jszip` unzips the `.docx`, merges fragmented `<w:r>` runs before matching the target cell, replaces its text in `word/document.xml`, rezips. Targeting is 1-indexed `(table number, row number)` in document order; a header row counts as row 1.
- **AD-6** Storage shape: raw file → `groups/<folder>/memory/documents/files/<slug>.<ext>`; one OKF concept file `groups/<folder>/memory/documents/<slug>.md` (`type: saved-document`, `description`, `source-filename`, `saved-date`); one line appended to `memory/index.md`; `memory/documents/index.md` created per the existing per-subfolder convention.
- **AD-7** `list_documents` returns structured candidate data (slug, filename, description) only — rendering the numbered pick-list and reading back the user's choice is the agent's own chat turn.
- **AD-8** `fill_document_field` returns this codebase's existing MCP error shape (`{ content: [{ type: 'text', text: 'Error: …' }], isError: true }`, per `core.ts`'s `err()`) when a target can't be resolved — never an approximate write.
- **AD-9** `src/attachment-naming.ts`'s `MIME_TO_EXT` map gains `.docx`/`.doc` entries — a landed prerequisite so a Word file never arrives extension-less.
- **AD-10** One shared slug-generation function (filename → lowercase kebab-case, strip extension, `-2`/`-3`… on collision) used by every tool in `documents.ts` — no per-tool reinvention.
- **AD-11** Every write to a shared per-group memory index file (`memory/index.md`, `memory/documents/index.md`) goes through locked read-modify-write — concurrent sessions of the same group can save at the same time.
- **AD-12** Docx fill-in-the-blank text lines (a paragraph with an underscore run or trailing colon/blank, no matching table) get their own targeting mode, distinct from AD-5's table-cell editing — same two-call discovery pattern as AD-4's PDF text-layer branch. Added post-launch: live production use showed real-world forms are built this way far more often than as Word tables.
- **AD-13** `.doc` support: `word-extractor` (pure-JS, base-image dependency) extracts text for the read path (save/recall) — no LibreOffice needed there. `libreoffice-writer` (apt system dependency, headless) converts `.doc`→`.docx` once for the fill path, after which the existing docx fill pipeline (AD-5/AD-12) runs unchanged. Output is always `.docx`, never a reconstructed `.doc`. User-approved despite the container image size cost; `soffice`-dependent tests must detect its absence and skip gracefully since the host `bun test` sandbox has no LibreOffice installed.
- **AD-14** New `save_signature` MCP tool: decodes an input PNG (`pngjs`, pure JS), thresholds near-white pixels to `alpha: 0` (fixed luminance cutoff, not configurable), computes the bounding box of remaining non-transparent pixels, crops to it, and writes to `groups/<folder>/memory/signatures/<name>.png` — reuses `documents.ts`'s existing hand-rolled `encodePng` (Story 1.1's scanned-PDF render path) for the write side. Same per-agent-group storage scoping as `memory/documents/` — no cross-group read; a signature usable from more than one group is saved once per group, response text makes this explicit.
- **AD-15** `fill_document_field` gains an optional `signatureName` argument, PDF-only in this story: resolves `memory/signatures/<name>.png` by exact filename match (directory-listed on a miss, for a usable error), embeds it via `pdf-lib`'s `pdfDoc.embedPng` + `page.drawImage`, and places it at whichever PDF target the call already resolves to (AcroForm field → the field's widget rectangle; text-layer line → same x/y as a text draw would use; scanned-page pixel position → same pixelX/pixelY conversion as a text draw). A fixed max-height (not a new argument) with aspect ratio preserved from the source PNG's natural pixel dimensions. `value` may be given alongside `signatureName` to draw a text value (e.g. a date) immediately beside the image, reusing the existing per-target text-draw logic offset by the image's drawn width. `signatureName` against a `.docx`/`.doc` document declines clearly — that stamping mode is a separate, later story (spine Constraints).
- **AD-16** `signatureName` extended to `.docx` (and, for free via the existing `.doc`→`.docx` conversion delegation, `.doc`): a new OOXML media part (`word/media/image<n>.png`) plus a `word/_rels/document.xml.rels` relationship entry plus a `[Content_Types].xml` PNG default (added only if not already present) are written into the zip alongside the existing `word/document.xml` edit. The image is embedded as an inline `<w:drawing>` run, sized via a fixed max-height (EMU, same ballpark as AD-15's PDF constant) with aspect preserved (dimensions read via `pngjs`, already a dependency from AD-14). The run is **always inserted, never a replacement** for existing content — appended into the target table cell's last paragraph (or table-row target) or right after the target paragraph (fill-in-the-blank-line target) — matching the existing insertion helpers' shape (`insertRunIntoCell`/`insertRunAfterParagraph`) rather than the text-fill paths' in-place-splice behavior, since a signature has no natural "text to replace." `value` alongside `signatureName` inserts an additional text run immediately after the image run in the same paragraph. Requires moving `signatureName` out of the (now-stale) `PDF_ONLY_ARGS` gate from AD-15, since it is no longer PDF-exclusive.
- New `container/skills/document-memory/SKILL.md` (agent-facing prose, same shape as `audio-report/SKILL.md`) teaches the agent when/how to call the three tools and how to run the numbered-pick-list disambiguation.
- Deferred (spine-acknowledged, not built now): whether an edit refreshes the stored raw copy and/or stored extracted text (default: neither — a re-save is a separate, unspecified action); OCR fallback if agent-vision reading proves insufficient in practice; multi-file/batch fill operations; version history/undo for edited documents.

### UX Design Requirements

N/A — no UX design contract exists and none is needed. This feature has no UI surface; all interaction is conversational (chat attachments in, chat replies + returned files out) through channels already wired.

### FR Coverage Map

| Requirement | Capability | Governing AD(s) |
| --- | --- | --- |
| FR1 | CAP-1 | AD-1, AD-2, AD-3, AD-4, AD-6, AD-9, AD-10, AD-11 |
| FR2 | CAP-2 | AD-6, AD-7, AD-10 |
| FR3 | CAP-3 | AD-1, AD-2, AD-3, AD-4, AD-5, AD-7, AD-8, AD-10, AD-12 |
| FR4 | CAP-4 | AD-1, AD-3, AD-13 |
| FR5 | CAP-5 | AD-1, AD-14 |
| FR6 | CAP-6 | AD-1, AD-15, AD-16 |
| NFR1, NFR2, NFR3 | CAP-1, CAP-3 | AD-4, AD-5 |
| NFR4 | CAP-1, CAP-2 | AD-6 |
| NFR5 | CAP-3 | (existing `send_file`, unchanged) |
| NFR6 | CAP-1, CAP-3 | AD-3 |
| NFR7 | CAP-2, CAP-3 | AD-7 |

## Epic List

### Epic 1: Document Memory + Fill-In Editing
Users can send a Word or PDF file, have the agent remember it (file + extracted content, recallable later), and ask the agent to fill a named row/field/line with a value and get back an updated document — all through one new MCP-tool surface sharing one library stack and one storage shape.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6

### Epic 2: Document Memory Hardening & Extensions — backlog
Story stubs only (OCR fallback, batch fill, version history/undo, auto-refresh on edit) — no FRs assigned yet, not spec'd. See the epic's own section below.

### FR Coverage Map

FR1: Epic 1 - Save a Word/PDF attachment to agent memory (file + extracted content + index summary)
FR2: Epic 1 - Recall a previously saved document's content, with numbered disambiguation
FR3: Epic 1 - Fill a named target in a saved document and return the updated file
FR4: Epic 1 - Save and fill a legacy `.doc` file via conversion
FR5: Epic 1 - Save a handwritten signature as a reusable, background-stripped, cropped image asset
FR6: Epic 1 - Stamp a saved signature (+ optional text) into a saved PDF, at whatever target a text fill would use

## Epic 1: Document Memory + Fill-In Editing

Users can send a Word or PDF file, have the agent remember it (file + extracted content, recallable later), and ask the agent to fill a named row/field/line with a value and get back an updated document. Story order (party-reviewed): Save → Fill → Recall — de-risking CAP-3 (the most novel, highest-invariant-count capability per the architecture spine) right after the minimum plumbing exists, rather than last.

### Story 1.1: Save a Word/PDF Document to Memory

As a NanoClaw user,
I want to tell my agent to remember a Word or PDF file I've sent,
So that its content persists in memory and I don't have to resend it later.

**Acceptance Criteria:**

**Given** a user sends a Word or PDF attachment and asks the agent to save/remember it
**When** `save_document` runs
**Then** the raw file is copied to `memory/documents/files/<slug>.<ext>`, a concept file `memory/documents/<slug>.md` is created (`type: saved-document`, `description`, `source-filename`, `saved-date`, extracted text/summary)
**And** one line is appended to `memory/index.md` (FR1, AD-6)

**Given** the source PDF has a text layer
**When** extraction runs
**Then** text and per-item positions are read directly via `pdfjs-dist` (NFR3, AD-4)

**Given** the source PDF has no text layer (scanned/image-only)
**When** extraction runs
**Then** the page is rendered to an image via `pdfium` and the agent's own multimodal turn reads the content — no OCR-engine call anywhere in the tool (NFR3, AD-4)

**Given** the attached Word file arrived with no explicit filename from the channel bridge
**When** `save_document` resolves its extension
**Then** `MIME_TO_EXT` correctly maps it to `.docx`, never landing extension-less (AD-9)

**Given** two `save_document` calls run concurrently for the same agent group
**When** both write to `memory/index.md`
**Then** both entries land intact — no lost update (AD-11)

**Given** a slug collision (two documents normalize to the same filename-derived slug)
**When** `save_document` runs
**Then** the second gets a `-2` suffix, deterministically (AD-10)

**Given** the attached file is not a `.docx` or `.pdf`
**When** the user asks the agent to save/remember it
**Then** the agent declines clearly and does not create a broken or partial memory entry (spec non-goal: only Word/PDF in scope)

### Story 1.2: Fill a Named Target in a Saved Document and Return It

As a NanoClaw user,
I want to tell my agent to fill a specific row, field, or line in a document I've saved with a value,
So that I get back an updated document without editing it myself.

**Acceptance Criteria:**

**Given** a saved `.docx` with one or more tables
**When** the user names `(table number, row number)` and a value
**Then** `fill_document_field` merges fragmented `<w:r>` runs, sets that cell's text via direct OOXML edit, and returns a new `.docx` with everything else byte-identical (FR3, NFR2, AD-5)

**Given** a saved `.docx` with exactly one table and the user names only a row number
**When** `fill_document_field` runs
**Then** the agent infers table 1; if the document has more than one table and no table number was given, the agent asks which table instead of guessing

**Given** a saved PDF with a matching AcroForm field
**When** the user names that field and a value
**Then** `pdf-lib` sets the field's value directly — no page content is redrawn (AD-4)

**Given** a saved PDF with a text layer but no matching form field
**When** the user names a line and a value
**Then** `pdfjs-dist` locates it by coordinate and `pdf-lib` overlays the value — original page content untouched underneath, never reflowed (NFR1, AD-4)

**Given** a saved PDF with no text layer (scanned)
**When** the user names a line and a value
**Then** the tool renders the page and passes its exact pixel dimensions to the agent in the same turn, the agent visually estimates the position, and the tool — not the agent — converts that estimate to PDF point space before drawing (AD-4)

**Given** the named target cannot be resolved (wrong table/row/field)
**When** `fill_document_field` runs
**Then** it returns this codebase's existing MCP error shape (`{ content: [...], isError: true }`) — never an approximate write (AD-8)

**Given** the target document reference is ambiguous or unnamed
**When** the user asks to fill a value
**Then** the agent presents a numbered list of candidates (from `list_documents`) and waits for the user's pick before proceeding (NFR7, AD-7)

**Given** the edit completes
**When** the agent replies
**Then** the updated file is delivered via the existing `send_file` tool, and the stored canonical copy plus stored extracted text remain at their as-saved content (NFR5, spine Deferred default)

### Story 1.3: Recall a Saved Document's Content

As a NanoClaw user,
I want to ask my agent about a document I saved earlier,
So that I get an accurate answer without resending the file.

**Acceptance Criteria:**

**Given** a document was saved in a prior session
**When** the user asks a content question referencing it by name or topic
**Then** the agent answers from the stored `memory/index.md` entry and extracted text — no file resend required (FR2)

**Given** the user's reference matches more than one saved document
**When** `list_documents` runs
**Then** the agent presents a numbered pick-list and waits for the user's number before answering (NFR7, AD-7)

**Given** the user's reference matches no saved document
**When** `list_documents` runs
**Then** the agent says so plainly rather than guessing at content

### Story 1.4: Fill a Docx Fill-In-The-Blank Text Line (No Table)

As a NanoClaw user,
I want to fill a blank on a plain Word form (a line with underscores or a label, not a table),
So that forms built the way real forms actually are can be filled without me doing it by hand.

**Acceptance Criteria:**

**Given** a saved `.docx` with no table matching the request, but a paragraph carrying an underscore run (3+ characters) or a trailing colon/blank
**When** the user asks to fill a value with no `lineNumber` given
**Then** `fill_document_field` returns a numbered list of detected fill-in-the-blank lines (AD-12)

**Given** the same document and a `lineNumber` + `value` from a follow-up call
**When** `fill_document_field` runs
**Then** the matched underscore run is replaced with the value (or the value is inserted right after the label if there's no underscore run), that one paragraph changes, every other paragraph is byte-identical, and a new `.docx` is returned (AD-12)

**Given** a `.docx` where a table already matches the request
**When** `fill_document_field` runs
**Then** the existing table-row path (AD-5) takes priority — text-line fill only applies when no table matches (row-targeting-matrix.md's selection rule)

**Given** no paragraph in the document matches (no table, no fill-in-the-blank marker found either)
**When** `fill_document_field` runs
**Then** it declines clearly (AD-8) — never guesses at inserting the value somewhere

### Story 1.5: Support Legacy .doc Files (Save, Recall, and Fill via Conversion)

As a NanoClaw user,
I want to save and fill a `.doc` file the same way I already can with `.docx`,
So that I don't have to convert old-format Word files myself before the agent can help with them.

**Acceptance Criteria:**

**Given** a `.doc` attachment and a request to save/remember it
**When** `save_document` runs
**Then** the raw `.doc` is stored under `memory/documents/files/<slug>.doc`, its text is extracted via `word-extractor` (no LibreOffice needed), and a concept file + index entry are written exactly like a `.docx` save (FR4, AD-13)

**Given** a saved `.doc` document
**When** the user asks a recall question about it
**Then** the agent answers from its stored extracted text — no different from a `.docx` recall (FR2/FR4)

**Given** a saved `.doc` document and a fill request (table row, or a fill-in-the-blank line)
**When** `fill_document_field` runs
**Then** the tool converts it to `.docx` via headless LibreOffice once, then runs the existing table-row (AD-5) or text-line (AD-12) fill logic against the converted file unchanged, and returns the result as a `.docx` — the response explicitly states the output is `.docx`, not the original `.doc` (FR4, AD-13)

**Given** the LibreOffice conversion itself fails (corrupted `.doc`, unexpected content)
**When** `fill_document_field` runs
**Then** it declines clearly (AD-8) rather than producing a broken or partial file

**Given** a test exercises the actual `soffice` conversion subprocess
**When** `bun test` runs on a machine without LibreOffice installed (the standard host dev sandbox)
**Then** that specific test detects `soffice`'s absence and skips rather than failing the suite

### Story 1.6: Save a Reusable Signature Asset

As a NanoClaw user,
I want to send a photo/scan of my handwritten signature and have the agent turn it into a clean, reusable asset,
So that I can reference it by name later to stamp documents without resending the image.

**Acceptance Criteria:**

**Given** a user sends a PNG image of a handwritten signature and asks the agent to save it as their signature
**When** `save_signature` runs
**Then** near-white pixels (fixed luminance threshold) become fully transparent, the result is cropped tightly to the bounding box of remaining non-transparent pixels, and the output is written to `memory/signatures/<name>.png` (FR5, AD-14)

**Given** the user gave no explicit name for the signature
**When** `save_signature` runs
**Then** the agent asks for one (or uses a sensible default it states plainly, e.g. the user's own name) — never silently invents an unstated name

**Given** the input image is not a PNG (e.g. JPEG, or a `.docx`/`.pdf`)
**When** the user asks the agent to save it as a signature
**Then** the agent declines clearly and does not create a broken or partial signature asset (spec non-goal: general background removal is out of scope)

**Given** an image with no non-transparent pixels remaining after thresholding (e.g. a blank/all-white image)
**When** `save_signature` runs
**Then** it declines clearly (AD-8's error-shape convention) rather than writing a zero-size or empty asset

**Given** a signature name collides with one already saved in this agent group
**When** `save_signature` runs
**Then** it overwrites only on explicit confirmation, or uses AD-10's `-2`-suffix collision behavior — never silently clobbers a prior signature

**Given** the user wants the same signature usable from more than one agent group (e.g. both a household group and a personal DM group)
**When** they ask the agent to save it in each
**Then** the agent saves it separately in each group's own `memory/signatures/`, and its response makes plain that no cross-group sharing occurred (spec non-goal, AD-14)

### Story 1.7: Stamp a Saved Signature into a Saved PDF

As a NanoClaw user,
I want to tell my agent to sign (and optionally date) a PDF I've already saved, using a signature I saved earlier,
So that I get back a signed document without printing, signing by hand, and rescanning it.

**Acceptance Criteria:**

**Given** a saved PDF with a matching AcroForm field and a saved signature name
**When** the user asks to stamp that field with the signature
**Then** `fill_document_field` embeds the signature image at the field's widget rectangle on the page (aspect ratio preserved, fixed max-height) and returns a new PDF — the field itself is not filled with text (FR6, AD-15)

**Given** a saved PDF with a text-layer line and a saved signature name, no matching AcroForm field
**When** the user asks to stamp that line with the signature
**Then** the image is drawn at the same position a text draw would use for that line, and the rest of the page is untouched

**Given** a saved, scanned (no text layer) PDF and a saved signature name with a pixel position
**When** the user asks to stamp that position with the signature
**Then** the image is drawn at the pixel-converted PDF position, same conversion a text draw would use

**Given** a signature name and a text `value` (e.g. a date) given together for the same target
**When** `fill_document_field` runs
**Then** the image is drawn at the target position and the text is drawn immediately beside it — both in one new PDF, one call

**Given** a `signatureName` that doesn't match any file under `memory/signatures/`
**When** `fill_document_field` runs
**Then** it declines clearly, listing the signature names that do exist (or that none are saved yet) — never guesses or silently skips the stamp

**Given** a `signatureName` argument on a `.docx` or `.doc` document
**When** `fill_document_field` runs (this story's predecessor, Story 1.7)
**Then** it declines clearly that signature stamping into Word documents isn't supported yet (superseded by Story 1.8 below)

### Story 1.8: Stamp a Saved Signature into a Saved .docx

As a NanoClaw user,
I want to tell my agent to sign (and optionally date) a Word document I've already saved, using a signature I saved earlier,
So that I get back a signed document the same way I already can for a PDF.

**Acceptance Criteria:**

**Given** a saved `.docx` with a matching table row and a saved signature name
**When** the user asks to stamp that row/cell with the signature
**Then** the image is embedded as a new OOXML media part, referenced via a new relationship, and inserted as an additional run in that cell's last paragraph — existing cell content (if any) is untouched, not replaced (FR6, AD-16)

**Given** a saved `.docx` with a fill-in-the-blank line matching a `lineNumber` and a saved signature name, no matching table
**When** the user asks to stamp that line with the signature
**Then** the image run is inserted right after the target paragraph, same insertion point a text fill-in-the-blank would use

**Given** a signature name and a text `value` (e.g. a date) given together for the same target
**When** `fill_document_field` runs
**Then** the image run is inserted, followed immediately by a text run with the value, in the same paragraph, one new `.docx`, one call

**Given** a saved `.doc` (legacy binary) document, converted to `.docx` via the existing Story 1.5 pipeline, and a saved signature name
**When** the user asks to stamp it
**Then** the same `.docx` image-stamping logic runs against the converted file unchanged (no new `.doc`-specific code), and the response still discloses the `.docx` output format

**Given** a `signatureName` that doesn't match any saved signature
**When** `fill_document_field` runs against a `.docx`/`.doc` document
**Then** it declines clearly, listing actual saved signature names — same behavior as the PDF path (Story 1.7)

**Given** the produced `.docx` after a signature stamp
**When** it's inspected (`word/document.xml`, `word/media/`, `word/_rels/document.xml.rels`, `[Content_Types].xml`)
**Then** it opens as a well-formed, valid `.docx` — the new relationship and content-type entries are present and correctly reference the new media part, and any pre-existing image relationships/media parts in the source document are untouched

## Epic 2: Document Memory Hardening & Extensions

**Status: backlog** — story stubs only, sourced from `deferred-work.md` / `ARCHITECTURE-SPINE.md`'s Deferred section (epic-1 retro action item AI-5 merged these into one canonical list). Not yet spec'd or estimated; pick one and run `bmad-spec` (or hand it to `bmad-build` for a lighter touch) in a fresh session before implementing. None of these block anything already shipped in Epic 1.

### Story 2.1: OCR Fallback for Scanned PDFs

As a NanoClaw user,
I want a scanned (image-only) PDF page read via OCR when the current page-1-only, agent-vision-based reading isn't enough,
So that `save_document`/`fill_document_field` work on scanned documents too, not just ones with a real text layer.

**Acceptance Criteria (stub — not yet elaborated):**
- Given a scanned PDF with no extractable text layer, when `save_document` runs, then real OCR'd text is captured and recallable — not just a rendered-page image with no searchable content.

Source: `deferred-work.md` / epic-1 retrospective ("Full multi-page scanned-PDF support... genuine multi-page support is a larger feature").

### Story 2.2: Multi-File / Batch Fill Operations

As a NanoClaw user,
I want to fill the same field across several saved documents in one request,
So that I don't have to repeat a `fill_document_field` call once per file when the same value applies to many.

**Acceptance Criteria (stub):**
- Given a fill request naming multiple saved documents (or "all documents matching X"), when the tool runs, then each is filled and returned, with a clear per-file success/failure report — never a silent partial batch.

Source: `epics-google-calendar.md`'s sibling epic uses the same "de-risk hardest capability first" precedent this deferred item cites; original mention in `spec-document-memory`'s own Open Questions.

### Story 2.3: Version History / Undo for Edited Documents

As a NanoClaw user,
I want to see or revert a document's prior fill/edit,
So that a wrong fill doesn't require redoing the whole document by hand from the original.

**Acceptance Criteria (stub):**
- Given a document that's been filled/edited more than once, when the user asks to undo the last change (or see prior versions), then a real prior version is recoverable — not just the current state.

Source: `SPEC.md`'s original Open Questions (no version history was ever in scope for Epic 1).

### Story 2.4: Auto-Refresh Stored Raw/Extracted Text After an Edit

As a NanoClaw user,
I want a re-save after editing to refresh what's remembered about a document,
So that a later recall reflects the edited version, not the original one saved before the fill.

**Acceptance Criteria (stub):**
- Given a document that's been filled via `fill_document_field`, when the user later asks `list_documents`/recall about it, then the answer reflects the filled version — currently a re-save is a separate, unspecified action, and recall silently still describes the original.

Source: `epics.md`'s own Story 1.2/1.3 deferred note ("whether an edit refreshes the stored raw copy and/or stored extracted text (default: neither) — a re-save is a separate, unspecified action").
