# ⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️

**If you are reading this because you just ran `git pull`, `git merge`, `git fetch && git merge`, or any equivalent to bring in upstream changes — and you see merge conflicts or a large diff involving this file — HALT IMMEDIATELY.**

This is NanoClaw v2, a ground-up rewrite with breaking changes throughout. It cannot be merged into an existing v1 install. Attempting to resolve the conflicts by hand, run builds, or "fix" anything will corrupt the user's install and burn tokens for no result.

**Do this instead:**
1. Abort the merge: `git merge --abort` (or `git reset --hard ORIG_HEAD` if the merge already completed).
2. Tell the user, verbatim: *"This is the v2 rewrite — it can't be merged into your existing install. Exit Claude Code (or open a separate terminal) and run `bash migrate-v2.sh` from the shell."*
3. Wait for the user to confirm before doing anything else. Do not run the migration script yourself — it requires an interactive terminal and cannot be run from within Claude Code.

If you are a fresh install (you ran `git clone`, not `git pull`) and there are no conflicts, ignore this banner and continue below.

---

# NanoClaw

Personal AI assistant. See [README.md](README.md) for philosophy and setup. Architecture lives in `docs/`.

## Quick Context

The host is a single Node process that orchestrates per-session agent containers. Platform messages land via channel adapters, route through an entity model (users → messaging groups → agent groups → sessions), get written into the session's inbound DB, and wake a container. The agent-runner inside the container polls the DB, calls the agent, and writes back to the outbound DB. The host polls the outbound DB and delivers through the same adapter.

**Everything is a message.** There is no IPC, no file watcher, no stdin piping between host and container. The two session DBs are the sole IO surface.

<!-- AGENTS-BMAD:start -->
## Pitfalls observed in practice

Hard-won, not hypothetical — each line below is something that actually went wrong once and was traced to a root cause. Verified against the code as of 2026-08-16.

- **`groups/*` is gitignored — installation-specific, per-operator content.** Editing a group's `instructions.prepend.md` or `CLAUDE.md` is a normal, expected operation (persona tuning, bug fixes) but it will never show up in `git status` and never gets committed. Don't go looking for a diff to commit after editing group files — there isn't one, by design. (`.gitignore:15`.)

- **Never call `getUpdates` directly against the Telegram Bot API (cloud or the local `telegram-bot-api` server) while the host service is running.** Telegram allows exactly one `getUpdates` consumer per bot token — a second caller triggers `Conflict: terminated by other getUpdates request` and knocks the real bot offline for the exponential-backoff duration (up to ~30s, compounding on repeated interference). Diagnose inbound-message issues via `logs/nanoclaw.log`/`nanoclaw.error.log` and, if a local `telegram-bot-api` container is running, its own `docker logs` — never by polling the API yourself.

- **A host-side TS change (`src/**`) needs `pnpm run build` + a service restart (`launchctl kickstart -k gui/$(id -u)/<service-label>` on macOS) to take effect — a container rebuild does nothing for it.** A container-side change (`container/agent-runner/src/**`, `container/skills/**`) needs `./container/build.sh` + the same service restart — a host-only rebuild does nothing for it. Two separate rebuild+restart paths; changing one side and only restarting for the other is a real, easy-to-make mistake. **Correction found live (2026-08-16):** on an install with `NANOCLAW_HARDENED_IMAGE=true` (`.env`), `container/agent-runner/src` is bind-mounted read-only into the container at spawn time (`src/container-runner.ts`'s `/app/src` mount) — a plain TS source edit under that path needs neither a rebuild nor a service restart, only a fresh container spawn (which happens automatically on the next inbound message once no container is currently running for that group). `./container/build.sh` on a hardened install only re-applies the CLI-tools overlay; it does NOT rebuild `/app/node_modules` unless `container/agent-runner/bun.lock` actually changed (see the script's own `OVERLAY`/lock-SHA check). Don't assume a rebuild was necessary — or that one actually happened — without checking which mode the install is in.

