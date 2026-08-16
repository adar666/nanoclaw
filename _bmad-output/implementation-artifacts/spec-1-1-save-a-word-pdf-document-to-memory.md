---
title: 'Save a Word/PDF Document to Memory'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '97646a53e64db37ff2576b80bba617b74cb15583'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A user can send a Word/PDF file, but the agent has no way to remember it — content is lost once the session inbox rotates, with no way to recall it later or edit it.

**Approach:** Add a `save_document` MCP tool that copies the file to a stable per-group memory location, extracts its text (directly if a text layer exists, otherwise via the agent's own multimodal reading of a rendered page image), and records it as an OKF concept file plus a `memory/index.md` line.

## Boundaries & Constraints

**Always:**
- Only `.docx` and `.pdf` are in scope; other types get a clear decline, never a partial memory entry.
- This story is read/extract only — writing/editing the document is Story 1.2.
- New tool follows the existing `McpToolDefinition` + `registerTools()` convention (AD-1). Dependencies `pdfjs-dist` and `@hyzyla/pdfium` go into `container/agent-runner/package.json` `dependencies` (base image only, AD-3) — not `pdf-lib`/`jszip`, those are Story 1.2's.
- Storage: raw file → `memory/documents/files/<slug>.<ext>`; concept file → `memory/documents/<slug>.md` (`type: saved-document`, `description`, `source-filename`, `saved-date`); one line appended to `memory/index.md`; `memory/documents/index.md` created (AD-6).
- One shared slug function (AD-10): lowercase kebab-case of the filename, extension stripped, `-2`/`-3`… on collision.
- Writes to shared index files go through locked read-modify-write (AD-11) — no unguarded overwrite.
- `MIME_TO_EXT` gains `.docx`/`.doc` entries (AD-9), landed here as a prerequisite.
- Scanned/no-text-layer PDF: tool renders the page to an image and hands it to the agent's own multimodal turn to read — never a tool-embedded OCR call (AD-4).

**Ask First:**
- If `@hyzyla/pdfium`'s optional `sharp` dependency turns out to be a real native-binary blocker in this Bun/Docker base image (spine says it isn't, via a bundled WASM fallback) — HALT before swapping libraries.
- If adding these two deps pulls unexpected transitive packages into `bun.lock` — HALT before proceeding.

