/**
 * create_calendar_event / list_calendar_events / update_calendar_event /
 * delete_calendar_event — read and write real events on this group's
 * configured Google Calendars via direct `fetch()` calls routed through
 * the container's already-injected `HTTPS_PROXY` — no Google API client
 * library (AD-6).
 *
 * [2026-08-17 pivot — see ARCHITECTURE-SPINE.md AD-2/AD-3] Google Calendar
 * OAuth in OneCLI is one connection per *project*, not per agent identity —
 * live-verified via `onecli apps get --provider google-calendar` (no
 * per-agent scoping exists in the CLI at all). So there is exactly one
 * connected Google account, and which calendar a call targets is picked by
 * the `calendar` argument, resolved to a `calendarId` via `resolveCalendarIds()`
 * below — **not** a closed `"uriel"`/`"devorah"` set (AD-18, Story 2.3: a
 * config-driven registry extends it) — never by which container/identity
 * happens to be calling. Each configured calendar is reachable because its
 * owner shares it with the
 * connected account (Google Calendar's own sharing, not a second OAuth
 * grant) — the already-granted `calendar.events` scope covers editing
 * events on any calendar the connected account can access, not just its
 * own `primary`.
 *
 * TLS trust: the gateway's CA cert reaches this container only through
 * `SSL_CERT_FILE`; Bun's `fetch()` reads `NODE_EXTRA_CA_CERTS` instead. The
 * shim that bridges the two (`../tls-shim.js`, AD-15) runs at agent-runner
 * startup (see `index.ts`), before this tool's `fetch()` can ever run.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { TIMEZONE, parseZonedToUtc, formatLocalTime } from '../timezone.js';
import type { McpToolDefinition } from './types.js';
import { registerTools } from './server.js';
import { askUserQuestion } from './interactive.js';
import { getConfig } from '../config.js';

/**
 * The two built-in calendars (spec cal-2.3: these stay hardcoded defaults,
 * unchanged behavior, no migration-time personal data). "uriel" maps to the
 * connected account's own calendar; "devorah" to her calendar, reachable
 * because she shares it with the connected account (AD-3) — not a second
 * OAuth connection. Matches `groups/household/memory/household/people.md`'s
 * recorded email for Devora.
 *
 * Do NOT reference this constant directly in a tool handler — call
 * `resolveCalendarIds()` instead, which merges this with the per-group
 * config registry (config entries win on a name collision).
 */
const CALENDAR_IDS: Record<string, string> = {
  uriel: 'primary',
  devorah: 'adardevora@gmail.com',
};

/**
 * Exported so tests can substitute the calendar-registry source without
 * going through a real `loadConfig()` file read (`calendar.test.ts` never
 * mounts a real `container.json` and calling `getConfig()` there would throw
 * "Config not loaded") — same testability pattern as `createHooks`/
 * `deleteHooks` below. Production code never overrides this.
 */
export const calendarConfigHooks = {
  getCalendarRegistry: (): Array<{ name: string; calendarId: string }> => getConfig().calendarRegistry,
};

/**
 * Effective calendar name → calendarId map: the built-in `CALENDAR_IDS`
 * merged with this group's config-driven `calendarRegistry`, config entries
 * taking precedence on a name collision (spec cal-2.3 — this is what makes
 * "no code change, ever, for the common case" true).
 *
 * Deliberately called INSIDE each handler body, never at module top level or
 * inside a static `inputSchema` object literal — `getConfig()` throws until
 * `loadConfig()` has run.
 *
 * CORRECTED (live incident, 2026-08-19): this module runs inside the MCP
 * tools stdio-server subprocess (`mcp-tools/index.ts`), a SEPARATE process
 * from `index.ts`'s own `main()` — not the same process as originally
 * assumed here. `main()`'s `loadConfig()` call has no effect in this
 * process; `mcp-tools/index.ts` now calls `loadConfig()` itself for exactly
 * this reason. Before that fix, every calendar tool call failed in
 * production with "Config not loaded" — deterministically, not
 * intermittently, since this subprocess never populated `_config` at all.
 */
function resolveCalendarIds(): Record<string, string> {
  // Object.create(null) — never a plain {} — so a registry entry named
  // "__proto__"/"constructor" (however unlikely, a hand-edited/corrupted
  // row is still possible) can't silently reach Object.prototype instead
  // of becoming a real own property (review finding).
  const merged: Record<string, string> = Object.create(null);
  for (const [name, calendarId] of Object.entries(CALENDAR_IDS)) merged[name] = calendarId;
  const seenRegistryNames = new Set<string>();
  for (const entry of calendarConfigHooks.getCalendarRegistry()) {
    // An empty calendarId would list the name as "resolvable" (error text
    // would offer it) yet still fail as "Unknown calendar" when chosen —
    // skip it instead (review finding).
    if (!entry.calendarId) continue;
    // A name colliding with a built-in (uriel/devorah) is the intended
    // override, not a duplicate — only warn when two REGISTRY entries share
    // a name (hand-edited/corrupted registry; the CLI write path already
    // dedupes by name, so this shouldn't happen via normal use). Otherwise
    // the last entry silently wins with no diagnostic (deferred-work.md
    // finding).
    if (seenRegistryNames.has(entry.name)) {
      log(`calendar registry: duplicate name "${entry.name}" — using the later entry (${entry.calendarId})`);
    }
    seenRegistryNames.add(entry.name);
    merged[entry.name] = entry.calendarId;
  }
  return merged;
}

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function eventsUrl(calendarId: string): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

interface GatewayErrorBody {
  connect_url?: string;
  secret_url?: string;
  manage_url?: string;
}

/**
 * Try to pull a OneCLI setup link out of a non-2xx response body. Adapted
 * from `upload-trace.ts`'s `notSignedInMessage` — same shape (try each
 * field, fall back gracefully), different wording. Google Calendar is a
 * first-class OneCLI OAuth app, so `connect_url` is the expected field;
 * `secret_url` was HF's API-key-flavored case and unlikely here, but the
 * fallback chain is kept for the same reason `upload-trace.ts` keeps it —
 * whichever field the gateway actually sends still resolves to a link.
 */
function extractSetupUrl(bodyText: string): string | undefined {
  try {
    const e = JSON.parse(bodyText) as GatewayErrorBody;
    return e.connect_url ?? e.secret_url ?? e.manage_url;
  } catch {
    return undefined; // not gateway error JSON (e.g. a real Google API error body)
  }
}

function notConnectedMessage(action: string, setupUrl: string): string {
  return `Can't ${action} — this agent's Google Calendar isn't connected yet. Connect it here: ${setupUrl}`;
}