- **A group wiring's `engage_pattern` has a special sentinel most operators don't expect: the literal string `.` means "always engage," everything else is a real regex tested against the message text.** Found live (2026-08-16): a Telegram group wired with `engage_mode: 'pattern'`, `engage_pattern: '^\.'` (require an explicit leading dot — normal for a multi-person group chat that shouldn't respond to every message) combined with `ignored_message_policy: 'drop'` silently discarded a bare audio-file attachment sent with no caption — its `text` is `''`, which fails `^\.` (or almost any real pattern), and 'drop' means a non-engaging message never reaches `inbound.db` at all, attachment included. The identical scenario in a DM worked fine, because DM wirings conventionally use the literal `.` sentinel (always engage), which is exempt. `ignored_message_policy: 'accumulate'` is the fix for a pattern-gated wiring where this matters — it stages the message (and any attachment, via `writeSessionMessage → extractAttachmentFiles`) as silent context even when it doesn't itself trigger a wake, so a later engaging message (".process the file I just sent") has something to reference; `router.ts`'s own code comment on that branch explains why. `scripts/audit-attachment-drop-risk.ts` flags any wiring with this combination — run it after creating or reconfiguring a group wiring with a non-`.` pattern.

- **An unawaited call to a `void | Promise<void>`-typed callback is invisible until the callee is slow.** `createPairingInterceptor` in `src/channels/telegram.ts` called `hostOnInbound(...)` without `await` on every early-return path — legal TypeScript, silent at runtime, harmless for a fast text message. It became a real bug — a message silently never reaching `inbound.db`, nothing logged anywhere — the moment the real work behind that callback got slow enough (a large attachment's base64 decode + disk write) for the premature resolution to matter. Fixed in `c09f1c5`, regression-tested with a controllable deferred promise. When a function is typed to *possibly* return a promise, treat it as always doing so and await it.

- **A per-group `instructions.prepend.md` can silently override or shadow a newly-shipped capability.** A group's existing persona text (e.g. "files route to a private log, checked only in a nightly sync") can generalize past what it originally meant to cover once a new tool is wired in for a case it didn't anticipate (e.g. audio files) — the agent trusts its older, more specific-sounding persona text over a capability it was just told about in the same context. When adding a new per-group capability, check the group's own `instructions.prepend.md` for language that might already (wrongly) claim to cover it.

- **Diagnostic `log.info()` calls added for live debugging must be reverted before considering a fix "done."** And: an "intermittent" bug report is worth checking against non-code causes (stale agent persona/instructions, a service that needs a restart, a race with your own manual API calls) before assuming the newest code change is at fault — several of the pitfalls above were each mistaken for a different one before the real cause surfaced.

- **`markCompleted` on a message must wait for real evidence of forward progress, not just "we handed it to the model."** `container/agent-runner/src/poll-loop.ts`'s follow-up-push path used to call `markCompleted(keptIds)` immediately after `query.push(prompt)` — before the model had produced any `'result'` event addressing that content. A container killed between the push and the next result left the message permanently `'completed'` in `processing_ack`, so `host-sweep.ts`'s crash recovery (which only resets rows still `'processing'`) never saw anything to retry — the work vanished with zero trace. Fixed by accumulating pushed ids in `pendingFollowUpIds` and flushing them only on the next genuine `'result'` event. The general lesson: any status write meaning "done" needs to be backed by actual completion evidence, not just "we started it" — a launchd `kickstart` (or any restart) landing between those two points otherwise loses work silently.

- **A "wait for the next event to prove progress" fix needs its OWN abandonment path — a stream that never crashes but never produces that event either is not covered by crash recovery.** The `pendingFollowUpIds` fix above initially left a real gap, found by adversarial review the same night: if the stream ends non-crash-style (`query.abort()` from a slash-command interruption, or the SDK just closing it) before the awaited `'result'` ever arrives, the container stays alive — so `host-sweep`'s heartbeat-based claim-stuck check never fires (heartbeat keeps advancing on whatever the container does next; the check has a one-way latch: once `heartbeatMtimeMs > claimedAt` for a claim, it's blessed forever). The row sat `'processing'` indefinitely, invisible to every recovery path. Fixed by adding an explicit `releaseProcessing()` (deletes the `processing_ack` row outright) in `processQuery`'s `finally` block, so any never-flushed ids get released — picked up fresh on the very next poll — the instant the stream ends, rather than relying on a host-side heuristic that structurally can't see this case. A second, related finding from the same review: a follow-up's claim needs to be blessed (`touchHeartbeat()`) at push time too, or a follow-up pushed mid a long non-Bash tool call could trip the 60s claim-stuck tolerance and get a genuinely-healthy container killed — Bash tool calls already got a longer grace window from their declared timeout, nothing else did.

- **The exact ordering of "claim it" vs. "protect it" matters — an `await` between the two is a window where the protection doesn't exist yet.** A third finding on the same fix: `markProcessing(newIds)` ran before an `await applyPreTaskScripts(...)`, and only *after* that await did the surviving ids get added to `pendingFollowUpIds` (the array the `finally`-block release above covers). A stream ending during that await left the claimed ids in a blind spot — claimed, but not yet in the array that gets released. Fixed by moving the ids into `pendingFollowUpIds` immediately after the claim, before the await, and pulling back out only the ones a pre-task script explicitly resolves via its own ack. General lesson: when a fix adds "protect until an event proves X," audit every path that can *create* the thing needing protection — not just the one you had in mind when you wrote the fix — for a gap between "claimed" and "protected".

- **Don't assume a restart-timing coincidence means the process management is broken — check whether the *work itself* is resumable first.** When a live turn got cut short by a service restart, the instinct was "processes must never fall, and if they do they must resume invisibly" — but `host-sweep.ts` already provides exactly that for anything left in `'processing'`; the actual gap (see above) was that one code path marked its claim `'completed'` too early, opting itself out of a recovery mechanism that already existed and already worked for every other case.

- **`bun:test`'s `mock.module()` patches the module registry for the whole test process, not just the file that calls it.** A regression test that mocked `scheduling/task-script.js` to get deterministic control over an await-timing race broke three unrelated tests in `task-script.test.ts` (same process, ran later in suite order) that needed the real implementation. There's no per-file scoping/restore for it in this codebase's Bun version — either isolate a `mock.module()`-using test file's target module to something nothing else imports, or find a way to test the behavior without it. Caught by running the *full* `bun test` suite, not just the new file in isolation — this is exactly why the "run both suites" rule below says full suite, not just the file you touched.

- **A user reporting "the file didn't arrive" is not automatically an ingestion bug — check whether an attachment was actually present in the raw inbound message first.** Traced one such report all the way to the parsed Telegram payload (`@chat-adapter/telegram`'s `extractAttachments`, which only looks at `raw.photo`/`raw.video`/`raw.audio`/`raw.voice`/`raw.document` — no group/DM branching) and confirmed `attachments: []` with no gap in the surrounding message-id sequence: no file was ever attached to that message, regardless of what the accompanying text claimed. The real, fixable gap turned out to be persona-level: none of the three DM/group personas had guidance for "user says they sent a file but this message has no attachment marker at all" — the model fell back to whatever adjacent framing it had (sometimes wrong), instead of just saying plainly "I don't see an attachment on this message." Added that guidance to all three groups' persona fragments.

- **Don't trust the agent to always call a separate confirmation tool before a destructive action — fold the confirmation into the tool itself.** `delete_calendar_event`'s first version gated the real `DELETE` behind a `confirm: boolean` argument, with `SKILL.md` instructing the agent to always call `ask_user_question` and get a real yes/no before setting it — the same trust model this codebase already uses for disambiguation (AD-7-style: agent/persona behavior, not tool-level logic). A live request ("תמחק את בדיקת יומן") showed that trust doesn't hold: the agent treated the user's own delete instruction as sufficient confirmation and deleted the event with zero question ever shown — confirmed by reading the session's `outbound.db` directly (one inbound message, one outbound "deleted" reply, no `ask_question` card in between; `messages_out`/`messages_in` don't log MCP tool calls themselves, only the chat-facing effects, so this is the only place such a gap is visible after the fact). Fixed by having `delete_calendar_event`'s handler call `askUserQuestion.handler(...)` directly, in-process, once exactly one event is resolved — one structurally-blocking tool call, nothing left for the agent to skip or self-authorize past. A second, related finding on the same live retest: the question text is shown to the user *verbatim* via the card, unlike every other tool's output, which the agent re-narrates in its own reply — building that text from `formatEventLine`/the shared `formatLocalTime` helper leaked a raw Google event id and 12-hour time ("8pm") straight to the user, because the usual agent-rephrasing step (which is where 24h formatting was actually happening this whole time) never ran on it. Any tool that composes user-facing text for a blocking card, rather than returning data for the agent to narrate, needs its own presentation pass — reusing an agent-facing formatter isn't safe by default. See `container/agent-runner/src/mcp-tools/calendar.ts`'s `deleteCalendarEvent`/`formatConfirmationSummary`.

### Running and verifying

- `pnpm test` (host, vitest) and `cd container/agent-runner && bun test` (container, bun:test) are two separate suites on two separate runtimes — a green run of one says nothing about the other. Run both when a change touches both trees.
- `pnpm exec tsc --noEmit -p .` (host) and `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (container) are two separate tsconfigs — same split as above.
<!-- AGENTS-BMAD:end -->

## Entity Model

```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id)       — owner | admin (global or scoped)
agent_group_members (user_id, agent_group_id)    — unprivileged access gate
user_dms (user_id, channel_type, messaging_group_id) — cold-DM cache

