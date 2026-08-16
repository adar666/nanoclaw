# Brownfield Notes — Existing Plumbing to Reuse

Grounding facts from the live NanoClaw v2 codebase, gathered before this spec was written, so downstream (architecture/build) doesn't rediscover them.

## Inbound: attachment already lands on disk — no new plumbing needed

- Extraction: `extractAttachmentFiles()` in `src/session-manager.ts` (called from the inbound-message write path). Any `content.attachments[]` entry with base64 `data` is decoded and written to disk.
- Filename derivation: `deriveAttachmentName()` in `src/attachment-naming.ts`. **Gap**: `MIME_TO_EXT` has `application/pdf` but no `.docx`/`.doc` MIME entries — a Word file arriving without an explicit `att.name` from the channel bridge could land without an extension. Worth checking/fixing as part of implementation.
- On-disk path (host): `data/v2-sessions/<agentGroupId>/<sessionId>/inbox/<messageId>/<filename>`.
- Container-side view: the agent sees `[<type>: <name> — saved to /workspace/inbox/<msgId>/<name>]` in its prompt text (`container/agent-runner/src/formatter.ts`, `formatAttachments()`).

## Memory: file-based, per group, already has a place for this

- Documented in `docs/memory.md`. Lives at `groups/<folder>/memory/` (host) = `/workspace/agent/memory/` (container).
- `memory/index.md` is Core Memory, always injected into the agent's context. Agent-chosen subfolders hold detail; OKF-frontmatter convention.
- No `agent_groups` DB field for memory — it's filesystem-only. A saved-document record belongs here: the file itself plus an index.md entry pointing to it.
- **Do not confuse with** `src/media-ingestion.ts` — a separate "second-brain" tenant-DB pipeline specific to certain DM groups (`dm-with-uriel`, `dm-with-partner`, `household`), PDF/image-only, writing to `second-brain-data/attachments/<tenant>/...`. That system is out of scope here; this spec's documents belong in the generic per-group `memory/` tree.

## Outbound: returning the edited file already works end-to-end

- `send_file` MCP tool (`container/agent-runner/src/mcp-tools/core.ts`): `{ to, path, text?, filename? }`. Resolves `path` relative to `/workspace/agent/` if not absolute, copies into `/workspace/outbox/<newMsgId>/<filename>`, writes a `messages_out` row with `content.files = [filename]`.
- Host side mirrors inbound: `readOutboxFiles()` in `src/session-manager.ts` → `src/delivery.ts` passes buffers to the channel adapter, then `clearOutbox()`.
- A new document-edit skill calls `send_file` exactly like any existing skill that returns a generated file — no new delivery code needed.

## Closest existing pattern to follow

- `container/skills/audio-report/SKILL.md`: reads an inbox-attachment path tag from the prompt, does its transformation, writes an output file, calls `send_file`. A new docx/pdf skill should follow this same shape (read from `/workspace/inbox/...`, write to a working path, `send_file` it back).

## What's missing (drives the build-cost constraint in SPEC.md)

- No docx or pdf read/write library anywhere in `container/agent-runner/package.json`, the Dockerfile, or any `container/skills/*`. Adding one (e.g. a Bun-compatible docx table-editing lib, plus a PDF library capable of overlay/stamp writes) is new work: `bun install` + `bun.lock` commit + `./container/build.sh` + service restart, per the project's standard container-dependency gotcha.
