---
title: 'Read a Fact Shared by Another Agent Group'
type: 'feature'
created: '2026-08-31'
status: 'done'
review_loop_iteration: 1
context: []
baseline_commit: 'c89f362d20630bffeca0f8c3d57e89a81e3a61d6'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** NanoClaw's three agent groups (Yulanda, household, Tina) have fully isolated memory — a fact one bot learns never reaches another, so a user repeats themselves across bots by design.

**Approach:** One new container-side MCP tool, `read_shared_context`, reads any `memory/shared-facts.md` an operator has explicitly mounted read-only from another group (via the existing `ncl groups config add-mount`), scanning `/workspace/extra/*-shared/shared-facts.md`. A server-side guard closes the RW-by-default footgun on that specific mount convention.

## Boundaries & Constraints

**Always:** The grant is operator-configured only (`ncl groups config add-mount --ro`) — no self-service/agent-initiated grant. A `--container <path>` where **any path segment** ends in `-shared` (matching bare `<folder>-shared` as well as `<folder>-shared/<anything>` — not just a path containing a trailing `-shared/`) is always rejected unless `--ro` is also passed. `read_shared_context` only ever reads `shared-facts.md` files under `/workspace/extra/*-shared/`; it never reads any other mounted path. No grant, a grant with no file yet, a grant whose `shared-facts.md` is empty/whitespace-only, and a mount-security-rejected mount all return the identical "not shared" result — never an error, never fabricated content. Each returned shared section is capped at a fixed size (matching this codebase's existing size-cap precedent, e.g. `documents.ts`'s `MAX_INBOX_FILE_BYTES`) — a shared-facts file is scoped to durable facts and should never need to be large; an oversized one is truncated with a note, never silently dumped in full.

**Ask First:** None — this story's scope is fully specified by the epic/spine.

