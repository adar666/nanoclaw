---
title: 'Create an Event on Your Own Calendar'
type: 'feature'
created: '2026-08-17'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '70cfafd'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There's no way to create a real Google Calendar event from chat. `save_document`/`fill_document_field`-class tools exist for documents; nothing exists for a calendar.

**Approach:** A new `create_calendar_event` MCP tool, direct-path only (no relay — that's Story 1.4). It makes one `fetch()` call to `POST https://www.googleapis.com/calendar/v3/calendars/primary/events` through the container's already-injected `HTTPS_PROXY`, using the group's existing timezone convention for correct `dateTime`/`timeZone` construction, and the gateway's own `connect_url` error contract for the not-connected-yet case. This story also closes a real TLS-trust gap found during architecture review (AD-15): the gateway's CA cert reaches the container via `SSL_CERT_FILE`, but Bun's `fetch()` only reads `NODE_EXTRA_CA_CERTS` — without a shim, every calendar `fetch()` call would fail TLS verification.

## Boundaries & Constraints

**Always:**
- New MCP tool `create_calendar_event`, registered in a new `container/agent-runner/src/mcp-tools/calendar.ts` via the existing `McpToolDefinition` + `registerTools()` convention (AD-6).
- Tool arguments: `title` (string, required), `start` (string, required — naive local wall-clock, e.g. `"2026-08-20T15:00:00"`, no offset/Z), `end` (string, required, same shape), `description` (string, optional), `location` (string, optional), `guests` (array of email strings, optional).
- `start`/`end` are converted to UTC via `parseZonedToUtc(input, TIMEZONE)` (reused unmodified from `container/agent-runner/src/timezone.ts` — do not reimplement) — `TIMEZONE` is that same module's already-resolved container timezone constant. The Google Calendar event body's `start`/`end` carry both `dateTime` (the resulting UTC ISO string) **and** `timeZone` (the `TIMEZONE` constant) — never a bare/UTC-only datetime with no `timeZone` field (AD-13).
- The actual HTTP call is `fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(eventBody) })` — no Google API client library (AD-6). `guests`, if given, map to the event body's `attendees: [{email}, ...]`.
- **TLS-trust shim (AD-15, required, not optional):** at agent-runner startup — before any calendar tool can be called — `process.env.NODE_EXTRA_CA_CERTS ??= process.env.SSL_CERT_FILE` when `SSL_CERT_FILE` is set and `NODE_EXTRA_CA_CERTS` isn't already. A one-line, defensive addition near the top of the agent-runner's entrypoint (`container/agent-runner/src/index.ts` or wherever the process first initializes — research the exact right spot, it must run before any MCP tool call is possible).
- A non-2xx response from the gateway is inspected for the OneCLI error-JSON shape (`connect_url`/`secret_url`/`manage_url`) — reuse the parsing pattern already proven in `container/agent-runner/src/upload-trace.ts`'s `notSignedInMessage` (read it, follow its shape, don't reinvent) — and surfaced to the agent with that link, so the agent can present it per the `onecli-gateway` skill's existing instructions (AD-8).
- New `container/skills/calendar/SKILL.md`: teaches the agent when/how to use `create_calendar_event`, and explicitly distinguishes "second-brain OAuth" (never disclose a link — existing rule, unchanged) from "OneCLI Google Calendar app connection" (always disclose `connect_url`) side by side, so the two can't be conflated (AD-14).
- A successful create replies with the event's real Google-assigned link (`htmlLink` from the API response) and the details that were set — never a synthetic/local confirmation.

**Ask First:**
- If the exact TLS-trust shim location in agent-runner's startup sequence isn't obvious (e.g. multiple entrypoints, unclear module-load order) — research the codebase's actual boot sequence and pick the earliest safe point; only HALT if no single point exists where it's guaranteed to run before any tool call.
- If Google Calendar's `events.insert` response shape differs materially from what's expected (missing `htmlLink`, different attendee-echo shape) — adapt to the real response; only HALT if the API's actual behavior is genuinely ambiguous after checking the real response in a live test.