/**
 * Deliberately loose — not RFC-5322-perfect, just enough to reject obvious
 * garbage (a number, `null`, `"[object Object]"`, an empty string) before it
 * becomes a bogus attendee sent to Google.
 */
const EMAIL_RE = /^\S+@\S+\.\S+$/;

function validateGuestEmails(guests: unknown[]): { emails: string[] } | { error: string } {
  const emails: string[] = [];
  for (const g of guests) {
    if (typeof g !== 'string' || !EMAIL_RE.test(g.trim())) {
      return { error: `Invalid guest email: ${JSON.stringify(g)}` };
    }
    emails.push(g.trim());
  }
  return { emails };
}

interface EventBody {
  summary: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  description?: string;
  location?: string;
  attendees?: Array<{ email: string }>;
  // Google's actual wire shape is always an array (RFC5545 lines), even
  // though the tool's own `recurrence` argument is a single RRULE string
  // (spec cal-2.2) — the handler wraps it as `[recurrence]` when building
  // this body. Don't widen the input schema to an array to "match" this;
  // the asymmetry is deliberate (one line is the supported shape for now).
  recurrence?: string[];
}

interface EventsInsertResponse {
  htmlLink?: string;
  summary?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: string;
  description?: string;
  attendees?: Array<{ email?: string }>;
  recurrence?: string[]; // see EventBody.recurrence's comment — same array-vs-single-string asymmetry
}

export const createCalendarEvent: McpToolDefinition = {
  tool: {
    name: 'create_calendar_event',
    description:
      'Create a real event on one of this group\'s configured Google Calendars (at minimum Uriel\'s and ' +
      'Devora\'s; an operator may add more) — all reachable through one connected account, each other ' +
      'calendar via sharing, not a separate connection.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        calendar: {
          type: 'string',
          description:
            "Which calendar to create the event on — one of this group's resolvable calendar names: the " +
            'built-in "uriel"/"devorah" plus any names added to this group\'s calendar registry ' +
            '(`ncl groups config add-calendar`).',
        },
        title: { type: 'string', description: 'Event title/summary.' },
        start: {
          type: 'string',
          description:
            'Start time as naive local wall-clock, no offset/Z (e.g. "2026-08-20T15:00:00"). ' +
            "Interpreted in this group's own configured timezone.",
        },
        end: {
          type: 'string',
          description: 'End time, same naive local wall-clock shape as start.',
        },
        description: { type: 'string', description: 'Optional event description.' },
        location: { type: 'string', description: 'Optional event location.' },
        recurrence: {
          type: 'string',
          description:
            'Optional recurrence rule to make this a repeating event — a single RFC5545 RRULE line, ' +
            'e.g. "RRULE:FREQ=WEEKLY;BYDAY=TH" for every Thursday. Omit for a single-occurrence event.',
        },
        guests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of guest email addresses to invite.',
        },
      },
      required: ['calendar', 'title', 'start', 'end'],
    },
  },
  async handler(args) {
    const calendar = args.calendar as string | undefined;
    const title = args.title as string | undefined;
    const start = args.start as string | undefined;
    const end = args.end as string | undefined;
    const description = args.description as string | undefined;
    const location = args.location as string | undefined;
    const recurrence = args.recurrence as string | undefined;
    const guests = args.guests as unknown;

    const calendarIds = resolveCalendarIds();
    if (!calendar) return err(`calendar is required — one of: ${Object.keys(calendarIds).join(', ')}`);
    const calendarId = calendarIds[calendar];
    if (!calendarId) {
      return err(`Unknown calendar "${calendar}" — must be one of: ${Object.keys(calendarIds).join(', ')}`);
    }
    if (!title) return err('title is required');
    if (!start) return err('start is required');
    if (!end) return err('end is required');
    if (guests !== undefined && !Array.isArray(guests)) {
      return err('guests must be an array of email address strings');
    }
    if (recurrence !== undefined && typeof recurrence !== 'string') {
      return err('recurrence must be a single RFC5545 RRULE string');
    }

    let guestEmails: string[] = [];
    if (Array.isArray(guests) && guests.length > 0) {
      const validated = validateGuestEmails(guests);
      if ('error' in validated) return err(validated.error);
      guestEmails = validated.emails;
    }

    const startUtc = parseZonedToUtc(start, TIMEZONE);
    if (Number.isNaN(startUtc.getTime())) return err(`start is not a valid date/time: "${start}"`);
    const endUtc = parseZonedToUtc(end, TIMEZONE);
    if (Number.isNaN(endUtc.getTime())) return err(`end is not a valid date/time: "${end}"`);
    if (endUtc.getTime() <= startUtc.getTime()) {
      return err(`end ("${end}") must be after start ("${start}")`);
    }

    const eventBody: EventBody = {
      summary: title,
      start: { dateTime: startUtc.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: endUtc.toISOString(), timeZone: TIMEZONE },
    };
    if (description) eventBody.description = description;
    if (location) eventBody.location = location;
    if (recurrence && recurrence.trim()) eventBody.recurrence = [recurrence.trim()];
    if (guestEmails.length > 0) {
      eventBody.attendees = guestEmails.map((email) => ({ email }));
    }

    // Idempotency guard (spec cal-2.1): a retried/racing call must not
    // silently double-book. Reuses fetchEvents — same AD-8 gateway-error
    // handling + 30s timeout as the POST below — bracketed tightly around
    // this event's own [startUtc, endUtc] window (Design Notes: local JS
    // match logic, never Google's own unreliable `q` search). Best-effort
    // only: two genuinely-simultaneous calls can both pass this check
    // before either POST lands.
    const precheck = await fetchEvents(calendarId, {
      timeMinIso: startUtc.toISOString(),
      timeMaxIso: endUtc.toISOString(),
      notConnectedAction: 'create the event',
    });
    if ('error' in precheck) return precheck.error;

    if (precheck.truncated) {
      // Best-effort: a duplicate past the returned page's cutoff can be
      // missed. Logged for diagnosability, not surfaced to the user — the
      // guard still runs against whatever page was returned.
      log(
        `create_calendar_event: pre-check GET truncated (nextPageToken present) for "${title}" on ${calendar}'s calendar — duplicate guard is best-effort`,
      );
    }

    const duplicate = findDuplicateCandidate(precheck.events, title, startUtc, new Date(), Boolean(eventBody.recurrence));
    if (duplicate) {
      const ageDesc = formatAgeDesc(duplicate.ageMs);
      // A recurring create has a bigger blast radius than a one-off (an
      // entire series, not a single event) — say so, since "anyway?" reads
      // identically for both otherwise (spec cal-2.2 review finding).
      const recurringNote = eventBody.recurrence ? ' This would create a recurring series, not a single event.' : '';
      const confirmResult = await createHooks.confirmCreation(
        `This looks like it might already be on ${calendar}'s calendar — created ${ageDesc}:\n` +
          `${formatConfirmationSummary(duplicate.event)}\n\nCreate "${title}" anyway?${recurringNote}`,
      );
      if ('error' in confirmResult) return confirmResult.error;
      if (!confirmResult.confirmed) {
        log(`create_calendar_event: possible duplicate of "${title}" on ${calendar}'s calendar — user skipped`);
        return ok(
          `Not created — "${title}" looks like a duplicate of an event already on ${calendar}'s calendar (created ${ageDesc}).`,
        );
      }
      log(`create_calendar_event: possible duplicate of "${title}" on ${calendar}'s calendar — user confirmed create anyway`);
    }

    let response: Response;
    try {
      response = await fetch(eventsUrl(calendarId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventBody),
        // Bounds a hung gateway/upstream call — without this, a stuck
        // fetch() blocks the MCP tool call (and the agent's whole turn)
        // indefinitely.
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      const msg = e instanceof Error ? e.message : String(e);
      log(`create_calendar_event: fetch failed: ${msg}`);
      if (isTimeout) {
        return err('Timed out waiting for Google Calendar (30s) — the gateway or Google may be unreachable right now.');
      }
      return err(`Could not reach Google Calendar: ${msg}`);
    }

    const bodyText = await response.text();

    if (!response.ok) {
      log(`create_calendar_event: gateway/API returned ${response.status}`);
      const setupUrl = extractSetupUrl(bodyText);
      // Only the not-connected framing when a real setup link was found —
      // a bare 401/403 with no such link is a genuine API error (scope,
      // quota, sharing policy, ...) and must not be relabeled as
      // "reconnect your calendar," which would discard the real cause.
      if (setupUrl) {
        return err(notConnectedMessage('create the event', setupUrl));
      }
      return err(`Google Calendar API returned ${response.status}: ${bodyText.slice(0, 500)}`);
    }

    let event: EventsInsertResponse;
    try {
      event = JSON.parse(bodyText) as EventsInsertResponse;
    } catch {
      log('create_calendar_event: 2xx response body was not valid JSON');
      return err('The event may have been created, but the response could not be read back.');
    }

    const lines = [`Event created: ${event.summary ?? title}`];
    lines.push(
      `When: ${event.start?.dateTime ?? eventBody.start.dateTime} (${event.start?.timeZone ?? TIMEZONE}) ` +
        `→ ${event.end?.dateTime ?? eventBody.end.dateTime} (${event.end?.timeZone ?? TIMEZONE})`,
    );
    if (event.location) lines.push(`Location: ${event.location}`);
    if (event.description) lines.push(`Description: ${event.description}`);
    // Prefer what Google's response actually echoes back over what we sent —
    // if Google dropped, normalized, or rejected a guest silently, the
    // confirmation must reflect that, not just restate the request.
    const confirmedAttendees = event.attendees?.length ? event.attendees : eventBody.attendees;
    const confirmedEmails = confirmedAttendees?.map((a) => a.email).filter((e): e is string => !!e);
    if (confirmedEmails && confirmedEmails.length > 0) lines.push(`Guests: ${confirmedEmails.join(', ')}`);
    // Same echo-preference as attendees above: Google's own response is the
    // source of truth for what recurrence was actually set, falling back to
    // what was sent only if the response happens to omit the field.
    const confirmedRecurrence = Array.isArray(event.recurrence) && event.recurrence.length ? event.recurrence : eventBody.recurrence;
    if (confirmedRecurrence && confirmedRecurrence.length > 0) {
      lines.push(`Recurrence: ${confirmedRecurrence.join(', ')}`);
    }
    if (event.htmlLink) lines.push(`Link: ${event.htmlLink}`);

    log(`create_calendar_event: created "${title}" on ${calendar}'s calendar`);
    return ok(lines.join('\n'));
  },
};