agent_groups (workspace, memory, CLAUDE.md, personality, container config)
    ↕ many-to-many via messaging_group_agents (session_mode, engage_mode/engage_pattern, sender_scope, priority)
messaging_groups (one chat/channel on one platform; instance = adapter-instance name, defaults to channel_type; unknown_sender_policy)

sessions (agent_group_id + messaging_group_id + thread_id → per-session container)
```

Privilege is user-level (owner/admin), not agent-group-level. See [docs/isolation-model.md](docs/isolation-model.md) for the three isolation levels (`agent-shared`, `shared`, separate agents).

## Two-DB Session Split

Each session has **two** SQLite files under `data/v2-sessions/<session_id>/`:

- `inbound.db` — host writes, container reads. `messages_in`, delivered, destinations, session_routing.
- `outbound.db` — container writes, host reads. `messages_out`, processing_ack, session_state, container_state.

Exactly one writer per file — no cross-mount lock contention. Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update. Host uses even `seq` numbers, container uses odd.

## Central DB

`data/v2.db` holds everything that isn't per-session: users, user_roles, agent_groups, messaging_groups, wiring, pending_approvals, user_dms, chat_sdk_* (for the Chat SDK bridge), schema_version. Migrations live at `src/db/migrations/`.

For ad-hoc queries from skills or scripts, use the in-tree wrapper rather than the `sqlite3` CLI: `pnpm exec tsx scripts/q.ts <db> "<sql>"`. The host setup intentionally avoids depending on the `sqlite3` binary (`setup/verify.ts:5`); the wrapper goes through the `better-sqlite3` dep that setup already installs and verifies. Default-output format matches `sqlite3 -list` (pipe-separated, no header) so existing skill text reads identically.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: init DB, migrations, channel adapters, delivery polls, sweep, shutdown |
| `src/router.ts` | Inbound routing: messaging group → agent group → session → `inbound.db` → wake |
| `src/delivery.ts` | Polls `outbound.db`, delivers via adapter, handles system actions (schedule, approvals, etc.) |
| `src/delivery-guard.ts` | `DeliveryGuardSpec` + `runGuarded` — the guard-consult pipeline for privileged delivery actions (registry stays in `delivery.ts`) |
| `src/host-sweep.ts` | 60s sweep: `processing_ack` sync, stale detection, due-message wake, recurrence |
| `src/session-manager.ts` | Resolves sessions; opens `inbound.db` / `outbound.db`; manages heartbeat path |
| `src/container-runner.ts` | Spawns per-agent-group Docker containers with session DB + outbox mounts, OneCLI `ensureAgent` |
| `src/container-runtime.ts` | Docker CLI wrapper (runtime binary, host-gateway args, mount args), orphan cleanup |
| `src/guard/` | Privileged-action decision seam: `guard(action, input)` → allow \| hold \| deny. Module-edge `guard.ts` adapters (cli, agent-to-agent, self-mod, permissions) define each action's decision; ncl commands + delivery actions demand a guard at registration; approved replays carry the approval row as a grant and re-run the checks. Conformance test: `src/guard/conformance.test.ts` |
| `src/modules/permissions/access.ts` | `canAccessAgentGroup` — owner / global admin / scoped admin / member resolution against `user_roles` + `agent_group_members` |
| `src/modules/approvals/primitive.ts` | `pickApprover`, `pickApprovalDelivery`, `requestApproval`, approval-handler registry |
| `src/command-gate.ts` | Router-side admin command gate — queries `user_roles` directly (no env var, no container-side check) |
| `src/modules/approvals/onecli-approvals.ts` | OneCLI credentialed-action approval bridge |
| `src/modules/permissions/user-dm.ts` | Cold-DM resolution + `user_dms` cache |
| `src/group-init.ts` | Per-agent-group filesystem scaffold (CLAUDE.md, skills) — agent-runner source is a shared read-only mount, not copied per group |
| `src/db/container-configs.ts` | CRUD for `container_configs` table (per-group container runtime config) |
| `src/backfill-container-configs.ts` | Migrates legacy `container.json` files into the DB on startup |
| `src/container-restart.ts` | Kill + on-wake respawn for agent group containers |
| `src/db/` | DB layer — agent_groups, messaging_groups, sessions, container_configs, user_roles, user_dms, pending_*, migrations |
| `src/channels/` | Channel adapter infra (registry, Chat SDK bridge); specific channel adapters are skill-installed from the `channels` branch |
| `src/channels/channel-defaults.ts` | Wiring-creation helpers over adapter-declared channel defaults (`resolveWiringDefaults`, `resolveThreadPolicy`, engage validation) |
| `src/providers/` | Host-side provider container-config (`claude` baked in; `opencode` etc. installed from the `providers` branch) |
| `container/agent-runner/src/` | Agent-runner: poll loop, formatter, provider abstraction, MCP tools, destinations |
| `container/skills/` | Container skills mounted into every agent session (`agent-browser`, `document-memory`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `vercel-cli`, `welcome`; channel-specific skills like `slack-formatting` and `whatsapp-formatting` install with their channel) |
| `groups/<folder>/` | Per-agent-group filesystem (CLAUDE.md, skills) — agent-runner source is a shared read-only mount, not copied per group |
| `scripts/init-first-agent.ts` | Bootstrap the first DM-wired agent (used by `/init-first-agent` skill) |
| `scripts/skill-apply.ts` | Deterministic SKILL.md applier — executes `nc:` directive fences; declare/emit core, journaled + idempotent |
| `scripts/skill-directives.ts` + `scripts/skill-policy.ts` | `nc:` grammar parser + lint; UI-free driver policy derived from document structure (gate confirm, URL offer) |
| `setup/lib/skill-driver.ts` + `setup/channels/run-channel-skill.ts` | Setup wizard's skill consumer: clack rendering of engine events + the generic channel-install flow |
| `migrate-v2.sh` + `setup/migrate-v2/` | v1→v2 migration. Standalone script: `bash migrate-v2.sh`. Seeds DB, copies groups/sessions, installs channels, builds container, offers service switchover, then hands off to `/migrate-from-v1` skill for owner setup and CLAUDE.md cleanup. See [docs/migration-dev.md](docs/migration-dev.md). |
| `nanoclaw.sh --uninstall` + `setup/uninstall/` | Uninstall this copy only (slug-scoped): service, containers + image, `data/`, `logs/`, `groups/`, this copy's OneCLI agents. Confirms per group; `--dry-run` previews, `--yes` skips prompts. Other copies and the shared OneCLI app are untouched. Bypasses bootstrap entirely; `uninstall.sh` is a pointer that execs it. |

## Admin CLI (`ncl`)

`ncl` queries and modifies the central DB — agent groups, messaging groups, wirings, users, roles, and more. On the host it connects via Unix socket (`src/cli/socket-server.ts`); inside containers it uses the session DB transport (`container/agent-runner/src/cli/ncl.ts`).

```
ncl <resource> <verb> [<id>] [--flags]
ncl <resource> help
ncl help
```

| Resource | Verbs | What it is |
|----------|-------|------------|
| groups | list, get, create, update, delete, restart, config get/update, config add-mcp-server/remove-mcp-server, config add-package/remove-package, config add-calendar/remove-calendar | Agent groups (workspace, personality, container config) |
| messaging-groups | list, get, create, update, delete | A single chat/channel on one platform |
| wirings | list, get, create, update, delete | Links a messaging group to an agent group (session mode, triggers) |
| users | list, get, create, update | Platform identities (`<channel>:<handle>`) |
| roles | list, grant, revoke | Owner / admin privileges (global or scoped to an agent group) |
| members | list, add, remove | Unprivileged access gate for an agent group |
| destinations | list, add, remove | Where an agent group can send messages |
| sessions | list, get | Active sessions (read-only) |
| tasks | list, get, create, update, cancel, pause, resume, delete, run, append-log | Scheduled tasks for an agent group |
| user-dms | list | Cold-DM cache (read-only) |
| dropped-messages | list | Messages from unregistered senders (read-only) |
| approvals | list, get | Pending approval requests (read-only) |

Key files: `src/cli/dispatch.ts` (dispatcher + approval handler), `src/cli/crud.ts` (generic CRUD registration), `src/cli/resources/` (per-resource definitions).

## Channels and Providers (skill-installed)

Trunk does not ship any specific channel adapter or non-default agent provider. The codebase is the registry/infra; the actual adapters and providers live on long-lived sibling branches and get copied in by skills:

- **`channels` branch** — Discord, Slack, Telegram, WhatsApp, Teams, Linear, GitHub, iMessage, Webex, Resend, Matrix, Google Chat, WhatsApp Cloud, Signal, WeChat, DeltaChat, Emacs (+ helpers, tests, channel-specific setup steps). Installed via `/add-<channel>` skills.
- **`providers` branch** — OpenCode (and any future non-default agent providers). Installed via `/add-opencode`.

Each `/add-<name>` skill is idempotent: `git fetch origin <branch>` → copy module(s) into the standard paths → append a self-registration import to the relevant barrel → `pnpm install <pkg>@<pinned-version>` → build. Channel skills carry these steps as `nc:` directive fences: setup applies them via the engine (`scripts/skill-apply.ts`), an agent applies the prose — same install either way. See [docs/skill-directives.md](docs/skill-directives.md).

**Channel defaults.** Each adapter declares its wiring-time defaults (`ChannelDefaults`: per DM/group context — engage mode/pattern, thread policy, unknown-sender policy — plus mention signaling). Exactly two levels: the adapter declaration, and the per-wiring override chosen at creation — no per-instance DB config table. Undeclared (stale) adapters resolve through a behavior-faithful fallback, so a trunk update alone changes nothing. See [docs/api-details.md](docs/api-details.md#channel-defaults) and `src/channels/channel-defaults.ts`.

## Self-Modification

One tier of agent self-modification today:

1. **`install_packages` / `add_mcp_server`** — changes to the per-agent-group container config in the DB (apt/npm deps, wire an existing MCP server). Single admin approval per request; on approve, the handler in `src/modules/self-mod/apply.ts` rebuilds the image when needed (`install_packages` only), writes an `on_wake` message, kills the container, and respawns via `onExit` callback. The on-wake message is only picked up by the fresh container's first poll — dying containers can never steal it. `container/agent-runner/src/mcp-tools/self-mod.ts`.

A second tier (direct source-level self-edits via a draft/activate flow) is planned but not yet implemented.

## Container Config

Per-agent-group container runtime config (provider, model, packages, MCP servers, mounts, etc.) lives in the `container_configs` table in the central DB. Materialized to `groups/<folder>/container.json` at spawn time so the container runner can read it. Managed via `ncl groups config get/update` and the self-mod MCP tools.

**`cli_scope`** — controls what the agent can do with `ncl` from inside the container:

| Value | Behavior |
|-------|----------|
| `disabled` | Agent never learns about ncl (instructions excluded from CLAUDE.md). Host dispatch rejects any `cli_request`. |
| `group` (default) | Agent can access `groups`, `sessions`, `destinations`, `members`, `tasks` only, scoped to its own agent group. `--id` and group args are auto-filled. Cross-group access rejected. `cli_scope` changes blocked. |
| `global` | Unrestricted. Set automatically for owner agent groups via `init-first-agent`. |

Key files: `src/db/container-configs.ts`, `src/container-config.ts`, `src/cli/dispatch.ts` (scope enforcement), `src/claude-md-compose.ts` (instructions exclusion).

## Container Restart

`ncl groups restart --id <group-id> [--rebuild] [--message <text>]`. Kills running containers; if `--message` is provided, writes an `on_wake` message and respawns via `onExit` callback. Without `--message`, containers come back on the next user message. From inside a container, `--id` is auto-filled and only the calling session is restarted.

The `on_wake` column on `messages_in` ensures wake messages are only picked up by a fresh container's first poll iteration. This prevents the race where a dying container (still in its SIGTERM grace period) could steal the message. `killContainer` accepts an optional `onExit` callback that fires after the process exits, guaranteeing the old container is gone before the new one spawns.

Key files: `src/container-restart.ts`, `src/container-runner.ts` (`killContainer`), `container/agent-runner/src/db/messages-in.ts` (`getPendingMessages`).

## Secrets / Credentials / OneCLI

API keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway. Secrets are injected into per-agent containers at request time — none are passed in env vars or through chat context. The container agent sees this via the `onecli-gateway` container skill (`container/skills/onecli-gateway/SKILL.md`), which teaches it how the proxy works, how to handle auth errors, and to never ask for raw credentials. Host-side wiring: `src/modules/approvals/onecli-approvals.ts`, `ensureAgent()` in `container-runner.ts`. Run `onecli --help`.

### Secret modes

Auto-created agents default to `all` secret mode — every vault secret whose host pattern matches is injected automatically, so the common case needs no per-agent setup. If an agent is in `selective` mode it gets no secrets until you assign them, which shows up as a `401` from an API whose credential *is* in the vault. The SDK can't change this; use the CLI (or the web UI at `http://127.0.0.1:10254`):

