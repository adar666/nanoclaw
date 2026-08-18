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
NFR2: Two named calendars only, addressed explicitly by name (`uriel`/`devorah`) — never inferred silently.
NFR3: Credentials never pass through chat, code, or env vars — routed exclusively through the OneCLI Gateway proxy.
NFR4: If a request targets a calendar whose OAuth isn't connected yet, the tool declines clearly with instructions to connect it — never silently falls back or fails opaquely.
NFR5: The target calendar is always an explicit selection — never inferred/guessed when ambiguous; the agent asks.
NFR6: All calendar writes are triggered by an explicit user chat instruction in the same turn — no autonomous/background writes.

### Additional Requirements

> **Pivot, 2026-08-17** (live-verified — see `ARCHITECTURE-SPINE.md`'s memlog): OneCLI's Google Calendar OAuth is one connection per *project*, not one per agent identity as originally architected. Revised to a single-connection design: one connected Google account (Uriel's), reaching Devorah's calendar via Google Calendar's own native sharing (she grants the connected account "Make changes to events" access — no second OAuth grant, no agent involvement on her side). AD-2/AD-3 revised in place; AD-4/AD-9/AD-10 retired (ids kept, not reused, per this project's convention). Confirmed end-to-end with a real live call: `calendar: 'uriel'` created a real event with a real link; `calendar: 'devorah'` correctly failed with a real Google 403 (not-yet-shared) before she completed the sharing step.

- **AD-1** Calendar access via the existing OneCLI Gateway transparent HTTPS proxy — direct `fetch()` calls to the real Google Calendar REST API v3 URL from inside the container. No new credential plumbing.
- **AD-2** [REVISED] One Google connection; a `calendar` argument (`uriel`|`devorah`) selects the `calendarId` (`primary`, or Devorah's own email) — never inferred from which container/identity is calling, since only one connection exists project-wide.
- **AD-3** [REVISED] Devorah's calendar is reached via Google-native sharing (she shares her calendar with the connected account, granting edit access) — not a second OAuth connection. No cross-agent relay anywhere in this design; any of the three chat surfaces calls either calendar directly through the one connected identity.
- **AD-4** [RETIRED] Cross-person relay latency — moot, no relay exists.
- **AD-5** [tightened, repurposed] Sender-to-person resolution reads from the group's own existing OKF memory (e.g. `groups/household/memory/household/people.md`) — never a hardcoded name. An unmatched/ambiguous sender is asked, never guessed. Now picks the `calendar` argument value directly, not which agent to relay to.
- **AD-6** New MCP tools — `create_calendar_event`, `list_calendar_events`, `update_calendar_event` — live in a new `container/agent-runner/src/mcp-tools/calendar.ts`, registered via the existing `McpToolDefinition` + `registerTools()` convention. Direct `fetch()` against Google Calendar REST API v3, no new client-library dependency.
- **AD-7** [tightened, simplified] Ambiguous event reference: numbered candidate list, never guess. Always same-turn, same-container — the cross-relay disambiguation variant no longer applies (no relay).
- **AD-8** A `401`/`403`/`app_not_connected` gateway response (carrying `connect_url`) is surfaced back to the agent as-is — the `onecli-gateway` skill's existing instructions already cover presenting that link. No new connection-status code. A real permissions error (e.g. Devorah's calendar not yet shared) is a genuinely distinct error, never relabeled as "not connected."
- **AD-9** [RETIRED] Relay request/result marking — moot, no relay exists.
- **AD-10** [RETIRED] Field-complete relay composition — moot, no relay exists.
- **AD-11** One tool call per named calendar, never a combined call — a request naming both calendars issues one call per calendar named (same `calendar`-argument mechanism, called twice).
- **AD-13** Every event `dateTime` carries an explicit `timeZone` field resolved via this codebase's existing group-timezone convention (`resolveGroupTimezone`) — never a bare/UTC-assumed datetime, never a second timezone-resolution path.
- **AD-14** `container/skills/calendar/SKILL.md` explicitly distinguishes "second-brain OAuth" (never disclose a link, existing rule) from "OneCLI Google Calendar app connection" (always disclose `connect_url`, AD-8) — named side by side so the agent can't conflate them.
- **AD-15** `NODE_EXTRA_CA_CERTS ??= SSL_CERT_FILE` shim closes a real TLS-trust gap in `fetch()`'s CA handling for the gateway's MITM proxy — plus a critical, pre-existing sibling fix (the `nanoclaw` MCP server's spawn `env: {}` → `env: { ...process.env }`, found in the same review round) without which no calendar `fetch()` call could reach the gateway at all.
- Operational prerequisite (not code, and not blocking): Devorah shares her Google Calendar with the connected account before her calendar is reachable — a one-time action in her own Google Calendar app.
- Deferred (spine-acknowledged, not built now): no idempotency/duplicate-request guard on `create_calendar_event`; recurring events; calendars beyond Uriel's/Devorah's; automatic guest-list validation against household memory.
- ~~Deletion/cancellation~~ — **built, 2026-08-18**, bounded change (no new story number): `delete_calendar_event`, blocking on a real tool-internal confirmation (an initial `confirm: boolean`-argument design was replaced the same day after a live incident showed the agent could — and did — self-authorize past it; see `ARCHITECTURE-SPINE.md`'s Deferred section). See `SPEC-google-calendar`'s Non-goals section and `calendar.ts`.

### UX Design Requirements

N/A — no UX design contract exists and none is needed. This feature has no UI surface; all interaction is conversational, through channels already wired.

### FR Coverage Map

| Requirement | Capability | Governing AD(s) |
| --- | --- | --- |
| FR1 | CAP-1 | AD-1, AD-2, AD-3, AD-5, AD-6, AD-8, AD-11, AD-13, AD-14, AD-15 |
| FR2 | CAP-2 | AD-1, AD-2, AD-3, AD-6, AD-7, AD-8, AD-11, AD-14, AD-15 |
| FR3 | CAP-3 | AD-1, AD-2, AD-3, AD-5, AD-6, AD-7, AD-8, AD-11, AD-13, AD-14, AD-15 |
| NFR1, NFR2, NFR3 | CAP-1, CAP-2, CAP-3 | AD-1, AD-2, AD-3 |
| NFR4 | CAP-1, CAP-2, CAP-3 | AD-8 |
| NFR5 | CAP-1, CAP-2, CAP-3 | AD-5, AD-7 |
| NFR6 | CAP-1, CAP-3 | (no autonomous-write guard needed — every call is a direct, same-turn tool call) |

## Epic List

### Epic 1: Google Calendar Read/Write
Users can ask the agent to create, read, and update events on either of two Google Calendars (Uriel's, Devorah's) from any of three chat surfaces (household, dm-with-uriel, dm-with-partner) — both reachable through one connected Google account, Devorah's via her own calendar-sharing grant.
**FRs covered:** FR1, FR2, FR3

### FR Coverage Map

FR1: Epic 1 - Create a calendar event, on either named calendar
FR2: Epic 1 - Read/query a calendar's contents
FR3: Epic 1 - Update an existing event, on either named calendar

## Epic 1: Google Calendar Read/Write

Users can create, read, and update events on Uriel's or Devorah's Google Calendar from chat, picking the target by a `calendar` argument — no relay, no per-identity OAuth. Story order: de-risk the core Calendar API integration and timezone handling first (create), then read, then update — mirroring spec-document-memory's "de-risk the hardest capability first" sequencing.

> **Pivot, 2026-08-17** (see epics.md header note and `ARCHITECTURE-SPINE.md`'s memlog): the original Story 1.1 (wire cross-agent destinations + connect two separate OAuth identities) and Stories 1.4/1.6 (cross-agent relay for create/update) are **obsolete** — the mechanism they built for no longer exists. Kept below, struck through, for the historical record rather than deleted outright (matches this project's AD-retirement convention). Story 1.2's actual outstanding work — wire ONE Google connection + confirm it live — is now folded into Story 1.2 itself.

<details>
<summary>~~Story 1.1: Wire Cross-Agent Calendar Access~~ — OBSOLETE, superseded by the pivot</summary>

Originally: wire 6 bidirectional agent-type destinations + connect two separate OAuth identities (one per person). Superseded: OneCLI only supports one Google Calendar connection per project — there was never a second identity to connect. The destinations themselves were wired and a real `send_message` round trip was verified (harmless, generally-useful leftover infrastructure) but the story's calendar-specific purpose no longer applies.

</details>

### Story 1.2: Create an Event on Uriel's or Devorah's Calendar

As a NanoClaw user,
I want to ask my agent to create a calendar event with full details, on either my calendar or Devorah's,
So that I get a real Google Calendar event without leaving chat.

**Acceptance Criteria:**

**Given** the one Google account this system connects (Uriel's) — done, live-verified
**When** a user asks the agent to create an event with title, location, start/end time, and guest emails, naming `calendar: uriel`
**Then** a real event is created via `POST https://www.googleapis.com/calendar/v3/calendars/primary/events` through the gateway's `HTTPS_PROXY`, with every given detail correctly set, and the agent confirms back with the event's details/link — **confirmed live**, real event created with a real `htmlLink` (FR1, AD-1, AD-2, AD-6)

**Given** the same request names a time like "Thursday at 3pm"
**When** the event's `dateTime` is constructed
**Then** it carries an explicit `timeZone` resolved via the existing `resolveGroupTimezone` convention — never a bare/UTC datetime (AD-13)

**Given** a request names `calendar: devorah`
**When** `create_calendar_event` runs
**Then** it targets `calendarId=<Devorah's email>` on the same connected account — **confirmed live**: before she shares her calendar, this correctly fails with a real Google `403 requiredAccessLevel` (writer access needed), not a generic/misleading error; once she shares with "Make changes to events" access, the same call succeeds (AD-2, AD-3)

**Given** Google Calendar isn't connected yet under the calling identity
**When** `create_calendar_event` runs
**Then** the gateway's `401`/`403`/`app_not_connected` response (with `connect_url`) is surfaced back to the agent as-is, and the agent presents the connect link per the `onecli-gateway` skill's existing instructions (AD-8)

**Given** the calendar-relevant persona files already contain second-brain-OAuth "never disclose a link" language
**When** the new `container/skills/calendar/SKILL.md` is written
**Then** it explicitly names both flows side by side so the agent can't conflate "never disclose" (second-brain) with "always disclose `connect_url`" (this feature, AD-8) — (AD-14)

**Given** the `nanoclaw` MCP server's env was found broken during review (`env: {}`, dropping `HTTPS_PROXY`/`SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` from every MCP tool's subprocess, not just this one)
**When** it's fixed
**Then** `env: { ...process.env }`, with a structural regression test — this was the actual root blocker for the whole capability, not just the TLS shim (AD-15)

### Story 1.3: Read Your Own Calendar

As a NanoClaw user,
I want to ask my agent what's on my calendar,
So that I get a real, current answer without opening Google Calendar myself.

**Acceptance Criteria:**

**Given** a user asks "what's on my calendar today/tomorrow/this week", naming (or having resolved, per AD-5) `calendar: uriel` or `calendar: devorah`
**When** `list_calendar_events` runs
**Then** it queries `GET https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events` with the resolved time range and answers from real, current data — never memory or a guess (FR2, AD-1, AD-2)

**Given** a natural-language event reference matches more than one real event
**When** `list_calendar_events` runs
**Then** it presents a numbered candidate list and waits for a pick — same-turn, same-container, matching `documents.ts`'s precedent (AD-7)

**Given** a request names both calendars in one message ("what's on mine and Devorah's")
**When** `list_calendar_events` runs
**Then** it's issued once per named calendar, never a single combined call, and never silently drops the second one (AD-11)

**Given** the request doesn't explicitly name whose calendar "my calendar" means, and it's asked in the shared `household` chat
**When** the agent resolves "my"
**Then** it reads the actual sender's identity against `groups/household/memory/household/people.md` — never defaults to Uriel just because that's the connected account's own calendar (AD-5)

<details>
<summary>~~Story 1.4: Create an Event on Someone Else's Calendar (Relay)~~ — OBSOLETE, superseded by the pivot</summary>

Originally: recognize a request for the calendar this container's identity doesn't own, relay it via `send_message` with request/result marking and field-complete composition. Superseded: there's no "owned by this identity" concept anymore (AD-2) — every calendar is reachable directly via the `calendar` argument, so there's nothing to relay. Folded into Story 1.2 (both calendars, one tool, no relay).

</details>

### Story 1.5: Update an Event on Uriel's or Devorah's Calendar

As a NanoClaw user,
I want to ask my agent to change an event's time, location, guests, or description,
So that I can fix a mistake or reschedule without recreating the event.

**Acceptance Criteria:**

**Given** a user asks to change a specific detail of an existing event, naming (or resolved via AD-5) which calendar it's on
**When** `update_calendar_event` runs
**Then** it issues `PATCH https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}` with only the changed field(s) set, and the rest of the event is unchanged (FR3, AD-1, AD-2, AD-6)

**Given** the changed field is a time
**When** the new `dateTime` is constructed
**Then** it carries an explicit `timeZone` the same way Story 1.2 requires for creation (AD-13)

**Given** the event reference is ambiguous
**When** `update_calendar_event` runs
**Then** it presents a numbered candidate list and waits for a pick, same-turn/same-container (AD-7)

<details>
<summary>~~Story 1.6: Update an Event on Someone Else's Calendar (Relay)~~ — OBSOLETE, superseded by the pivot</summary>

Originally: the hardest orchestration case in the epic — relay an update request, disambiguate cross-person, relay the pick back. Superseded for the same reason as Story 1.4: no relay needed. Folded into Story 1.5.

</details>