// ---------------------------------------------------------------------------
// Shared read plumbing for list_calendar_events / update_calendar_event's
// search-based disambiguation path (spec cal-1.5: "reuse cal-1.3's search
// logic, don't duplicate it").
// ---------------------------------------------------------------------------

interface EventTimePoint {
  dateTime?: string;
  date?: string; // present instead of dateTime for all-day events
  timeZone?: string;
}

interface CalendarEventItem {
  id: string;
  summary?: string;
  start?: EventTimePoint;
  end?: EventTimePoint;
  location?: string;
  description?: string;
  created?: string;
  /**
   * Present only on a *master* recurring event, absent on an expanded
   * instance. `fetchEvents` sets `singleEvents=true`, so this call path
   * only ever returns instances — this field alone is a no-op as a
   * recurring-series exclusion here; see `recurringEventId` below, and
   * `findDuplicateCandidate`'s guard checks both.
   */
  recurrence?: string[];
  /**
   * Present on every expanded recurring *instance* (absent on a master).
   * The realistic field to check given `singleEvents=true` — see the note
   * on `recurrence` above (spec cal-2.1 review loop 1 correction).
   */
  recurringEventId?: string;
}

interface EventsListApiResponse {
  items?: CalendarEventItem[];
  nextPageToken?: string;
}

/**
 * Google defaults to 250 anyway; set explicitly so `nextPageToken` in the
 * response reliably signals "there were more than this many" (AD: never
 * silently cap/truncate without saying so — spec cal-1.3 Boundaries).
 */
const MAX_RESULTS = 250;

