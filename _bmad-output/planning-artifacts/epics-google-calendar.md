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
FR4 (added 2026-08-18, Epic 2 spec revision): A duplicate or retried `create_calendar_event` call must not silently double-book — it declines, dedupes, or asks instead.
FR5 (added 2026-08-18, Epic 2 spec revision): A user can ask the agent to create a recurring event ("every Thursday at 3pm").
FR6 (added 2026-08-18, Epic 2 spec revision): A user can reach a calendar beyond Uriel's/Devorah's through the same tools, added via config, not code.
FR7 (added 2026-08-18, Epic 2 spec revision): A guest named by first name only is checked against household memory automatically.

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
- ~~Deferred (spine-acknowledged, not built now): no idempotency/duplicate-request guard on `create_calendar_event`; recurring events; calendars beyond Uriel's/Devorah's; automatic guest-list validation against household memory.~~ — **superseded 2026-08-18**: spec revised (CAP-4..CAP-7 added), architecture spine extended (AD-16..AD-19). See Epic 2 below.
- ~~Deletion/cancellation~~ — **built, 2026-08-18**, bounded change (no new story number): `delete_calendar_event`, blocking on a real tool-internal confirmation (an initial `confirm: boolean`-argument design was replaced the same day after a live incident showed the agent could — and did — self-authorize past it; see `ARCHITECTURE-SPINE.md`'s Deferred section). See `SPEC-google-calendar`'s Non-goals section and `calendar.ts`.
- **AD-16** (added 2026-08-18) Idempotency guard: before `create_calendar_event`'s `POST`, a `GET` bracketed by `timeMin`/`timeMax` checks for an existing event on the same `calendarId` at the same timezone-normalized instant, same title, `created` within 10 minutes, and not itself a recurring series. On a hit, blocks via `askUserQuestion` in-process ("create anyway" vs "skip") — never silently decides. Best-effort, not atomic under true concurrency (logged to spine Deferred).
- **AD-17** (added 2026-08-18) Recurring events: `create_calendar_event` gains an optional `recurrence` argument (one RFC5545 `RRULE` string), wrapped as `recurrence: [arg]` in the API body (Google requires an array). Same tool, no new dependency. Editing/cancelling a single occurrence stays a non-goal — not yet structurally enforced (spine Deferred flags this for build-stage verification).
- **AD-18** (added 2026-08-18) Calendars beyond two: the `calendar` argument becomes a DB-backed registry (`name → {calendarId, ownerEmail}`, `container_configs`-style — not a source file, which would need a rebuild). New calendar's owner grants access via the same native-sharing Devorah uses (AD-3). AD-2 revised to point here — `calendar` is no longer a closed `uriel`/`devorah` enum.
- **AD-19** (added 2026-08-18) Guest auto-validation: every non-email guest token resolves against `groups/household/memory/household/people.md` automatically; ambiguous → numbered candidate list (AD-7 precedent); unmatched → asked directly, blocks rather than proceeding silently. Runs before AD-16's duplicate check; both asks are sequential, never simultaneous, in the same turn.

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
| FR4 | CAP-4 | AD-16, AD-13, AD-19 |
| FR5 | CAP-5 | AD-17, AD-16 |
| FR6 | CAP-6 | AD-18, AD-2 |
| FR7 | CAP-7 | AD-19, AD-5, AD-16 |

## Epic List

### Epic 1: Google Calendar Read/Write
Users can ask the agent to create, read, and update events on either of two Google Calendars (Uriel's, Devorah's) from any of three chat surfaces (household, dm-with-uriel, dm-with-partner) — both reachable through one connected Google account, Devorah's via her own calendar-sharing grant. Also covers Story 1.7 (delete), built later as a bounded change, not a new FR.
**FRs covered:** FR1, FR2, FR3

### Epic 2: Calendar Hardening & Extensions — ready-for-dev
Idempotency guard, recurring events, calendars beyond Uriel's/Devorah's, automatic guest validation — spec'd (CAP-4..CAP-7) and architected (AD-16..AD-19). See the epic's own section below.
**FRs covered:** FR4, FR5, FR6, FR7

### FR Coverage Map

FR1: Epic 1 - Create a calendar event, on either named calendar
FR2: Epic 1 - Read/query a calendar's contents
FR3: Epic 1 - Update an existing event, on either named calendar
FR4: Epic 2 - Idempotency guard on event creation
FR5: Epic 2 - Recurring events
FR6: Epic 2 - Calendars beyond Uriel's and Devorah's
FR7: Epic 2 - Automatic guest-list validation against household memory

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

### Story 1.7: Delete an Event on Uriel's or Devorah's Calendar

**Status: done, 2026-08-18** — built as a bounded change outside the original story sequence (added retroactively here for a complete epic record; see this file's own Deferred-list note above and `ARCHITECTURE-SPINE.md`'s Deferred section for the full history, including two same-day live-incident fixes). `delete_calendar_event`: targets by `eventId` or `eventQuery` (same disambiguation as Story 1.5), blocks on a real, tool-internal confirmation (`ask_user_question`, called directly by the handler) before ever issuing the `DELETE` — no `confirm` argument for the agent to set itself. The confirmation card shows a human-facing summary (title, 24h time, location; no raw event id) built separately from the agent-facing result text. See `container/agent-runner/src/mcp-tools/calendar.ts`.

## Epic 2: Calendar Hardening & Extensions

**Status: ready-for-dev** (elaborated 2026-08-18) — spec'd (`SPEC-google-calendar/SPEC.md` CAP-4..CAP-7) and architected (`ARCHITECTURE-SPINE.md` AD-16..AD-19, reviewer-gated: lint clean, web-verified, adversarially reviewed with fixes applied). Story order follows the spine's own dependency shape: idempotency first (touches the same `create_calendar_event` path every other story in this epic also touches), then recurrence, then the registry, then guest validation (lowest-risk, most independent). None of these block anything already shipped in Epic 1.

### Story 2.1: Idempotency Guard on Event Creation

As a NanoClaw user,
I want a duplicate or retried `create_calendar_event` call to never double-book the same event,
So that a retried request (network hiccup, agent retry, two chat surfaces racing) can't silently create two copies of the same meeting.

**Acceptance Criteria:**

**Given** a create request whose `calendarId`, timezone-normalized start instant, and case-insensitive-trimmed title all match an event already on that calendar, `created` within the last 10 minutes
**When** `create_calendar_event` runs
**Then** it does not silently `POST` a second event — it calls `askUserQuestion` in-process, offering "create anyway" vs "skip, likely already exists," and only proceeds on an explicit answer (FR4, AD-16)

**Given** the match check compares start times
**When** two events carry the same local numerals but different `timeZone` values (per AD-13)
**Then** they are correctly treated as different instants, never false-matched (AD-16, AD-13)

**Given** the candidate event has a `recurrence` field set (i.e. is part of a recurring series)
**When** the match check runs
**Then** it is excluded from matching entirely — a recurring series' later occurrence never false-matches a coincidentally same-titled one-off (AD-16, cross-ref AD-17)

**Given** a request also needed AD-19's guest-resolution question
**When** both AD-19 and AD-16 need to ask something in the same turn
**Then** AD-19's question resolves first, AD-16's duplicate check runs second — never simultaneously (AD-16 Ordering rule)

**Known limit (not an AC, recorded so it isn't silently assumed fixed):** this check is best-effort, not atomic — two genuinely-concurrent `create_calendar_event` calls can both pass the pre-check before either `POST` lands. No server-side idempotency-key primitive exists to close this fully (spine Deferred).

Source: `ARCHITECTURE-SPINE.md` AD-16; `SPEC-google-calendar/SPEC.md` CAP-4.

### Story 2.2: Recurring Events

As a NanoClaw user,
I want to create a recurring event ("every Thursday at 3pm"),
So that I don't have to ask the agent to create the same event by hand every week.

**Acceptance Criteria:**

**Given** a request naming a recurrence pattern ("every Thursday at 3pm")
**When** `create_calendar_event` runs with a `recurrence` argument (one RFC5545 `RRULE` string, e.g. `RRULE:FREQ=WEEKLY;BYDAY=TH`)
**Then** the handler wraps it as `recurrence: [recurrenceArg]` in the API request body (Google's `Event.recurrence` is an array of strings, web-verified against `developers.google.com/workspace/calendar/api/v3/reference/events`) and a real recurring event is created, confirmed back with the pattern actually set (FR5, AD-17)

**Given** no recurrence argument is given
**When** `create_calendar_event` runs
**Then** behavior is unchanged from Story 1.2 — a single-occurrence event, exactly as before (AD-17 is additive, no regression)

**Given** a recurring series already exists
**When** a user asks to edit or cancel a single occurrence of it
**Then** this is out of scope for this story (spec non-goal) — **not yet structurally enforced**; before shipping, confirm whether `list_calendar_events` surfaces individual occurrence `eventId`s (`singleEvents=true` semantics) and, if so, decide explicitly whether `update_calendar_event`/`delete_calendar_event` should refuse them (spine Deferred, flagged from the delete-confirmation precedent — don't repeat that trust-only mistake silently)

Source: `ARCHITECTURE-SPINE.md` AD-17; `SPEC-google-calendar/SPEC.md` CAP-5.

### Story 2.3: Calendars Beyond Uriel's and Devorah's

As a NanoClaw user,
I want to reach a third calendar (e.g. a shared family calendar) from the same tools,
So that the agent isn't hard-limited to exactly two named people.

**Acceptance Criteria:**

**Given** a calendar registry stored in a new DB table (`container_configs`-style, mirroring `src/db/container-configs.ts` — not a source file, which would need a rebuild)
**When** an operator adds a `name → {calendarId, ownerEmail}` row for a third calendar
**Then** all four calendar tools (`create`/`list`/`update`/`delete_calendar_event`) resolve that `calendar` argument value the same way they resolve `uriel`/`devorah`, with no code change (FR6, AD-18)

**Given** the new calendar's owner hasn't shared it yet
**When** a tool call targets it
**Then** the same AD-8 not-connected/permissions-error handling applies — a real Google 403 surfaces clearly, not silently mislabeled (AD-18, AD-8)

**Given** existing code/persona text hardcodes `uriel`/`devorah` as the only two valid values (AD-2's original wording)
**When** this story ships
**Then** every such reference is updated to reflect the open registry — AD-2 is already marked `[REVISED]` pointing here; sweep `calendar.ts`, `container/skills/calendar/SKILL.md`, and any validation/enum code for the same assumption (AD-18, AD-2)

Source: `ARCHITECTURE-SPINE.md` AD-18 (supersedes AD-2's original closed enum); `SPEC-google-calendar/SPEC.md` CAP-6.

### Story 2.4: Automatic Guest-List Validation Against Household Memory

As a NanoClaw user,
I want an unresolved guest named by first name only to be checked against household memory automatically,
So that I don't have to spell out an email address the agent could already know.

> **Correction, 2026-08-18** (spec-stage discovery ahead of this story's build — see `ARCHITECTURE-SPINE.md`'s AD-19 revision): `people.md` is free-form prose (mixed Hebrew/English, no fixed schema) — a `calendar.ts` code-level parser would be fragile and break on any hand-edit. AD-5 already established the correct precedent for this exact class of resolution: persona-level, the agent reads its own memory context, never a tool-code parser. This story is therefore a **`container/skills/calendar/SKILL.md`-only change** — the existing `EMAIL_RE`/`validateGuestEmails` in `calendar.ts` already structurally rejects a non-email guest string with a clear error (the "never silently guess" floor); what's missing is an explicit persona instruction to resolve proactively, before the tool call, not only reactively after that rejection.

**Acceptance Criteria:**

**Given** a create/update request naming a guest by a token that isn't a valid email address (e.g. a first name)
**When** the agent prepares to call `create_calendar_event`/`update_calendar_event`
**Then** it looks up `groups/household/memory/household/people.md` itself, proactively, before the call — not only after the tool rejects a bad guest string — and a matched name resolves to its known email with no extra user turn (FR7, AD-19, AD-5)

**Given** more than one household-memory entry plausibly matches the named guest
**When** the agent resolves it
**Then** it presents a numbered candidate list and waits for a pick — same disambiguation precedent as AD-7, never guessed (AD-19)

**Given** no household-memory entry matches at all
**When** the agent resolves it
**Then** it asks the user for the email directly and blocks rather than silently proceeding without it, or calling the tool with a guess (AD-19)

**Given** the agent forgets or skips this persona instruction and calls the tool with a non-email guest string anyway
**When** `create_calendar_event`/`update_calendar_event` runs
**Then** the existing `EMAIL_RE`/`validateGuestEmails` check still rejects it with a clear error — the structural floor holds regardless of persona compliance (unchanged `calendar.ts` behavior, not part of this story's diff)

Source: `ARCHITECTURE-SPINE.md` AD-19 (revised); `SPEC-google-calendar/SPEC.md` CAP-7.
