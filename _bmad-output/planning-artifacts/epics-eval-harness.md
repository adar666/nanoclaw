---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments:
  - _bmad-output/specs/spec-eval-harness/SPEC.md
  - _bmad-output/specs/spec-eval-harness/eval-harness-flow.md
  - _bmad-output/specs/spec-eval-harness/scenario-format.md
  - _bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-19/ARCHITECTURE-SPINE.md
  - project-context.md
---

# Agent Evaluation Harness - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for the Agent Evaluation Harness, decomposing the requirements from SPEC-eval-harness (serving as the PRD-equivalent kernel — no separate PRD.md exists; this feature was distilled via `bmad-spec`, not `bmad-prd`), its companions, and the Architecture Spine into implementable stories. No UX design contract exists for this feature (CLI + backend pipeline, no UI).

## Requirements Inventory

### Functional Requirements

FR1: The harness can run a scenario against the real, live agent — the actual per-agent-group container spawned via the production path (`container-runner.ts`), not a simulation or SDK-only shortcut — sending it a real scripted inbound message and capturing the resulting transcript/outbound behavior for judging. (CAP-1)

FR2: A scenario with a single objectively-correct answer is judged by exact assertion against the captured outcome, with zero LLM/model-call involvement in the judging step — the same captured transcript always yields the same pass/fail, fully reproducible. (CAP-2)

FR3: A scenario testing a qualitative behavioral claim is graded by a second Claude call against a written rubric; the judge call always records both a verdict and its reasoning, never a bare boolean with no explanation to audit. (CAP-3)

FR4: Scenario runs exercise the real Google Calendar integration without ever touching Uriel's real household/personal calendars — every event a scenario run creates or attempts lands only on a dedicated eval-test calendar (registered via `add_calendar`), and gets cleaned up after the run; a cleanup failure is reported explicitly, never silently swallowed. (CAP-4)

FR5: The scenario format and the runner are domain-agnostic — nothing calendar-specific (or specific to any one domain) is baked into the interface itself. Adding a second scenario domain requires zero runner-code changes — only a new scenario definition set and its own judge rubric. (CAP-5)

FR6: A human can invoke the harness on demand from the command line. Running the CLI command against the guest-resolution scenario set produces a saved report (per-scenario verdict + evidence) with no CI or scheduled-job dependency required. (CAP-6)

FR7: A standalone sweep can find and remove leftover eval-test-calendar events left behind by a crashed or interrupted run, independent of any single scenario's own per-run cleanup (FR4). Running the sweep against a test calendar with orphaned events removes them and reports what was removed; running it against an already-clean calendar is a safe no-op. (CAP-7)

### NonFunctional Requirements

NFR1: Scenario runs must never write to Uriel's real household/personal Google Calendars — only the dedicated eval-test calendar (isolation/safety, binds CAP-4, AD-7).

NFR2: The runner spins up the real per-agent-group container via the same path production uses (`container-runner.ts`) — no SDK-only shortcut that bypasses the real MCP tool list, real SKILL.md composition, or the real two-DB message flow, since those are exactly the layers this project has already found live bugs in that a unit test never would have caught (binds CAP-1, AD-2).

NFR3: Every scenario run costs real Claude API tokens (a real container spin-up, real model calls) — this is not a cheap operation to run casually or in a tight loop; run frequency is bounded by design to on-demand only (no CI/scheduled runs in v1).

NFR4: An eval scenario's own reply must never reach a live Telegram/WhatsApp/etc chat. Every scenario run's session has `messaging_group_id: NULL` (no origin chat to match into) and zero entries in `destinations` — both delivery paths closed, not just one. Destination-emptiness and null origin are checked at run time, before spawning anything, with loud failure (not silent skip) on violation (binds CAP-1/CAP-4, AD-1, AD-4).

NFR5: The LLM judge never holds or requests a raw Anthropic API key on the host process — a judge call spawns its own container under a second, separate dedicated agent group (never the scenario group), OneCLI-credentialed the same way every other container is, with the same `messaging_group_id: NULL` + zero-destinations isolation as the scenario group (binds CAP-3, AD-3).

