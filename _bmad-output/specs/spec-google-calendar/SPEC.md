---
id: SPEC-google-calendar
companions: []
sources: []
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Google Calendar Read/Write

## Why

A pain to solve: scheduling a household event used to mean leaving chat and opening Google Calendar by hand, and the agent couldn't answer "what's on the calendar" without being told. Epic 1 solved the core loop — create, read, update, delete on Uriel's or Devorah's calendar from chat. Epic 2 hardens and extends that loop: guard against duplicate writes, support recurrence, admit calendars beyond the original two, and auto-resolve guests the agent already half-knows.

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

- **CAP-4**
  - **intent:** A duplicate or retried `create_calendar_event` call (network hiccup, agent retry, two chat surfaces racing) does not silently double-book the same event.
  - **success:** A create request closely matching one already created moments ago on the same calendar is declined, deduped, or asked about — never silently creates a second event.

- **CAP-5**
  - **intent:** A user can ask the agent to create a recurring event ("every Thursday at 3pm") instead of a single occurrence.
  - **success:** A real recurring Google Calendar event is created with a correct `RRULE`, confirmed back with the pattern actually set.

- **CAP-6**
  - **intent:** A user can reach a calendar outside the original two (Uriel's, Devorah's) — e.g. a shared family calendar — through the same four tools.
  - **success:** A request naming a calendar outside `{uriel, devorah}` is served via a config/mapping addition, with no code change required per newly-added calendar.

- **CAP-7**
  - **intent:** A guest named by first name only (not an email) in a create/update request is checked against household memory automatically, not only when the agent already happens to have it in context.
  - **success:** A first-name-only guest auto-resolves via lookup against `groups/household/memory/household/people.md`; an ambiguous or unmatched name is asked about, never guessed.

## Constraints

- Google Calendar only — not Outlook or any other provider (user-confirmed).
- Credentials never pass through chat, code, or env vars — routed exclusively through the OneCLI Gateway proxy, the same pattern every other credentialed action in this codebase already uses.
- If a request targets a calendar whose OAuth isn't connected yet, the tool declines clearly with instructions to connect it — never silently falls back to another calendar or fails with an opaque error.
- The target calendar is always an explicit selection — never inferred/guessed when a request is ambiguous about whose calendar it means; the agent asks. This holds for any calendar in the registry, hardcoded or config-added via CAP-6.
- New/extended MCP tool(s) live under `container/agent-runner/src/mcp-tools/calendar.ts`, registered via the existing `McpToolDefinition` + `registerTools()` convention.
- All calendar writes (create/update) are triggered by an explicit user chat instruction in the same turn — no autonomous/background/scheduled calendar writes without a direct request.

## Non-goals

- Free-busy conflict detection or scheduling-suggestion logic beyond what's explicitly asked.
- Editing or cancelling a single occurrence of a recurring series independently of the whole series (CAP-5 covers creation only; single-occurrence edits are a future revisit).

## Success signal

A retried "schedule a meeting with X on Thursday at 3pm" never creates two events. "Every Thursday at 3pm" creates one correctly-recurring event. A third calendar (e.g. a family calendar) works the same way Uriel's and Devorah's do, added via config, not code. "Schedule with Yossi" (first name only, known to household memory) resolves his email without the user spelling it out.

## Assumptions

- CAP-4's dedup check is scoped per-calendar, not global — a near-identical event on two different calendars is not a duplicate.
- CAP-6's config/mapping mechanism reuses the existing `calendar` argument shape (a name → calendarId lookup), not a new argument shape.

## Open Questions

- CAP-4: exact dedup-match definition (iCalUID-based vs title+time+calendar heuristic) and the time window counting as "moments ago" — resolved at build stage.
- CAP-5: whether recurring events go through the existing `create_calendar_event` tool (extended) or a new tool — resolved at architecture/build stage.
- CAP-6: how a newly-added calendar's owner grants access (Devorah's native-sharing pattern reused per-calendar, vs a per-calendar OAuth connection) — resolved at architecture stage.
- CAP-7: exact trigger condition (every non-email guest string vs only ones the agent flags as uncertain) — resolved at build stage.