/** Midnight today in TIMEZONE, expressed as a UTC Date. */
function startOfTodayUtc(): Date {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return parseZonedToUtc(`${parts.year}-${parts.month}-${parts.day}T00:00:00`, TIMEZONE);
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve the from/to search window per spec cal-1.3: naive local wall-clock
 * inputs (same shape as create_calendar_event's start/end), defaulting to
 * "today through 7 days from now" in the group's own timezone when either
 * side is omitted. `to`, when omitted, is always `from` (or today) + 7d —
 * not tied to whether `from` itself was given explicitly.
 */
function resolveTimeWindow(
  from: string | undefined,
  to: string | undefined,
): { timeMin: Date; timeMax: Date } | { error: string } {
  let timeMin: Date;
  if (from) {
    timeMin = parseZonedToUtc(from, TIMEZONE);
    if (Number.isNaN(timeMin.getTime())) return { error: `from is not a valid date/time: "${from}"` };
  } else {
    timeMin = startOfTodayUtc();
  }

  let timeMax: Date;
  if (to) {
    timeMax = parseZonedToUtc(to, TIMEZONE);
    if (Number.isNaN(timeMax.getTime())) return { error: `to is not a valid date/time: "${to}"` };
  } else {
    timeMax = new Date(timeMin.getTime() + DEFAULT_WINDOW_MS);
  }

  if (timeMax.getTime() <= timeMin.getTime()) {
    // Interpolate the *resolved* values, not the raw (possibly-omitted)
    // args — if `from` was omitted (defaults to today) and only `to` is
    // invalid, the raw args would literally read `from ("undefined")`.
    return {
      error:
        `to ("${formatLocalTime(timeMax.toISOString(), TIMEZONE)}") must be after ` +
        `from ("${formatLocalTime(timeMin.toISOString(), TIMEZONE)}")`,
    };
  }
  return { timeMin, timeMax };
}

/** Human-readable time range for one event, timezone-displayed (never raw UTC). */
function formatEventTimeRange(start?: EventTimePoint, end?: EventTimePoint): string {
  if (start?.dateTime) {
    const s = formatLocalTime(start.dateTime, TIMEZONE);
    const e = end?.dateTime ? formatLocalTime(end.dateTime, TIMEZONE) : '?';
    return `${s} → ${e}`;
  }
  if (start?.date) {
    if (end?.date && end.date !== start.date) return `All day: ${start.date} → ${end.date}`;
    return `All day: ${start.date}`;
  }
  return 'time unknown';
}

/**
 * One event's id/title/time/location, shared by list_calendar_events'
 * results and update_calendar_event's multi-match candidate list — so a
 * disambiguation candidate list never drops a field (e.g. location) that
 * the list output includes, which would make two same-title/same-time
 * events differing only by location indistinguishable.
 */
function formatEventLine(ev: CalendarEventItem): string {
  const title = ev.summary ?? '(no title)';
  let line = `[${ev.id}] ${title} — ${formatEventTimeRange(ev.start, ev.end)}`;
  if (ev.location) line += ` @ ${ev.location}`;
  return line;
}

/** Human-readable "<start> to <end>" description of a resolved search window. */
function formatRangeDesc(timeMin: Date, timeMax: Date): string {
  return `${formatLocalTime(timeMin.toISOString(), TIMEZONE)} to ${formatLocalTime(timeMax.toISOString(), TIMEZONE)}`;
}

/**
 * `GET .../events` with the query-param shape events.list expects
 * (`timeMin`/`timeMax`/`q`/`singleEvents=true`/`orderBy=startTime`), same
 * gateway-error handling (AD-8) and 30s timeout bound as create's insert
 * call. Returns either the raw events + a truncation flag, or an
 * already-built MCP error result the caller can return directly.
 */
async function fetchEvents(
  calendarId: string,
  params: { timeMinIso: string; timeMaxIso: string; q?: string; notConnectedAction?: string },
): Promise<{ events: CalendarEventItem[]; truncated: boolean } | { error: CallToolResult }> {
  const url = new URL(eventsUrl(calendarId));
  url.searchParams.set('timeMin', params.timeMinIso);
  url.searchParams.set('timeMax', params.timeMaxIso);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(MAX_RESULTS));
  if (params.q) url.searchParams.set('q', params.q);

  let response: Response;
  try {
    response = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const msg = e instanceof Error ? e.message : String(e);
    log(`calendar events list: fetch failed: ${msg}`);
    if (isTimeout) {
      return {
        error: err('Timed out waiting for Google Calendar (30s) — the gateway or Google may be unreachable right now.'),
      };
    }
    return { error: err(`Could not reach Google Calendar: ${msg}`) };
  }

  const bodyText = await response.text();
  if (!response.ok) {
    log(`calendar events list: gateway/API returned ${response.status}`);
    const setupUrl = extractSetupUrl(bodyText);
    if (setupUrl) return { error: err(notConnectedMessage(params.notConnectedAction ?? 'list events', setupUrl)) };
    return { error: err(`Google Calendar API returned ${response.status}: ${bodyText.slice(0, 500)}`) };
  }

  let parsed: EventsListApiResponse;
  try {
    parsed = JSON.parse(bodyText) as EventsListApiResponse;
  } catch {
    log('calendar events list: 2xx response body was not valid JSON');
    return { error: err('The events list could not be read back from the response.') };
  }

  return { events: parsed.items ?? [], truncated: Boolean(parsed.nextPageToken) };
}

/** create_calendar_event's idempotency guard (spec cal-2.1): a candidate must have been created within this window to count as a possible duplicate. */
const DUPLICATE_RECENCY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Find a pre-check candidate that looks like the same event `create_calendar_event`
 * is about to create. A match requires: `start.dateTime` resolving to the same
 * real instant as the new event's own `startUtc` (dateTime always carries its
 * own offset/Z per the Calendar API, so a plain `Date` comparison is already
 * timezone-normalized — never a raw string compare, and never fooled by a
 * candidate sharing the same local numerals but a different `timeZone`) +
 * case-insensitive-trimmed title match + `created` within the last 10
 * minutes, with a clock-skew-safe lower bound (a `created` timestamp in
 * the future yields a negative age, which never matches). A candidate with
 * no `created` field can't have its recency verified and is never treated
 * as a match.
 *
 * A candidate that's part of a recurring series (a master, carrying
 * `recurrence`, or an expanded instance, carrying `recurringEventId` —
 * `fetchEvents` sets `singleEvents=true`, so only instances are ever
 * returned here) is excluded from matching **only when the new request
 * itself is a one-off** — that's the case AD-16 originally wrote this
 * exclusion for: stop an unrelated pre-existing series' occurrence from
 * false-matching a coincidentally same-titled one-off create. Once AD-17
 * added `recurrence` as a `create_calendar_event` argument, applying that
 * same exclusion unconditionally silently defeated the whole guard for the
 * exact case it exists to catch: a retried/racing *recurring* create would
 * always find "no duplicate", because every real candidate (the series it
 * just created) carries `recurringEventId`/`recurrence` and got skipped
 * regardless of what's being created. Retrospective finding (epic-2,
 * cross-story boundary pass) — fixed by keying the exclusion on whether
 * `newRecurrence` is set, not on the candidate alone.
 */