```bash
onecli agents list                                          # check secretMode
onecli agents set-secret-mode --id <agent-id> --mode all    # inject all matching secrets
onecli agents set-secrets --id <agent-id> --secret-ids ...  # or stay selective, assign specific ones
```

No container restart needed — the gateway looks up secrets per request.

### Requiring approval for credential use

Approval-gating credentialed actions is a **two-sided** flow:

- **Server-side** (OneCLI gateway): decides *when* to hold a request and emit a pending approval. As of `onecli@2.2.5`, the CLI does **not** expose this — `rules create --action` only accepts `block` or `rate_limit`, and `secrets create` has no approval flag. Approval policies must be configured via the OneCLI web UI at `http://127.0.0.1:10254`. If/when the CLI grows an `approve` action, this section needs updating.
- **Host-side** (nanoclaw): receives pending approvals and routes them to a human. `src/modules/approvals/onecli-approvals.ts` registers a callback via `onecli.configureManualApproval(cb)` (long-polls `GET /api/approvals/pending`). The callback uses `pickApprover` + `pickApprovalDelivery` from `src/modules/approvals/primitive.ts` to DM an approver. Approvers are resolved from the `user_roles` table — preference order: scoped admins for the agent group → global admins → owners. There is no env var like `NANOCLAW_ADMIN_USER_IDS`; roles are persisted in the central DB only.