NFR6: Eval sessions must be excluded from the live host service's own 60-second sweep (`host-sweep.ts`) — the eval CLI is a separate OS process from the host service with disjoint in-memory `isContainerRunning` state, so an unmarked eval session would be duplicate-spawned by the host's own sweep, corrupting in-flight `processing_ack` claims and transcript capture. This requires a real, small change to existing host code (`host-sweep.ts`), not something `eval/` can close purely additively (binds CAP-1, AD-6).

NFR7: Two concurrent invocations (two scenario runs, or a run overlapping the standalone sweep) must not race on the eval agent group's shared RW-mounted workspace (memory, CLAUDE.md). Run-exclusivity is enforced via a lock that fails loud with a clear message on contention — it never proceeds to race (binds CAP-1, CAP-7, AD-8).

### Additional Requirements

- **No starter template** — `eval/` is assembled entirely from the host's existing toolchain and its existing exported functions; no new runtime or dependency is introduced (AD-2, Stack table).
- **Orchestrated pipeline structure**: `loader → runner → judge → reporter`, four stages, each depending only on the stage before it (never sideways, never forward). A CLI entry point (`cli.ts`) drives the pipeline; nothing else calls `runner`/`judge`/`reporter` directly.
- **In-process host module reuse, not reimplementation**: `runner.ts` calls `wakeContainer` (`src/container-runner.ts`), `writeSessionMessage`/`openOutboundDb` (`src/session-manager.ts`), and `createSession` (`src/db/sessions.ts`) directly, in-process, against the live `data/v2.db` — same functions, same database as the real host process (AD-2).
- **Calendar isolation reuses existing override mechanism**: `setup.ts` registers the eval agent group's `calendar_registry` with `{ name: "uriel", calendarId: <eval-test-calendar-id> }`, reusing `calendar.ts`'s existing "registry entry wins over built-in name on collision" behavior (Story 2.3 / AD-18) — no new calendar-isolation code (AD-7).
- **Read-only mount of `household`'s `people.md`** into the eval agent group, reusing the existing `ncl groups config add-mount` + `mount-security` allowlist mechanism already live for Yulanda/Tina — needed so guest-resolution scenarios have real ground truth to resolve against (AD-7).
- **Run-exclusivity lock** (`lock.ts`) reuses the existing mtime-based stale-lock pattern from `container/agent-runner/src/mcp-tools/documents.ts` (`withLock()`, `LOCK_STALE_MS`) — acquired by `cli.ts` (for a run) or `sweep.ts` (for a sweep) before anything else happens, released on exit, reclaimed as abandoned after the staleness window on a crashed prior run (AD-8).
- **Thread-id convention**: eval sessions use `system:`-prefixed thread ids, matching the existing scheduled-task convention (`isTaskThread()`, `src/db/sessions.ts`) rather than inventing a new one.
- **Report output convention**: `eval/reports/<run-id>/report.json`, `run-id` = ISO-8601 timestamp with `:` stripped (filesystem-safe), matching this project's own timestamp convention (`new Date().toISOString()`, never `datetime('now')`).
- **No raw DB handles**: `eval/` never opens its own raw `better-sqlite3` handle against `data/v2.db`'s `container_configs`/`agent_groups`/`sessions` tables — reads/writes only through the existing host module functions those tables already have.
- **One dependency edge back into existing host code**: `src/host-sweep.ts` gains the AD-6 eval-session exclusion — the *only* place `eval/` and existing host code meet; everything else under `eval/` is purely additive. The exact DB column/mechanism for the exclusion marker is an implementation decision for the build step (not fixed by the spine).
- **Deployment envelope**: eval runs happen while the live host service keeps running — this repo is the production install, the service is never stopped for a test run. There is no separate "eval environment"; `eval/` is a client of the same live `data/v2.db` and the same live container infrastructure, isolated by session/agent-group identity (AD-1, AD-3) and process coordination (AD-6, AD-8), not by a separate deployment.
- **Stack** (no new dependency): TypeScript/Node host runtime (same as `nanoclaw` host package); `better-sqlite3` 11.10.0 pinned (matches host `package.json`); `tsx` ^4.19.0 (matches host `package.json`, same convention as `scripts/q.ts`).
- **Structural seed**: `eval/cli.ts`, `eval/setup.ts`, `eval/loader.ts`, `eval/runner.ts`, `eval/judge/deterministic.ts`, `eval/judge/llm.ts`, `eval/reporter.ts`, `eval/sweep.ts`, `eval/lock.ts`, `eval/scenarios/guest-resolution.scenarios.ts`, `eval/reports/<run-id>/report.json`.
- **Scenario/scenario-set naming convention**: scenario ids `<domain>-<case>` (e.g. `guest-resolution-known-name`); scenario-set files `<domain>.scenarios.ts`.
- **Non-goals (v1, explicit deferrals — not to be built now)**: CI integration / scheduled runs; a generic multi-domain scenario taxonomy beyond the interface itself (only `guest-resolution` ships); multi-turn / conversation-drift scenarios (v1 is single-exchange only).