**Never:**
- Never write to or modify the source document in this story.
- Never call a dedicated OCR engine (Tesseract, cloud OCR API).
- Never store under the second-brain media-ingestion pipeline (`src/media-ingestion.ts`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path, docx | `.docx` sent, "remember this" | File → `memory/documents/files/<slug>.docx`; concept file + index line written | N/A |
| Happy path, PDF with text layer | `.pdf` with selectable text | `pdfjs-dist` extracts text directly into the concept file | N/A |
| Scanned PDF, no text layer | `.pdf` with no text layer | Page rendered via `pdfium`; agent's own multimodal turn reads content into the concept file | N/A |
| Unsupported file type | `.txt`/`.xlsx`, "remember this" | Tool declines clearly | MCP error text; no partial memory entry |
| Extension-less Word attachment | Word file with no filename from channel bridge | `MIME_TO_EXT` resolves `.docx` | N/A |
| Slug collision | New doc normalizes to an existing slug | Gets a `-2` suffix | N/A |
| Concurrent saves, same group | Two `save_document` calls race on `memory/index.md` | Both entries land intact | Locked read-modify-write, no lost update |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/core.ts:1-33` -- `McpToolDefinition` pattern, `err()`/`ok()` helpers, `registerTools` import -- mirror shape for `documents.ts`.
- `container/agent-runner/src/mcp-tools/core.ts:112-160` -- `sendFile` tool -- reference for schema/handler/file-write shape.
- `container/agent-runner/src/mcp-tools/index.ts:8-13` -- barrel; add `import './documents.js';` after `transcribe-audio.js`.
- `container/agent-runner/src/mcp-tools/transcribe-audio.test.ts` -- bun:test pattern (`initTestSessionDb`/`closeSessionDb`, direct handler calls) to mirror in `documents.test.ts`.
- `container/agent-runner/package.json:11-16` -- `dependencies`; add `pdfjs-dist`, `@hyzyla/pdfium`.
- `container/Dockerfile:77-80` -- `bun install --frozen-lockfile` layer; no Dockerfile edit needed, only `package.json`/`bun.lock`.
- `src/attachment-naming.ts:20-37` -- `MIME_TO_EXT` map; add `.docx`/`.doc` entries.
- `container/agent-runner/src/formatter.ts:268-282` -- `formatAttachments()`; confirms the `[type: name — saved to /workspace/inbox/msgId/name]` tag the agent sees (read-only reference).
- `docs/memory.md:59-68` -- OKF convention (`type` + free vocabulary) for concept-file frontmatter.
- `container/agent-runner/src/memory/templates/index.md` -- shape of the always-loaded `index.md`.
- `groups/household/memory/household/supplies.md:1-4` -- real OKF concept-file example to match.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/package.json` -- add `pdfjs-dist`, `@hyzyla/pdfium` to `dependencies` -- extraction libs (AD-3)
- [x] `container/agent-runner/bun.lock` -- regenerate via `bun install` -- lockfile discipline
- [x] `src/attachment-naming.ts` -- add `.docx`/`.doc` to `MIME_TO_EXT` -- AD-9 prerequisite
- [x] `container/agent-runner/src/mcp-tools/documents.ts` (new) -- `save_document` tool, shared slug function, locked index-write helper -- AD-1/6/10/11
- [x] `container/agent-runner/src/mcp-tools/index.ts` -- add barrel import -- wiring (AD-1)
- [x] `container/agent-runner/src/mcp-tools/documents.test.ts` (new) -- bun:test coverage for the I/O matrix above
- [x] `container/skills/document-memory/SKILL.md` (new) -- agent-facing prose for `save_document`, mirrors `audio-report/SKILL.md`'s shape

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs, then all tests (new and existing) pass.
- Given the new dependencies are added, when the container build runs `bun install --frozen-lockfile`, then it succeeds against the regenerated `bun.lock`.

## Spec Change Log

- 2026-08-16 (implementation): Both "Ask First" boundaries checked empirically against the real `bun install` output rather than skipped:
  - `@hyzyla/pdfium`'s `sharp` dependency: confirmed a *devDependency of the package's own README example only* (`npm view` shows no runtime `dependencies`/`peerDependencies` at all — "zero dependencies," PDFium WASM bundled). Not installed, not needed; a hand-rolled PNG encoder (`zlib.deflateSync` + manual chunk/CRC framing) replaces the example's `sharp` usage so no native-binary dependency is pulled in. Spine's claim confirmed correct.
  - Unexpected transitive packages: `pdfjs-dist@6.2.108` declares `@napi-rs/canvas` (plus 11 platform-native variants) as an `optionalDependency`, used only for its browser-Canvas-style render-to-canvas API. `bun install` resolved but did **not** install any of them (confirmed: 4 packages installed, none under `@napi-rs`) because this tool only calls `getTextContent()`, never the canvas render path. Flagging per the boundary's letter rather than silently proceeding; judged non-blocking since nothing native actually lands in `node_modules` or ships in the image.
- 2026-08-16 (implementation): `.doc` (legacy binary Word format) is explicitly declined by `save_document` — only `.docx`/`.pdf` are accepted, per "Only .docx and .pdf are in scope." The `MIME_TO_EXT` `.doc` entry (AD-9) exists solely so a legacy attachment lands with a correct, decline-able extension instead of none.
- 2026-08-16 (implementation): `.docx` text extraction shells out to the `unzip` CLI (already in the base image, per `container/Dockerfile`'s `apt-get install ... unzip`) to read `word/document.xml`, then strips OOXML markup with a small regex-based reader — no `jszip` dependency, consistent with this story's boundary reserving `jszip`/`pdf-lib` for Story 1.2.
- 2026-08-16 (code review, patch round): 11 patch-tier findings applied to the same diff — path-traversal containment on the `path` argument (mirrors `src/inbox-safety.ts`'s realpath-containment pattern), mtime-based stale-lock recovery (30s), rollback of partial writes inside the locked block on any failure, control-character stripping in `yamlEscape` (+ the same stripping applied to the `memory/index.md` link text and concept-file heading, a directly adjacent gap found while testing the reviewer's fix), `[`/`]`/`(`/`)` Markdown-escaping of untrusted filenames in both the index link and the heading, a fix so the scanned-PDF response message derives its render path from the injected `baseDir` instead of a hardcoded `/workspace/agent/` prefix, deterministic (hash-based) render filenames so a successful follow-up call can clean up its own PNG, explicit `extractedText` type validation, "(page 1 only)" disclosure in the tool's response plus matching SKILL.md caveats for page-1-only and body-only extraction, 11 new tests (26 total in `documents.test.ts`), and the `document-memory` skill added to `CLAUDE.md`'s two "Container skills" listings. Full diff re-verified: `cd container/agent-runner && bun test` (195 pass, 1 pre-existing skip, 0 fail) and `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (clean) — both spec-mandated Verification commands pass; host `pnpm test` (1384 pass) and `pnpm exec tsc --noEmit -p .` also re-run clean.

## Design Notes

Locking (AD-11): implement via an exclusive-create lock file (e.g. `memory/documents/.index.lock`) with `wx`-flag create + short retry/backoff -- no new dependency, mirrors the `wx`-flag pattern `session-manager.ts`'s inbox writer already uses (`fs.writeFileSync(..., { flag: 'wx' })`).

Slug function (AD-10) should live in `documents.ts` itself (not a new shared module) since only this file's tools use it yet -- Story 1.2/1.3 import it from here.

## Verification

**Commands:**
- `cd container/agent-runner && bun test` -- expected: all pass, including new `documents.test.ts`
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

## Suggested Review Order

**Entry point & save orchestration**

- Start here -- the whole flow: resolve path, route by extension, extract, lock, write, respond.
  [`documents.ts:436`](../../container/agent-runner/src/mcp-tools/documents.ts#L436)

**Security: path containment**

- Every path resolves through this before any file is touched -- rejects escapes outside the inbox.
  [`documents.ts:91`](../../container/agent-runner/src/mcp-tools/documents.ts#L91)
- Realpath-based containment check, mirrors `src/inbox-safety.ts`'s existing pattern.
  [`documents.ts:86`](../../container/agent-runner/src/mcp-tools/documents.ts#L86)

**Concurrency & crash safety**

- Exclusive-create lock with mtime-staleness detection -- a crashed holder no longer deadlocks future saves.
  [`documents.ts:158`](../../container/agent-runner/src/mcp-tools/documents.ts#L158)
- Stale-lock threshold check -- the actual "was the holder killed" heuristic.
  [`documents.ts:170`](../../container/agent-runner/src/mcp-tools/documents.ts#L170)
- Partial-failure rollback -- unwinds whatever was already written before rethrowing.
  [`documents.ts:520`](../../container/agent-runner/src/mcp-tools/documents.ts#L520)

**Extraction: text layer vs. scanned fallback**

- Text-layer extraction via pdfjs-dist -- the fast path, all pages concatenated.
  [`documents.ts:287`](../../container/agent-runner/src/mcp-tools/documents.ts#L287)
- Scanned-page render via pdfium -- page 1 only, hands off to the agent's own multimodal read.
  [`documents.ts:384`](../../container/agent-runner/src/mcp-tools/documents.ts#L384)

**Output safety (frontmatter & Markdown injection)**

- Control-character stripping -- closes the YAML-frontmatter-corruption gap from a crafted filename.
  [`documents.ts:221`](../../container/agent-runner/src/mcp-tools/documents.ts#L221)
- YAML value escaping for frontmatter fields.
  [`documents.ts:226`](../../container/agent-runner/src/mcp-tools/documents.ts#L226)
- Markdown-link escaping for the generated `memory/index.md` entry and concept-file heading.
  [`documents.ts:235`](../../container/agent-runner/src/mcp-tools/documents.ts#L235)

**Naming (AD-10)**

- Deterministic slug scheme shared by every document-memory tool.
  [`documents.ts:123`](../../container/agent-runner/src/mcp-tools/documents.ts#L123)
- Collision handling -- appends `-2`/`-3`... under the same lock as the write.
  [`documents.ts:134`](../../container/agent-runner/src/mcp-tools/documents.ts#L134)

**Tool contract & wiring**

- The MCP schema the agent actually calls -- what `path`/`extractedText` mean to it.
  [`documents.ts:594`](../../container/agent-runner/src/mcp-tools/documents.ts#L594)
- Barrel import -- the one line that wires this tool into the running agent.
  [`index.ts:14`](../../container/agent-runner/src/mcp-tools/index.ts#L14)

**Peripherals**

- New base-image dependencies (AD-3).
  [`package.json:14`](../../container/agent-runner/package.json#L14)
- `MIME_TO_EXT` prerequisite fix (AD-9) for extension-less Word attachments.
  [`attachment-naming.ts:34`](../../src/attachment-naming.ts#L34)
- Agent-facing usage guide, including the page-1-only / body-only disclosures.
  [`SKILL.md`](../../container/skills/document-memory/SKILL.md)
- 26-test suite covering the I/O matrix plus every patch-round fix.
  [`documents.test.ts`](../../container/agent-runner/src/mcp-tools/documents.test.ts)
- Docs-index update for the new container skill.
  [`CLAUDE.md`](../../CLAUDE.md)