**Never:** No self-service or agent-initiated dynamic grants (out of scope, spine AD-2). No write path/tool for `shared-facts.md` in this story — a source group's agent edits it with its own normal file tools, same as any other memory `.md` file; there is no dedicated `save`/`write` MCP tool to build here. No digest/federation across domains (that's Epic 2, Story 2.4). No push/proactive notification.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Grant exists, file present | One `/workspace/extra/<folder>-shared/shared-facts.md` mount, file has content | Tool returns that content, labeled with the source folder name | N/A |
| Multiple grants | Two or more `*-shared/shared-facts.md` mounts present | Tool returns each one's content, each labeled by its own source folder name | N/A |
| No grant at all | No `/workspace/extra/*-shared/` directory exists | Clean "not shared with you" result | Never an error |
| Grant exists, file not yet written | `/workspace/extra/<folder>-shared/` exists but `shared-facts.md` is missing | Same clean "not shared" result as no grant | Never an error, never distinguished from the no-grant case |
| Grant rejected by mount-security | Operator's `add-mount` call was rejected (bad allowlist match, blocked pattern, etc.) — no mount ever materializes | Same clean "not shared" result (the tool sees nothing, same as no grant) | Operator diagnoses via the existing mount-security `WARN` log in `nanoclaw.error.log` — no new diagnostic in this tool |
| `add-mount` called for a `*-shared/` path without `--ro` | `ncl groups config add-mount --container household-shared/shared-facts.md --host ...` (no `--ro`) | Handler throws, mount is never written to `additional_mounts` | Clear error naming the requirement |
| `add-mount` called for a `*-shared/` path with `--ro` | Same call, `--ro` included | Handler proceeds exactly as it does today for any other mount | N/A |
| `add-mount` for a non-`*-shared/` path, no `--ro` | Any other existing use of `add-mount` (e.g. household's `people.md` mount) | Unchanged — the new guard only fires on the `*-shared/` convention | N/A |
| `add-mount` called with `--container <folder>-shared` (bare, no trailing filename), no `--ro` | e.g. `--container household-shared` | Handler throws, same as the `.../shared-facts.md` case — a bare `-shared` directory mount is caught too, not just one with a trailing slash | Clear error naming the requirement |
| `shared-facts.md` exists but is empty or whitespace-only | File present, zero meaningful content | Treated identically to "file not yet written" — the clean "not shared" result, not a section with an empty body | N/A |
| `shared-facts.md` exceeds the size cap | File larger than the fixed cap | Content is truncated to the cap with a note, never silently returned in full | N/A |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/shared-context.ts` -- NEW FILE. `read_shared_context` `McpToolDefinition`, no required arguments. Scans `/workspace/extra/` for entries matching `*-shared`, and for each one checks `<entry>/shared-facts.md`; returns the content of every file found, labeled by source folder name (the `*-shared` suffix stripped). Returns the clean "not shared" text when nothing is found. Mirror `calendar.ts`'s `ok()`/`err()` local helpers (lines 122-128) and end-of-file `registerTools([...])` call. **Revised in review_loop_iteration 1**: (a) skip a file whose trimmed content is empty — treat identically to a missing file, don't emit a section with an empty body; (b) cap each file's content at a fixed `MAX_SHARED_FACTS_CHARS` (pick a generous-but-real value, e.g. 20_000 — this file is meant to hold durable facts, never a document dump), truncating with a trailing note (`"…truncated"`) if exceeded; (c) add one code comment cross-referencing the `-shared`/`WORKSPACE_EXTRA_DIR` constants against `src/cli/resources/groups.ts`'s independent regex and `src/modules/mount-security/index.ts`'s `/workspace/extra/` prefix (different runtimes, can't share an actual constant — the comment is the drift-prevention mechanism per spine AD-5's convention).
- `container/agent-runner/src/mcp-tools/types.ts` -- `McpToolDefinition` type, reused unchanged.
- `container/agent-runner/src/mcp-tools/server.ts:24-33` -- `registerTools()`, reused unchanged; no changes here.
- `container/agent-runner/src/mcp-tools/index.ts:8-15` -- barrel; add one line, `import './shared-context.js';`, alongside the existing 7.
- `container/agent-runner/src/mcp-tools/scheduling.instructions.md` -- sibling `.instructions.md` precedent to mirror (not a full `container/skills/<name>/` directory — this is a single small tool, matching `scheduling`/`self-mod`'s lighter convention, not `calendar`/`documents`' full-skill convention).
- `src/cli/resources/groups.ts:554-588` -- `config add-mount` handler. Guard clause right after `containerPath` is parsed, before the `mount` object is built: if `containerPath` matches `/(^|\/)[^/]+-shared(\/|$)/` (any path segment ending in `-shared` — catches both a bare `<folder>-shared` and `<folder>-shared/<anything>`, not just a path with a trailing `-shared/`) and `!isReadonly`, throw a clear error naming the requirement. `config remove-mount` is unaffected — removal never needs the check. **Revised in review_loop_iteration 1**: the original `/-shared\//` regex required a trailing slash, so a bare `--container household-shared` (no filename) silently bypassed the guard entirely — see Spec Change Log.
- `src/modules/mount-security/index.ts:274-298,312-389,396-438` -- read-only reference. Confirms `readonly: false` is the CLI's actual default (line 579 in groups.ts: `Boolean(args.ro || args.readonly)`) and that a validated mount lands at `/workspace/extra/${containerPath}` (line 416) — no change needed here, this story's guard lives entirely in the CLI handler, one layer up.
- `eval/setup.ts:142-144` -- existing precedent for the exact containerPath shape (`'household-shared/people.md'`) this story's `*-shared/<filename>` convention already matches — reference only, no change.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/src/mcp-tools/shared-context.ts` -- create `read_shared_context` tool per Code Map -- core capability
- [x] `container/agent-runner/src/mcp-tools/index.ts` -- add barrel import -- wires the new tool into the running MCP server
- [x] `container/agent-runner/src/mcp-tools/shared-context.instructions.md` -- new sibling instructions file telling the agent when/how to call `read_shared_context` (mirrors `scheduling.instructions.md`'s tone/length) -- agent needs to know this tool exists and what it's for
- [x] `src/cli/resources/groups.ts` -- add the `*-shared/` + `--ro` guard clause to `config add-mount`'s handler -- closes the RW-by-default footgun in code, not just documentation
- [x] `container/agent-runner/src/mcp-tools/shared-context.test.ts` -- unit tests for every I/O Matrix row (grant+file, multiple grants, no grant, grant-no-file, path construction) -- `bun test`
- [x] `src/cli/resources/groups.test.ts` -- unit tests for the new guard clause (rejects `*-shared/` without `--ro`, allows it with `--ro`, doesn't affect non-`*-shared/` mounts) -- `pnpm test`
- [x] `src/cli/resources/groups.ts` -- **review_loop_iteration 1**: broaden the guard regex per the revised Code Map entry (any `-shared` path segment, not just a trailing `-shared/`) -- closes a real RW-mount bypass on a bare `<folder>-shared` containerPath
- [x] `src/cli/resources/groups.test.ts` -- **review_loop_iteration 1**: add a test for `--container <folder>-shared` (bare, no filename) without `--ro` -- covers the bypass the broadened regex fixes
- [x] `container/agent-runner/src/mcp-tools/shared-context.ts` -- **review_loop_iteration 1**: skip empty/whitespace-only `shared-facts.md` content (treat as not-written); cap returned content at `MAX_SHARED_FACTS_CHARS`, truncating with a note; add the cross-reference comment per the revised Code Map entry
- [x] `container/agent-runner/src/mcp-tools/shared-context.test.ts` -- **review_loop_iteration 1**: add tests for empty/whitespace-only file, and for the size cap/truncation
- [x] `container/agent-runner/src/mcp-tools/shared-context.test.ts` -- **review_loop_iteration 1**: add one test calling the real exported `readSharedContext.handler` (not just `readSharedContextImpl`) against `WORKSPACE_EXTRA_DIR`, asserting the constant equals `/workspace/extra` (the real path mount-security actually uses) -- closes a coverage gap where the wiring-level constant itself was never exercised
- [x] `container/agent-runner/src/mcp-tools/shared-context.instructions.md` -- **review_loop_iteration 1**: state the exact expected shape (`<folder>-shared/shared-facts.md`) so an agent/operator troubleshooting a missing expected fact can tell "nothing shared" apart from "shared under the wrong name"
- [x] `container/agent-runner/src/mcp-tools/shared-context.ts` -- **round 2 patch**: surrogate-safe truncation (`Array.from(...)` instead of raw `.slice()`); `inputSchema.additionalProperties: false`
- [x] `container/agent-runner/src/mcp-tools/shared-context.test.ts` -- **round 2 patch**: astral-character truncation test
- [x] `container/agent-runner/src/mcp-tools/shared-context.instructions.md` -- **round 2 patch**: mention the truncation note

**Acceptance Criteria:**
- Given a mounted `/workspace/extra/household-shared/shared-facts.md` with real content, when `read_shared_context` runs, then it returns that content labeled `household`
- Given two mounted `*-shared/shared-facts.md` paths, when `read_shared_context` runs, then both are returned, each correctly labeled
- Given no `/workspace/extra/*-shared/` directory exists, when `read_shared_context` runs, then it returns the clean "not shared with you" result, not an error
- Given a `/workspace/extra/<folder>-shared/` directory exists but has no `shared-facts.md` inside, when `read_shared_context` runs, then it returns the same clean "not shared" result as the no-grant case
- Given `ncl groups config add-mount --container household-shared/shared-facts.md --host <path>` with no `--ro`, when the handler runs, then it throws before writing anything to `additional_mounts`
- Given the same call with `--ro`, when the handler runs, then it succeeds exactly as `add-mount` already does for any other path today
- Given `ncl groups config add-mount` for a path that does not match `*-shared/` (e.g. the existing `household-shared/people.md` eval precedent, or any unrelated mount), when the handler runs without `--ro`, then it is unaffected by this story's new guard — behavior is unchanged from today
- Given `ncl groups config add-mount --container household-shared --host <path>` (bare, no filename) with no `--ro`, when the handler runs, then it throws, same as the `.../shared-facts.md` form
- Given a mounted `shared-facts.md` that is empty or whitespace-only, when `read_shared_context` runs, then it returns the clean "not shared" result, not a section with an empty body
- Given a mounted `shared-facts.md` larger than the size cap, when `read_shared_context` runs, then the returned content is truncated with a note, never the full oversized content

## Spec Change Log

- **review_loop_iteration 1** (bad_spec, from blind-hunter + edge-case-hunter review of the first implementation pass): the original guard regex (`/-shared\//`, requiring a trailing slash) silently let a bare `--container <folder>-shared` (no filename) land as a read-write mount — the exact footgun this story exists to close, just missed at the boundary. Amended the frozen Boundaries/I-O-Matrix to require the broader "any path segment ending in `-shared`" match, and to specify empty-file and size-cap handling that the first pass's implementer correctly built to spec but the spec itself hadn't asked for. **KEEP**: the overall tool design (scan `/workspace/extra/*-shared/`, label by source folder, one uniform "not shared" result), the `ok()`/`err()` + `registerTools()` mirroring of `calendar.ts`, the `readSharedContextImpl(extraDir)` injectable-base test pattern, and the CLI guard's placement in `config add-mount` right after `containerPath` parsing — none of that was wrong, only the regex's precision and two missing edge-case behaviors. Known-bad state avoided: an operator could believe `--ro` is enforced for every shared-context mount when a bare-directory form silently bypassed it.

- **Round 2 (patch-only, applied directly, no further loopback):** a second 3-layer review pass against the fixed diff found only low-severity items — two were cheap, real bugs fixed directly without another spec amendment: (1) truncation sliced by raw UTF-16 index, which could split an astral character's surrogate pair at the cutoff — now slices via `Array.from(...)`; (2) `read_shared_context`'s `inputSchema` lacked `additionalProperties: false`, silently accepting stray arguments — added. `shared-context.instructions.md` also gained a line about the 20,000-char truncation note. Everything else round 2 found (an empty-prefix `-shared` regex edge, a nested-path false-positive on the write-guard, case-sensitivity mismatch, no cross-`additional_mounts`-write-path defense-in-depth, no migration/audit script, no aggregate cap across grants) was logged to `deferred-work.md` as genuinely low-likelihood or low-severity — not worth a third loopback on an already narrow, well-tested surface.

## Design Notes

**Tool argument shape (a genuine implementation choice the spine left open):** `read_shared_context` takes no required arguments. It scans `/workspace/extra/` for any `*-shared` directory (there may be zero, one, or several, depending on how many grants an operator has configured into this group) rather than requiring the agent to name a specific source group up front — the agent usually doesn't know in advance which groups have shared anything. This directly satisfies the "clean not-shared result" requirement for the zero-match case without a separate error path.

**No new dependency:** directory scanning uses `fs.readdirSync`/`fs.existsSync`, already used elsewhere in this file tree — no glob library needed.

**Deliberately not building in this story:** a `save_shared_context`/write tool. `memory/shared-facts.md` is written by a source group's agent using its own ordinary file-editing tools, the same way every other per-group memory `.md` file is maintained today — there is no dedicated MCP tool for it, so there is nothing to guard with a file lock in this story. (The architecture spine's AD-3 mentions lock-guarded writes; that applies only if/when a dedicated write path is ever built. Flagging this explicitly rather than either inventing an unnecessary lock mechanism with no real callsite, or silently dropping the spine's note.)

## Verification

**Commands:**
- `cd container/agent-runner && bun test src/mcp-tools/shared-context.test.ts` -- expected: all new tests pass
- `cd container/agent-runner && bun run typecheck` -- expected: clean (or `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from root)
- `pnpm test -- groups.test.ts` -- expected: all new + existing `add-mount` tests pass
- `pnpm exec tsc --noEmit -p .` -- expected: clean

**Manual checks (if no CLI):**
- Read the final `shared-context.instructions.md` for tone/length consistency with `scheduling.instructions.md`

## Suggested Review Order

**Security guard — the RW-mount footgun this story exists to close**

- Entry point: the write-side guard, tightened once already after review caught a regex gap.
  [`groups.ts:582`](../../src/cli/resources/groups.ts#L582)

- Guard fires on any `-shared` path segment, not just one with a trailing slash — closes the bare-`<folder>-shared` bypass.
  [`groups.ts:583`](../../src/cli/resources/groups.ts#L583)

**Read tool — the new capability**

- Core scan: reads every mounted `*-shared/shared-facts.md`, skips missing/empty content, one uniform result on empty.
  [`shared-context.ts:69`](../../container/agent-runner/src/mcp-tools/shared-context.ts#L69)

- Empty/whitespace content treated identically to "not written yet" — never an empty-bodied section.
  [`shared-context.ts:98`](../../container/agent-runner/src/mcp-tools/shared-context.ts#L98)

- Size cap with surrogate-pair-safe truncation (fixed after review found raw `.slice()` could split an astral character).
  [`shared-context.ts:105`](../../container/agent-runner/src/mcp-tools/shared-context.ts#L105)

- Tool definition: no-argument schema, `additionalProperties: false` so a stray model argument is never silently swallowed.
  [`shared-context.ts:121`](../../container/agent-runner/src/mcp-tools/shared-context.ts#L121)

**Wiring**

- One-line barrel import — the only change needed to bring the tool into the running MCP server.
  [`index.ts:16`](../../container/agent-runner/src/mcp-tools/index.ts#L16)

**Peripherals — tests and docs**

- Guard test matrix: rejects bare `<folder>-shared` without `--ro`, allows the real production `household-shared/people.md` shape with `--ro`.
  [`groups.test.ts:283`](../../src/cli/resources/groups.test.ts#L283)

- Astral-character truncation test, added after review flagged the surrogate-pair gap.
  [`shared-context.test.ts:158`](../../container/agent-runner/src/mcp-tools/shared-context.test.ts#L158)

- Agent-facing instructions: exact expected shape, speculative-call guidance, truncation-note explanation.
  [`shared-context.instructions.md:5`](../../container/agent-runner/src/mcp-tools/shared-context.instructions.md#L5)