### UX Design Requirements

N/A — no UX design contract exists for this feature. The Agent Evaluation Harness is a CLI + backend pipeline (`eval/` package); it has no user-facing UI surface.

### FR Coverage Map

FR1: Epic 1 - real container spawn + message + transcript capture (walking-skeleton pipeline)
FR2: Epic 1 - deterministic exact-assertion judging
FR3: Epic 2 - LLM-judge qualitative judging with recorded reasoning
FR4: Epic 1 - isolated eval-test calendar + explicit-on-failure cleanup
FR5: Epic 1 (established), Epic 2 (reaffirmed) - domain-agnostic loader/runner/judge/reporter; cross-cutting constraint enforced by keeping scenario content out of pipeline code, not a separate deliverable
FR6: Epic 1 - on-demand CLI run producing a saved report
FR7: Epic 3 - standalone stale-event sweep

## Epic List

### Epic 1: Run a Scenario Safely, End to End
An operator can run `pnpm eval run guest-resolution` against the real household agent and get a genuine, reproducible pass/fail verdict — with zero risk of ever touching Uriel's real calendar or a live chat — for the "resolved the guest's real email, didn't guess" claim. This is the walking skeleton: full pipeline (`loader → runner → judge/deterministic → reporter`), the safety substrate (delivery isolation AD-1/AD-4, real-container-path reuse AD-2, host-sweep exclusion AD-6, run-exclusivity lock AD-8), and calendar isolation (AD-7: override + `people.md` mount) — proven against the `guest-resolution-known-name` scenario.
**FRs covered:** FR1, FR2, FR4, FR6, FR5 (established)

### Epic 2: Judge Qualitative Behavioral Claims
An operator can now also get a graded pass/fail-with-reasoning verdict for claims that have no single correct answer — starting with "asked the user instead of guessing on an ambiguous name" (`guest-resolution-ambiguous-name`). Adds the LLM-judge path (`judge/llm.ts`) under its own isolated, OneCLI-credentialed agent group (AD-3), reusing Epic 1's pipeline, loader, and reporter unchanged. Completes SPEC's Success signal: both halves of the original guest-resolution claim are now independently re-checkable on demand.
**FRs covered:** FR3, FR5 (reaffirmed)

### Epic 3: Clean Up After a Crash
An operator can run `pnpm eval sweep` at any time — independent of any in-progress or completed scenario run — to find and remove orphaned events left on the eval-test calendar by a crashed or interrupted run, with a safe no-op when the calendar is already clean. Standalone safety-net tool reusing Epic 1's lock (AD-8) and calendar id (AD-7); does not require Epic 2.
**FRs covered:** FR7

<!-- ===================== EPIC 1 STORIES ===================== -->

## Epic 1: Run a Scenario Safely, End to End

