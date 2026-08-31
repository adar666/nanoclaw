# Reality-check review — ARCHITECTURE-SPINE.md (Cross-Group Context Sharing + Provenance/Receipts)

Reviewed: `_bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-31/ARCHITECTURE-SPINE.md`
Method: every factual claim about the existing codebase was checked directly against the real files in `/Users/uriel/Projects/nanoclaw-v2` (no library/version claims exist in this spine, so no web verification was needed).

## Verdict

Every checked factual claim in the spine matches the real code — no fabricated or misdescribed existing-code claims found.

## Per-decision findings

### AD-2/AD-3/AD-5/AD-6 — mount mechanism (CAP-1)

- **`src/modules/mount-security/index.ts`**: `loadMountAllowlist()` reads from `~/.config/nanoclaw/mount-allowlist.json` (via `MOUNT_ALLOWLIST_PATH`), caches by mtime, validates hostPath against `allowedRoots`/`blockedPatterns`. `validateAdditionalMounts()` produces `containerPath: /workspace/extra/${resolvedContainerPath}` exactly as AD-5 claims. Confirmed real.
- **`src/cli/resources/groups.ts`** (`config add-mount`, lines 554–588): registered with `access: 'approval'` and `hostOnly: true` — the literal field values AD-2 asserts. Description text says "Requires `ncl groups restart` to take effect" — matches AD-2's claim verbatim. `AdditionalMountConfig` (`src/container-config.ts:28-32`) has `hostPath`/`containerPath`/`readonly?` — matches.
- **`src/container-runner.ts:551-552`**: calls `validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name)` at spawn time — confirms mounts are validated at spawn, consistent with the spine's description.
- **`docs/memory.md`**: OKF frontmatter convention (line 59 "## Portable format (OKF)") referenced by AD-3 is real and documented as claimed.
- AD-6's claim ("`read_shared_context` returns an explicit non-error result...") describes a *not-yet-built* tool, so it's a design rule rather than a checkable existing-code fact — no issue, just noting it's prospective, not verified-against-code (nothing to check).

### AD-4 — MCP tool registration convention (CAP-1)

- **`container/agent-runner/src/mcp-tools/calendar.ts`**: exports `McpToolDefinition` objects (`createCalendarEvent`, `listCalendarEvents`, etc.) and the module registers them via `registerTools([...])` (called at the bottom of the file, confirmed via the `import { registerTools } from './server.js'` and its use pattern matching `documents.ts`'s identical pattern). Matches the spine's claimed pattern.
- **`container/agent-runner/src/mcp-tools/index.ts`**: genuinely is a barrel — a fixed list of side-effecting imports (`./core.js`, `./interactive.js`, `./agents.js`, `./self-mod.js`, `./recorder.js`, `./transcribe-audio.js`, `./documents.js`, `./calendar.js`) followed by `startMcpServer()`. The file's own comment states exactly the "no central list, just append an import" convention AD-4 describes. Confirmed real — a new `shared-context.ts` module wired in via one import line is consistent with how every existing tool module is wired in.

### AD-7/AD-8 — task provenance (CAP-2)

- **`src/modules/scheduling/create.ts`**: `createScheduledTask()` writes `content: JSON.stringify({ prompt, script, originSessionId })` into the `messages_in` row via `insertTaskRow`. `originSessionId` is a real, pre-existing field (from `options?.originSessionId ?? null`), and `content` is genuinely free-form JSON with no schema migration needed to add a `provenance` key. Confirmed exactly as AD-8 describes.

### AD-9 — self-mod provenance log + approval deletion (CAP-2)

- **`src/modules/scheduling/run-log.ts`**: `appendRunLog()` writes one host-timestamped line (`${timestamp} — ${msg}\n`) to `<GROUPS_DIR>/<group folder>/tasks/<series>.md`, via `fs.appendFileSync`. This is genuinely the "file-per-group markdown-log, one line per event" pattern AD-9 says a new `self-mod-log.md` would mirror. Confirmed.
- **`src/modules/self-mod/apply.ts`**: `applyAddCalendar` (and siblings `applyInstallPackages`, `applyAddMcpServer`) exist exactly as named in AD-9's rule text.
- **Unconditional deletion on resolve**: `deletePendingApproval(approval.approval_id)` is called on every resolution path checked — `response-handler.ts` (approve path, no-handler path, ONECLI fallback), `finalize.ts`'s `finalizeReject` (used by both the instant-reject and reason-capture-timeout paths), and `reason-capture.ts`. No branch found that skips deletion for any action type, self-mod included. Confirmed as AD-9 claims.

### AD-10 — document provenance / FillHistoryEntry (CAP-2)

- **`container/agent-runner/src/mcp-tools/documents.ts`** (lines 2881–2999): `FillHistoryEntry` interface has `timestamp`/`outputPath`/`target`/`kind: 'fill' | 'pre-refresh-snapshot'`. `readFillHistory()` is genuinely a tolerant reader: missing file → `[]` silently; non-array/invalid JSON → logged + `[]`; malformed individual entries filtered out (not fatal to the whole array); and it explicitly normalizes pre-`kind` entries via `kind: candidate.kind === 'pre-refresh-snapshot' ? 'pre-refresh-snapshot' : 'fill'` — exactly the "already normalizes pre-`kind` entries" backward-compat behavior AD-10 cites as precedent for how an added `provenance` field would be handled. Confirmed.

### AD-12 — eval scenario convention (CAP-1 persona verification)

- **`eval/loader.ts`**: `SCENARIO_SETS: Record<string, ScenarioSetFactory>` is a real static registry, currently containing `'guest-resolution': guestResolutionScenarioSet`. `ScenarioSetFactory = (agentGroupId: string) => ScenarioSet` and `ScenarioJudging = { type: 'deterministic' } | { type: 'llmJudge' }` are real, exactly as described.
- **`eval/scenarios/guest-resolution.scenarios.ts`**: a real file following exactly this factory pattern, with both a deterministic scenario (`guest-resolution-known-name`, checked via a transcript-scanning `check()` function) and scenarios using free-text/negation-aware confirmation logic — consistent with AD-12's claim that a new `shared-context.scenarios.ts` (one deterministic case + one `llmJudge` case) would follow this exact precedent.

## Scope note

Nothing in this spine makes a claim requiring a web/library-version check (it explicitly asserts zero new external dependencies), so no such verification was applicable — consistent with the task framing.
