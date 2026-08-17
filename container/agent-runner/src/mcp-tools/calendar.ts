/**
 * create_calendar_event — creates a real event on one of two Google
 * Calendars via a single direct `fetch()` call routed through the
 * container's already-injected `HTTPS_PROXY` — no Google API client
 * library (AD-6).
 *
 * [2026-08-17 pivot — see ARCHITECTURE-SPINE.md AD-2/AD-3] Google Calendar
 * OAuth in OneCLI is one connection per *project*, not per agent identity —
 * live-verified via `onecli apps get --provider google-calendar` (no
 * per-agent scoping exists in the CLI at all). So there is exactly one
 * connected Google account, and which calendar a call targets is picked by
 * the `calendar` argument (`"uriel"` | `"devorah"`), resolved to a
 * `calendarId` here — never by which container/identity happens to be
 * calling. Devorah's calendar is reachable because she shares it with the
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
import { TIMEZONE, parseZonedToUtc } from '../timezone.js';
import type { McpToolDefinition } from './types.js';
import { registerTools } from './server.js';

/**
 * The only two calendars in scope (spec non-goal: no others). "uriel" maps
 * to the connected account's own calendar; "devorah" to her calendar,
 * reachable because she shares it with the connected account (AD-3) — not
 * a second OAuth connection. Matches `groups/household/memory/household/
 * people.md`'s recorded email for Devora.
 */
const CALENDAR_IDS: Record<string, string> = {
  uriel: 'primary',
  devorah: 'adardevora@gmail.com',
};

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

function notConnectedMessage(setupUrl: string): string {
  return `Can't create the event — this agent's Google Calendar isn't connected yet. Connect it here: ${setupUrl}`;
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
}

interface EventsInsertResponse {
  htmlLink?: string;
  summary?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: string;
  description?: string;
  attendees?: Array<{ email?: string }>;
}

export const createCalendarEvent: McpToolDefinition = {
  tool: {
    name: 'create_calendar_event',
    description:
      'Create a real event on Uriel\'s or Devora\'s Google Calendar (both reachable through one connected ' +
      'account — Devora\'s via calendar sharing, not a separate connection).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        calendar: {
          type: 'string',
          enum: ['uriel', 'devorah'],
          description: 'Which calendar to create the event on.',
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
    const guests = args.guests as unknown;

    if (!calendar) return err(`calendar is required — one of: ${Object.keys(CALENDAR_IDS).join(', ')}`);
    const calendarId = CALENDAR_IDS[calendar];
    if (!calendarId) {
      return err(`Unknown calendar "${calendar}" — must be one of: ${Object.keys(CALENDAR_IDS).join(', ')}`);
    }
    if (!title) return err('title is required');
    if (!start) return err('start is required');
    if (!end) return err('end is required');
    if (guests !== undefined && !Array.isArray(guests)) {
      return err('guests must be an array of email address strings');
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
    if (guestEmails.length > 0) {
      eventBody.attendees = guestEmails.map((email) => ({ email }));
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
        return err(notConnectedMessage(setupUrl));
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
    if (event.htmlLink) lines.push(`Link: ${event.htmlLink}`);

    log(`create_calendar_event: created "${title}" on ${calendar}'s calendar`);
    return ok(lines.join('\n'));
  },
};

registerTools([createCalendarEvent]);
