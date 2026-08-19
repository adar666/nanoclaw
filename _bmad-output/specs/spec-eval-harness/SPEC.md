---
id: SPEC-eval-harness
companions:
  - eval-harness-flow.md
  - scenario-format.md
  - ../../../project-context.md
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Agent Evaluation Harness

## Why

This project's persona-level behavioral claims — SKILL.md instructions like "resolve a guest's email proactively, ask on ambiguity, never guess" — are currently unfalsifiable. Nothing in this codebase checks whether the agent actually does what its own instructions claim; the only verification method used so far has been a human eyeballing one live Telegram exchange and moving on (`deferred-work.md`'s guest-resolution finding, epic-2 calendar hardening). A wrong-but-plausible-looking guess (one that still passes `EMAIL_RE`'s shape check) would ship silently. Per this project's own standing direction (`project-context.md`) — treated as an end-to-end demonstration of a strong, capable agent, held to industry-standard practice rather than "good enough for one household" — this is a real infrastructure gap, not an acceptable permanent state. This spec exists to close it: a real, on-demand harness that exercises the actual production agent against scripted scenarios and produces a genuine pass/fail verdict with evidence, starting with the guest-resolution claim that motivated it.

## Capabilities

- **CAP-1**
  - **intent:** A scenario can be run against the real, live agent (the actual per-agent-group container, not a simulation) and produce a captured outcome.
  - **success:** Running a scenario spins up the real container, sends it a real scripted message, and captures the resulting transcript/outbound behavior for judging.
- **CAP-2**
  - **intent:** A scenario with a single objectively-correct answer (e.g. "the invite went to devorah's real address") is checked by exact assertion, no LLM involved.
  - **success:** A deterministic scenario's verdict is fully reproducible — the same captured transcript always yields the same pass/fail, with zero model-call variance in the judging step itself.
- **CAP-3**
  - **intent:** A scenario testing a qualitative behavioral claim (e.g. "asked the user instead of guessing on an ambiguous name") is graded by a second Claude call against a written rubric.
  - **success:** The judge call records both a verdict and its reasoning — never a bare boolean with no explanation to audit.
- **CAP-4**
  - **intent:** Scenario runs exercise the real Google Calendar integration without ever touching Uriel's real household/personal calendars.
  - **success:** Every event a scenario run creates or attempts lands only on a dedicated eval-test calendar (registered via `add_calendar`), and gets cleaned up after the run — a cleanup failure is reported explicitly, never silently swallowed.
- **CAP-5**
  - **intent:** The scenario format and the runner are domain-agnostic — nothing calendar-specific baked into the interface itself.
  - **success:** Adding a second scenario domain (e.g. AD-5's sender-identity resolution claim) requires zero runner-code changes — only a new scenario definition set and its own judge rubric.
- **CAP-6**
  - **intent:** A human can invoke the harness on demand from the command line.
  - **success:** Running the CLI command against the guest-resolution scenario set produces a saved report (per-scenario verdict + evidence) with no CI or scheduled-job dependency required.
- **CAP-7**
  - **intent:** A standalone sweep can find and remove leftover eval-test-calendar events left behind by a crashed or interrupted run, independent of any single scenario's own per-run cleanup (CAP-4).
  - **success:** Running the sweep against a test calendar with orphaned events removes them and reports what was removed; running it against an already-clean calendar is a safe no-op.

## Constraints

- Every scenario run costs real Claude API tokens (a real container spin-up, real model calls) — this is not a cheap operation to run casually or in a tight loop; it bounds run frequency by design (see Non-goals).
- Scenario runs must never write to Uriel's real household/personal Google Calendars — only the dedicated eval-test calendar (CAP-4).
- The runner spins up the real per-agent-group container via the same path production uses (`container-runner.ts`) — no SDK-only shortcut that bypasses the real MCP tool list, real SKILL.md composition, or the real two-DB message flow, since those are exactly the layers this project has already found live bugs in that a unit test never would have caught.

## Non-goals

- CI integration and scheduled/nightly runs are out of scope for v1 — on-demand only; revisit once the harness has demonstrated real value.
- A full generic taxonomy covering every persona-level behavioral claim in the project (beyond guest-resolution) is out of scope for v1 — the runner interface stays generic (CAP-5), but only one scenario domain ships now.
- Multi-turn conversation-drift or long-session behavioral testing is out of scope — v1 scenarios are single-exchange (one scripted request, one real container spawn, one verdict), not a simulated long conversation history.

## Success signal

Running the harness against the guest-resolution scenario set produces genuine per-scenario pass/fail evidence — not just "ran without crashing" — for the real behavioral claims this session already checked ad hoc, live, by hand (e.g. "תוסיף את דבורה כאורחת" resolving to her correct real email; an ambiguous/unrecognized name causing the agent to ask rather than guess). The concrete demonstration: a persona claim that used to be verifiable only by a human watching one live Telegram exchange is now independently re-checkable on demand, by anyone, without waiting for a real user interaction to happen to exercise it.

## Assumptions

- Assumed the `household` group's real `people.md` (already used in production guest resolution) is an acceptable source of scenario ground truth — a scenario like "invite Devorah" can assert against the real recorded email in that file, rather than needing a separate fixture file.
- Assumed a scenario is judged from the container's outbound behavior (what it actually sent/did — the `outbound.db` content and any real Calendar API side effects), not from inspecting its internal reasoning trace — matching how every live bug in this project's history so far was actually found (reading `outbound.db`, not reading agent "thinking").

