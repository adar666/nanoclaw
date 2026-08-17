---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation]
inputDocuments:
  - _bmad-output/specs/spec-google-calendar/SPEC.md
  - _bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-17/ARCHITECTURE-SPINE.md
---

# nanoclaw-v2 - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for **Google Calendar Read/Write**, decomposing SPEC-google-calendar's capabilities and the driving architecture spine's invariants into implementable stories. No PRD or UX design contract exists for this feature — SPEC.md's five-field kernel serves as the requirements source (per this project's fast-path convention, same as spec-document-memory), and there is no UI surface (chat-only feature).

## Requirements Inventory

### Functional Requirements

FR1: A user can ask the agent to create a new event (title, description, location, start/end time, guest emails) on a named calendar (Uriel's or Devorah's), from a natural-language chat request.
FR2: A user can ask the agent what's on a named calendar for a time range or a specific question ("what's on today/tomorrow/this week", "when is X").
FR3: A user can ask the agent to change an already-created event's details (time, location, guests, description) on a named calendar. If the target event is ambiguous, the agent presents a numbered candidate list and waits for a pick rather than guessing.

### NonFunctional Requirements

NFR1: Google Calendar only — not Outlook or any other provider.
NFR2: Two named calendars only, each authenticated with its own independent OAuth grant through the OneCLI Agent Vault — no shared/delegated access between them.
NFR3: Credentials never pass through chat, code, or env vars — routed exclusively through the OneCLI Gateway proxy.
NFR4: If a request targets a calendar whose OAuth isn't connected yet, the tool declines clearly with instructions to connect it — never silently falls back or fails opaquely.
NFR5: The target calendar is always an explicit selection — never inferred/guessed when ambiguous; the agent asks.
NFR6: All calendar writes are triggered by an explicit user chat instruction in the same turn — no autonomous/background writes.

### Additional Requirements

