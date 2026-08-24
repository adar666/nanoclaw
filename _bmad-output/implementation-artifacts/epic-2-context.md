# Epic 2 Context: Document Memory Hardening & Extensions

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Epic 1 shipped the core document-memory + fill-in-editing feature (save, recall, and fill Word/PDF documents, plus signature stamping). Epic 2 is a **backlog of story stubs** — not yet spec'd or estimated — covering four capabilities that were deliberately deferred during Epic 1 rather than built then: real OCR for scanned PDFs (today's fallback is page-1-only agent-vision reading, not searchable OCR text), filling the same value across multiple saved documents in one request, recovering a prior version after a fill/edit, and refreshing what's remembered about a document after it's been edited (today a fill never touches the stored raw copy or extracted text — recall always reflects the as-saved original). None of these block anything already shipped in Epic 1. Before implementing any one of these stories, run `bmad-spec` (or hand it to `bmad-build` for a lighter touch) in a fresh session to elaborate its stub-level acceptance criteria into a real spec.

## Stories

- Story 2.1: OCR Fallback for Scanned PDFs
- Story 2.2: Multi-File / Batch Fill Operations
- Story 2.3: Version History / Undo for Edited Documents
- Story 2.4: Auto-Refresh Stored Raw/Extracted Text After an Edit

## Requirements & Constraints

- **Story 2.1 (OCR):** A scanned/image-only PDF with no text layer must yield real, recallable OCR'd text — not just a rendered-page image the agent reads once in its own multimodal turn (today's behavior, and only for page 1; multi-page scanned support was also explicitly deferred out of Epic 1). This is in tension with Epic 1's own "no new OCR-engine dependency" decision, which was scoped as a deliberate no-Tesseract-class-engine constraint for that build — revisiting it for this story is an explicit, informed decision to make, not an oversight to silently reverse.
- **Story 2.2 (batch fill):** Today's `fill_document_field` (and the whole spec this feature was built from) is explicitly scoped to one named document at a time — batch/multi-file fill is a real scope expansion, not a bug fix. A batch operation must report per-file success/failure clearly; a partial batch must never fail silently.
- **Story 2.3 (version history/undo):** No version history was ever in scope for Epic 1's spec. Note Epic 1's own non-goals explicitly excluded "version-conflict resolution across overlapping edit requests" — this story should treat that boundary as still open, not assume it's now included.
- **Story 2.4 (auto-refresh after edit):** Currently, a fill/edit writes only a new output file for delivery — the stored canonical raw file and stored extracted text under `memory/documents/` are never modified, so a later recall (`list_documents`/content Q&A) still describes the pre-edit original. This was a deliberate default ("neither" — a re-save is treated as a separate, unspecified action), not an oversight; this story is where that default gets revisited.
- All four stories inherit Epic 1's ambiguity-handling rule: when the target saved document is ambiguous, present a numbered candidate list and wait for the user's pick — never guess.

## Technical Decisions

- The whole feature's storage shape (unchanged, and any Epic 2 story should build on it rather than restructure it): raw file at `memory/documents/files/<slug>.<ext>`, one concept file `memory/documents/<slug>.md` (`type: saved-document`, description, source filename, saved date), one summary line appended to `memory/index.md`, plus a `memory/documents/index.md`. All per-agent-group, never cross-group.
- All three existing MCP tools (`save_document`, `list_documents`, `fill_document_field`) live in `container/agent-runner/src/mcp-tools/documents.ts`; any Epic 2 addition should follow the same `McpToolDefinition`/`registerTools()` convention and reuse the existing shared slug-generation helper rather than reinventing one.
- Any shared per-group index file (`memory/index.md`, `memory/documents/index.md`) must go through the existing locked read-modify-write pattern — concurrent sessions of the same group can write at the same time.
- PDF filling only ever draws (AcroForm field set, or overlay-on-top) — parsing/reflowing PDF text in place remains permanently out of scope regardless of what Epic 2 adds.
- Errors for an unresolvable target use this codebase's existing MCP error shape (`{ content: [...], isError: true }`) — never an approximate or partial write.
- Delivery of any produced/updated file goes through the existing `send_file` MCP tool / outbox path — no new outbound delivery mechanism.
- Library stack already in the base image and available to build on: `pdf-lib`, `pdfjs-dist`, `@hyzyla/pdfium` (PDF), `jszip` (docx), `word-extractor` + `libreoffice-writer` (`.doc`), `pngjs` (signature assets). Adding a genuinely new dependency (e.g. an OCR engine for Story 2.1) means another container base-image rebuild + service restart, same cost class as Epic 1 paid.

## Cross-Story Dependencies

- All four stories build on Epic 1's shipped `save_document` / `list_documents` / `fill_document_field` tools and storage shape — none are reachable without that foundation, which is already merged and live.
- Story 2.3 (version history) and Story 2.4 (auto-refresh after edit) both touch the same open question — what happens to stored document state after a fill — and should be scoped with awareness of each other to avoid landing conflicting designs (e.g. auto-refresh overwriting the very "prior version" 2.3 would need to keep).
- Story 2.2 (batch fill) would call the same per-document fill logic Story 2.4 might change the post-fill behavior of — sequence-sensitive if both are picked up close together.
- Story 2.1 (OCR) requires its own separate scoping decision (whether to add a real OCR engine dependency at all) before implementation can start; it does not block or depend on the other three.
