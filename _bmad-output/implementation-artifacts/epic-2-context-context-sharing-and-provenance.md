# Epic 2 Context: Provenance & Receipts for Automated Actions

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A user can always ask "why did this happen" — for a reminder that fired, a self-mod change that applied, or a document that got written — and get a real, trustworthy answer instead of having to reconstruct it from memory. Every automated system action records a retrievable one-line trigger and requester at the moment it's created, never reconstructed after the fact. Standalone: usable the moment it ships, independent of Epic 1 (different files, different domain) — none of its three source stories depend on each other either, since each touches a distinct domain's own files; only the digest story (2.4) depends on the other three having shipped their own retrieval surfaces first.

## Stories

- Story 2.1: Task/Reminder Provenance
- Story 2.2: Self-Mod Change Provenance
- Story 2.3: Document Write Provenance
- Story 2.4: On-Demand Cross-Domain Digest

## Requirements & Constraints

- Every task/reminder created (via `ncl tasks create`, whether from an agent's chat turn or the CLI directly) captures a provenance record at creation time, retrievable on demand; fixed at the series' original creation and unchanged across recurrence fires (FR4).
- Every self-mod change (`add_calendar`, `install_packages`, `add_mcp_server`) records a provenance line at apply time, retrievable by reading the log; the agent cannot tamper with it — enforced by mounting the log read-only into its own container (FR5).
- Every document fill/refresh write can carry an optional provenance record on its version-history entry, surfaced by the existing version-listing tool (FR6).
- A user can ask "what have you automated recently and why" and get one on-demand summary federating provenance across tasks, self-mod, and documents — pull-only, no periodic/proactive push (FR7).
- Every write to the self-mod log is lock-guarded/atomic — no unguarded read-then-overwrite on a file concurrent sessions could race on (NFR2).
- The self-mod log is capped at a fixed entry count, not unbounded growth (NFR3).
- No provenance is backfilled — only tasks/self-mod changes/document writes made after this ships carry a provenance record; pre-existing records/entries remain valid and are read as simply absent of it (NFR4).
- Real test coverage required on both host (`pnpm test`) and container (`bun test`) trees for every story (NFR5).
- No new runtime dependencies — composes entirely on libraries/tables/conventions already in the dependency tree (NFR6).
- Success signal requires live demonstration against the running system (not just tests): a real task, self-mod change, and document write must each show a correct trigger+requester when the user asks "why."

## Technical Decisions

- **One provenance shape everywhere (AD-7):** `{ triggeredBy: 'user' | 'agent' | 'system', requesterUserId?: string, message?: string, reason?: string, at: string /* ISO-8601 UTC */ }`. Every domain writes this exact shape — no per-domain variant. `requesterUserId` is additive and resolved from session/user context when available; it never duplicates a domain's own pre-existing session-identifying field.
- **Task provenance (AD-8):** Additive on `messages_in.content.provenance` (the `kind='task'` row), alongside pre-existing `prompt`/`script`/`originSessionId`. `originSessionId` remains the task's session-identifying field — `provenance.requesterUserId` does not replace it. Defined as the series' *original creation* provenance (why the series exists); `insertRecurrence` copies `content` verbatim, so provenance is deliberately unchanged across every recurrence fire — this is defined scope, not a bug. "What happened on this specific firing" is a separate concern, answered by the pre-existing `run-log.ts`/`task_log` entry for that run; a full why-answer for one firing combines both. No backfill.
- **Self-mod provenance (AD-9):** A new file, `groups/<folder>/self-mod-log.md`, one line appended per apply by `src/modules/self-mod/apply.ts` (`applyAddCalendar` and siblings `install_packages`, `add_mcp_server`), host-side only. Same file-per-group markdown-log style already established by `run-log.ts` for tasks. Capped at a fixed entry count (`SELF_MOD_LOG_CAP`, same role as `FillHistoryEntry`'s `FILL_HISTORY_CAP`), oldest trimmed first. Guarded by the same `withLock`/atomic-write discipline as the sibling shared-facts file. Mounted **read-only** into its own group's container (same convention already used for `CLAUDE.md`/`container.json`) — the host apply handler is its sole legitimate writer. **Deliberate deviation from SPEC.md's literal wording** ("reuse `pending_approvals`"): `pending_approvals` is shared infrastructure used by every approval-gated action system-wide and is deleted on resolve — retaining rows there would widen its blast radius, so this reuses the *pattern* (`run-log.ts`-style file-per-group log) instead. `pending_approvals` itself stays unchanged, still deleted on resolve for every action type including self-mod. No backfill.
- **Document provenance (AD-10):** One additive optional field, `provenance` (AD-7 shape), on `FillHistoryEntry`, captured at write time by `fillOneDocument` and the `save_document` refresh path. Entries without it remain valid per `readFillHistory`'s existing tolerant-reader/backward-compat handling (same pattern already used for pre-`kind` entries). No backfill.
- **Retrieval is pull-only, ships now (AD-11):** `list_document_versions` renders `provenance` when present; a task's provenance surfaces via `ncl tasks get`; self-mod's via reading `self-mod-log.md`. A periodic/proactively-pushed digest is explicitly out of scope for this spec — only the on-demand federated digest (AD-14) ships.
- **On-demand digest (AD-14):** One new query surface (`ncl tasks` extension, MCP tool, or CLI verb — the implementation choice is deferred to whichever story builds it, i.e. Story 2.4) reads across all three domains' provenance and returns one federated summary. Must handle a domain with no provenance to show by saying so plainly, not erroring or silently omitting it.
- No new communication path, table, or IPC channel (AD-1): all writes land in existing storage (`messages_in.content`, `groups/<folder>/*.md`, `FillHistoryEntry`).
- **Rebuild/restart implications:** the host-side changes this epic makes (`src/cli/resources/tasks.ts` for AD-8, `src/modules/self-mod/apply.ts` for AD-9) need `pnpm run build` + a service restart to take effect — a container-only rebuild does nothing for them. This is a separate rebuild path from any container-side work in the sibling Epic 1 (CAP-1); a change touching both epics' surfaces needs both paths run.

## Cross-Story Dependencies

- Stories 2.1, 2.2, and 2.3 are independent of each other — each touches a distinct domain's own files (tasks, self-mod log, document history) and can ship/be worked in any order.
- Story 2.4 depends on 2.1, 2.2, and 2.3 having each shipped their own retrieval surface first, since the digest reads across all three (`content.provenance`, `self-mod-log.md`, `FillHistoryEntry.provenance`) rather than producing new data itself.
- Epic 2 as a whole is independent of Epic 1 (Cross-Group Context Sharing) — different files, different domain, no shared code path.