If approvals are configured server-side but the host callback isn't running (or throws), every credentialed call hangs until the gateway times out. Conversely, if the gateway has no rule asking for approval, the host callback never fires regardless of how it's wired.

## Skills

Four types of skills. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy.

- **Channel/provider install skills** — copy the relevant module(s) in from the `channels` or `providers` branch, wire imports, install pinned deps (e.g. `/add-discord`, `/add-slack`, `/add-whatsapp`, `/add-opencode`).
- **Utility skills** — ship code files alongside `SKILL.md` (e.g. a `scripts/` CLI or helper).
- **Operational skills** — instruction-only workflows (`/setup`, `/debug`, `/customize`, `/init-first-agent`, `/manage-channels`, `/init-onecli`, `/update-nanoclaw`).
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`: `agent-browser`, `document-memory`, `frontend-engineer`, `onecli-gateway`, `self-customize`, `vercel-cli`, `welcome`; channel-specific skills like `slack-formatting` and `whatsapp-formatting` are copied in by their `/add-<channel>` skill).

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time install, auth, service config |
| `/init-first-agent` | Bootstrap the first DM-wired agent (channel pick → identity → wire → welcome DM) |
| `/manage-channels` | Wire channels to agent groups with isolation level decisions |
| `/customize` | Adding channels, integrations, behavior changes |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials |
| `/migrate-memory` | Carry a group's agent memory across a provider switch (operator-run, both directions) |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, `SKILL.md` format rules, and the pre-submission checklist.

## PR Hygiene

Before creating a PR, run these checks:

```bash
git diff upstream/main --stat HEAD
git log upstream/main..HEAD --oneline
```

Show the output and wait for approval. Installation-specific files (group files, .claude/settings.json, local configs) should not be included.

## Development

Run commands directly — don't tell the user to run them.

```bash
# Host (Node + pnpm)
pnpm run dev          # Host via tsx (no watch)
pnpm run build        # Compile host TypeScript (src/)
./container/build.sh  # Rebuild agent container image (nanoclaw-agent:latest)
pnpm test             # Host tests (vitest)

