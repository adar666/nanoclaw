import { describe, it, expect, afterEach, mock } from 'bun:test';

import {
  createCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
  deleteCalendarEvent,
  deleteHooks,
  createHooks,
  calendarConfigHooks,
} from './calendar.js';
import { TIMEZONE, parseZonedToUtc, formatLocalTime } from '../timezone.js';

const originalFetch = globalThis.fetch;
const originalConfirmDeletion = deleteHooks.confirmDeletion;
const originalConfirmCreation = createHooks.confirmCreation;

/**
 * Suite-wide default calendar registry: empty, matching a fresh migration
 * (spec cal-2.3 I/O Matrix row 1) — every pre-existing test in this file
 * exercises only the built-in "uriel"/"devorah" names and must keep passing
 * unmodified. Deliberately NOT the real `calendarConfigHooks.getCalendarRegistry`
 * (which calls `getConfig()` — this test file never calls `loadConfig()`, so
 * the real implementation would throw "Config not loaded" on every call).
 * Tests that care about the registry stub this per-test via
 * `stubCalendarRegistry` and afterEach resets back to this default.
 */
const DEFAULT_CALENDAR_REGISTRY: Array<{ name: string; calendarId: string }> = [];
calendarConfigHooks.getCalendarRegistry = () => DEFAULT_CALENDAR_REGISTRY;

/** Stub the calendar-registry source for one test — mirrors stubConfirmDeletion/stubConfirmCreation. */
function stubCalendarRegistry(registry: Array<{ name: string; calendarId: string }>) {
  calendarConfigHooks.getCalendarRegistry = () => registry;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  deleteHooks.confirmDeletion = originalConfirmDeletion;
  createHooks.confirmCreation = originalConfirmCreation;
  calendarConfigHooks.getCalendarRegistry = () => DEFAULT_CALENDAR_REGISTRY;
});

/**
 * Stub the human-confirmation gate delete_calendar_event blocks on, without
 * going anywhere near the real ask_user_question DB round trip. Captures
 * every question asked so tests can assert the shown text is a real,
 * specific description — not a bare "are you sure?".
 */
/**
 * Mirrors calendar.ts's private formatLocalTime24h — used only to compute
 * an expected substring dynamically (TIMEZONE varies by environment; a
 * hardcoded "20:00" assumes a specific offset from the UTC fixture times
 * below, which doesn't hold everywhere this suite runs).
 */
function format24h(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false });
}

function stubConfirmDeletion(result: { confirmed: boolean } | { error: { content: unknown; isError: true } }) {
  const questions: string[] = [];
  const fn = mock(async (question: string) => {
    questions.push(question);
    return result;
  });
  deleteHooks.confirmDeletion = fn as unknown as typeof deleteHooks.confirmDeletion;
  return { fn, questions };
}

/** Mirrors stubConfirmDeletion — stubs create_calendar_event's idempotency-guard confirmation gate. */
function stubConfirmCreation(result: { confirmed: boolean } | { error: { content: unknown; isError: true } }) {
  const questions: string[] = [];
  const fn = mock(async (question: string) => {
    questions.push(question);
    return result;
  });
  createHooks.confirmCreation = fn as unknown as typeof createHooks.confirmCreation;
  return { fn, questions };
}

/** Stub globalThis.fetch with a single canned JSON response, capturing the call. */
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = mock(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { fn, calls };
}