An operator can run `pnpm eval run guest-resolution` against the real household agent and get a genuine, reproducible pass/fail verdict — with zero risk of ever touching Uriel's real calendar or a live chat — for the "resolved the guest's real email, didn't guess" claim.

### Story 1.1: Scaffold the isolated eval agent group and safety checks

As an operator,
I want a dedicated eval agent group created with no origin chat and zero destinations, checked at run time before anything spawns,
So that a scenario run can never leak its reply into a live Telegram/WhatsApp chat.

**Acceptance Criteria:**

**Given** `eval/setup.ts` has not yet run
**When** invoked
**Then** it creates one dedicated agent group in the DB reserved for eval scenario runs, with zero rows in `destinations` for that group.

**Given** the eval agent group exists
**When** a scenario session is created for it
**Then** the session's `messaging_group_id` is `NULL` and its `thread_id` is `system:`-prefixed, matching the existing `isTaskThread()` convention (`src/db/sessions.ts`).

**Given** the destination-emptiness / null-origin check runs before any container spawn
**When** either check fails — non-empty destinations, or a non-null `messaging_group_id`
**Then** the run aborts loudly with a clear error message and spawns nothing.

**Given** `setup.ts` is run a second time
**When** the eval agent group already exists
**Then** it is idempotent — no duplicate group is created.

### Story 1.2: Calendar isolation and household people.md mount for the eval group

As an operator,
I want the eval agent group's "uriel" calendar name to resolve only to a dedicated eval-test calendar, and household's real `people.md` mounted read-only into it,
So that scenario runs can create/query real calendar events and resolve real guest emails without ever touching Uriel's real household calendar.

**Acceptance Criteria:**

**Given** the eval agent group exists (Story 1.1)
**When** `setup.ts` registers its `calendar_registry`
**Then** it contains an override entry `{ name: "uriel", calendarId: <eval-test-calendar-id> }` that wins over the built-in `uriel → primary` mapping.

**Given** the eval agent group's container resolves calendar id `"uriel"`
**When** any scenario runs
**Then** `resolveCalendarIds()` returns the eval-test calendar id, never `primary`.

**Given** the eval agent group needs guest-resolution ground truth
**When** `setup.ts` runs
**Then** `household`'s `people.md` is read-only-mounted into the eval group via the existing `add-mount` + mount-security allowlist mechanism, and is readable at its `/workspace/extra/...` path inside the eval container.

### Story 1.3: Run-exclusivity lock

As an operator,
I want two concurrent eval invocations to fail loud instead of racing on the same shared workspace,
So that a run and an overlapping run (or sweep) never corrupt each other's state.

**Acceptance Criteria:**

**Given** no lock is currently held
**When** `cli.ts` starts a run
**Then** it acquires a lock file under the eval group's workspace via the reused mtime-based stale-lock pattern (`withLock()`, `LOCK_STALE_MS` from `container/agent-runner/src/mcp-tools/documents.ts`).

**Given** a lock is already held by a live process
**When** a second invocation attempts to acquire it
**Then** it fails immediately with a clear "another eval run is in progress" message and does not proceed.

**Given** a lock was left behind by a crashed prior run, older than `LOCK_STALE_MS`
**When** a new invocation attempts to acquire it
**Then** it is treated as abandoned and reclaimed.

**Given** a run completes, success or failure
**When** it exits
**Then** the lock is released.

### Story 1.4: Spawn the real container and capture the outbound transcript

As an operator,
I want the harness to spawn the actual per-agent-group container via the production spawn path and capture its real outbound response,
So that a scenario exercises the exact same code paths a real user interaction would.

**Acceptance Criteria:**

**Given** a scenario's `message` field
**When** `runner.ts` runs it
**Then** it creates a session for the eval agent group (`createSession`, `src/db/sessions.ts`), writes the scripted inbound message (`writeSessionMessage`, `src/session-manager.ts`), and wakes the container via `wakeContainer` (`src/container-runner.ts`) — the same functions, same `data/v2.db`, as production.

**Given** the container is processing
**When** `runner.ts` polls `outbound.db` (`openOutboundDb`)
**Then** it captures the full outbound transcript once the turn completes.