function findDuplicateCandidate(
  events: CalendarEventItem[],
  title: string,
  startUtc: Date,
  now: Date,
  newRecurrence: boolean,
): { event: CalendarEventItem; ageMs: number } | undefined {
  // Collapses internal whitespace too, not just leading/trailing — a
  // realistic copy/paste or agent-generated "Team  Sync" (double space)
  // must still match "Team Sync" (deferred-work.md finding).
  const normalizeTitle = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const normalizedTitle = normalizeTitle(title);
  for (const ev of events) {
    const candidateIsRecurring = Boolean(ev.recurrence || ev.recurringEventId);
    if (candidateIsRecurring && !newRecurrence) continue; // one-off create — an unrelated series is never a match
    if (!ev.start?.dateTime) continue; // all-day or malformed — no instant to compare
    if (new Date(ev.start.dateTime).getTime() !== startUtc.getTime()) continue;
    if (normalizeTitle(ev.summary ?? '') !== normalizedTitle) continue;
    if (!ev.created) continue; // can't verify recency — not treated as a match
    const ageMs = now.getTime() - new Date(ev.created).getTime();
    // Number.isNaN guards an unparseable `created` string: NaN fails both the
    // `< 0` and `> window` comparisons, which would otherwise silently pass
    // the check instead of correctly excluding an unverifiable candidate.
    if (Number.isNaN(ageMs) || ageMs < 0 || ageMs > DUPLICATE_RECENCY_WINDOW_MS) continue;
    return { event: ev, ageMs };
  }
  return undefined;
}

/** "created N minute(s) ago" for the confirmation text — states the candidate's actual age, never a hardcoded guess. */
function formatAgeDesc(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  return minutes < 1 ? 'less than a minute ago' : `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
}

/**
 * Shared search entry point — resolves the from/to window then calls
 * fetchEvents. Both `list_calendar_events` and `update_calendar_event`'s
 * eventQuery disambiguation path call this; neither duplicates the window
 * resolution or the HTTP call (spec cal-1.5 Code Map).
 *
 * Returns the resolved `timeMin`/`timeMax` alongside the events so callers
 * that need to describe the window searched (range-description text, the
 * inverted-window error) reuse this single resolution rather than calling
 * `resolveTimeWindow` a second time — two independent `new Date()`-based
 * resolutions could in principle disagree at a midnight boundary.
 */
async function searchEvents(
  calendarId: string,
  params: { query?: string; from?: string; to?: string },
): Promise<
  | { events: CalendarEventItem[]; truncated: boolean; timeMin: Date; timeMax: Date }
  | { error: CallToolResult }
> {
  const window = resolveTimeWindow(params.from, params.to);
  if ('error' in window) return { error: err(window.error) };
  const fetched = await fetchEvents(calendarId, {
    timeMinIso: window.timeMin.toISOString(),
    timeMaxIso: window.timeMax.toISOString(),
    q: params.query || undefined,
  });
  if ('error' in fetched) return fetched;
  return { ...fetched, timeMin: window.timeMin, timeMax: window.timeMax };
}

export const listCalendarEvents: McpToolDefinition = {
  tool: {
    name: 'list_calendar_events',
    description:
      "List real events on one of this group's configured Google Calendars (at minimum Uriel's and " +
      "Devora's; an operator may add more) — all reachable through one connected account. Use for " +
      '"what\'s on my/their calendar" or "when is X" questions — never answer those from memory or a guess.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        calendar: {
          type: 'string',
          description:
            "Which calendar to list events from — one of this group's resolvable calendar names: the " +
            'built-in "uriel"/"devorah" plus any names added to this group\'s calendar registry ' +
            '(`ncl groups config add-calendar`).',
        },
        from: {
          type: 'string',
          description:
            'Start of the range, naive local wall-clock, no offset/Z (e.g. "2026-08-20T00:00:00"). ' +
            "Interpreted in this group's own configured timezone. Defaults to the start of today.",
        },
        to: {
          type: 'string',
          description: 'End of the range, same naive local wall-clock shape as from. Defaults to 7 days after from.',
        },
        query: {
          type: 'string',
          description: 'Optional free-text search (Google\'s own search, e.g. "dentist") to filter events.',
        },
      },
      required: ['calendar'],
    },
  },
  async handler(args) {
    const calendar = args.calendar as string | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const query = args.query as string | undefined;

    const calendarIds = resolveCalendarIds();
    if (!calendar) return err(`calendar is required — one of: ${Object.keys(calendarIds).join(', ')}`);
    const calendarId = calendarIds[calendar];
    if (!calendarId) {
      return err(`Unknown calendar "${calendar}" — must be one of: ${Object.keys(calendarIds).join(', ')}`);
    }

    const result = await searchEvents(calendarId, { query, from, to });
    if ('error' in result) return result.error;

    const rangeDesc = formatRangeDesc(result.timeMin, result.timeMax);
    const queryDesc = query ? ` matching "${query}"` : '';

    if (result.events.length === 0) {
      return ok(`No events found on ${calendar}'s calendar${queryDesc} between ${rangeDesc}.`);
    }

    const lines = [`Events on ${calendar}'s calendar${queryDesc} (${rangeDesc}):`];
    for (const ev of result.events) {
      lines.push(`- ${formatEventLine(ev)}`);
    }
    if (result.truncated) {
      lines.push(`(Results capped at ${MAX_RESULTS} — there may be more events than shown.)`);
    }

    log(`list_calendar_events: ${result.events.length} event(s) on ${calendar}'s calendar`);
    return ok(lines.join('\n'));
  },
};

interface EventsPatchResponse {
  summary?: string;
  start?: EventTimePoint;
  end?: EventTimePoint;
  location?: string;
  description?: string;
  htmlLink?: string;
}

/**
 * Resolve which event a call targets — a direct eventId, or a search via
 * eventQuery with the same 0/1/2+ disambiguation semantics list_calendar_events
 * exposes (zero declines, one resolves, two+ returns a numbered candidate
 * list instead of an error). Shared by update_calendar_event and
 * delete_calendar_event so neither duplicates this flow (spec cal-1.5 Code
 * Map: "reuse cal-1.3's search logic, don't duplicate it" — the same
 * argument applies one level up, to the target-resolution wrapper itself).
 *
 * A direct eventId does no lookup (matches update_calendar_event's existing
 * minimal-lookup precedent) — the returned event carries only `id` in that
 * case, nothing else.
 */