# Agent-runner (Bun — separate package tree under container/agent-runner/)
cd container/agent-runner && bun install   # After editing agent-runner deps
cd container/agent-runner && bun test      # Container tests (bun:test)
```

Container typecheck is a separate tsconfig — if you edit `container/agent-runner/src/`, run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from root (or `bun run typecheck` from `container/agent-runner/`).

Service management:
```bash
# macOS (launchd)
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start|stop|restart nanoclaw
```

## Troubleshooting

Check these first when something goes wrong:

| What | Where |
|------|-------|
| Host logs | `logs/nanoclaw.error.log` first (delivery failures, crash-loop backoff, warnings), then `logs/nanoclaw.log` for the full routing chain |
| Setup logs | `logs/setup.log` (overall), `logs/setup-steps/*.log` (per-step: bootstrap, environment, container, onecli, mounts, service, etc.) |
| Session DBs | `data/v2-sessions/<agent-group>/<session>/` — `inbound.db` (`messages_in`: did the message reach the container?), `outbound.db` (`messages_out`: did the agent produce a response?) |

Note: container logs are lost after the container exits (`--rm` flag). If the agent silently failed inside the container, there's no persistent log to inspect.

## Timestamps

Two rules, no exceptions:

- **Storage**: every timestamp written from JS is `new Date().toISOString()` (ISO-8601 UTC with `Z`). Never `datetime('now')` — its naive `YYYY-MM-DD HH:MM:SS` shape is misparsed as local time by `new Date()` and breaks string comparisons against ISO values. In pure-SQL contexts (skill snippets) use `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. SQL-side *comparisons* wrap both sides in `datetime()`.
- **Display**: anything shown to an agent or a user renders in the install timezone — `formatLocalTime` (prose) or `formatLocalStamp` (log lines) from `src/timezone.ts` / `container/agent-runner/src/timezone.ts`. `--json` output, DB values, and operator logs stay ISO.

An agent group can override the install timezone (`ncl groups config update --timezone <IANA>`, `""` clears; approval-gated for agent callers). The override grounds that group's scheduling (cron interpretation, `--process-after`, run-log stamps — effective immediately) and the container's `TZ` env (effective on respawn). Host-side operator display (`ncl` human output) stays in the install timezone. Resolution: `resolveGroupTimezone` in `src/container-config.ts` — group override → install global.

## Supply Chain Security (pnpm)

This project uses pnpm with `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`. New package versions must exist on the npm registry for 3 days before pnpm will resolve them.

**Rules — do not bypass without explicit human approval:**
- **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release age gate, the human must approve and the entry must pin the exact version being excluded (e.g. `package@1.2.3`), never a range.
- **`onlyBuiltDependencies`**: Never add packages to this list without human approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** should be used in CI, automation, and container builds. Never run bare `pnpm install` in those contexts.

## Docs Index

| Doc | Purpose |
|-----|---------|
| [docs/architecture.md](docs/architecture.md) | Full architecture writeup |
| [docs/api-details.md](docs/api-details.md) | Host API + DB schema details |
| [docs/db.md](docs/db.md) | DB architecture overview: three-DB model, cross-mount rules, readers/writers map |
| [docs/db-central.md](docs/db-central.md) | Central DB (`data/v2.db`) — every table + migration system |
| [docs/db-session.md](docs/db-session.md) | Per-session `inbound.db` + `outbound.db` schemas + seq parity |
| [docs/agent-runner-details.md](docs/agent-runner-details.md) | Agent-runner internals + MCP tool interface |
| [docs/isolation-model.md](docs/isolation-model.md) | Three-level channel isolation model |
| [docs/setup-wiring.md](docs/setup-wiring.md) | What's wired, what's open in the setup flow |
| [docs/architecture-diagram.md](docs/architecture-diagram.md) | Diagram version of the architecture |
| [docs/build-and-runtime.md](docs/build-and-runtime.md) | Runtime split (Node host + Bun container), lockfiles, image build surface, CI, key invariants |
| [docs/v1-to-v2-changes.md](docs/v1-to-v2-changes.md) | v1→v2 architecture diff — vocabulary for where v1 things moved |
| [docs/migration-dev.md](docs/migration-dev.md) | Migration development guide — testing, debugging, dev loop |
| [docs/provider-migration.md](docs/provider-migration.md) | Switching a live agent group between providers (e.g. Claude → Codex) — what carries over, rollback |
| [docs/customizing.md](docs/customizing.md) | Short intro to customizing via skills |
| [docs/skills-model.md](docs/skills-model.md) | The skills model in full: recipes, tests, upgrades, migrations |
| [docs/skill-guidelines.md](docs/skill-guidelines.md) | Authoritative checklist for writing a skill |
| [docs/skill-directives.md](docs/skill-directives.md) | `nc:` directive reference: fence grammar, the eight kinds, effects, guards, lint |
| [docs/skill-engine-seam.md](docs/skill-engine-seam.md) | Skill-engine consumer contract (wizard / pipeline / agent-relay) + boundary-rule rationale |
| [docs/templates.md](docs/templates.md) | Agent templates: what they are, stamping via `ncl groups create --template` + the setup wizard, the OneCLI/MCP-credential model, supported providers, and how to contribute one |
| [docs/hardened-image.md](docs/hardened-image.md) | Opt-in: pull the agent image from a registry instead of building it |

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Container Runtime (Bun)

The agent container runs on **Bun**; the host runs on **Node** (pnpm). They communicate only via session DBs — no shared modules. Details and rationale: [docs/build-and-runtime.md](docs/build-and-runtime.md).

**Gotchas — trigger + action:**

- **Adding or bumping a runtime dep in `container/agent-runner/`** → edit `package.json`, then `cd container/agent-runner && bun install` and commit the updated `bun.lock`. Do not run `pnpm install` there — agent-runner is not a pnpm workspace.
- **Bumping `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, or any agent-runner runtime dep** → no `minimumReleaseAge` policy applies to this tree. Check the release date on npm, pin deliberately, never `bun update` blindly.
- **Writing a new named-param SQL insert/update in the container** → use `$name` in both SQL and JS keys: `.run({ $id: msg.id })`. `bun:sqlite` does not auto-strip the prefix the way `better-sqlite3` does on the host. Positional `?` params work normally.
- **Adding a test in `container/agent-runner/src/`** → import from `bun:test`, not `vitest`. Vitest runs on Node and can't load `bun:sqlite`. `vitest.config.ts` excludes this tree.
- **Adding a Node CLI the agent invokes at runtime** (like `agent-browser`, `claude-code`, `vercel`) → put it in the Dockerfile's pnpm global-install block, pinned to an exact version via a new `ARG`. Don't use `bun install -g` — that bypasses the pnpm supply-chain policy.
- **Changing the Dockerfile entrypoint or the dynamic-spawn command** (`src/container-runner.ts` line ~503) → keep `exec bun ...` so signals forward cleanly. The image has no `/app/dist`; don't reintroduce a tsc build step.
- **Changing session-DB pragmas** (`container/agent-runner/src/db/connection.ts`) → `journal_mode=DELETE` is load-bearing for cross-mount visibility. Read the comment block at the top of the file first.

## CJK font support

Agent containers ship without CJK fonts by default (~200MB saved). If you notice signals the user works with Chinese/Japanese/Korean content — conversing in CJK, CJK timezone (e.g., `Asia/Tokyo`, `Asia/Shanghai`, `Asia/Seoul`, `Asia/Taipei`, `Asia/Hong_Kong`), system locale hint, or mentions of needing to render CJK in screenshots/PDFs/scraped pages — offer to enable it:

```bash
# Ensure .env has INSTALL_CJK_FONTS=true (overwrite or append)
grep -q '^INSTALL_CJK_FONTS=' .env && sed -i.bak 's/^INSTALL_CJK_FONTS=.*/INSTALL_CJK_FONTS=true/' .env && rm -f .env.bak || echo 'INSTALL_CJK_FONTS=true' >> .env

# Rebuild and restart so new sessions pick up the new image
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

`container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through as a Docker build-arg. Without CJK fonts, Chromium-rendered screenshots and PDFs containing CJK text show tofu (empty rectangles) instead of characters.