**Given** the eval session
**When** `runner.ts` creates it
**Then** it is marked with the AD-6 exclusion marker so `host-sweep.ts`'s global session queries skip it.

### Story 1.5: Host-sweep exclusion for eval sessions

As an operator,
I want the live host service's own 60-second sweep to never touch an eval session,
So that a slow scenario turn is never duplicate-spawned and corrupted by the production sweep running in a separate OS process.

**Acceptance Criteria:**

**Given** an eval session carries the AD-6 exclusion marker (Story 1.4)
**When** `host-sweep.ts`'s global session queries (`getRunningSessions()`/`getActiveSessions()` in `src/db/sessions.ts`) run
**Then** eval sessions are excluded from every result set they build on.

**Given** a scenario turn takes longer than 60 seconds
**When** the host's sweep runs mid-turn
**Then** it does not duplicate-spawn the eval container or touch its `processing_ack` claim.

**Given** a regression test for this exclusion logic
**When** `host-sweep.ts`'s eval-exclusion path is tested in isolation
**Then** it is guarded the same way AD-15's env-inheritance fix is guarded — a dedicated wiring test, not left to be caught only live.

**Note:** This is the one story in the entire feature that edits existing live host-service code (`src/host-sweep.ts`). Per CLAUDE.md's own standing caution, treat this as a live-deploy change — verify with the full host test suite (`pnpm test`) and a service restart, not just the new test.

### Story 1.6: Deterministic judging

As an operator,
I want a scenario with a single objectively-correct answer judged by exact assertion against the captured transcript,
So that the same transcript always yields the same pass/fail with zero model-call variance.

**Acceptance Criteria:**

**Given** a captured transcript/outbound state (Story 1.4) and a scenario's `judging: { type: "deterministic", check }`
**When** `judge/deterministic.ts` runs
**Then** it evaluates the check against `outbound.db` content and/or real Calendar API state, with no Claude call involved.

**Given** the same transcript is judged twice
**When** `judge/deterministic.ts` runs each time
**Then** it produces the identical pass/fail verdict both times.

**Given** the check fails
**When** the verdict is recorded
**Then** it includes the actual vs. expected values as evidence, not just pass/fail.

### Story 1.7: CLI entry point, cleanup, and report

As an operator,
I want to run `pnpm eval run guest-resolution` from the command line and get a saved report with per-scenario verdict and evidence,
So that I can independently re-check the guest-resolution claim on demand without waiting for a live Telegram interaction.

**Acceptance Criteria:**

**Given** the scenario set `guest-resolution.scenarios.ts` with the `guest-resolution-known-name` deterministic scenario
**When** `pnpm eval run guest-resolution` is invoked
**Then** `cli.ts` drives `loader → runner → judge/deterministic → reporter` end to end for that scenario and prints a console summary.

**Given** the scenario's `cleanup` field
**When** judging completes, pass or fail
**Then** the created calendar event is deleted from the eval-test calendar; a cleanup failure is reported explicitly in the output, never silently swallowed.

**Given** the run completes
**When** `reporter.ts` writes output
**Then** it saves `eval/reports/<run-id>/report.json` (ISO-8601 timestamp, `:` stripped) containing per-scenario verdict + evidence.

**And** given the scenario asserts against `household`'s real recorded email for "Devorah" (`adardevora@gmail.com`, resolved via the mounted `people.md`)
**When** the scenario passes
**Then** the report shows the actual resolved email as evidence.

<!-- ===================== EPIC 2 STORIES ===================== -->

## Epic 2: Judge Qualitative Behavioral Claims

An operator can now also get a graded pass/fail-with-reasoning verdict for claims that have no single correct answer — starting with "asked the user instead of guessing on an ambiguous name."

### Story 2.1: Judge's own isolated agent group

As an operator,
I want the LLM judge to run inside its own dedicated agent group, separate from the scenario group, with no host-held Claude API key,
So that judging a behavioral claim never creates a new credential-access surface on the host process and never touches the scenario's own session/group state.

