# Epic 1 Context: Document Memory + Fill-In Editing

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Today a Word or PDF file a user sends an agent lives only in that session's ephemeral inbox — its content can't be recalled later and it can't be edited. This epic gives agents a durable, per-group document memory: a user can save a Word/PDF (file + extracted text, indexed for recall), ask about its content in any later conversation without resending it, and ask the agent to fill a named target — a Word table row, a Word fill-in-the-blank text line, a PDF form field, or a PDF text line/position — with a value and get back an updated file. All four capabilities share one new MCP-tool surface, one library stack, and one storage shape under the agent group's existing memory tree. No PRD or UX design contract governs this epic — SPEC.md (plus its companions `row-targeting-matrix.md` and `brownfield.md`) is the sole requirements source; there is no UI surface, this is chat-only.

## Stories

- Story 1.1: Save a Word/PDF Document to Memory
- Story 1.2: Fill a Named Target in a Saved Document and Return It
- Story 1.3: Recall a Saved Document's Content
- Story 1.4: Fill a Docx Fill-In-The-Blank Text Line (No Table)

## Requirements & Constraints

- Saving a Word/PDF on request must persist both the raw file and its extracted text/summary in the requesting agent group's memory, with a discoverable index entry — never the separate, tenant-scoped second-brain media-ingestion pipeline, which is a different system serving only specific DM groups.
- Recall must answer content questions from the stored memory entry alone — never require the user to resend the file.
- Filling a named target must auto-detect which of four mechanisms applies (Word table row, Word fill-in-the-blank text line, PDF form field, PDF overlay-by-position) purely from the file's structure — the user is never asked to pick a mode.
- The Word text-line mechanism only applies when no table already matches the request; table-row targeting always takes priority over text-line targeting for the same `.docx`.
- When a `.docx` has no table match and no fill-in-the-blank line matches either, the tool declines clearly rather than inserting the value anywhere.
- PDF value-filling never parses and reflows existing PDF text in place; it either sets a matching AcroForm field via the PDF's native form API (no page redraw) or overlays/stamps new text on top of the existing page, saved as a new file. Original page content underneath an overlay is always untouched.
- Extraction and overlay-positioning use only a text layer when one exists (Word always; PDF when present, via structured extraction with per-item coordinates). When no text layer exists (scanned/image-only PDF), the page is rendered to an image and the agent's own multimodal turn reads content / estimates position — no OCR-engine dependency is introduced anywhere.
- Whenever the target saved document is ambiguous (unnamed reference, or a name matching more than one saved document), the agent must present a numbered candidate list and wait for the user's pick — never guess (e.g. "most recent").
- Filling a target that can't be resolved (wrong table/row/field/line) must fail explicitly, never write an approximate or wrong-location value.
- Editing returns the updated file through the existing outbound file-delivery path only — no new delivery mechanism, and an edit must touch only the one targeted cell or paragraph — everything else in the document stays byte-identical.
- Only `.docx` and `.pdf` are in scope; other file types are declined cleanly, without creating a broken or partial memory entry.
- Out of scope for this epic: layout restructuring/reformatting beyond the requested value, concurrent/collaborative editing or version-conflict resolution, file types beyond docx/pdf, and full PDF text reflow.
- Shipping requires new dependencies in the agent-runner base image (no docx/pdf library exists today) plus a container image rebuild and service restart — accepted as in-scope build cost, not deferred.

## Technical Decisions

- New capability surfaces as three MCP tools (save, list/recall-candidates, fill) in one new module, registered through the codebase's existing tool-registration convention and wired into the agent via a single barrel import — no bespoke dispatch path.
- All parsing/extraction/writing runs synchronously inside the tool handler, in-container, during the same turn — this work needs no external API/credential, so the host fire-and-forget pattern used elsewhere for async work does not apply here.
- The docx/pdf libraries are added as base-image dependencies (shared `bun install` layer), not through the per-group package self-mod flow — the feature must work identically for every agent group.
- Word table-cell edits are direct OOXML manipulation (unzip, merge fragmented text runs before matching, replace text, rezip) — not a templating library. Table/row targeting is 1-indexed in natural document order; a header row counts as row 1; if a document has multiple tables and no table number was given, the agent asks rather than guessing.
- Word fill-in-the-blank text lines are a separate, structurally independent targeting mode from table cells: a paragraph carrying an underscore run (3+ characters) or a trailing colon/blank is treated as a numbered candidate line. Same two-call discovery pattern as the PDF text-layer overlay path — a first call with no line number lists candidates, a second call with a line number and value fills exactly one, replacing only the matched underscore run (or inserting right after the label text when there's no underscore run). This mode only exists on the `.docx` side; a given document offers either table-row or text-line targeting for a given request, never both.
- Saved documents get a stable home independent of the ephemeral per-message inbox: a canonical raw-file copy, a small per-document metadata/summary file (not the full text bloating the always-loaded index), and one index-line reference — extending the existing per-group memory conventions with two feature-specific metadata keys, not a new schema mechanism.
- A single shared slug-generation function (filename → lowercase kebab-case, collision-suffixed) is used by every tool that needs to name or reference a saved document — no per-tool reinvention, so cross-tool references never drift.
- Every write to a shared per-group memory index file goes through locked/atomic read-modify-write — two concurrent sessions of the same group can save at the same time without corrupting or dropping an entry.
- Failure returns the codebase's existing MCP tool error shape for the agent to relay in chat — the fill tool has no silent/approximate-write path, for any of its four targeting mechanisms.
- The tool, never the agent, owns pixel-to-PDF-point coordinate conversion for the scanned-PDF overlay path: it passes the agent the image's exact rendered pixel dimensions in the same turn (guarding against an API silently resizing the image), then converts the agent's visual estimate itself.
- An attachment-naming gap (Word MIME types missing from the extension-resolution map) is a landed prerequisite fix bundled with this epic, not a separate change — without it a Word file can arrive with no extension and break downstream file-type routing.
- The stored canonical raw file and stored extracted text are never mutated by an edit (default, pending a future explicit decision) — an edit only ever produces a new delivered copy; recall continues to reflect as-saved content until a re-save.

## UX & Interaction Patterns

All interaction is conversational — chat attachment in, chat reply plus a returned file out — through channels already wired; there is no UI surface. One recurring pattern spans recall and fill: whenever a document reference is ambiguous (not named, or matching more than one saved document), the agent presents a numbered list of candidates and waits for the user's numeric pick before proceeding, rather than guessing. The same numbered-candidate pattern also governs the text-line fill mode: when no line number is given, the tool lists detected fill-in-the-blank lines and waits for a follow-up call naming one.

## Cross-Story Dependencies

Story order is intentional: Save (1.1) before Fill (1.2) before Recall (1.3) — Fill is sequenced second, ahead of the more familiar-shaped Recall, specifically to de-risk it early since it is the most novel and highest-invariant capability of the three. Story 1.4 extends the same `fill_document_field` tool built in 1.2 with a second, distinct `.docx` targeting mode (added post-launch, after live use showed most real forms use plain fill-in-the-blank lines rather than tables) — it must respect 1.2's table-row path as the priority match and only engage when no table matches. All of Fill, Recall, and the text-line extension depend on a document already having been saved via Story 1.1 (same storage shape, same slug scheme, same disambiguation data source), and Fill/Recall/1.4 all consume the same candidate-list/disambiguation mechanism, so they should resolve it consistently rather than diverging.
