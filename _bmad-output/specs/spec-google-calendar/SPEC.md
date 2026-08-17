---
id: SPEC-google-calendar
companions: []
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Google Calendar Read/Write

## Why

A pain to solve: right now, scheduling a household event means leaving the chat and opening Google Calendar by hand — and the agent can't answer "what's on the calendar" without being told. The user wants the agent to read and write two people's calendars (Uriel's and Devorah's) directly from chat: say "schedule X" and get a real calendar event with the right details; ask "what's on" and get a real answer.

## Capabilities

- **CAP-1**
  - **intent:** A user can ask the agent to create a new event — title, description, location, start/end time, guest emails — on a named calendar (Uriel's or Devorah's), from a natural-language chat request.
  - **success:** The agent creates a real Google Calendar event with the requested details on the correct calendar and confirms back with the event's details/link.

- **CAP-2**
  - **intent:** A user can ask the agent what's on a named calendar for a time range or a specific question ("what's on today/tomorrow/this week", "when is X").
  - **success:** The agent answers from real, current calendar data — never from memory or a guess.

- **CAP-3**
  - **intent:** A user can ask the agent to change an already-created event's details (time, location, guests, description) on a named calendar. If the target event is ambiguous, the agent presents a numbered candidate list and waits for a pick rather than guessing.
  - **success:** The named event's changed field(s) reflect the new value on the real calendar; everything else about the event is unchanged.

## Constraints

- Google Calendar only — not Outlook or any other provider (user-confirmed).
- Two named calendars only: Uriel's and Devorah's — two separate, independently-owned Google Calendars, each addressed explicitly by name. (How access to each is authenticated is an implementation/architecture-stage detail, not a spec-level constraint — see the architecture spine's AD-2/AD-3.)
- Credentials never pass through chat, code, or env vars — routed exclusively through the OneCLI Gateway proxy, the same pattern every other credentialed action in this codebase already uses.
- If a request targets a calendar whose OAuth isn't connected yet (most likely Devorah's, initially), the tool declines clearly with instructions to connect it — never silently falls back to the other calendar or fails with an opaque error.
- The target calendar (Uriel's vs Devorah's) is always an explicit selection — never inferred/guessed when a request is ambiguous about whose calendar it means; the agent asks.
- New MCP tool(s) live under `container/agent-runner/src/mcp-tools/`, registered via the existing `McpToolDefinition` + `registerTools()` convention — same mechanism as the document-memory tools.
- All calendar writes (create/update) are triggered by an explicit user chat instruction in the same turn — no autonomous/background/scheduled calendar writes without a direct request.
- The exact Google Calendar client library (Node/Bun-compatible) is not pinned here — deferred to the architecture stage's stack research.

## Non-goals

- Deleting/cancelling an event — a separate, higher-stakes destructive action than create/update; revisit if requested.
- Recurring-event creation (e.g. "every Thursday") — single-occurrence events only for v1; revisit if requested.
- Calendars other than Uriel's and Devorah's (a shared/family calendar, an invited guest's own calendar).
- Free-busy conflict detection or scheduling-suggestion logic beyond what's explicitly asked.

## Success signal

A user says "schedule a meeting with X on Thursday at 3pm at the office, with Yossi" and the agent creates a real Google Calendar event on the right calendar with every given detail correctly set, confirming back with the event's details/link. Separately, "what do I have tomorrow" returns real events from the calendar for that day.

## Assumptions

- Which agent group(s)/wiring this tool is exposed through (household, dm-with-uriel, a new per-person grouping) is an architecture-stage decision, not resolved here.
- "Guests" means attendee email addresses added to the event; the agent may already know some people's emails from existing household memory (`groups/household/memory/household/people.md`) and can ask when it doesn't.

## Open Questions

- Whether an unresolvable guest email blocks event creation or the agent asks and proceeds without it — resolved at build stage.