async function resolveTargetEvent(
  calendarId: string,
  calendar: string,
  toolName: string,
  verb: string,
  target: { eventId?: string; eventQuery?: string; from?: string; to?: string },
): Promise<{ event: CalendarEventItem } | { response: CallToolResult }> {
  if (target.eventId) {
    return { event: { id: target.eventId } };
  }

  const searchResult = await searchEvents(calendarId, { query: target.eventQuery, from: target.from, to: target.to });
  if ('error' in searchResult) return { response: searchResult.error };

  const rangeDesc = formatRangeDesc(searchResult.timeMin, searchResult.timeMax);

  if (searchResult.events.length === 0) {
    return {
      response: err(
        `No events found on ${calendar}'s calendar matching "${target.eventQuery}" between ${rangeDesc} — nothing to ${verb}.`,
      ),
    };
  }
  if (searchResult.events.length > 1) {
    const lines = [
      `Found ${searchResult.events.length} events matching "${target.eventQuery}" on ${calendar}'s calendar ` +
        `(${rangeDesc}) — re-call ${toolName} with the specific eventId:`,
    ];
    searchResult.events.forEach((ev, i) => {
      lines.push(`${i + 1}. ${formatEventLine(ev)}`);
    });
    if (searchResult.truncated) {
      lines.push(`(Search capped at ${MAX_RESULTS} — there may be more matches than shown.)`);
    }
    return { response: ok(lines.join('\n')) };
  }
  return { event: searchResult.events[0] };
}

