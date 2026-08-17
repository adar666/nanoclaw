---
title: 'Save a Reusable Signature Asset'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '5f2ac53'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A user who has an image of their handwritten signature has no way to give it to the agent once and reuse it — every future document that needs signing would require resending the image and re-describing where to place it. Confirmed live: the household form-filling feature (Stories 1.1-1.5) works, but the user now wants to sign and date-stamp filled forms too, starting with turning a photographed/drawn signature into a clean, storable asset.

**Approach:** A new `save_signature` MCP tool, same shape and conventions as `save_document` (AD-1, AD-2, AD-6, AD-10, AD-11): decodes an input PNG with `pngjs` (pure JS, new dependency), thresholds near-white pixels to fully transparent (fixed luminance cutoff), crops to the bounding box of what's left, and writes the result to `memory/signatures/<name>.png` — reusing the existing hand-rolled `encodePng`/`pngChunk`/`crc32` helpers (Story 1.1's scanned-PDF-render path) for the encode side rather than adding a second PNG writer. This story is save-only: it does not stamp a signature into any document (that's CAP-6, deliberately split into two later, sequential stories — PDF stamping, then `.docx` embedding — per explicit user direction to build and verify each independently).

## Boundaries & Constraints

**Always:**
- New MCP tool `save_signature`, registered in `documents.ts` alongside `saveDocument`/`listDocuments`/`fillDocumentField` via the existing `registerTools()` call — same file, same `McpToolDefinition` convention (AD-1).
- Input must be a `.png` (by extension after `resolveInboxPath` resolution, matching `save_document`'s own extension-check pattern). Any other extension is declined cleanly, same error shape as `save_document`'s unsupported-type decline — no partial write.
- Background removal: for each pixel, if R, G, and B are all `>= 240` (fixed threshold, not user-configurable, not read from args), set alpha to `0`; otherwise leave the pixel as decoded (alpha stays whatever the source had, `255` for an opaque PNG). No edge feathering, no anti-aliasing pass — a hard per-pixel cutoff.
- After thresholding, compute the bounding box of every pixel with `alpha > 0`. If that set is empty (nothing survived thresholding — e.g. an all-white input), decline cleanly rather than writing a zero-dimension or empty file.
- Crop the RGBA buffer to that bounding box before encoding — the output PNG's dimensions are the bounding box's, not the source image's.
- Encode via the existing `encodePng` helper (reused, not reimplemented) and write to `memory/signatures/<name>.png` under the agent group's `baseDir` (same `baseDir`/`workspaceRoot` opts shape as `SaveDocumentOpts`).
- `<name>` comes from an explicit `name` argument. If omitted, the tool declines and asks for one — never invents an unstated name (no silent default, unlike a `save_document` slug which is filename-derived; a signature name is a value the user chose, e.g. "Uriel").
- `<name>` is sanitized through the existing `slugify` helper (reused, not reimplemented) before touching the filesystem — same untrusted-input discipline as every other model-controlled string this file already handles.
- A name collision (a file already exists at `memory/signatures/<slug>.png`) does not silently overwrite: append `-2`/`-3`… (reuses `uniqueSlug`'s collision-suffix behavior, adapted to this directory) unless the caller's request text made an explicit intent to replace the existing one — the tool description instructs the agent to ask the user when it's ambiguous, matching the `save_document`-family's existing "ask, don't guess" pattern (AD-8's spirit, not a literal reuse of its function).
- `memory/signatures/` is created on first use (`fs.mkdirSync(..., { recursive: true })`), same as `memory/documents/files/` was in Story 1.1 — no separate provisioning step.
- The source `path` argument goes through the existing `resolveInboxPath` containment check (reused, not reimplemented) — same untrusted-path discipline as every other tool in this file.
- No cross-agent-group read or write — this tool only ever touches the calling session's own `baseDir`. A signature usable from more than one agent group requires the user to ask the agent in each group separately; the tool's success response says the signature was saved for *this* group, never implies it's now available elsewhere.
- `pngjs` added to `container/agent-runner/package.json` `dependencies`, baked into the shared base image (same mechanism as every other dependency in this feature, AD-3's convention) — not a per-group `install_packages` self-mod.

**Ask First:**
- If `pngjs`'s current npm version has a materially different decode API than expected (e.g. doesn't expose a simple synchronous `PNG.sync.read(buffer)`) — research and adapt; only HALT if no straightforward synchronous decode path exists at all.

**Never:**
- Never attempts general-purpose background removal (segmentation, alpha matting, non-near-white backgrounds) — luminance threshold only, per spec non-goal.
- Never stamps a signature into any document in this story — that is out of scope here (CAP-6, future stories).
- Never shares a saved signature across agent groups.
- Never silently overwrites an existing signature file at the same path without either an explicit user intent in the request or falling back to the collision-suffix behavior.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Save a signature | PNG image, ink drawing on white background, `name: "uriel"` | Near-white pixels → transparent; cropped to ink bounding box; written to `memory/signatures/uriel.png` | N/A |
| No name given | PNG image, no `name` argument | Tool declines, asks the agent to supply one | MCP error text |
| Non-PNG input | `.jpg`/`.docx`/`.pdf` attachment, asked to save as signature | Declines cleanly, no file written | MCP error text |
| All-white / blank input | PNG where every pixel is `>= 240,240,240` | Declines cleanly (no bounding box survives thresholding) | MCP error text |
| Name collision | `memory/signatures/uriel.png` already exists, new save with the same name, no explicit "replace" intent | Written as `memory/signatures/uriel-2.png` instead of overwriting | N/A |
| Concurrent saves, same group | Two `save_signature` calls racing on directory creation | Both complete without crashing (`mkdirSync recursive` is idempotent; no shared index file is at stake here, unlike `memory/index.md`) | N/A |
| Path outside inbox | `path` argument resolves outside `/workspace/inbox` | Declines via the existing containment check, same as `save_document` | MCP error text |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/documents.ts:85` -- `SUPPORTED_EXTENSIONS` -- do not touch (that set is documents-only); signature PNG-extension check is a new, local check inside the new handler.
- `container/agent-runner/src/mcp-tools/documents.ts:103` -- `resolveInboxPath` -- reuse as-is for the `path` argument.
- `container/agent-runner/src/mcp-tools/documents.ts:135` -- `slugify` -- reuse as-is for turning the `name` argument into a filesystem-safe slug.
- `container/agent-runner/src/mcp-tools/documents.ts:146` -- `uniqueSlug` -- reference shape only; needs a small adapted version (or a generalized directory+extension parameter) since it currently hardcodes `.md` in `memory/documents/` — the new code should not hand-roll a second collision-suffix loop from scratch.
- `container/agent-runner/src/mcp-tools/documents.ts:404-443` -- `crc32`/`pngChunk`/`encodePng` -- reuse the encode side unmodified.
- `container/agent-runner/src/mcp-tools/documents.ts:493-667` (`saveDocumentImpl`/`SaveDocumentOpts`) -- shape/pattern reference for the new `saveSignatureImpl`/`SaveSignatureOpts` (same `baseDir`/`workspaceRoot` opts convention, same try/catch-into-`err()` structure, same `log()` call on success).
- `container/agent-runner/src/mcp-tools/documents.ts:1993-2023` (`saveDocument` tool definition + `registerTools([...])` call) -- add `saveSignature` alongside it in both the export and the `registerTools([...])` array.
- New function `saveSignatureImpl` + exported `saveSignature: McpToolDefinition` -- placed as a new section in this same file (this feature's convention: all MCP tools for this capability live in one file), including the PNG decode (`pngjs`), threshold, bounding-box crop, and encode/write logic.
- `container/agent-runner/package.json` -- add `pngjs` to `dependencies` (and its `@types/pngjs` to `devDependencies` if no bundled types ship, matching this file's existing pattern of a small local ambient `.d.ts` when a dependency has no npm-published types, as Story 1.5 did for `word-extractor`).
- `container/skills/document-memory/SKILL.md` -- extend with a short section on `save_signature`: when to use it, what it does NOT do yet (no stamping in this story), and how to ask for a name if the user didn't give one.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/package.json` -- add `pngjs` to `dependencies` (+ types dependency/ambient `.d.ts` if needed)
- [x] `container/agent-runner/bun.lock` -- regenerate via `bun install`
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- `saveSignatureImpl` + `saveSignature` tool definition + registration; threshold/crop/encode logic; name-collision suffix handling
- [x] `container/agent-runner/src/mcp-tools/documents.test.ts` -- bun:test coverage for the I/O matrix above (build a small real PNG fixture with a known ink-colored region on a white background, verify transparency + crop dimensions + written file)
- [x] `container/skills/document-memory/SKILL.md` -- document `save_signature`

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs, then all tests pass, including a real end-to-end decode→threshold→crop→encode→write test against a hand-built PNG fixture (not just a mocked pipeline).
- Given a real container build, when a signature image is saved via chat, then the returned confirmation names the exact saved path/slug and the resulting file, when inspected, has a transparent background and is cropped tighter than the source image.

## Spec Change Log

- 2026-08-17 (implementation, mechanism named by the spec's own Boundaries language but not spelled out): the Boundaries text says a name collision doesn't overwrite "unless the caller's request text made an explicit intent to replace" — since an MCP tool only sees args, not raw request text, an optional `replace: boolean` argument (default `false`) was added; the tool description instructs the agent to set it only when it has judged the user's message as an explicit replace/overwrite request. Not a Boundaries deviation — it's the concrete mechanism the frozen text implied but didn't name.

- 2026-08-17 (code review — blind-hunter/edge-case-hunter/verification-gap, 5 patch findings applied, rest deferred): a `name` consisting entirely of characters `slugify()` strips (Hebrew-only, emoji-only, punctuation-only) previously fell through silently onto `slugify`'s generic `"document"` fallback — a real violation of the frozen Boundaries' "no silent default" line, since a name genuinely was supplied but got discarded. Now declines with a clear error unless the trimmed input was literally the word "document" (control-tested so a real signature named "document" still saves normally). `replace: true`'s overwrite path now `lstatSync`-checks the destination first and refuses if it's a symlink, rather than following it and truncating whatever it points to (narrow but real gap — nothing in this tool's own arguments can currently plant such a symlink, but the write path shouldn't trust the filesystem state blindly either). A non-string `name` argument now gets its own explicit "name must be a string" message instead of being silently coerced into the generic "name is required" text. Two tests originally named `describe('save_signature — concurrent saves, same group')` were found (by the verification-gap lens) to not actually race — `saveSignatureImpl` has no internal `await`, so `Promise.all` calls run fully sequentially under Bun/Node's event loop, never interleaving — the tests were renamed to describe what they actually prove (sequential idempotent calls), and a new test genuinely forces the `writeSignaturePng` EEXIST-retry branch via a monkey-patched `fs.writeFileSync` on one specific candidate path, asserting the catch-and-retry logic actually ran. Added decode-failure and zero-byte-`.png` test coverage (code path was already correct, just untested). **Deferred, not fixed** (logged to `ARCHITECTURE-SPINE.md`'s Deferred section): no size/dimension bound on the synchronous threshold/crop loop for a large/hostile input PNG; no OKF concept file or `memory/index.md` entry for a saved signature (by design per this story's frozen storage shape — whether a future stamping story needs a lookup/listing mechanism is that story's open question, not this one's). **Verified independently**, not just self-reported: re-ran `cd container/agent-runner && bun test` (275 pass, 7 skip [pre-existing, unrelated soffice-gated tests], 0 fail) and `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (clean) myself after the patch round, before accepting the implementer's report.

## Design Notes

`pngjs`'s synchronous API (`PNG.sync.read(buffer)` / `PNG.sync.write(png)`) is well-established and widely used for exactly this kind of pixel-array manipulation — expect it to decode into a `{ width, height, data: Buffer }` shape (RGBA, 4 bytes/pixel, row-major) directly compatible with `encodePng`'s existing `Uint8Array` RGBA input, meaning the whole pipeline is: `PNG.sync.read` → mutate `data` in place (threshold) → compute bbox → slice into a new smaller buffer respecting the crop → `encodePng(croppedData, croppedWidth, croppedHeight)`. No intermediate library-specific image object needs to survive past the initial decode.

For the collision-suffix logic, rather than literally reusing `uniqueSlug` (which is `.md`-in-`memory/documents/`-specific), the cleanest fix per the Code Map note is to extract a small generalized helper (`uniqueName(dir, base, ext)`) that both `uniqueSlug` and the new signature path can call — avoiding a second hand-rolled `-2`/`-3` loop. This is a reasonable, spec-compatible internal refactor (not a Boundaries change) — implementer's call whether to extract now or duplicate the ~6-line loop; extracting is preferred if it's a clean, low-risk change.

Test fixture: build a small real PNG in the test file (a handful of ink-colored pixels — e.g. a 3x3 black square — inside a larger all-white canvas), matching this file's existing convention of hand-rolling minimal real fixtures (`buildDocx`, `buildMinimalPdf`) rather than binary blobs checked into the repo.

## Verification

**Commands:**
- `cd container/agent-runner && bun test` -- expected: all pass
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors
- `./container/build.sh build` -- expected: succeeds with `pngjs` installed (host-run verification after implementation)

## Suggested Review Order

- Start here -- entry point, validation, name-collapse decline, threshold/crop/write orchestration.
  [`documents.ts:798`](../../container/agent-runner/src/mcp-tools/documents.ts#L798)
- Threshold + bounding-box crop -- the core pixel logic.
  [`documents.ts:705`](../../container/agent-runner/src/mcp-tools/documents.ts#L705)
- Collision-suffix write, symlink-refusal on replace, EEXIST retry.
  [`documents.ts:754`](../../container/agent-runner/src/mcp-tools/documents.ts#L754)
- Generalized collision-suffix helper (also used by `uniqueSlug`).
  [`documents.ts:156`](../../container/agent-runner/src/mcp-tools/documents.ts#L156)
- Tool definition + registration.
  [`documents.ts:884`](../../container/agent-runner/src/mcp-tools/documents.ts#L884)
- Test suite -- start with the name-collapse-decline and EEXIST-forced-retry blocks, the two review-round additions worth the closest look.
  [`documents.test.ts:2117`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L2117), [`documents.test.ts:2339`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L2339)
- Agent-facing usage guide.
  [`SKILL.md`](../../container/skills/document-memory/SKILL.md)