- **AD-1** Calendar access via the existing OneCLI Gateway transparent HTTPS proxy — direct `fetch()` calls to the real Google Calendar REST API v3 URL from inside the container. No new credential plumbing.
- **AD-2** [ADOPTED, SDK-verified] One calendar per OneCLI identity — `applyContainerConfig`'s `agent` binding holds a container's entire outbound network to one identity for its process lifetime, no per-request switching. Every calendar tool call operates on `calendarId=primary` under whichever identity the calling container is bound to; no calendar-selection argument exists on the tool schema.
- **AD-3** [user-confirmed] Uriel's calendar connects under household's own OneCLI identity; Devorah's connects under her own `dm-with-partner` identity ("Tina") — her own OAuth grant, never shared. A chat surface that isn't the target calendar's owner relays the request via the existing `send_message` tool to the owning agent, in natural language; the owning agent performs the action and replies via its own `send_message`.
- **AD-4** A relayed cross-person calendar action is fire-and-forget/async, never synchronous within the same turn — every persona sets that expectation up front rather than implying same-turn completion.
- **AD-5** [tightened] Sender-to-person resolution reads from the group's own existing OKF memory (e.g. `groups/household/memory/household/people.md`) — never a hardcoded name. An unmatched/ambiguous sender is asked, never guessed.
- **AD-6** New MCP tools — `create_calendar_event`, `list_calendar_events`, `update_calendar_event` — live in a new `container/agent-runner/src/mcp-tools/calendar.ts`, registered via the existing `McpToolDefinition` + `registerTools()` convention. Direct `fetch()` against Google Calendar REST API v3, no new client-library dependency.
- **AD-7** [tightened] Ambiguous event reference: numbered candidate list, never guess. Same-owner request: same-turn, same-container (as `documents.ts`'s precedent). Cross-person request: the owning agent builds and relays the candidate list back to the original requester's destination; the pick flows back the same way.
- **AD-8** A `401`/`403`/`app_not_connected` gateway response (carrying `connect_url`) is surfaced back to the agent as-is — the `onecli-gateway` skill's existing instructions already cover presenting that link. No new connection-status code.
- **AD-9** Every relay send carries a fixed, parseable prefix identifying its kind (`[calendar-relay-request]` vs. `[calendar-relay-result]`) — a result-marked message is always terminal, never re-relayed or re-acted on as a new request.
- **AD-10** Before relaying a create/update, the relaying agent resolves and restates every field it has (title, start, end, timezone, location, attendees, requester) as explicit prose — never forwards the user's raw request text unresolved.
- **AD-11** One tool call per named calendar, never a combined call — a request naming both calendars issues one call (direct or relayed) per calendar named.
- **AD-13** Every event `dateTime` carries an explicit `timeZone` field resolved via this codebase's existing group-timezone convention (`resolveGroupTimezone`) — never a bare/UTC-assumed datetime, never a second timezone-resolution path.
- **AD-14** `container/skills/calendar/SKILL.md` explicitly distinguishes "second-brain OAuth" (never disclose a link, existing rule) from "OneCLI Google Calendar app connection" (always disclose `connect_url`, AD-8) — named side by side so the agent can't conflate them.
- Setup prerequisite (not code): every pair among `household` / `dm-with-uriel` / `dm-with-partner` needs a bidirectional agent-type destination wired via `ncl destinations add` before AD-3's relay can work — none exist today.
- Deferred (spine-acknowledged, not built now): no idempotency/duplicate-request guard on `create_calendar_event`; recurring events; deletion/cancellation; calendars beyond Uriel's/Devorah's; automatic guest-list validation against household memory.

### UX Design Requirements

N/A — no UX design contract exists and none is needed. This feature has no UI surface; all interaction is conversational, through channels already wired.

### FR Coverage Map

| Requirement | Capability | Governing AD(s) |
| --- | --- | --- |
| FR1 | CAP-1 | AD-1, AD-2, AD-3, AD-4, AD-5, AD-6, AD-8, AD-9, AD-10, AD-11, AD-13, AD-14 |
| FR2 | CAP-2 | AD-1, AD-2, AD-3, AD-6, AD-7, AD-8, AD-11, AD-14 |
| FR3 | CAP-3 | AD-1, AD-2, AD-3, AD-4, AD-5, AD-6, AD-7, AD-8, AD-9, AD-10, AD-11, AD-13, AD-14 |
| NFR1, NFR2, NFR3 | CAP-1, CAP-2, CAP-3 | AD-1, AD-2, AD-3 |
| NFR4 | CAP-1, CAP-2, CAP-3 | AD-8 |
| NFR5 | CAP-1, CAP-2, CAP-3 | AD-5, AD-7 |
| NFR6 | CAP-1, CAP-3 | AD-4, AD-9 |

## Epic List

### Epic 1: Google Calendar Read/Write
Users can ask the agent to create, read, and update events on either of two independently-authenticated Google Calendars (Uriel's, Devorah's) from any of three chat surfaces (household, dm-with-uriel, dm-with-partner) — reaching the calendar you don't directly own relays through the agent that does, via the existing cross-agent messaging primitive.
**FRs covered:** FR1, FR2, FR3

### FR Coverage Map

FR1: Epic 1 - Create a calendar event, own calendar direct + other-person relay
FR2: Epic 1 - Read/query a calendar's contents
FR3: Epic 1 - Update an existing event, own calendar direct + other-person relay

## Epic 1: Google Calendar Read/Write

Users can create, read, and update events on Uriel's or Devorah's Google Calendar from chat. Story order: wire the prerequisite plumbing first, then de-risk the core Calendar API integration and timezone handling on the simpler same-owner path before layering the harder cross-person relay mechanics on top — mirroring the same "de-risk the hardest capability's foundation before its hardest variant" sequencing spec-document-memory used.

### Story 1.1: Wire Cross-Agent Calendar Access

As a NanoClaw operator,
I want the three calendar-relevant agent groups bidirectionally wired and each calendar connected under the right identity,
So that the relay mechanism (AD-3) and direct calendar access have something real to run against before any tool code is built.

**Acceptance Criteria:**

**Given** `household`, `dm-with-uriel`, and `dm-with-partner` currently have no `agent`-type destinations wired between them
**When** this story is done
**Then** each pair has a bidirectional agent-type destination (`ncl destinations add`), confirmed via `ncl destinations list` showing `target_type=agent` rows for all three pairs (AD-3's Structural Seed prerequisite)

**Given** Uriel's Google Calendar should be reachable from `household`
**When** this story is done
**Then** the `household` OneCLI identity has Google Calendar connected to Uriel's account (via the OneCLI dashboard's connect flow), confirmed by a real `fetch()` smoke test from inside a household container succeeding against the Calendar API

**Given** Devorah's Google Calendar should be reachable from `dm-with-partner`
**When** this story is done
**Then** the `dm-with-partner` ("Tina") OneCLI identity has Google Calendar connected to Devorah's own account, confirmed the same way

**Given** the wiring is in place
**When** `household`'s agent sends a test message to `dm-with-partner`'s destination and vice versa
**Then** both directions deliver successfully (a real, minimal `send_message` round trip, not just a DB row check)

### Story 1.2: Create an Event on Your Own Calendar

As a NanoClaw user,
I want to ask my agent to create a calendar event with full details,
So that I get a real Google Calendar event without leaving chat — starting with the calendar I can reach directly.

**Acceptance Criteria:**

**Given** a user in `household` asks the agent to create an event with title, location, start/end time, and guest emails, referring to "my calendar" (Uriel, the calendar `household` owns)
**When** `create_calendar_event` runs
**Then** a real event is created via `POST https://www.googleapis.com/calendar/v3/calendars/primary/events` through the gateway's `HTTPS_PROXY`, with every given detail correctly set, and the agent confirms back with the event's details/link (FR1, AD-1, AD-2, AD-6)

**Given** the same request names a time like "Thursday at 3pm"
**When** the event's `dateTime` is constructed
**Then** it carries an explicit `timeZone` resolved via the existing `resolveGroupTimezone` convention — never a bare/UTC datetime (AD-13)

**Given** the request is made from `dm-with-partner` ("Tina") asking to create an event on Devorah's own calendar
**When** `create_calendar_event` runs
**Then** the same direct-create path works identically, scoped to Devorah's calendar via `dm-with-partner`'s own OneCLI identity (AD-2, AD-3)

**Given** Google Calendar isn't connected yet under the calling identity
**When** `create_calendar_event` runs
**Then** the gateway's `401`/`403`/`app_not_connected` response (with `connect_url`) is surfaced back to the agent as-is, and the agent presents the connect link per the `onecli-gateway` skill's existing instructions (AD-8)

**Given** the calendar-relevant persona files already contain second-brain-OAuth "never disclose a link" language
**When** the new `container/skills/calendar/SKILL.md` is written
**Then** it explicitly names both flows side by side so the agent can't conflate "never disclose" (second-brain) with "always disclose `connect_url`" (this feature, AD-8) — (AD-14)

### Story 1.3: Read Your Own Calendar

As a NanoClaw user,
I want to ask my agent what's on my calendar,
So that I get a real, current answer without opening Google Calendar myself.

**Acceptance Criteria:**

**Given** a user asks "what's on my calendar today/tomorrow/this week" from the calendar-owning surface (household for Uriel, dm-with-partner for Devorah)
**When** `list_calendar_events` runs
**Then** it queries `GET https://www.googleapis.com/calendar/v3/calendars/primary/events` with the resolved time range and answers from real, current data — never memory or a guess (FR2, AD-1, AD-2)

**Given** a natural-language event reference matches more than one real event
**When** `list_calendar_events` runs
**Then** it presents a numbered candidate list and waits for a pick — same-turn, same-container, matching `documents.ts`'s precedent (AD-7, same-owner case only)

**Given** a request names both calendars in one message ("what's on mine and Devorah's")
**When** `list_calendar_events` runs
**Then** it's issued once per named calendar, never a single combined call, and never silently drops the second one (AD-11) — for this story, this AC covers only the case where the requester can reach both directly (e.g. a future combined-identity scenario); the cross-person half is covered by Story 1.4/1.6's relay

### Story 1.4: Create an Event on Someone Else's Calendar (Relay)

As a NanoClaw user,
I want to ask my agent to schedule something on the other person's calendar,
So that I don't have to switch to their chat to do it myself.

**Acceptance Criteria:**

**Given** a user in `household` asks the agent to create an event on Devorah's calendar (or a user in `dm-with-uriel` asks for either calendar)
**When** the agent determines it doesn't own the target calendar (AD-2/AD-3)
**Then** it does not call `create_calendar_event` directly — it relays via `send_message` to the owning agent's wired destination (Story 1.1), setting the user's expectation that this isn't instant ("I'll pass this to Devorah's agent, one sec") (AD-3, AD-4)

**Given** a relay is being composed
**When** the relaying agent builds the `send_message` text
**Then** it resolves and restates every field it has (title, start, end, timezone, location, attendees, and who's asking) as explicit prose, tagged `[calendar-relay-request]` — never forwards the user's raw phrasing verbatim (AD-9, AD-10)

**Given** the owning agent receives a `[calendar-relay-request]`-tagged message
**When** it performs the real `create_calendar_event` call
**Then** it replies via its own `send_message`, tagged `[calendar-relay-result]`, back to the original requester's destination

**Given** a `[calendar-relay-result]`-tagged message arrives at either agent
**When** it's processed
**Then** it's treated as terminal — never re-relayed or re-acted on as a fresh request (AD-9)

**Given** the request doesn't explicitly name whose calendar "my calendar" means, and it's asked in the shared `household` chat
**When** the agent resolves "my"
**Then** it reads the actual sender's identity against `groups/household/memory/household/people.md` (or the equivalent group's memory) — never defaults to Uriel just because that's the locally-connected calendar (AD-5)

### Story 1.5: Update an Event on Your Own Calendar

As a NanoClaw user,
I want to ask my agent to change an event's time, location, guests, or description,
So that I can fix a mistake or reschedule without recreating the event.

**Acceptance Criteria:**

**Given** a user asks to change a specific detail of an existing event on the calendar their surface owns
**When** `update_calendar_event` runs
**Then** it issues `PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/{eventId}` with only the changed field(s) set, and the rest of the event is unchanged (FR3, AD-1, AD-2, AD-6)

**Given** the changed field is a time
**When** the new `dateTime` is constructed
**Then** it carries an explicit `timeZone` the same way Story 1.2 requires for creation (AD-13)

**Given** the event reference is ambiguous
**When** `update_calendar_event` runs
**Then** it presents a numbered candidate list and waits for a pick, same-turn/same-container — the same-owner half of AD-7

### Story 1.6: Update an Event on Someone Else's Calendar (Relay)

As a NanoClaw user,
I want to ask my agent to reschedule or edit something on the other person's calendar,
So that I get the same convenience for updates that Story 1.4 gave for creation.

**Acceptance Criteria:**

**Given** a user asks to update an event on a calendar their surface doesn't own
**When** the agent relays the request
**Then** it reuses Story 1.4's relay mechanics in full — `[calendar-relay-request]`/`[calendar-relay-result]` marking (AD-9), field-complete composition (AD-10), async expectation-setting (AD-4), sender-identity resolution for an unqualified "my event" (AD-5)

**Given** the reference to the target event is ambiguous on the *owning* agent's side
**When** disambiguation is needed
**Then** the owning agent builds the candidate list and relays it back (`[calendar-relay-result]`-tagged, listing candidates) to the original requester's destination; the user's pick flows back through another relay round trip to complete the update — the cross-person half of AD-7, the hardest orchestration case in this epic

**Given** the picked candidate is relayed back
**When** the owning agent receives the pick
**Then** it completes the `PATCH` against the correct event and sends a final `[calendar-relay-result]` confirmation — no more than the two relay round trips (list request → candidate list back, pick forward → confirmation back) this flow requires