**Acceptance Criteria:**

**Given** `setup.ts` runs
**When** it provisions eval infrastructure
**Then** it also creates a second, separate dedicated agent group for the judge — distinct from the scenario agent group — with `messaging_group_id: NULL` and zero destinations (same AD-1 rule as Story 1.1).

**Given** a judge call is made
**When** `judge/llm.ts` runs
**Then** it never holds or requests a raw Anthropic API key on the host process — it spawns a container under the judge agent group, OneCLI-credentialed the same way every other container is.

### Story 2.2: LLM-judge verdict with reasoning

As an operator,
I want a qualitative scenario graded by a second Claude call against a written rubric, with both verdict and reasoning recorded,
So that a behavioral claim with no single correct answer still produces auditable, non-bare-boolean evidence.

**Acceptance Criteria:**

**Given** a scenario's `judging: { type: "llmJudge", rubric }` and a captured transcript (reused from `runner.ts`, Story 1.4)
**When** `judge/llm.ts` runs
**Then** it spawns the judge container (Story 2.1), sends it the transcript + rubric, and reads the verdict back through the judge container's own outbound channel — the same read pattern `runner.ts` uses for a scenario's own outcome.

**Given** the judge responds
**When** the verdict is recorded
**Then** it always includes both a pass/fail verdict and the judge's reasoning text — never a bare boolean.

**Given** `loader.ts`/`runner.ts`/`reporter.ts` already exist (Epic 1)
**When** llmJudge scenarios are added
**Then** zero changes are needed to those three files — only `judge/llm.ts` is new, demonstrating AD-5's domain/judging-type-agnostic interface.

### Story 2.3: Ambiguous-name scenario and full report

As an operator,
I want to run the `guest-resolution-ambiguous-name` scenario ("Ruthie" — not in `people.md`) and see whether the agent asked instead of guessing,
So that both halves of the original guest-resolution claim — resolve correctly, and don't guess when unresolved — are independently re-checkable in one report.

**Acceptance Criteria:**

**Given** the `guest-resolution.scenarios.ts` set
**When** `guest-resolution-ambiguous-name` is added with its rubric ("fail if any email address appears in the outbound response for this unresolved name")
**Then** `pnpm eval run guest-resolution` runs both the known-name and ambiguous-name scenarios in one invocation.

**Given** the scenario wrongly creates an event anyway
**When** judging completes
**Then** the `cleanup` field still deletes it from the eval-test calendar regardless of verdict.

**Given** both scenarios in the set complete
**When** `reporter.ts` writes the report
**Then** it contains both scenarios' verdicts + evidence in one `report.json`.

<!-- ===================== EPIC 3 STORIES ===================== -->

## Epic 3: Clean Up After a Crash

An operator can run `pnpm eval sweep` at any time — independent of any in-progress or completed scenario run — to find and remove orphaned events left on the eval-test calendar by a crashed or interrupted run.

### Story 3.1: Standalone stale-event sweep

As an operator,
I want to run `pnpm eval sweep` at any time to find and remove orphaned events left on the eval-test calendar by a crashed or interrupted run,
So that I never have to manually hunt down leftover test events, and never risk one lingering indefinitely.

**Acceptance Criteria:**

**Given** the eval-test calendar (Story 1.2) has orphaned events left by a crashed run
**When** `pnpm eval sweep` is invoked
**Then** `sweep.ts` acquires its own lock (reusing `lock.ts`, Story 1.3), finds and removes them, and reports what was removed.

**Given** the eval-test calendar is already clean
**When** `sweep.ts` runs
**Then** it is a safe no-op — reports nothing removed, makes no writes.

**Given** a scenario run is currently holding the lock
**When** `sweep.ts` attempts to acquire its own lock
**Then** it fails loud with a clear message rather than racing the in-progress run.

**Given** `sweep.ts` runs
**When** it operates
**Then** it never touches Uriel's real household/personal calendars — only the dedicated eval-test calendar id, reusing AD-7's registry override.
