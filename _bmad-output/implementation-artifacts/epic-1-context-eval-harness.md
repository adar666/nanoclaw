# Epic 1 Context: Run a Scenario Safely, End to End

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->
<!-- Scoped filename: this project has multiple parallel "Epic 1"s (document-memory owns the unsuffixed
     epic-1-context.md). This file is eval-harness's own Epic 1 only — do not confuse the two. -->

## Goal

Today this project's persona-level behavioral claims (e.g. "resolve a guest's email proactively, ask on ambiguity, never guess") are unfalsifiable — verified only by a human eyeballing one live Telegram exchange. This epic delivers the walking skeleton of a real evaluation harness: a CLI command that spawns the actual production per-agent-group container, sends it a real scripted message, captures its real outbound behavior, judges a single objectively-correct claim by exact assertion, and produces a saved report — with zero risk of ever touching Uriel's real calendar or leaking a reply into a live chat. Proven end-to-end against the `guest-resolution-known-name` scenario (does the invite go to Devorah's real, on-file email).

## Stories

- Story 1.1: Scaffold the isolated eval agent group and safety checks
- Story 1.2: Calendar isolation and household people.md mount for the eval group
- Story 1.3: Run-exclusivity lock
- Story 1.4: Spawn the real container and capture the outbound transcript
- Story 1.5: Host-sweep exclusion for eval sessions
- Story 1.6: Deterministic judging
- Story 1.7: CLI entry point, cleanup, and report

## Requirements & Constraints

- The harness must run a scenario against the real, live agent — the actual per-agent-group container via the production spawn path — not a simulation or SDK-only shortcut, since past live bugs in this project all lived in the container/DB/composition layer, not reachable by a hand-assembled prompt.
- A deterministic scenario's verdict must be computed by exact assertion, zero model-call variance, fully reproducible from the same captured transcript.
- Scenario runs must never write to Uriel's real household/personal Google Calendars — only a dedicated eval-test calendar; every created event must be cleaned up after the run, with any cleanup failure reported explicitly, never silently swallowed.
- Every scenario run's session must have no origin chat (`messaging_group_id: NULL`) and zero entries in `destinations` — checked at run time before anything spawns, with loud failure (not silent skip) on violation. An eval reply must never reach a live chat.
- Eval sessions must be excluded from the live host service's own 60-second sweep — the eval CLI is a separate OS process with disjoint in-memory container-running state from the host service, so an unmarked session gets duplicate-spawned.
- Two concurrent invocations (two runs, or a run overlapping the sweep) must not race on the eval group's shared workspace — enforced by a lock that fails loud on contention, never races silently.
- A human invokes the harness on demand from the CLI; running it produces a saved report (per-scenario verdict + evidence) with no CI/scheduled-job dependency.
- Every scenario run costs real Claude API tokens (real container spin-up, real model calls) — not cheap to run casually; frequency is bounded by design to on-demand only.

## Technical Decisions

- **Orchestrated pipeline**: `loader → runner → judge → reporter`, four stages, each depending only on the stage before it. A CLI entry point (`cli.ts`) drives the pipeline; nothing else calls the stage modules directly.
- **In-process host reuse, not reimplementation**: `runner.ts` calls `wakeContainer` (`src/container-runner.ts`), `writeSessionMessage`/`openOutboundDb` (`src/session-manager.ts`), and `createSession` (`src/db/sessions.ts`) directly, against the live `data/v2.db` — same functions, same database as production. No mocked spawn path.
- **Calendar isolation** reuses the existing calendar-registry override mechanism: `setup.ts` registers `{ name: "uriel", calendarId: <eval-test-calendar-id> }` for the eval group, which wins over the built-in `uriel → primary` mapping (`calendar.ts`'s existing "registry wins on collision" behavior) — no new isolation code.
- **`household`'s `people.md`** is read-only-mounted into the eval group via the existing `ncl groups config add-mount` + `mount-security` allowlist mechanism (same pattern already live for Yulanda/Tina), so guest-resolution scenarios have real ground truth.
- **Run-exclusivity lock** (`lock.ts`) reuses the existing mtime-based stale-lock pattern from `container/agent-runner/src/mcp-tools/documents.ts` (`withLock()`, `LOCK_STALE_MS`).
- **Thread-id convention**: eval sessions use `system:`-prefixed thread ids, matching the existing scheduled-task convention (`isTaskThread()`).
- **Report convention**: `eval/reports/<run-id>/report.json`, `run-id` = ISO-8601 timestamp with `:` stripped.
- **No raw DB handles**: `eval/` never opens its own `better-sqlite3` handle against `data/v2.db` — reads/writes only through existing host module functions.
- **The one dependency edge into existing host code**: `src/host-sweep.ts` gains a session-exclusion marker check (Story 1.5) — everything else under `eval/` is purely additive. No new runtime dependency is introduced anywhere in this epic.
- **Structural seed**: `eval/cli.ts`, `eval/setup.ts`, `eval/loader.ts`, `eval/runner.ts`, `eval/judge/deterministic.ts`, `eval/reporter.ts`, `eval/lock.ts`, `eval/scenarios/guest-resolution.scenarios.ts`.
- **Deployment envelope**: eval runs happen while the live host service keeps running — this repo is the production install, never stopped for a test run.

## Cross-Story Dependencies

- Strictly sequential within the epic: 1.1 (agent group + safety checks) → 1.2 (calendar isolation + mount, needs the group from 1.1) → 1.3 (lock, independent but ordered here) → 1.4 (real spawn + capture, needs 1.1/1.2, creates the AD-6 marker) → 1.5 (host-sweep exclusion, consumes the marker from 1.4 — this is the one story editing live host code, `src/host-sweep.ts`, treat as a live-deploy change) → 1.6 (deterministic judging, needs a captured transcript from 1.4) → 1.7 (CLI entry point, wires all of the above together end to end).
- Epic 2 (LLM-judge path) depends on this epic's pipeline (`loader`/`runner`/`reporter`) existing unchanged — it must add zero changes to those three files.
- Epic 3 (standalone sweep) depends only on this epic's calendar id (1.2) and lock (1.3) — not on Epic 2.