**Never:**
- Never relays to another agent in this story — that's Story 1.4. A request for a calendar this container doesn't own is out of scope here (the persona/skill instructions for recognizing "not my calendar" and relaying come in Story 1.4; this story's tool simply always targets `calendarId=primary` under whichever identity is running).
- Never adds a Google API client library dependency.
- Never sends a bare/UTC-only `dateTime` with no `timeZone`.
- Never treats the TLS shim as optional or skips its live verification.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Create with full details | title, start, end, location, description, guests, this identity's Calendar connected | Real event created via `POST .../events`, confirmed back with `htmlLink` and the details set | N/A |
| Create with only required fields | title, start, end only | Event created, no location/description/attendees fields sent (not empty strings) | N/A |
| Timezone construction | start="2026-08-20T15:00:00" (naive), group TZ e.g. Asia/Jerusalem | Event's `dateTime`/`timeZone` reflect a real 15:00 Asia/Jerusalem instant, verified by reading back the created event | N/A |
| Calendar not connected yet | Gateway returns 401/403 with `connect_url` in the error body | Tool surfaces `connect_url` in its response text; agent presents it per onecli-gateway skill | MCP error text, not a crash |
| TLS shim absent (regression check) | `NODE_EXTRA_CA_CERTS` unset, `SSL_CERT_FILE` set | Shim sets `NODE_EXTRA_CA_CERTS` before the tool's first fetch — verified with a real fetch through the real running gateway, not just a unit test | N/A |
| Malformed/missing required arg | `title` or `start`/`end` missing | Declines clearly, no partial API call attempted | MCP error text |

</frozen-after-approval>

## Code Map

- New file `container/agent-runner/src/mcp-tools/calendar.ts` — `createCalendarEventImpl` + exported `createCalendarEvent: McpToolDefinition`, registered via `registerTools([createCalendarEvent])` (new call, or added to an existing barrel import in `mcp-tools/index.ts` if one exists — check the pattern `documents.ts`/`core.ts` already use).
- `container/agent-runner/src/timezone.ts` — reuse `TIMEZONE` and `parseZonedToUtc` unmodified. Do not add a second timezone-resolution path.
- `container/agent-runner/src/upload-trace.ts:73-102` (`notSignedInMessage`) — reference shape for parsing the gateway's error JSON (`connect_url`/`secret_url`/`manage_url`) and building a user-facing message; adapt for the calendar tool's own message text (Google Calendar is an OAuth app, so `connect_url` is the expected field — `secret_url` was HF's API-key-flavored case, may not apply here, but keep the fallback pattern).
- Agent-runner startup/entrypoint (research exact file — likely `container/agent-runner/src/index.ts` or the poll-loop's own init) — add the one-line `NODE_EXTRA_CA_CERTS ??= SSL_CERT_FILE` shim (AD-15) as early as possible, before any MCP tool server starts accepting calls.
- `container/skills/calendar/SKILL.md` — new file (AD-14): when to use `create_calendar_event`, the second-brain-vs-calendar OAuth distinction, and a note that this story doesn't yet support the other person's calendar (Story 1.4 will).
- `src/container-runner.ts:627-630` — reference only, confirms `onecli.ensureAgent`/`applyContainerConfig` are already wired per agent-group; no change needed here.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/src/index.ts` -- `NODE_EXTRA_CA_CERTS ??= SSL_CERT_FILE`-equivalent shim (AD-15) + the critical `nanoclaw` MCP server `env: {}` → `env: { ...process.env }` fix (see Spec Change Log)
- [x] `container/agent-runner/src/mcp-tools/calendar.ts` -- `create_calendar_event` tool: arg validation, timezone conversion, `fetch()` call, gateway-error parsing, success response
- [x] `container/agent-runner/src/mcp-tools/calendar.test.ts` -- bun:test coverage for the I/O matrix above (mock `fetch` for unit tests; a real end-to-end call against the actual gateway is a separate, manual verification step — this story's tests do not require live Google Calendar credentials to pass)
- [x] `container/skills/calendar/SKILL.md` -- new skill file (AD-14)

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs, then all tests pass using mocked `fetch` responses (real credentials aren't available in the test sandbox).
- Given a real container build with Uriel's Google Calendar connected under household's OneCLI identity, when a user asks the agent to create an event with full details, then a real event appears in the actual Google Calendar with every detail correctly set — verified by fetching it back via `list_calendar_events`-equivalent or the returned `htmlLink`, not just "the tool returned ok()".
- Given the same real container, when the TLS-trust shim is checked, then a real `fetch()` call through the gateway succeeds without a TLS error — this is the AD-15 gap's actual closure, must be confirmed live, not assumed.

## Spec Change Log

- 2026-08-17 (implementation, well-justified deviation from literal Boundary text): the frozen Boundaries specify `NODE_EXTRA_CA_CERTS ??= SSL_CERT_FILE`. The implementation uses an explicit `if (SSL_CERT_FILE && !NODE_EXTRA_CA_CERTS)` guard instead — `??=` on a `process.env` key would coerce a genuinely-unset value through `undefined`-stringification in a way this codebase's own conventions avoid; the explicit guard is behaviorally equivalent and safer. Verified by `tls-shim.test.ts`'s dedicated case for a pre-existing `NODE_EXTRA_CA_CERTS` value.

- 2026-08-17 (code review — blind-hunter/edge-case-hunter/verification-gap, 6 patch findings applied, 1 CRITICAL pre-existing bug found and fixed, rest deferred): all three review lenses independently converged on the same critical finding, which I then verified myself by reading the actual installed `@modelcontextprotocol/sdk` package and grepping the compiled Claude Code binary directly: `container/agent-runner/src/index.ts`'s `nanoclaw` MCP server entry used `env: {}` (pre-existing code, predating this story) — the MCP stdio transport spawns each server with a curated 6-variable safe-list (`HOME`/`LOGNAME`/`PATH`/`SHELL`/`TERM`/`USER`) merged with the server's own `env`, never full `process.env` by default. An empty `env: {}` meant the subprocess actually running `calendar.ts`'s `fetch()` never received `HTTPS_PROXY`, `SSL_CERT_FILE`, or `NODE_EXTRA_CA_CERTS` at all — not just breaking AD-15's TLS shim, but AD-1's entire premise that calendar calls route through the OneCLI gateway. Every real call would have gone straight to Google with zero credential injection and failed outright. Fixed to `env: { ...process.env }` (correct here since `nanoclaw` is this codebase's own first-party server, not an untrusted third party — the curated-default security rationale doesn't apply), with a new structural regression test (`index.wiring.test.ts`) asserting the source text never regresses to a literal `env: {}` again — confirmed to actually catch the regression by reverting the fix locally, watching the test fail, then restoring it. Also fixed: no local chronological validation (`end <= start` silently sent to Google unvalidated); no per-item guest-email format validation (non-string/malformed entries silently coerced into bogus attendees); a blanket 401/403 → "not connected" relabeling that discarded the real error body whenever no setup URL was actually found in it (masking real Google errors like quota/scope/permission issues as a false "reconnect" prompt); no request timeout (an unbounded `fetch()` could hang the whole agent turn — now a 30s `AbortSignal.timeout`); and a guest-confirmation message built from the request body rather than what Google's response actually echoed back (a dropped/rejected guest would have been falsely confirmed as invited). **Deferred, not fixed** (logged to `ARCHITECTURE-SPINE.md`'s Deferred section): no idempotency/`iCalUID` dedup key against a duplicate retry; raw network-error messages surfaced verbatim to chat text (minor infra-detail-leak risk); `SKILL.md` wording around a real (non-not-connected) 403 case, moot once the blanket-relabeling fix landed. **Verified independently**, not just self-reported: re-ran `cd container/agent-runner && bun test` three times (340 pass, 8 skip, 0 fail every run) and `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (clean) myself after the patch round, and independently confirmed the critical `index.ts` fix by reading the actual diff before accepting the implementer's report.

## Design Notes

`parseZonedToUtc`'s own doc comment already covers the DST-boundary edge case (~1h off for ~1h of wall-clock time per year near a transition) — acceptable per that module's existing precedent, not something this story needs to solve better.

For the gateway error-parsing reuse: `upload-trace.ts`'s `notSignedInMessage` is written for a specific HF-flavored error shape (`secret_url` for an unknown host). Google Calendar is a first-class OAuth app in the gateway (confirmed: `onecli apps list` shows `google-calendar` as a real configurable app), so the more likely field is `connect_url` — adapt the parsing logic's *shape* (try each field, fall back gracefully) rather than copying HF-specific wording.

Testing the TLS shim without live credentials: the shim itself (setting an env var) is trivially unit-testable in isolation (assert `process.env.NODE_EXTRA_CA_CERTS` after calling the shim function with various starting states). The *actual* TLS-handshake verification against the real gateway can only be confirmed with a real container + real connected calendar — flag this clearly as a manual, post-implementation verification step in the report, not something the automated test suite can cover.

## Verification

**Commands:**
- `cd container/agent-runner && bun test` -- expected: all pass (mocked fetch)
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors
- `./container/build.sh build` -- expected: succeeds (no new dependency)
- Manual, post-build: a real `create_calendar_event` call from inside a real household container, with Uriel's calendar connected, confirming (a) no TLS error and (b) a real event appears in the real calendar.

## Suggested Review Order

- Start here -- the critical env-inheritance fix and why it's correct.
  [`index.ts:91-116`](../../container/agent-runner/src/index.ts#L91), [`index.wiring.test.ts`](../../container/agent-runner/src/index.wiring.test.ts)
- TLS shim (AD-15), now actually reachable thanks to the fix above.
  [`tls-shim.ts`](../../container/agent-runner/src/tls-shim.ts)
- Tool handler -- arg validation, timezone conversion, guest-email validation, chronological check, timeout, gateway-error handling.
  [`calendar.ts:132`](../../container/agent-runner/src/mcp-tools/calendar.ts#L132)
- Test suite.
  [`calendar.test.ts:35`](../../container/agent-runner/src/mcp-tools/calendar.test.ts#L35)
- Agent-facing usage guide.
  [`SKILL.md`](../../container/skills/calendar/SKILL.md)
