---
id: SPEC-document-memory
companions: [row-targeting-matrix.md, brownfield.md]
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Document Memory + Fill-In Editing

## Why

A pain to solve: right now a user who sends a Word or PDF file to their agent gets no lasting benefit from it — the file lives only in that session's inbox, and its content is not something the agent can be asked about later or asked to change. The user wants two things from the same document: (1) durable memory of what's in it, so later conversations can reference it without resending the file, and (2) the ability to say "fill row X with value Y" and get back an updated copy — turning the agent into a working document assistant, not just a file receiver.

## Capabilities

- **CAP-1**
  - **intent:** When a user sends a Word or PDF attachment and asks to save/remember it, the agent stores the file and its extracted text content in the agent group's memory, with a pointer entry in `memory/index.md` (a mechanical filename restatement, not a generated content summary — see `implementation-artifacts/epic-1-retro-2026-08-16.md` action item AI-3). For a PDF with no text layer (scanned/image-only), extraction falls back to the agent reading the rendered page image directly (see `row-targeting-matrix.md`).
  - **success:** After sending a docx/pdf with "remember this," a later, unrelated conversation can ask about the document's content and the agent answers correctly from memory, with no need to resend the file — including for a scanned PDF.

- **CAP-2**
  - **intent:** A user can ask about a previously saved document's content at any later point, and the agent answers from the stored memory/index entry and extracted text rather than requiring the file again. If the reference is ambiguous (matches more than one saved document, or none was named), the agent presents a numbered list of candidates and the user picks by number.
  - **success:** A query referencing a document saved in a prior session (by name or topic) returns a content-accurate answer; an ambiguous reference produces a numbered pick-list instead of a guess.

- **CAP-3**
  - **intent:** A user can name a target inside a specific saved document — a Word table row (by table number + row number), a Word plain-paragraph fill-in-the-blank line (by line number, when no table matches), a PDF form field, or a PDF text line/position — plus a value, and the agent produces an updated copy of the document with that value applied, delivered back in chat. If the target document is ambiguous, the agent presents a numbered list of candidates first (same disambiguation as CAP-2).
  - **success:** For a Word document with a matching table, the named table's named row's cell contains the new value and the rest of the document is otherwise unchanged. For a Word document with a fill-in-the-blank line (no matching table), the blank on that one paragraph is filled and every other paragraph is unchanged. For a PDF, a new PDF is returned with the value overlaid/stamped at the correct location and the original page content otherwise unchanged.

## Constraints

- PDF value-filling must use an overlay/stamp technique — draw the new text on top of the existing page and save as a new PDF. Parsing and reflowing PDF text in place is ruled out entirely (user-mandated, see `row-targeting-matrix.md`).
- Row/field targeting must handle four distinct mechanisms depending on file type — Word table row (addressed as table number + row number), Word plain-paragraph fill-in-the-blank line (addressed by line number, only when no table matches — discovered live: real forms are more often built this way than as tables), PDF AcroForm field, or PDF overlay-by-position for plain/scanned PDFs — auto-selected from the file, never chosen by the user up front.
- Content extraction and overlay positioning use a hybrid, no-new-OCR-engine approach: a text layer (Word always; PDF when present) is read directly via structured extraction (including per-text-item coordinates for positioning); a PDF with no text layer is handled by rendering the page to an image and having the agent itself (already multimodal) read/estimate content and position from it. No Tesseract-class OCR engine dependency.
- When the target saved document is ambiguous — not named, or the name matches more than one — the agent must present a numbered list of candidate documents and wait for the user to pick a number, never guess.
- Saved documents and their extracted content live under the requesting agent group's `memory/` tree (raw file + a `memory/index.md` summary entry, per the existing OKF convention) — not the separate second-brain media-ingestion pipeline, which is a different tenant-scoped system serving only specific DM groups.
- Editing must return the updated file through the existing `send_file` MCP tool / outbox delivery path. No new outbound delivery mechanism.
- No docx/pdf read or write library exists in the container today. Shipping this feature requires adding a new dependency to the agent-runner (Bun) package tree and a container image rebuild — accepted as in-scope for this spec, not deferred to a later epic.
- PDF fill values must render correctly for non-Latin-1 scripts (Hebrew, confirmed working) via an embedded Unicode-coverage font, not just the Latin-1-only PDF standard fonts — added during implementation review, not originally planned here; see `architecture-nanoclaw-v2-2026-08-16/ARCHITECTURE-SPINE.md`'s Stack table.

## Non-goals

- Restructuring, reformatting, or redesigning document layout — only single-value fill-ins into an existing row/field/line, never new sections, styling changes, or content beyond the requested value.
- Concurrent/collaborative multi-user editing of the same saved document, or version-conflict resolution across overlapping edit requests.
- File types other than Word (`.docx`) and PDF (`.pdf`) — other formats (xlsx, pptx, images, plain text) are out of scope.
- Full reflow / re-typeset PDF text editing — explicitly excluded in favor of the overlay approach.

## Success signal

A user sends a Word or PDF file and says "save this to memory"; weeks later, in an unrelated conversation, they ask a question about that document's content and get a correct answer with no file resent — this holds even if the PDF was a scan with no text layer. Separately, they say "fill row 3 with [value]" naming a previously saved document (or pick it from a numbered list if ambiguous), and the agent replies with a new file — Word or PDF — containing that value in the right place, everything else untouched.

## Assumptions

- Memory is scoped per agent group (shared across everyone in that group's chat), matching existing `memory/index.md` semantics — not isolated per individual user within a group.
- Saved documents are referenced by the agent picking up on filename/topic from conversation context, the same way any other memory item is recalled — not by a formal document ID the user must quote, except when disambiguation kicks in and a numbered pick-list is used instead.