/** Stub fetch to reject — proves the tool never attempts a call for a given scenario. */
function stubFetchThrows() {
  const fn = mock(async () => {
    throw new Error('fetch should not have been called');
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/**
 * Stub globalThis.fetch with a sequence of canned responses, one per call —
 * used for update_calendar_event's search-then-PATCH flow (two fetch calls).
 * The last response repeats if more calls happen than responses given.
 */
function stubFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = mock(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return { fn, calls };
}

/** A pre-check GET response with no matching events — the common case, used to lead a stubFetchSequence for tests not exercising the duplicate guard itself. */
const PRECHECK_EMPTY = { status: 200, body: { items: [] } };

describe('create_calendar_event MCP tool', () => {
  it('declares calendar/title/start/end as required', () => {
    expect(createCalendarEvent.tool.name).toBe('create_calendar_event');
    expect(createCalendarEvent.tool.inputSchema).toMatchObject({
      required: ['calendar', 'title', 'start', 'end'],
    });
  });

  it('declines a missing calendar argument', async () => {
    const result = await createCalendarEvent.handler({
      title: 'x',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('calendar is required');
  });

  it('declines an unknown calendar value', async () => {
    const result = await createCalendarEvent.handler({
      calendar: 'devora', // typo — not in CALENDAR_IDS
      title: 'x',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown calendar');
  });

  it('routes calendar: "devorah" to her calendar ID in both the pre-check GET and the POST URL', async () => {
    const { calls } = stubFetchSequence([
      PRECHECK_EMPTY,
      {
        status: 200,
        body: {
          summary: 'Her event',
          start: { dateTime: '2026-08-20T12:00:00.000Z', timeZone: TIMEZONE },
          end: { dateTime: '2026-08-20T13:00:00.000Z', timeZone: TIMEZONE },
        },
      },
    ]);

    await createCalendarEvent.handler({
      calendar: 'devorah',
      title: 'Her event',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(calls[0].url).toContain(encodeURIComponent('adardevora@gmail.com'));
    expect(calls[1].url).toContain(encodeURIComponent('adardevora@gmail.com'));
  });

  it('routes calendar: "uriel" to /calendars/primary/ in the POST URL', async () => {
    const { calls } = stubFetchSequence([
      PRECHECK_EMPTY,
      {
        status: 200,
        body: {
          summary: 'His event',
          start: { dateTime: '2026-08-20T12:00:00.000Z', timeZone: TIMEZONE },
          end: { dateTime: '2026-08-20T13:00:00.000Z', timeZone: TIMEZONE },
        },
      },
    ]);

    await createCalendarEvent.handler({
      calendar: 'uriel',
      title: 'His event',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(calls[1].url).toContain('/calendars/primary/events');
    expect(calls[1].init?.method).toBe('POST');
  });

  it('creates an event with full details and confirms with htmlLink', async () => {
    const start = '2026-08-20T15:00:00';
    const end = '2026-08-20T16:00:00';
    const { fn, calls } = stubFetchSequence([
      PRECHECK_EMPTY,
      {
        status: 200,
        body: {
          summary: 'Team sync',
          start: { dateTime: parseZonedToUtc(start, TIMEZONE).toISOString(), timeZone: TIMEZONE },
          end: { dateTime: parseZonedToUtc(end, TIMEZONE).toISOString(), timeZone: TIMEZONE },
          location: 'Office',
          description: 'Weekly sync',
          attendees: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
          htmlLink: 'https://calendar.google.com/event?eid=abc123',
        },
      },
    ]);

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start,
      end,
      description: 'Weekly sync',
      location: 'Office',
      guests: ['a@example.com', 'b@example.com'],
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(2); // pre-check GET, then the real POST
    expect(calls[1].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(calls[1].init?.method).toBe('POST');
    expect(calls[1].init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    // A request timeout bound must be present (Patch 5) — a hung gateway/
    // upstream call must not block the tool call indefinitely.
    expect(calls[1].init?.signal).toBeInstanceOf(AbortSignal);

    const sentBody = JSON.parse(calls[1].init!.body as string);
    expect(sentBody.summary).toBe('Team sync');
    expect(sentBody.description).toBe('Weekly sync');
    expect(sentBody.location).toBe('Office');
    expect(sentBody.attendees).toEqual([{ email: 'a@example.com' }, { email: 'b@example.com' }]);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('https://calendar.google.com/event?eid=abc123');
    expect(text).toContain('Office');
    expect(text).toContain('Weekly sync');
    expect(text).toContain('a@example.com, b@example.com');
  });

  it('creates an event with only required fields — no empty-string location/description/attendees sent', async () => {
    const { fn, calls } = stubFetchSequence([
      PRECHECK_EMPTY,
      {
        status: 200,
        body: {
          summary: 'Quick call',
          start: { dateTime: '2026-08-20T12:00:00.000Z', timeZone: TIMEZONE },
          end: { dateTime: '2026-08-20T13:00:00.000Z', timeZone: TIMEZONE },
          htmlLink: 'https://calendar.google.com/event?eid=def456',
        },
      },
    ]);

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Quick call',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(2);

    const sentBody = JSON.parse(calls[1].init!.body as string);
    expect(sentBody.summary).toBe('Quick call');
    expect(sentBody).not.toHaveProperty('description');
    expect(sentBody).not.toHaveProperty('location');
    expect(sentBody).not.toHaveProperty('attendees');
  });

  it('constructs start/end dateTime + timeZone via parseZonedToUtc(input, TIMEZONE) — never a bare/UTC-only dateTime', async () => {
    const start = '2026-08-20T15:00:00';
    const end = '2026-08-20T16:00:00';
    const { calls } = stubFetchSequence([
      PRECHECK_EMPTY,
      { status: 200, body: { summary: 'Tz check', htmlLink: 'https://calendar.google.com/event?eid=tz1' } },
    ]);

    await createCalendarEvent.handler({ calendar: 'uriel', title: 'Tz check', start, end });

    const sentBody = JSON.parse(calls[1].init!.body as string);
    // Same conversion the tool must reuse unmodified (AD-13 / Design Notes):
    // this asserts the tool actually delegates to parseZonedToUtc(input, TIMEZONE)
    // rather than reimplementing timezone math, and that timeZone always
    // accompanies dateTime (never a bare/UTC-only value).
    expect(sentBody.start.dateTime).toBe(parseZonedToUtc(start, TIMEZONE).toISOString());
    expect(sentBody.start.timeZone).toBe(TIMEZONE);
    expect(sentBody.end.dateTime).toBe(parseZonedToUtc(end, TIMEZONE).toISOString());
    expect(sentBody.end.timeZone).toBe(TIMEZONE);
  });

  it('passes an already-offset start/end straight through parseZonedToUtc unchanged, timeZone still set to TIMEZONE', async () => {
    // parseZonedToUtc treats a string carrying its own Z/offset as already
    // absolute and passes it through unchanged (see timezone.ts) — this
    // just confirms the tool doesn't fight that, and still always attaches
    // the timeZone field per AD-13 regardless of the input shape.
    const start = '2026-08-20T15:00:00Z';
    const end = '2026-08-20T19:00:00+02:00'; // 17:00 UTC — after start
    const { calls } = stubFetchSequence([
      PRECHECK_EMPTY,
      { status: 200, body: { summary: 'Offset check', htmlLink: 'https://calendar.google.com/event?eid=off1' } },
    ]);

    const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Offset check', start, end });

    expect(result.isError).toBeFalsy();
    const sentBody = JSON.parse(calls[1].init!.body as string);
    expect(sentBody.start.dateTime).toBe(new Date(start).toISOString());
    expect(sentBody.start.timeZone).toBe(TIMEZONE);
    expect(sentBody.end.dateTime).toBe(new Date(end).toISOString());
    expect(sentBody.end.timeZone).toBe(TIMEZONE);
  });

  it('surfaces the gateway connect_url when the calendar is not connected yet (401 on the POST)', async () => {
    stubFetchSequence([
      PRECHECK_EMPTY,
      {
        status: 401,
        body: { error: 'app_not_connected', connect_url: 'https://gateway.local/connect/google-calendar?agent=household' },
      },
    ]);

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('https://gateway.local/connect/google-calendar?agent=household');
  });

  it('surfaces manage_url when present and connect_url is absent (403 on the POST)', async () => {
    stubFetchSequence([
      PRECHECK_EMPTY,
      { status: 403, body: { error: 'agent_lacks_access', manage_url: 'https://gateway.local/manage/google-calendar' } },
    ]);

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('https://gateway.local/manage/google-calendar');
  });

  it('does NOT relabel a 403 with no setup URL as "not connected" — surfaces the real error instead (POST)', async () => {
    // A genuine Google 403 (insufficient scope, quota, read-only sharing,
    // domain policy, ...) carries no connect_url/secret_url/manage_url.
    // Blanket-treating any 401/403 as "reconnect your calendar" would
    // discard this real cause and mislead the user about an already-working
    // connection.
    stubFetchSequence([
      PRECHECK_EMPTY,
      { status: 403, body: { error: { code: 403, message: 'Insufficient permission for this calendar' } } },
    ]);

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('403');
    expect(text).toContain('Insufficient permission for this calendar');
    expect(text).not.toContain("isn't connected yet");
  });

  it('returns an MCP error (not a crash) for a non-2xx response with no setup URL (POST)', async () => {
    stubFetchSequence([PRECHECK_EMPTY, { status: 400, body: { error: { code: 400, message: 'Invalid request' } } }]);

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Bad event',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('400');
  });

  it('declines a missing title with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines an empty-string title the same as a missing one', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: '',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines a missing start with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines a missing end with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines end == start (zero duration) with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T15:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines end before start with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T16:00:00',
      end: '2026-08-20T15:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines a malformed guests argument (not an array) with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
      guests: 'not-an-array@example.com',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines a guests array containing a non-string element with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
      guests: ['a@example.com', 42, null],
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines a guests array containing a malformed email string with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
      guests: ['a@example.com', 'not-an-email'],
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats guests: [] the same as omitting guests entirely', async () => {
    const { fn, calls } = stubFetchSequence([
      PRECHECK_EMPTY,
      { status: 200, body: { summary: 'Quick call', htmlLink: 'https://calendar.google.com/event?eid=empty-guests' } },
    ]);

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Quick call',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
      guests: [],
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(2);
    const sentBody = JSON.parse(calls[1].init!.body as string);
    expect(sentBody).not.toHaveProperty('attendees');
  });

  it('declines an unparseable start with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: 'not-a-real-date',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns an MCP error (not a throw) when the POST fetch itself rejects (pre-check GET already succeeded)', async () => {
    let call = 0;
    globalThis.fetch = mock(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('network unreachable');
    expect(call).toBe(2);
  });

  it('surfaces a clear timeout message when the POST request aborts (30s bound, pre-check GET already succeeded)', async () => {
    let call = 0;
    globalThis.fetch = mock(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain('timed out');
    expect(call).toBe(2);
  });

  it('surfaces the pre-check GET\'s own error and never attempts the POST when it fails / not connected', async () => {
    const { fn } = stubFetch(401, {
      error: 'app_not_connected',
      connect_url: 'https://gateway.local/connect/google-calendar',
    });

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('https://gateway.local/connect/google-calendar');
    expect(fn).toHaveBeenCalledTimes(1); // pre-check GET only — no POST ever attempted
  });

  it('prefers attendees actually echoed back by Google over what was requested', async () => {
    // Google dropped one of the two requested guests (e.g. invalid/blocked)
    // — the confirmation must reflect that, not just restate the request.
    stubFetchSequence([
      PRECHECK_EMPTY,
      {
        status: 200,
        body: {
          summary: 'Team sync',
          attendees: [{ email: 'a@example.com' }],
          htmlLink: 'https://calendar.google.com/event?eid=partial-guests',
        },
      },
    ]);

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
      guests: ['a@example.com', 'b@example.com'],
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('a@example.com');
    expect(text).not.toContain('b@example.com');
  });

  it('produces a sensible confirmation when the 2xx response omits htmlLink', async () => {
    stubFetchSequence([PRECHECK_EMPTY, { status: 200, body: { summary: 'Team sync' } }]);

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Team sync');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('Link:');
  });

  describe('idempotency guard (spec cal-2.1)', () => {
    const start = '2026-08-20T15:00:00';
    const end = '2026-08-20T16:00:00';
    const startUtc = parseZonedToUtc(start, TIMEZONE);

    /** A candidate event that matches on instant + title + recency, and isn't part of any recurring series. */
    function baseDuplicateCandidate(overrides: Record<string, unknown> = {}) {
      return {
        id: 'evt-dup',
        summary: '  Team Sync  ', // case/whitespace variance — must still match case-insensitive-trimmed
        start: { dateTime: startUtc.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: new Date(startUtc.getTime() + 3_600_000).toISOString(), timeZone: TIMEZONE },
        created: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago — within the 10-min window
        ...overrides,
      };
    }

    it('proceeds normally when the pre-check GET finds no matching event', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: true });
      const { fn } = stubFetchSequence([PRECHECK_EMPTY, { status: 200, body: { summary: 'Team sync' } }]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(result.isError).toBeFalsy();
      expect(confirmFn).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2); // pre-check, then POST — no block
    });

    it('blocks on a possible-duplicate confirmation and proceeds when the user picks "create anyway"', async () => {
      const { fn: confirmFn, questions } = stubConfirmCreation({ confirmed: true });
      const { fn } = stubFetchSequence([
        { status: 200, body: { items: [baseDuplicateCandidate()] } },
        { status: 200, body: { summary: 'Team sync', htmlLink: 'https://calendar.google.com/event?eid=dup1' } },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).toHaveBeenCalledTimes(1);
      expect(questions[0]).toContain('Team Sync');
      expect(questions[0]).toContain('5 minutes ago'); // real age, not a hardcoded "a few minutes ago"
      expect(fn).toHaveBeenCalledTimes(2); // pre-check, then the POST still happens
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('https://calendar.google.com/event?eid=dup1');
    });

    it('blocks on a possible-duplicate confirmation and skips (no POST) when the user declines', async () => {
      const { fn: confirmFn, questions } = stubConfirmCreation({ confirmed: false });
      const { fn } = stubFetchSequence([{ status: 200, body: { items: [baseDuplicateCandidate()] } }]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).toHaveBeenCalledTimes(1);
      expect(questions[0]).toContain('5 minutes ago');
      expect(fn).toHaveBeenCalledTimes(1); // pre-check only — no POST
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text.toLowerCase()).toContain('not created');
      expect(result.content[0].text).toContain('Team sync');
    });

    it('confirmation gate itself errors (e.g. timeout) after a matching duplicate — surfaced as-is, no POST attempted', async () => {
      const { fn } = stubFetchSequence([{ status: 200, body: { items: [baseDuplicateCandidate()] } }]);
      stubConfirmCreation({ error: { content: [{ type: 'text', text: 'Error: Question timed out after 300s' }], isError: true } });

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('timed out');
      expect(fn).toHaveBeenCalledTimes(1); // pre-check only, no POST
    });

    it('does not match a candidate representing a different real instant, even with the same title — POST proceeds, no confirmation', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: true });
      const differentInstantCandidate = baseDuplicateCandidate({
        start: { dateTime: new Date(startUtc.getTime() + 3_600_000).toISOString(), timeZone: 'America/New_York' },
      });
      const { fn } = stubFetchSequence([
        { status: 200, body: { items: [differentInstantCandidate] } },
        { status: 200, body: { summary: 'Team sync' } },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
    });

    it('matches a candidate whose instant is identical but expressed with an explicit offset instead of "Z" — never a raw string compare', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: false });
      const sameInstantDifferentFormat = baseDuplicateCandidate({
        start: { dateTime: startUtc.toISOString().replace('Z', '+00:00'), timeZone: TIMEZONE },
      });
      const { fn } = stubFetchSequence([{ status: 200, body: { items: [sameInstantDifferentFormat] } }]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).toHaveBeenCalledTimes(1); // matched despite the differently-formatted (but identical) instant
      expect(fn).toHaveBeenCalledTimes(1); // skipped — no POST
      expect(result.content[0].text.toLowerCase()).toContain('not created');
    });

    it('excludes a recurring series master (recurrence set) from matching — POST proceeds, no confirmation', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: true });
      const masterCandidate = baseDuplicateCandidate({ recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5'] });
      const { fn } = stubFetchSequence([
        { status: 200, body: { items: [masterCandidate] } },
        { status: 200, body: { summary: 'Team sync' } },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
    });

    it('excludes a recurring series instance (recurringEventId set, no recurrence — the realistic singleEvents=true shape) from matching', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: true });
      const instanceCandidate = baseDuplicateCandidate({ recurringEventId: 'master-evt-1' });
      const { fn } = stubFetchSequence([
        { status: 200, body: { items: [instanceCandidate] } },
        { status: 200, body: { summary: 'Team sync' } },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
    });

    it('a recurring create DOES match an existing recurring master/instance with the same instant+title — retry protection, epic-2 retro fix', async () => {
      // The bug: excluding every recurring candidate unconditionally (as
      // written for Story 2.1, before Story 2.2 added `recurrence`) meant a
      // retried recurring create could never find its own just-created
      // series as a duplicate — the guard silently did nothing for exactly
      // the case it exists to protect. Fixed by keying the exclusion on
      // whether the NEW request is itself recurring, not on the candidate
      // alone.
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: false });
      const masterCandidate = baseDuplicateCandidate({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'] });
      const { fn } = stubFetchSequence([{ status: 200, body: { items: [masterCandidate] } }]);

      const result = await createCalendarEvent.handler({
        calendar: 'uriel',
        title: 'Team sync',
        start,
        end,
        recurrence: 'RRULE:FREQ=WEEKLY;BYDAY=TH',
      });

      expect(confirmFn).toHaveBeenCalledTimes(1); // matched — the retry is blocked, same as any other duplicate
      expect(fn).toHaveBeenCalledTimes(1); // pre-check only — no POST
      expect(result.content[0].text.toLowerCase()).toContain('not created');
    });

    it('a recurring create still matches a non-recurring one-off candidate with the same instant+title (recurrence never relaxes the match)', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: true });
      const oneOffCandidate = baseDuplicateCandidate(); // no recurrence/recurringEventId
      const { fn } = stubFetchSequence([
        { status: 200, body: { items: [oneOffCandidate] } },
        { status: 200, body: { summary: 'Team sync' } },
      ]);

      const result = await createCalendarEvent.handler({
        calendar: 'uriel',
        title: 'Team sync',
        start,
        end,
        recurrence: 'RRULE:FREQ=WEEKLY;BYDAY=TH',
      });

      // Same instant+title+recency still matches regardless of the NEW
      // request's own recurrence — recurrence only changes which
      // CANDIDATES are eligible, never relaxes the match itself.
      expect(confirmFn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledTimes(2); // pre-check GET, then the POST (user confirmed "create anyway")
      expect(result.isError).toBeFalsy();
    });

    it('does not treat a match outside the 10-minute recency window as a duplicate — POST proceeds', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: true });
      const staleCandidate = baseDuplicateCandidate({ created: new Date(Date.now() - 15 * 60 * 1000).toISOString() });
      const { fn } = stubFetchSequence([
        { status: 200, body: { items: [staleCandidate] } },
        { status: 200, body: { summary: 'Team sync' } },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
    });

    it('does not treat a candidate with a future `created` (clock skew) as a duplicate — negative age never matches', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: true });
      const futureCreatedCandidate = baseDuplicateCandidate({ created: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
      const { fn } = stubFetchSequence([
        { status: 200, body: { items: [futureCreatedCandidate] } },
        { status: 200, body: { summary: 'Team sync' } },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
    });

    it('still runs the guard against a truncated pre-check page (best-effort) and proceeds when no match is on that page', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: true });
      const { fn } = stubFetchSequence([
        { status: 200, body: { items: [], nextPageToken: 'more-results' } },
        { status: 200, body: { summary: 'Team sync' } },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2); // guard ran against the returned page, then proceeded
      expect(result.isError).toBeFalsy();
    });

    it('brackets the pre-check GET to the new event\'s own [startUtc, endUtc] window', async () => {
      stubConfirmCreation({ confirmed: true });
      const { calls } = stubFetchSequence([PRECHECK_EMPTY, { status: 200, body: { summary: 'Team sync' } }]);

      await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      const url = new URL(calls[0].url);
      expect(url.searchParams.get('timeMin')).toBe(startUtc.toISOString());
      expect(url.searchParams.get('timeMax')).toBe(new Date(startUtc.getTime() + 3_600_000).toISOString());
    });

    it('surfaces the pre-check GET failing at the network layer (throw/timeout) — no POST attempted, not connected wording says "create the event"', async () => {
      stubConfirmCreation({ confirmed: true });
      const fn = stubFetchThrows();

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(result.isError).toBe(true);
      expect(fn).toHaveBeenCalledTimes(1); // pre-check only — throws before any POST is attempted
    });

    it('surfaces a not-connected pre-check error with "create the event" wording, not the generic "list events" phrasing', async () => {
      stubConfirmCreation({ confirmed: true });
      const { fn } = stubFetch(401, {
        error: 'app_not_connected',
        connect_url: 'https://gateway.local/connect/google-calendar',
      });

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('create the event');
      expect(text).not.toContain('list events');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('scans past an earlier non-matching candidate to find the real duplicate later in the list', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: false });
      const unrelated = baseDuplicateCandidate({ id: 'evt-unrelated', summary: 'Totally different meeting' });
      const { fn } = stubFetchSequence([{ status: 200, body: { items: [unrelated, baseDuplicateCandidate()] } }]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledTimes(1); // matched on the second candidate — no POST
      expect(result.content[0].text.toLowerCase()).toContain('not created');
    });

    it('never matches a candidate with no summary at all', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: true });
      const noSummary = baseDuplicateCandidate({ summary: undefined });
      const { fn } = stubFetchSequence([
        { status: 200, body: { items: [noSummary] } },
        { status: 200, body: { summary: 'Team sync' } },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
    });

    it('never matches a candidate with an unparseable `created` timestamp (NaN age must not bypass the recency bounds)', async () => {
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: true });
      const badCreated = baseDuplicateCandidate({ created: 'not-a-real-timestamp' });
      const { fn } = stubFetchSequence([
        { status: 200, body: { items: [badCreated] } },
        { status: 200, body: { summary: 'Team sync' } },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(confirmFn).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
    });
  });

  describe('recurrence (spec cal-2.2)', () => {
    const start = '2026-08-20T15:00:00';
    const end = '2026-08-20T16:00:00';
    const RRULE = 'RRULE:FREQ=WEEKLY;BYDAY=TH';

    it('no recurrence given — regression: byte-identical to pre-story behavior (no recurrence field sent, plain confirmation)', async () => {
      const { calls } = stubFetchSequence([
        PRECHECK_EMPTY,
        {
          status: 200,
          body: {
            summary: 'Team sync',
            start: { dateTime: parseZonedToUtc(start, TIMEZONE).toISOString(), timeZone: TIMEZONE },
            end: { dateTime: parseZonedToUtc(end, TIMEZONE).toISOString(), timeZone: TIMEZONE },
            htmlLink: 'https://calendar.google.com/event?eid=norec',
          },
        },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end });

      expect(result.isError).toBeFalsy();
      const sentBody = JSON.parse(calls[1].init!.body as string);
      expect(sentBody).not.toHaveProperty('recurrence');
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain('Recurrence:');
    });

    it('valid RRULE given — wraps as recurrence: [arg] in the outgoing body, confirmation echoes Google\'s response value', async () => {
      const { calls } = stubFetchSequence([
        PRECHECK_EMPTY,
        {
          status: 200,
          body: {
            summary: 'Team sync',
            start: { dateTime: parseZonedToUtc(start, TIMEZONE).toISOString(), timeZone: TIMEZONE },
            end: { dateTime: parseZonedToUtc(end, TIMEZONE).toISOString(), timeZone: TIMEZONE },
            recurrence: [RRULE],
            htmlLink: 'https://calendar.google.com/event?eid=rec1',
          },
        },
      ]);

      const result = await createCalendarEvent.handler({
        calendar: 'uriel',
        title: 'Team sync',
        start,
        end,
        recurrence: RRULE,
      });

      expect(result.isError).toBeFalsy();
      const sentBody = JSON.parse(calls[1].init!.body as string);
      expect(sentBody.recurrence).toEqual([RRULE]);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain(`Recurrence: ${RRULE}`);
    });

    it('confirmation prefers what Google\'s response echoes back over what was sent, when they differ', async () => {
      const normalized = 'RRULE:FREQ=WEEKLY;BYDAY=TH;WKST=SU'; // Google normalized/echoed a different string
      const { calls } = stubFetchSequence([
        PRECHECK_EMPTY,
        {
          status: 200,
          body: {
            summary: 'Team sync',
            recurrence: [normalized],
            htmlLink: 'https://calendar.google.com/event?eid=rec2',
          },
        },
      ]);

      const result = await createCalendarEvent.handler({
        calendar: 'uriel',
        title: 'Team sync',
        start,
        end,
        recurrence: RRULE,
      });

      const sentBody = JSON.parse(calls[1].init!.body as string);
      expect(sentBody.recurrence).toEqual([RRULE]); // sent the raw arg, unmodified
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain(`Recurrence: ${normalized}`); // confirmation echoes what Google returned
      expect(text).not.toContain(`Recurrence: ${RRULE}\n`); // not just restating the sent value verbatim
    });

    it('empty string recurrence is treated as falsy — no recurrence field sent, single-occurrence event created', async () => {
      const { calls } = stubFetchSequence([
        PRECHECK_EMPTY,
        {
          status: 200,
          body: {
            summary: 'Team sync',
            htmlLink: 'https://calendar.google.com/event?eid=rec3',
          },
        },
      ]);

      const result = await createCalendarEvent.handler({
        calendar: 'uriel',
        title: 'Team sync',
        start,
        end,
        recurrence: '',
      });

      expect(result.isError).toBeFalsy();
      const sentBody = JSON.parse(calls[1].init!.body as string);
      expect(sentBody).not.toHaveProperty('recurrence');
      const text = (result.content[0] as { text: string }).text;
      expect(text).not.toContain('Recurrence:');
    });

    it('Google rejects a malformed RRULE (400 on the POST) — surfaced via the existing generic error path, no client-side validation', async () => {
      stubFetchSequence([
        PRECHECK_EMPTY,
        {
          status: 400,
          body: { error: { code: 400, message: 'Invalid recurrence rule' } },
        },
      ]);

      const result = await createCalendarEvent.handler({
        calendar: 'uriel',
        title: 'Team sync',
        start,
        end,
        recurrence: 'RRULE:NOT-A-REAL-RULE',
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('400');
      expect(text).toContain('Invalid recurrence rule');
    });

    it('a recurring create still trips the idempotency guard against an existing one-off match', async () => {
      const startUtc = parseZonedToUtc(start, TIMEZONE);
      const duplicate = {
        id: 'evt-dup-rec',
        summary: '  Team Sync  ',
        start: { dateTime: startUtc.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: new Date(startUtc.getTime() + 3_600_000).toISOString(), timeZone: TIMEZONE },
        created: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      };
      const { fn: confirmFn } = stubConfirmCreation({ confirmed: false });
      const { fn } = stubFetchSequence([{ status: 200, body: { items: [duplicate] } }]);

      const result = await createCalendarEvent.handler({
        calendar: 'uriel',
        title: 'Team sync',
        start,
        end,
        recurrence: RRULE,
      });

      expect(confirmFn).toHaveBeenCalledTimes(1); // guard still runs, unaffected by recurrence
      expect(fn).toHaveBeenCalledTimes(1); // pre-check GET only — no POST, guard declined
      expect(result.content[0].text.toLowerCase()).toContain('not created');
    });

    it('declares recurrence as an optional string in the tool schema', () => {
      expect(createCalendarEvent.tool.inputSchema).toMatchObject({
        properties: { recurrence: { type: 'string' } },
        required: ['calendar', 'title', 'start', 'end'],
      });
      expect((createCalendarEvent.tool.inputSchema.required as string[]) ?? []).not.toContain('recurrence');
    });

    it('rejects a non-string recurrence argument with no fetch attempted', async () => {
      const fn = stubFetchThrows();
      const result = await createCalendarEvent.handler({
        calendar: 'uriel',
        title: 'Team sync',
        start,
        end,
        recurrence: ['RRULE:FREQ=WEEKLY'] as unknown as string,
      });

      expect(result.isError).toBe(true);
      expect(fn).not.toHaveBeenCalled();
    });

    it('whitespace-only recurrence is treated the same as empty — no recurrence field sent', async () => {
      const { calls } = stubFetchSequence([
        PRECHECK_EMPTY,
        { status: 200, body: { summary: 'Team sync', htmlLink: 'https://calendar.google.com/event?eid=rec4' } },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end, recurrence: '   ' });

      expect(result.isError).toBeFalsy();
      const sentBody = JSON.parse(calls[1].init!.body as string);
      expect(sentBody).not.toHaveProperty('recurrence');
    });

    it('does not crash when Google\'s response has a malformed (non-array) recurrence field — falls back to the sent value', async () => {
      const { calls } = stubFetchSequence([
        PRECHECK_EMPTY,
        {
          status: 200,
          body: {
            summary: 'Team sync',
            recurrence: RRULE, // malformed: a bare string, not an array — Google shouldn't send this, but must not crash if it does
            htmlLink: 'https://calendar.google.com/event?eid=rec5',
          },
        },
      ]);

      const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end, recurrence: RRULE });

      expect(result.isError).toBeFalsy(); // no uncaught TypeError from calling .join on a string
      const sentBody = JSON.parse(calls[1].init!.body as string);
      expect(sentBody.recurrence).toEqual([RRULE]);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain(`Recurrence: ${RRULE}`); // falls back to what was sent, since Google's shape was unusable
    });

    it('the duplicate-confirmation question notes the pending create is a recurring series, not just a one-off', async () => {
      const startUtc = parseZonedToUtc(start, TIMEZONE);
      const duplicate = {
        id: 'evt-dup-rec2',
        summary: 'Team sync',
        start: { dateTime: startUtc.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: new Date(startUtc.getTime() + 3_600_000).toISOString(), timeZone: TIMEZONE },
        created: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      };
      const { questions } = stubConfirmCreation({ confirmed: false });
      stubFetchSequence([{ status: 200, body: { items: [duplicate] } }]);

      await createCalendarEvent.handler({ calendar: 'uriel', title: 'Team sync', start, end, recurrence: RRULE });

      expect(questions[0]).toContain('recurring series');
    });
  });
});

describe('list_calendar_events MCP tool', () => {
  it('declares only calendar as required (from/to/query optional)', () => {
    expect(listCalendarEvents.tool.name).toBe('list_calendar_events');
    expect(listCalendarEvents.tool.inputSchema).toMatchObject({ required: ['calendar'] });
  });

  it('declines a missing calendar argument, no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await listCalendarEvents.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('calendar is required');
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines an unknown calendar value, no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await listCalendarEvents.handler({ calendar: 'devora' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown calendar');
    expect(fn).not.toHaveBeenCalled();
  });

  it('routes calendar: "devorah" to her calendar ID in the request URL', async () => {
    const { calls } = stubFetch(200, { items: [] });
    await listCalendarEvents.handler({ calendar: 'devorah' });
    expect(calls[0].url).toContain(encodeURIComponent('adardevora@gmail.com'));
  });

  it('defaults to today through 7 days from now when from/to are omitted', async () => {
    const { calls } = stubFetch(200, { items: [] });
    await listCalendarEvents.handler({ calendar: 'uriel' });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('orderBy')).toBe('startTime');
    const timeMin = new Date(url.searchParams.get('timeMin')!);
    const timeMax = new Date(url.searchParams.get('timeMax')!);
    expect(timeMax.getTime() - timeMin.getTime()).toBe(7 * 24 * 60 * 60 * 1000);

    // timeMin should be today's midnight in TIMEZONE, not "right now" —
    // computed independently here rather than reusing the tool's own helper.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(timeMin).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
    );
    // Some ICU builds render hour12:false midnight as "24" instead of "00" —
    // same quirk parseZonedToUtc itself normalizes; match that here too.
    const hour = parts.hour === '24' ? '00' : parts.hour;
    expect(`${hour}:${parts.minute}:${parts.second}`).toBe('00:00:00');
  });

  it('uses an explicit from/to range via parseZonedToUtc, not the default window', async () => {
    const from = '2026-09-01T00:00:00';
    const to = '2026-09-03T00:00:00';
    const { calls } = stubFetch(200, { items: [] });

    await listCalendarEvents.handler({ calendar: 'uriel', from, to });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get('timeMin')).toBe(parseZonedToUtc(from, TIMEZONE).toISOString());
    expect(url.searchParams.get('timeMax')).toBe(parseZonedToUtc(to, TIMEZONE).toISOString());
  });

  it('passes query through as the Google q search parameter', async () => {
    const { calls } = stubFetch(200, { items: [] });
    await listCalendarEvents.handler({ calendar: 'uriel', query: 'dentist' });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('q')).toBe('dentist');
  });

  it('omits the q parameter when query is not given', async () => {
    const { calls } = stubFetch(200, { items: [] });
    await listCalendarEvents.handler({ calendar: 'uriel' });
    const url = new URL(calls[0].url);
    expect(url.searchParams.has('q')).toBe(false);
  });

  it('declines an invalid from with no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await listCalendarEvents.handler({ calendar: 'uriel', from: 'not-a-date' });
    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines a to before from with no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await listCalendarEvents.handler({
      calendar: 'uriel',
      from: '2026-09-05T00:00:00',
      to: '2026-09-01T00:00:00',
    });
    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('says plainly when no events are found — not an error, no guessing', async () => {
    stubFetch(200, { items: [] });
    const result = await listCalendarEvents.handler({ calendar: 'uriel' });
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('No events found');
  });

  it('lists each event with id, title, time, and location', async () => {
    stubFetch(200, {
      items: [
        {
          id: 'evt-1',
          summary: 'Dentist',
          start: { dateTime: '2026-08-20T14:00:00.000Z', timeZone: TIMEZONE },
          end: { dateTime: '2026-08-20T15:00:00.000Z', timeZone: TIMEZONE },
          location: 'Clinic',
        },
        {
          id: 'evt-2',
          summary: 'Team sync',
          start: { dateTime: '2026-08-21T12:00:00.000Z', timeZone: TIMEZONE },
          end: { dateTime: '2026-08-21T13:00:00.000Z', timeZone: TIMEZONE },
        },
      ],
    });

    const result = await listCalendarEvents.handler({ calendar: 'uriel' });
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('evt-1');
    expect(text).toContain('Dentist');
    expect(text).toContain('Clinic');
    expect(text).toContain(formatLocalTime('2026-08-20T14:00:00.000Z', TIMEZONE));
    expect(text).toContain('evt-2');
    expect(text).toContain('Team sync');
  });

  it('formats an all-day event without a raw dateTime', async () => {
    stubFetch(200, {
      items: [{ id: 'evt-allday', summary: 'Holiday', start: { date: '2026-08-20' }, end: { date: '2026-08-21' } }],
    });
    const result = await listCalendarEvents.handler({ calendar: 'uriel' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('All day');
    expect(text).toContain('2026-08-20');
  });

  it('notes when results were capped rather than silently showing a partial list', async () => {
    stubFetch(200, { items: [{ id: 'evt-1', summary: 'X' }], nextPageToken: 'more' });
    const result = await listCalendarEvents.handler({ calendar: 'uriel' });
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain('capped');
  });

  it('surfaces the gateway connect_url when not connected (401)', async () => {
    stubFetch(401, { error: 'app_not_connected', connect_url: 'https://gateway.local/connect/google-calendar' });
    const result = await listCalendarEvents.handler({ calendar: 'uriel' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('https://gateway.local/connect/google-calendar');
  });

  it('does NOT relabel a real 403 (no setup URL) as "not connected"', async () => {
    stubFetch(403, { error: { code: 403, message: "Devora's calendar is not shared" } });
    const result = await listCalendarEvents.handler({ calendar: 'devorah' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('403');
    expect(text).toContain("Devora's calendar is not shared");
    expect(text).not.toContain("isn't connected yet");
  });

  it('returns an MCP error (not a throw) when fetch itself rejects', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const result = await listCalendarEvents.handler({ calendar: 'uriel' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('network unreachable');
  });

  it('surfaces a clear timeout message on the 30s bound', async () => {
    globalThis.fetch = mock(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;

    const result = await listCalendarEvents.handler({ calendar: 'uriel' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('timed out');
  });
});

describe('update_calendar_event MCP tool', () => {
  it('declares only calendar as required (eventId/eventQuery are alternatives)', () => {
    expect(updateCalendarEvent.tool.name).toBe('update_calendar_event');
    expect(updateCalendarEvent.tool.inputSchema).toMatchObject({ required: ['calendar'] });
  });

  it('declines a missing calendar argument, no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await updateCalendarEvent.handler({ eventId: 'evt-1', title: 'New title' });
    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines an unknown calendar value, no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await updateCalendarEvent.handler({ calendar: 'devora', eventId: 'evt-1', title: 'x' });
    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines a recurrence argument with a clear message, no fetch attempted', async () => {
    // update_calendar_event has no recurrence support (create-time only) —
    // an agent passing it anyway must get a clear rejection, not have it
    // silently ignored (deferred-work.md finding).
    const fn = stubFetchThrows();
    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventId: 'evt-1',
      title: 'x',
      recurrence: ['RRULE:FREQ=WEEKLY'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cannot add, change, or remove recurrence');
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines when neither eventId nor eventQuery is given, no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await updateCalendarEvent.handler({ calendar: 'uriel', title: 'New title' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('eventId or eventQuery');
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines when eventId is given but no field to change, no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await updateCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Nothing to update');
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines an invalid start with no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventId: 'evt-1',
      start: 'not-a-date',
    });
    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines end <= start when both are given, no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventId: 'evt-1',
      start: '2026-08-20T16:00:00',
      end: '2026-08-20T15:00:00',
    });
    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('updates by known eventId directly — PATCH to the exact event URL, no search call', async () => {
    const { fn, calls } = stubFetch(200, { summary: 'Renamed', htmlLink: 'https://calendar.google.com/event?eid=u1' });

    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventId: 'evt-known',
      title: 'Renamed',
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-known');
    expect(calls[0].init?.method).toBe('PATCH');
    const sentBody = JSON.parse(calls[0].init!.body as string);
    expect(sentBody).toEqual({ summary: 'Renamed' });
  });

  it('sends only the changed field(s) — a real partial PATCH, not a full replace', async () => {
    const start = '2026-08-20T15:00:00';
    const { calls } = stubFetch(200, { summary: 'Team sync' });

    await updateCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', start });

    const sentBody = JSON.parse(calls[0].init!.body as string);
    expect(sentBody).toEqual({
      start: { dateTime: parseZonedToUtc(start, TIMEZONE).toISOString(), timeZone: TIMEZONE },
    });
    expect(sentBody).not.toHaveProperty('end');
    expect(sentBody).not.toHaveProperty('summary');
  });

  it('sends only end when only end is given — symmetric to the start-only case', async () => {
    const end = '2026-08-20T17:00:00';
    const { calls } = stubFetch(200, { summary: 'Team sync' });

    await updateCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', end });

    const sentBody = JSON.parse(calls[0].init!.body as string);
    expect(sentBody).toEqual({
      end: { dateTime: parseZonedToUtc(end, TIMEZONE).toISOString(), timeZone: TIMEZONE },
    });
    expect(sentBody).not.toHaveProperty('start');
    expect(sentBody).not.toHaveProperty('summary');
  });

  it('an explicit empty-string description alone is a real change, not "nothing to update"', async () => {
    const { fn, calls } = stubFetch(200, { summary: 'x' });

    const result = await updateCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', description: '' });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(calls[0].init!.body as string);
    expect(sentBody).toEqual({ description: '' });
  });

  it('an explicit empty-string title (clear) is sent alongside a real location change, not silently dropped', async () => {
    const { calls } = stubFetch(200, { summary: '', location: 'Office' });

    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventId: 'evt-1',
      title: '',
      location: 'Office',
    });

    expect(result.isError).toBeFalsy();
    const sentBody = JSON.parse(calls[0].init!.body as string);
    expect(sentBody).toEqual({ summary: '', location: 'Office' });
  });

  it('eventId takes priority over eventQuery when both are given — no search call made', async () => {
    // A single-response stub: if a search GET happened first, it would
    // consume this response and the subsequent PATCH would see it as the
    // "events list" shape, not a patched-event shape — asserting exactly
    // one call and that it hits /events/evt-direct is enough to prove no
    // search was attempted.
    const { fn, calls } = stubFetch(200, { summary: 'Renamed' });

    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventId: 'evt-direct',
      eventQuery: 'this should be ignored',
      title: 'Renamed',
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(1); // one call: the PATCH, no search GET
    expect(calls[0].url).toContain('/events/evt-direct');
    expect(calls[0].init?.method).toBe('PATCH');
  });

  it('routes calendar: "devorah" to her calendar ID in the PATCH URL', async () => {
    const { calls } = stubFetch(200, { summary: 'x' });
    await updateCalendarEvent.handler({ calendar: 'devorah', eventId: 'evt-1', title: 'x' });
    expect(calls[0].url).toContain(encodeURIComponent('adardevora@gmail.com'));
  });

  it('resolves a single search match and updates it directly', async () => {
    const { fn, calls } = stubFetchSequence([
      {
        status: 200,
        body: {
          items: [
            {
              id: 'evt-found',
              summary: 'Dentist',
              start: { dateTime: '2026-08-20T14:00:00.000Z' },
              end: { dateTime: '2026-08-20T15:00:00.000Z' },
            },
          ],
        },
      },
      { status: 200, body: { summary: 'Dentist (moved)' } },
    ]);

    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventQuery: 'dentist',
      start: '2026-08-25T14:00:00',
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[1].url).toContain('/events/evt-found');
    expect(calls[1].init?.method).toBe('PATCH');
  });

  it('declines with zero search matches, no PATCH attempted, and states the window searched', async () => {
    const { fn } = stubFetchSequence([{ status: 200, body: { items: [] } }]);

    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventQuery: 'nonexistent',
      title: 'New title',
      from: '2026-09-01T00:00:00',
      to: '2026-09-03T00:00:00',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('no events found');
    // States the resolved window, not just "not found" — otherwise "doesn't
    // exist" and "exists but outside the searched window" are indistinguishable.
    expect(result.content[0].text).toContain(
      formatLocalTime(parseZonedToUtc('2026-09-01T00:00:00', TIMEZONE).toISOString(), TIMEZONE),
    );
    expect(fn).toHaveBeenCalledTimes(1); // search only, no PATCH
  });

  it('returns a numbered candidate list (not an error) on multiple search matches, no PATCH attempted, states the window searched', async () => {
    const { fn } = stubFetchSequence([
      {
        status: 200,
        body: {
          items: [
            {
              id: 'evt-a',
              summary: 'Team sync',
              start: { dateTime: '2026-08-20T14:00:00.000Z' },
              end: { dateTime: '2026-08-20T15:00:00.000Z' },
            },
            {
              id: 'evt-b',
              summary: 'Team sync',
              start: { dateTime: '2026-08-21T14:00:00.000Z' },
              end: { dateTime: '2026-08-21T15:00:00.000Z' },
            },
          ],
        },
      },
    ]);

    const from = '2026-08-15T00:00:00';
    const to = '2026-08-25T00:00:00';
    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventQuery: 'team sync',
      title: 'Renamed sync',
      from,
      to,
    });

    expect(result.isError).toBeFalsy(); // discovery response, not an error (matrix: N/A)
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('evt-a');
    expect(text).toContain('evt-b');
    expect(text).toContain('1.');
    expect(text).toContain('2.');
    expect(text).toContain(formatLocalTime(parseZonedToUtc(from, TIMEZONE).toISOString(), TIMEZONE));
    expect(fn).toHaveBeenCalledTimes(1); // search only, no PATCH
  });

  it('candidate list includes location — two same-title/same-time candidates stay distinguishable', async () => {
    stubFetchSequence([
      {
        status: 200,
        body: {
          items: [
            {
              id: 'evt-home',
              summary: 'Team sync',
              start: { dateTime: '2026-08-20T14:00:00.000Z' },
              end: { dateTime: '2026-08-20T15:00:00.000Z' },
              location: 'Home office',
            },
            {
              id: 'evt-hq',
              summary: 'Team sync',
              start: { dateTime: '2026-08-20T14:00:00.000Z' },
              end: { dateTime: '2026-08-20T15:00:00.000Z' },
              location: 'HQ',
            },
          ],
        },
      },
    ]);

    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventQuery: 'team sync',
      title: 'Renamed sync',
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Home office');
    expect(text).toContain('HQ');
  });

  it('candidate list discloses truncation the same way list_calendar_events does', async () => {
    stubFetchSequence([
      {
        status: 200,
        body: {
          items: [
            { id: 'evt-a', summary: 'Team sync', start: { dateTime: '2026-08-20T14:00:00.000Z' } },
            { id: 'evt-b', summary: 'Team sync', start: { dateTime: '2026-08-21T14:00:00.000Z' } },
          ],
          nextPageToken: 'more',
        },
      },
    ]);

    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventQuery: 'team sync',
      title: 'Renamed sync',
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain('capped');
  });

  it('confirmation reflects what Google actually echoes back, not just the request', async () => {
    stubFetch(200, {
      summary: 'Renamed by Google',
      start: { dateTime: '2026-08-20T14:00:00.000Z', timeZone: TIMEZONE },
      end: { dateTime: '2026-08-20T15:00:00.000Z', timeZone: TIMEZONE },
      location: 'New office',
      htmlLink: 'https://calendar.google.com/event?eid=echoed',
    });

    const result = await updateCalendarEvent.handler({
      calendar: 'uriel',
      eventId: 'evt-1',
      title: 'Attempted title', // Google's response differs — must reflect Google's, not this
      location: 'New office',
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Renamed by Google');
    expect(text).toContain('New office');
    expect(text).toContain('https://calendar.google.com/event?eid=echoed');
  });

  it('surfaces the gateway connect_url on a PATCH 401 (direct eventId path)', async () => {
    stubFetch(401, { error: 'app_not_connected', connect_url: 'https://gateway.local/connect/google-calendar' });

    const result = await updateCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', title: 'x' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('https://gateway.local/connect/google-calendar');
  });

  it('does NOT relabel a real 403 (no setup URL) as "not connected" on PATCH', async () => {
    stubFetch(403, { error: { code: 403, message: 'Insufficient permission for this calendar' } });

    const result = await updateCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', title: 'x' });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('403');
    expect(text).toContain('Insufficient permission for this calendar');
    expect(text).not.toContain("isn't connected yet");
  });

  it('returns an MCP error (not a throw) when the PATCH fetch itself rejects', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const result = await updateCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', title: 'x' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('network unreachable');
  });

  it('surfaces a clear timeout message on the PATCH 30s bound', async () => {
    globalThis.fetch = mock(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;

    const result = await updateCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', title: 'x' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('timed out');
  });

  it('never sends a title/description/location that was not requested to change', async () => {
    const { calls } = stubFetch(200, { summary: 'x' });
    await updateCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', description: 'New notes' });
    const sentBody = JSON.parse(calls[0].init!.body as string);
    expect(sentBody).toEqual({ description: 'New notes' });
  });
});

describe('delete_calendar_event MCP tool', () => {
  it('declares only calendar as required (eventId/eventQuery are alternatives)', () => {
    expect(deleteCalendarEvent.tool.name).toBe('delete_calendar_event');
    expect(deleteCalendarEvent.tool.inputSchema).toMatchObject({ required: ['calendar'] });
  });

  it('does not expose a confirm argument — the tool always blocks on a real confirmation itself', () => {
    const props = (deleteCalendarEvent.tool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty('confirm');
  });

  it('declines a missing calendar argument, no fetch attempted, no confirmation asked', async () => {
    const fetchFn = stubFetchThrows();
    const { fn: confirmFn } = stubConfirmDeletion({ confirmed: true });
    const result = await deleteCalendarEvent.handler({ eventId: 'evt-1' });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('declines an unknown calendar value, no fetch attempted, no confirmation asked', async () => {
    const fetchFn = stubFetchThrows();
    const { fn: confirmFn } = stubConfirmDeletion({ confirmed: true });
    const result = await deleteCalendarEvent.handler({ calendar: 'devora', eventId: 'evt-1' });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('declines when neither eventId nor eventQuery is given, no fetch attempted, no confirmation asked', async () => {
    const fetchFn = stubFetchThrows();
    const { fn: confirmFn } = stubConfirmDeletion({ confirmed: true });
    const result = await deleteCalendarEvent.handler({ calendar: 'uriel' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('eventId or eventQuery');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('a direct eventId is looked up first (real details for the confirmation), then blocks on confirmation', async () => {
    const { fn: fetchFn, calls } = stubFetchSequence([
      {
        status: 200,
        body: {
          id: 'evt-1',
          summary: 'Dentist',
          start: { dateTime: '2026-08-20T17:00:00.000Z' },
          end: { dateTime: '2026-08-20T17:30:00.000Z' },
        },
      },
    ]);
    const { fn: confirmFn, questions } = stubConfirmDeletion({ confirmed: false });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1' });

    expect(fetchFn).toHaveBeenCalledTimes(1); // lookup only — confirmed: false, no DELETE
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1');
    expect(confirmFn).toHaveBeenCalledTimes(1);
    // The human-facing question is what a chat card shows verbatim — never
    // rephrased by the agent the way every other tool's output is. It must
    // never leak the raw Google event id (meaningless noise to a human
    // deciding yes/no) and must use 24h time, not the shared formatLocalTime
    // helper's 12-hour English default (2026-08-18 finding: the LLM
    // normally reformats that to 24h in its own reply; this text skips that
    // rephrasing step entirely, so it must already be right).
    expect(questions[0]).toContain('Dentist');
    expect(questions[0]).not.toContain('evt-1');
    expect(questions[0]).toContain(format24h('2026-08-20T17:00:00.000Z'));
    expect(questions[0].toUpperCase()).not.toContain('PM');
    expect(questions[0].toUpperCase()).not.toContain('AM');
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.toLowerCase()).toContain('not deleted');
  });

  it('a direct eventId that fails to look up surfaces the lookup error — no confirmation asked, no DELETE', async () => {
    stubFetch(404, { error: { message: 'Not Found' } });
    const { fn: confirmFn } = stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-gone' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('404');
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('confirmation gate itself errors (e.g. timeout) after a successful lookup — surfaced as-is, no DELETE attempted', async () => {
    const { fn: fetchFn } = stubFetchSequence([
      { status: 200, body: { id: 'evt-1', summary: 'Dentist', start: {}, end: {} } },
    ]);
    stubConfirmDeletion({ error: { content: [{ type: 'text', text: 'Error: Question timed out after 300s' }], isError: true } });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('timed out');
    expect(fetchFn).toHaveBeenCalledTimes(1); // lookup only, no DELETE
  });

  it('confirmed: true with a direct eventId — looks it up, then DELETEs the exact event URL, no search call', async () => {
    const { fn, calls } = stubFetchSequence([
      { status: 200, body: { id: 'evt-known', summary: 'Renamed', start: {}, end: {} } },
      { status: 200, body: {} },
    ]);
    stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-known' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Renamed'); // real looked-up title, not a bare id
    expect(fn).toHaveBeenCalledTimes(2); // lookup, then DELETE
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-known');
    expect(calls[1].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-known');
    expect(calls[1].init?.method).toBe('DELETE');
  });

  it('routes calendar: "devorah" to her calendar ID in the lookup and DELETE URLs', async () => {
    const { calls } = stubFetchSequence([
      { status: 200, body: { id: 'evt-1', summary: 'x', start: {}, end: {} } },
      { status: 200, body: {} },
    ]);
    stubConfirmDeletion({ confirmed: true });
    await deleteCalendarEvent.handler({ calendar: 'devorah', eventId: 'evt-1' });
    expect(calls[0].url).toContain(encodeURIComponent('adardevora@gmail.com'));
    expect(calls[1].url).toContain(encodeURIComponent('adardevora@gmail.com'));
  });

  it('eventId takes priority over eventQuery when both are given — no search call made', async () => {
    const { fn, calls } = stubFetchSequence([
      { status: 200, body: { id: 'evt-direct', summary: 'x', start: {}, end: {} } },
      { status: 200, body: {} },
    ]);
    stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({
      calendar: 'uriel',
      eventId: 'evt-direct',
      eventQuery: 'this should be ignored',
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(2); // lookup + DELETE — no search GET
    expect(calls[0].url).toContain('/events/evt-direct');
    expect(calls[1].url).toContain('/events/evt-direct');
    expect(calls[1].init?.method).toBe('DELETE');
  });

  it('resolves a single search match, asks for confirmation with the real event details, before touching DELETE', async () => {
    const { fn: fetchFn } = stubFetchSequence([
      {
        status: 200,
        body: {
          items: [
            {
              id: 'evt-found',
              summary: 'Dentist',
              start: { dateTime: '2026-08-20T17:00:00.000Z' },
              end: { dateTime: '2026-08-20T17:30:00.000Z' },
            },
          ],
        },
      },
    ]);
    const { fn: confirmFn, questions } = stubConfirmDeletion({ confirmed: false });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventQuery: 'dentist' });

    expect(fetchFn).toHaveBeenCalledTimes(1); // search only — confirmed: false, no DELETE
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(questions[0]).toContain('Dentist');
    expect(questions[0]).not.toContain('evt-found'); // no raw id in the human-facing question
    expect(questions[0]).toContain(format24h('2026-08-20T17:00:00.000Z'));
    expect(questions[0].toUpperCase()).not.toContain('PM');
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.toLowerCase()).toContain('not deleted');
  });

  it('resolves a single search match and deletes it once confirmed, echoing real event details', async () => {
    const { fn, calls } = stubFetchSequence([
      {
        status: 200,
        body: {
          items: [
            {
              id: 'evt-found',
              summary: 'Dentist',
              start: { dateTime: '2026-08-20T14:00:00.000Z' },
              end: { dateTime: '2026-08-20T15:00:00.000Z' },
            },
          ],
        },
      },
      { status: 200, body: {} },
    ]);
    stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventQuery: 'dentist' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Dentist');
    expect(fn).toHaveBeenCalledTimes(2); // search, then DELETE
    expect(calls[1].url).toContain('/events/evt-found');
    expect(calls[1].init?.method).toBe('DELETE');
  });

  it('declines with zero search matches, no confirmation asked, no DELETE attempted, states the window searched', async () => {
    const { fn: fetchFn } = stubFetchSequence([{ status: 200, body: { items: [] } }]);
    const { fn: confirmFn } = stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({
      calendar: 'uriel',
      eventQuery: 'nonexistent',
      from: '2026-09-01T00:00:00',
      to: '2026-09-03T00:00:00',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('no events found');
    expect(result.content[0].text).toContain(
      formatLocalTime(parseZonedToUtc('2026-09-01T00:00:00', TIMEZONE).toISOString(), TIMEZONE),
    );
    expect(fetchFn).toHaveBeenCalledTimes(1); // search only, no DELETE
    expect(confirmFn).not.toHaveBeenCalled(); // nothing resolved — nothing to confirm
  });

  it('returns a numbered candidate list on multiple search matches — ambiguity blocks confirmation and DELETE alike', async () => {
    const { fn: fetchFn } = stubFetchSequence([
      {
        status: 200,
        body: {
          items: [
            {
              id: 'evt-a',
              summary: 'Team sync',
              start: { dateTime: '2026-08-20T14:00:00.000Z' },
              end: { dateTime: '2026-08-20T15:00:00.000Z' },
            },
            {
              id: 'evt-b',
              summary: 'Team sync',
              start: { dateTime: '2026-08-21T14:00:00.000Z' },
              end: { dateTime: '2026-08-21T15:00:00.000Z' },
            },
          ],
        },
      },
    ]);
    const { fn: confirmFn } = stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventQuery: 'team sync' });

    expect(result.isError).toBeFalsy(); // discovery response, not an error
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('evt-a');
    expect(text).toContain('evt-b');
    expect(text).toContain('1.');
    expect(text).toContain('2.');
    expect(fetchFn).toHaveBeenCalledTimes(1); // search only, no DELETE
    expect(confirmFn).not.toHaveBeenCalled(); // still ambiguous — nothing to confirm yet
  });

  it('a direct eventId whose lookup fetch itself rejects surfaces an MCP error, no confirmation asked', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    const { fn: confirmFn } = stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network unreachable');
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('surfaces the gateway connect_url when the DELETE call returns 401 (lookup already succeeded)', async () => {
    stubFetchSequence([
      { status: 200, body: { id: 'evt-1', summary: 'x', start: {}, end: {} } },
      { status: 401, body: { connect_url: 'https://onecli.example/connect/google-calendar' } },
    ]);
    stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('https://onecli.example/connect/google-calendar');
  });

  it('does NOT relabel a real 403 on DELETE (no setup URL) as "not connected"', async () => {
    stubFetchSequence([
      { status: 200, body: { id: 'evt-1', summary: 'x', start: {}, end: {} } },
      { status: 403, body: { error: { message: 'requiredAccessLevel' } } },
    ]);
    stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({ calendar: 'devorah', eventId: 'evt-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).not.toContain('not connected');
    expect(result.content[0].text).toContain('403');
  });

  it('returns an MCP error (not a throw) when the DELETE fetch itself rejects (lookup already succeeded)', async () => {
    let call = 0;
    globalThis.fetch = mock(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ id: 'evt-1', summary: 'x', start: {}, end: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network unreachable');
  });

  it('surfaces a clear timeout message when the DELETE call itself times out (lookup already succeeded)', async () => {
    let call = 0;
    globalThis.fetch = mock(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ id: 'evt-1', summary: 'x', start: {}, end: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;
    stubConfirmDeletion({ confirmed: true });

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('timed out');
  });
});

// spec cal-2.3: config-driven calendar registry — resolveCalendarIds() merges
// the built-in CALENDAR_IDS with calendarConfigHooks.getCalendarRegistry(),
// config entries winning on a name collision. Uses list_calendar_events as
// the representative tool (single fetch, no confirmation gate) since all
// four tools share the exact same resolution triplet.
describe('calendar registry resolution (spec cal-2.3)', () => {
  // I/O Matrix row 5 ("remove-calendar on a name that was never added") is
  // CLI-level behavior with no calendar.ts involvement — covered in
  // src/cli/resources/groups.test.ts's 'groups config add-calendar /
  // remove-calendar' block instead, not duplicated here.
  it('I/O Matrix row 1: empty registry (fresh migration) — built-in "uriel"/"devorah" resolve exactly as before this story', async () => {
    stubCalendarRegistry([]);
    const { calls: urielCalls } = stubFetch(200, { items: [] });
    await listCalendarEvents.handler({ calendar: 'uriel' });
    expect(urielCalls[0].url).toContain('/calendars/primary/events');

    const { calls: devorahCalls } = stubFetch(200, { items: [] });
    await listCalendarEvents.handler({ calendar: 'devorah' });
    expect(devorahCalls[0].url).toContain(encodeURIComponent('adardevora@gmail.com'));
  });

  it('I/O Matrix row 2: a config-added third calendar resolves and works the same as a built-in name', async () => {
    stubCalendarRegistry([{ name: 'family', calendarId: 'family-cal@group.calendar.google.com' }]);
    const { calls } = stubFetch(200, { items: [] });

    const result = await listCalendarEvents.handler({ calendar: 'family' });

    expect(result.isError).toBeFalsy();
    expect(calls[0].url).toContain(encodeURIComponent('family-cal@group.calendar.google.com'));
  });

  it('I/O Matrix row 3: a registry entry reusing a built-in name ("uriel") overrides the built-in — config wins', async () => {
    stubCalendarRegistry([{ name: 'uriel', calendarId: 'override@group.calendar.google.com' }]);
    const { calls } = stubFetch(200, { items: [] });

    const result = await listCalendarEvents.handler({ calendar: 'uriel' });

    expect(result.isError).toBeFalsy();
    expect(calls[0].url).toContain(encodeURIComponent('override@group.calendar.google.com'));
    expect(calls[0].url).not.toContain('/calendars/primary/');
  });

  it('I/O Matrix row 4: an unresolvable calendar name declines, listing every currently-resolvable name (built-ins + registry)', async () => {
    stubCalendarRegistry([{ name: 'family', calendarId: 'family-cal@group.calendar.google.com' }]);
    const fn = stubFetchThrows();

    const result = await listCalendarEvents.handler({ calendar: 'not-added-yet' });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Unknown calendar');
    expect(text).toContain('uriel');
    expect(text).toContain('devorah');
    expect(text).toContain('family');
    expect(fn).not.toHaveBeenCalled();
  });

  it('I/O Matrix row 6: a registry entry not yet reflected in the loaded config (stale container.json) declines exactly like a genuinely-unknown name', async () => {
    // Simulates a registry entry that exists in the DB but hasn't been
    // materialized into this container's container.json yet — from
    // resolveCalendarIds()'s perspective this is indistinguishable from a
    // name that was never added at all (restart is required, same as every
    // other config change).
    stubCalendarRegistry([]); // pre-restart snapshot — "family" not present yet
    const fn = stubFetchThrows();

    const result = await listCalendarEvents.handler({ calendar: 'family' });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    // The requested (unresolved) name is echoed once in the "Unknown calendar
    // "family"" preamble — the assertion below is about the RESOLVABLE-set
    // listing that follows "must be one of:", which must not include it.
    expect(text).toContain('Unknown calendar "family"');
    const resolvableSet = text.split('must be one of:')[1] ?? '';
    expect(resolvableSet).toContain('uriel');
    expect(resolvableSet).toContain('devorah');
    expect(resolvableSet).not.toContain('family');
    expect(fn).not.toHaveBeenCalled();
  });

  it('every one of the four tools resolves a config-added calendar name, not just list_calendar_events', async () => {
    stubCalendarRegistry([{ name: 'family', calendarId: 'family-cal@group.calendar.google.com' }]);

    // create_calendar_event
    stubFetchSequence([PRECHECK_EMPTY, { status: 200, body: { summary: 'x' } }]);
    const createResult = await createCalendarEvent.handler({
      calendar: 'family',
      title: 'x',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });
    expect(createResult.isError).toBeFalsy();

    // update_calendar_event (direct eventId — no search)
    stubFetchSequence([{ status: 200, body: { summary: 'x' } }]);
    const updateResult = await updateCalendarEvent.handler({ calendar: 'family', eventId: 'evt-1', title: 'y' });
    expect(updateResult.isError).toBeFalsy();

    // delete_calendar_event (direct eventId — lookup, confirm, delete)
    stubFetchSequence([
      { status: 200, body: { id: 'evt-1', summary: 'x', start: {}, end: {} } },
      { status: 204, body: {} },
    ]);
    stubConfirmDeletion({ confirmed: true });
    const deleteResult = await deleteCalendarEvent.handler({ calendar: 'family', eventId: 'evt-1' });
    expect(deleteResult.isError).toBeFalsy();
  });
});