export const updateCalendarEvent: McpToolDefinition = {
  tool: {
    name: 'update_calendar_event',
    description:
      "Update a real event on one of this group's configured Google Calendars (at minimum Uriel's and " +
      "Devora's; an operator may add more). Target it either by a known eventId " +
      '(e.g. from a prior list_calendar_events call) or by eventQuery free-text search. Never deletes/cancels ' +
      'an event — use delete_calendar_event for that.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        calendar: {
          type: 'string',
          description:
            "Which calendar the event is on — one of this group's resolvable calendar names: the built-in " +
            '"uriel"/"devorah" plus any names added to this group\'s calendar registry ' +
            '(`ncl groups config add-calendar`).',
        },
        eventId: {
          type: 'string',
          description:
            'The real Google event id, if already known. When given, updates this exact event directly — no ' +
            'search. Takes priority over eventQuery if both are given.',
        },
        eventQuery: {
          type: 'string',
          description:
            'Free-text search to find the event when eventId is not known. Exactly one match updates directly; ' +
            'zero matches declines; two or more return a numbered candidate list (id/title/time) — re-call with ' +
            'the specific eventId from that list.',
        },
        from: {
          type: 'string',
          description: 'Optional search window start, naive local wall-clock, used only with eventQuery. Defaults to start of today.',
        },
        to: {
          type: 'string',
          description: 'Optional search window end, used only with eventQuery. Defaults to 7 days after from.',
        },
        title: { type: 'string', description: 'New title/summary, if changing.' },
        start: { type: 'string', description: 'New start time, naive local wall-clock, if changing.' },
        end: { type: 'string', description: 'New end time, naive local wall-clock, if changing.' },
        description: { type: 'string', description: 'New description, if changing.' },
        location: { type: 'string', description: 'New location, if changing.' },
      },
      required: ['calendar'],
    },
  },
  async handler(args) {
    const calendar = args.calendar as string | undefined;
    const eventId = args.eventId as string | undefined;
    const eventQuery = args.eventQuery as string | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;
    const title = args.title as string | undefined;
    const start = args.start as string | undefined;
    const end = args.end as string | undefined;
    const description = args.description as string | undefined;
    const location = args.location as string | undefined;

    const calendarIds = resolveCalendarIds();
    if (!calendar) return err(`calendar is required — one of: ${Object.keys(calendarIds).join(', ')}`);
    const calendarId = calendarIds[calendar];
    if (!calendarId) {
      return err(`Unknown calendar "${calendar}" — must be one of: ${Object.keys(calendarIds).join(', ')}`);
    }

    if (!eventId && !eventQuery) {
      return err('Either eventId or eventQuery is required to target an event to update.');
    }

    // `!== undefined`, not truthy — an explicit '' is a real, given value
    // (clear this field), not the same as "this field wasn't mentioned".
    // A truthy check here would both silently drop an explicit '' from the
    // PATCH body below *and* wrongly decline as "nothing to update" when
    // that '' was the only field given.
    if (
      title === undefined &&
      start === undefined &&
      end === undefined &&
      description === undefined &&
      location === undefined
    ) {
      return err('Nothing to update — give at least one of title, start, end, description, or location.');
    }

    let startUtc: Date | undefined;
    if (start !== undefined) {
      startUtc = parseZonedToUtc(start, TIMEZONE);
      if (Number.isNaN(startUtc.getTime())) return err(`start is not a valid date/time: "${start}"`);
    }
    let endUtc: Date | undefined;
    if (end !== undefined) {
      endUtc = parseZonedToUtc(end, TIMEZONE);
      if (Number.isNaN(endUtc.getTime())) return err(`end is not a valid date/time: "${end}"`);
    }
    // Only compared when both are given in the same call — a single-sided
    // change (e.g. start only) is left to Google's own validation, since
    // this tool never fetches the existing event just to compare against it
    // (spec cal-1.5 Boundaries: partial PATCH, don't fetch-then-resend).
    if (startUtc && endUtc && endUtc.getTime() <= startUtc.getTime()) {
      return err(`end ("${end}") must be after start ("${start}")`);
    }

    const resolved = await resolveTargetEvent(calendarId, calendar, 'update_calendar_event', 'update', {
      eventId,
      eventQuery,
      from,
      to,
    });
    if ('response' in resolved) return resolved.response;
    const targetEventId = resolved.event.id;

    // `!== undefined`, not truthy — see the "nothing to update" gate above:
    // an explicit '' is a real value (clear this field) and must reach
    // Google, not be silently dropped from the PATCH body.
    const patchBody: Record<string, unknown> = {};
    if (title !== undefined) patchBody.summary = title;
    if (startUtc) patchBody.start = { dateTime: startUtc.toISOString(), timeZone: TIMEZONE };
    if (endUtc) patchBody.end = { dateTime: endUtc.toISOString(), timeZone: TIMEZONE };
    if (description !== undefined) patchBody.description = description;
    if (location !== undefined) patchBody.location = location;

    let response: Response;
    try {
      response = await fetch(`${eventsUrl(calendarId)}/${encodeURIComponent(targetEventId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patchBody),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      const msg = e instanceof Error ? e.message : String(e);
      log(`update_calendar_event: fetch failed: ${msg}`);
      if (isTimeout) {
        return err('Timed out waiting for Google Calendar (30s) — the gateway or Google may be unreachable right now.');
      }
      return err(`Could not reach Google Calendar: ${msg}`);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      log(`update_calendar_event: gateway/API returned ${response.status}`);
      const setupUrl = extractSetupUrl(bodyText);
      if (setupUrl) {
        return err(notConnectedMessage('update the event', setupUrl));
      }
      return err(`Google Calendar API returned ${response.status}: ${bodyText.slice(0, 500)}`);
    }

    let event: EventsPatchResponse;
    try {
      event = JSON.parse(bodyText) as EventsPatchResponse;
    } catch {
      log('update_calendar_event: 2xx response body was not valid JSON');
      return err('The event may have been updated, but the response could not be read back.');
    }

    const lines = [`Event updated: ${event.summary ?? title ?? '(title unchanged)'}`];
    if (event.start || event.end) {
      lines.push(`When: ${formatEventTimeRange(event.start, event.end)}`);
    }
    if (event.location) lines.push(`Location: ${event.location}`);
    if (event.description) lines.push(`Description: ${event.description}`);
    if (event.htmlLink) lines.push(`Link: ${event.htmlLink}`);

    log(`update_calendar_event: updated event ${targetEventId} on ${calendar}'s calendar`);
    return ok(lines.join('\n'));
  },
};

/**
 * Same as timezone.ts's shared formatLocalTime, but 24-hour. Deliberately
 * local, not promoted to the shared (host-mirrored) module — used only for
 * delete_calendar_event's confirmation question, which a chat card shows to
 * the user verbatim. Every other tool's output goes through the agent's own
 * reply first, and this install's persona already renders times in 24h
 * there — formatLocalTime's shared `hour12: true` default is fine when an
 * LLM re-narrates it, wrong when it reaches the user unmediated (2026-08-18
 * finding: a real confirmation card showed "8pm" instead of "20:00").
 */
function formatLocalTime24h(utcIso: string): string {
  return new Date(utcIso).toLocaleString('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatEventTimeRange24h(start?: EventTimePoint, end?: EventTimePoint): string {
  if (start?.dateTime) {
    const s = formatLocalTime24h(start.dateTime);
    const e = end?.dateTime ? formatLocalTime24h(end.dateTime) : '?';
    return `${s} → ${e}`;
  }
  if (start?.date) {
    if (end?.date && end.date !== start.date) return `All day: ${start.date} → ${end.date}`;
    return `All day: ${start.date}`;
  }
  return 'time unknown';
}

/**
 * Human-facing summary for the delete confirmation card — title, 24h local
 * time, location. Deliberately NOT formatEventLine: that includes the raw
 * Google event id, useful for the agent's own follow-up tool calls, pure
 * noise to a human deciding yes/no (same 2026-08-18 finding as the 24h note
 * above — the id showed up verbatim in a real confirmation card).
 */
function formatConfirmationSummary(ev: CalendarEventItem): string {
  const title = ev.summary?.trim() || '(no title)';
  let line = `${title} — ${formatEventTimeRange24h(ev.start, ev.end)}`;
  if (ev.location) line += ` @ ${ev.location}`;
  return line;
}

/**
 * `GET .../events/{eventId}` — fetches one event's full details. Used only
 * by delete_calendar_event's direct-eventId path: update_calendar_event
 * deliberately skips this lookup for its own PATCH (spec cal-1.5's
 * minimal-lookup precedent), but delete's confirmation card needs a real
 * title/time to show the user, not just a bare id (see
 * formatConfirmationSummary above). Same AD-8 gateway-error handling and 30s
 * timeout bound as every other fetch in this file.
 */
async function fetchSingleEvent(
  calendarId: string,
  eventId: string,
): Promise<{ event: CalendarEventItem } | { error: CallToolResult }> {
  let response: Response;
  try {
    response = await fetch(`${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`, {
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const msg = e instanceof Error ? e.message : String(e);
    log(`delete_calendar_event: lookup fetch failed: ${msg}`);
    if (isTimeout) {
      return {
        error: err('Timed out waiting for Google Calendar (30s) — the gateway or Google may be unreachable right now.'),
      };
    }
    return { error: err(`Could not reach Google Calendar: ${msg}`) };
  }

  const bodyText = await response.text();
  if (!response.ok) {
    log(`delete_calendar_event: lookup gateway/API returned ${response.status}`);
    const setupUrl = extractSetupUrl(bodyText);
    if (setupUrl) return { error: err(notConnectedMessage('delete the event', setupUrl)) };
    return { error: err(`Google Calendar API returned ${response.status}: ${bodyText.slice(0, 500)}`) };
  }

  let event: CalendarEventItem;
  try {
    event = JSON.parse(bodyText) as CalendarEventItem;
  } catch {
    log('delete_calendar_event: lookup 2xx response body was not valid JSON');
    return { error: err('The event could not be read back from the response.') };
  }
  return { event };
}

const CONFIRM_CREATE_LABEL = 'Create anyway';
const SKIP_CREATE_LABEL = 'Skip, likely already exists';

/**
 * Mirrors defaultConfirmDeletion below exactly (same in-process
 * askUserQuestion.handler call, same testability seam) — create_calendar_event's
 * idempotency guard (spec cal-2.1) blocks on a real yes/no card the same way
 * delete's confirmation does, never a `confirm: boolean` argument the agent
 * could self-authorize past.
 */
async function defaultConfirmCreation(question: string): Promise<{ confirmed: boolean } | { error: CallToolResult }> {
  let result: CallToolResult;
  try {
    result = await askUserQuestion.handler({
      title: 'Possible duplicate event',
      question,
      options: [CONFIRM_CREATE_LABEL, SKIP_CREATE_LABEL],
    });
  } catch (e) {
    // A thrown rejection (vs. a returned isError) would otherwise propagate
    // unhandled instead of surfacing as a clean MCP error (deferred-work.md
    // finding — same fix applied to defaultConfirmDeletion below).
    return { error: err(`Could not ask for confirmation: ${e instanceof Error ? e.message : String(e)}`) };
  }
  if (result.isError) return { error: result };
  const answer = (result.content[0] as { text?: string } | undefined)?.text;
  return { confirmed: answer === CONFIRM_CREATE_LABEL };
}

/**
 * Exported so tests can substitute the confirmation gate — same rationale
 * and pattern as deleteHooks below. Production code never overrides this.
 */
export const createHooks = {
  confirmCreation: defaultConfirmCreation,
};

const CONFIRM_DELETE_LABEL = 'Yes, delete it';
const CANCEL_DELETE_LABEL = 'No, cancel';

/**
 * Real, blocking human confirmation via the same card-and-poll mechanism
 * ask_user_question already exposes — reused in-process rather than via a
 * second MCP round trip. Deliberately not a `confirm: boolean` argument the
 * agent supplies itself: an earlier design trusted the agent to always call
 * ask_user_question on its own before setting such a flag, and a live
 * incident (2026-08-18) showed that trust doesn't hold — the agent treated
 * the user's own delete request as sufficient confirmation and deleted the
 * event with no question ever shown. Calling askUserQuestion.handler
 * directly here makes that skip structurally impossible.
 */
async function defaultConfirmDeletion(question: string): Promise<{ confirmed: boolean } | { error: CallToolResult }> {
  let result: CallToolResult;
  try {
    result = await askUserQuestion.handler({
      title: 'Confirm deletion',
      question,
      options: [CONFIRM_DELETE_LABEL, CANCEL_DELETE_LABEL],
    });
  } catch (e) {
    return { error: err(`Could not ask for confirmation: ${e instanceof Error ? e.message : String(e)}`) };
  }
  if (result.isError) return { error: result };
  const answer = (result.content[0] as { text?: string } | undefined)?.text;
  return { confirmed: answer === CONFIRM_DELETE_LABEL };
}

/**
 * Exported so tests can substitute the confirmation gate without going
 * anywhere near the real ask_user_question DB round trip (writeMessageOut /
 * findQuestionResponse / getSessionRouting all require a live session DB).
 * Production code never overrides this — only calendar.test.ts does, and
 * always restores it in afterEach.
 */
export const deleteHooks = {
  confirmDeletion: defaultConfirmDeletion,
};

export const deleteCalendarEvent: McpToolDefinition = {
  tool: {
    name: 'delete_calendar_event',
    description:
      "Delete a real event from one of this group's configured Google Calendars (at minimum Uriel's and " +
      "Devora's; an operator may add more). This cannot be undone. The tool itself " +
      "blocks and asks the user to confirm (a real yes/no card, same mechanism as ask_user_question) before " +
      'issuing the actual delete — there is nothing else to orchestrate, one call resolves the target, gets a ' +
      'real confirmation, and deletes (or does not) in sequence. Target the event either by a known eventId or ' +
      'by eventQuery free-text search.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        calendar: {
          type: 'string',
          description:
            "Which calendar the event is on — one of this group's resolvable calendar names: the built-in " +
            '"uriel"/"devorah" plus any names added to this group\'s calendar registry ' +
            '(`ncl groups config add-calendar`).',
        },
        eventId: {
          type: 'string',
          description:
            'The real Google event id, if already known. When given, targets this exact event directly — no search.',
        },
        eventQuery: {
          type: 'string',
          description:
            'Free-text search to find the event when eventId is not known. Exactly one match resolves it; ' +
            'zero matches declines; two or more return a numbered candidate list (id/title/time) — re-call with ' +
            'the specific eventId from that list.',
        },
        from: {
          type: 'string',
          description: 'Optional search window start, naive local wall-clock, used only with eventQuery. Defaults to start of today.',
        },
        to: {
          type: 'string',
          description: 'Optional search window end, used only with eventQuery. Defaults to 7 days after from.',
        },
      },
      required: ['calendar'],
    },
  },
  async handler(args) {
    const calendar = args.calendar as string | undefined;
    const eventId = args.eventId as string | undefined;
    const eventQuery = args.eventQuery as string | undefined;
    const from = args.from as string | undefined;
    const to = args.to as string | undefined;

    const calendarIds = resolveCalendarIds();
    if (!calendar) return err(`calendar is required — one of: ${Object.keys(calendarIds).join(', ')}`);
    const calendarId = calendarIds[calendar];
    if (!calendarId) {
      return err(`Unknown calendar "${calendar}" — must be one of: ${Object.keys(calendarIds).join(', ')}`);
    }

    if (!eventId && !eventQuery) {
      return err('Either eventId or eventQuery is required to target an event to delete.');
    }

    const resolved = await resolveTargetEvent(calendarId, calendar, 'delete_calendar_event', 'delete', {
      eventId,
      eventQuery,
      from,
      to,
    });
    if ('response' in resolved) return resolved.response;
    const targetEventId = resolved.event.id;

    // A direct eventId did no lookup in resolveTargetEvent (matches
    // update_calendar_event's precedent, which never fetches before its own
    // PATCH) — but delete's confirmation card needs real details, not a
    // bare id, so fetch them now. The eventQuery path already has full
    // details from the search above.
    let eventForDisplay: CalendarEventItem = resolved.event;
    if (eventId) {
      const lookup = await fetchSingleEvent(calendarId, eventId);
      if ('error' in lookup) return lookup.error;
      eventForDisplay = lookup.event;
    }
    const targetDesc = formatEventLine(eventForDisplay); // agent-facing (result text) — id is useful context there

    // Structurally blocks on a real human confirmation — no separate
    // "preview" call the agent has to remember to make, and no way for the
    // agent's own judgment to substitute for asking (see calendar.ts's file
    // header note / the 2026-08-18 live incident this replaced: an earlier
    // `confirm: boolean` argument trusted the agent to always ask first and
    // it silently didn't, deleting an event on the user's very first real
    // request with zero confirmation shown). The question text itself is
    // human-facing — formatConfirmationSummary, not formatEventLine: no raw
    // event id, 24h time (a second, related 2026-08-18 finding — this text
    // reaches the user as a chat card verbatim, bypassing the agent's own
    // rephrasing step every other tool's output goes through).
    const confirmResult = await deleteHooks.confirmDeletion(
      `Delete this event from ${calendar}'s calendar? This cannot be undone.\n${formatConfirmationSummary(eventForDisplay)}`,
    );
    if ('error' in confirmResult) return confirmResult.error;
    if (!confirmResult.confirmed) {
      return ok(`Not deleted: ${targetDesc}.`);
    }

    let response: Response;
    try {
      response = await fetch(`${eventsUrl(calendarId)}/${encodeURIComponent(targetEventId)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      const msg = e instanceof Error ? e.message : String(e);
      log(`delete_calendar_event: fetch failed: ${msg}`);
      if (isTimeout) {
        return err('Timed out waiting for Google Calendar (30s) — the gateway or Google may be unreachable right now.');
      }
      return err(`Could not reach Google Calendar: ${msg}`);
    }

    if (!response.ok) {
      const bodyText = await response.text();
      log(`delete_calendar_event: gateway/API returned ${response.status}`);
      const setupUrl = extractSetupUrl(bodyText);
      if (setupUrl) {
        return err(notConnectedMessage('delete the event', setupUrl));
      }
      return err(`Google Calendar API returned ${response.status}: ${bodyText.slice(0, 500)}`);
    }

    // events.delete returns 204 No Content on success — nothing to echo back
    // from the response itself; confirm from what was already resolved above.
    log(`delete_calendar_event: deleted event ${targetEventId} on ${calendar}'s calendar`);
    return ok(`Deleted: ${targetDesc}.`);
  },
};

registerTools([createCalendarEvent, listCalendarEvents, updateCalendarEvent, deleteCalendarEvent]);
