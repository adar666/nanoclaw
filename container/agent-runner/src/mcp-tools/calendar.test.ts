import { describe, it, expect, afterEach, mock } from 'bun:test';

import { createCalendarEvent, listCalendarEvents, updateCalendarEvent, deleteCalendarEvent } from './calendar.js';
import { TIMEZONE, parseZonedToUtc, formatLocalTime } from '../timezone.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

  it('routes calendar: "devorah" to her calendar ID in the request URL', async () => {
    const { calls } = stubFetch(200, {
      summary: 'Her event',
      start: { dateTime: '2026-08-20T12:00:00.000Z', timeZone: TIMEZONE },
      end: { dateTime: '2026-08-20T13:00:00.000Z', timeZone: TIMEZONE },
    });

    await createCalendarEvent.handler({
      calendar: 'devorah',
      title: 'Her event',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(calls[0].url).toContain(encodeURIComponent('adardevora@gmail.com'));
  });

  it('routes calendar: "uriel" to /calendars/primary/ in the request URL', async () => {
    const { calls } = stubFetch(200, {
      summary: 'His event',
      start: { dateTime: '2026-08-20T12:00:00.000Z', timeZone: TIMEZONE },
      end: { dateTime: '2026-08-20T13:00:00.000Z', timeZone: TIMEZONE },
    });

    await createCalendarEvent.handler({
      calendar: 'uriel',
      title: 'His event',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(calls[0].url).toContain('/calendars/primary/events');
  });

  it('creates an event with full details and confirms with htmlLink', async () => {
    const start = '2026-08-20T15:00:00';
    const end = '2026-08-20T16:00:00';
    const { fn, calls } = stubFetch(200, {
      summary: 'Team sync',
      start: { dateTime: parseZonedToUtc(start, TIMEZONE).toISOString(), timeZone: TIMEZONE },
      end: { dateTime: parseZonedToUtc(end, TIMEZONE).toISOString(), timeZone: TIMEZONE },
      location: 'Office',
      description: 'Weekly sync',
      attendees: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
      htmlLink: 'https://calendar.google.com/event?eid=abc123',
    });

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start,
      end,
      description: 'Weekly sync',
      location: 'Office',
      guests: ['a@example.com', 'b@example.com'],
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    // A request timeout bound must be present (Patch 5) — a hung gateway/
    // upstream call must not block the tool call indefinitely.
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);

    const sentBody = JSON.parse(calls[0].init!.body as string);
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
    const { fn, calls } = stubFetch(200, {
      summary: 'Quick call',
      start: { dateTime: '2026-08-20T12:00:00.000Z', timeZone: TIMEZONE },
      end: { dateTime: '2026-08-20T13:00:00.000Z', timeZone: TIMEZONE },
      htmlLink: 'https://calendar.google.com/event?eid=def456',
    });

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Quick call',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(1);

    const sentBody = JSON.parse(calls[0].init!.body as string);
    expect(sentBody.summary).toBe('Quick call');
    expect(sentBody).not.toHaveProperty('description');
    expect(sentBody).not.toHaveProperty('location');
    expect(sentBody).not.toHaveProperty('attendees');
  });

  it('constructs start/end dateTime + timeZone via parseZonedToUtc(input, TIMEZONE) — never a bare/UTC-only dateTime', async () => {
    const start = '2026-08-20T15:00:00';
    const end = '2026-08-20T16:00:00';
    const { calls } = stubFetch(200, {
      summary: 'Tz check',
      htmlLink: 'https://calendar.google.com/event?eid=tz1',
    });

    await createCalendarEvent.handler({ calendar: 'uriel', title: 'Tz check', start, end });

    const sentBody = JSON.parse(calls[0].init!.body as string);
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
    const { calls } = stubFetch(200, { summary: 'Offset check', htmlLink: 'https://calendar.google.com/event?eid=off1' });

    const result = await createCalendarEvent.handler({ calendar: 'uriel', title: 'Offset check', start, end });

    expect(result.isError).toBeFalsy();
    const sentBody = JSON.parse(calls[0].init!.body as string);
    expect(sentBody.start.dateTime).toBe(new Date(start).toISOString());
    expect(sentBody.start.timeZone).toBe(TIMEZONE);
    expect(sentBody.end.dateTime).toBe(new Date(end).toISOString());
    expect(sentBody.end.timeZone).toBe(TIMEZONE);
  });

  it('surfaces the gateway connect_url when the calendar is not connected yet (401)', async () => {
    stubFetch(401, {
      error: 'app_not_connected',
      connect_url: 'https://gateway.local/connect/google-calendar?agent=household',
    });

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('https://gateway.local/connect/google-calendar?agent=household');
  });

  it('surfaces manage_url when present and connect_url is absent (403)', async () => {
    stubFetch(403, {
      error: 'agent_lacks_access',
      manage_url: 'https://gateway.local/manage/google-calendar',
    });

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('https://gateway.local/manage/google-calendar');
  });

  it('does NOT relabel a 403 with no setup URL as "not connected" — surfaces the real error instead', async () => {
    // A genuine Google 403 (insufficient scope, quota, read-only sharing,
    // domain policy, ...) carries no connect_url/secret_url/manage_url.
    // Blanket-treating any 401/403 as "reconnect your calendar" would
    // discard this real cause and mislead the user about an already-working
    // connection.
    stubFetch(403, { error: { code: 403, message: 'Insufficient permission for this calendar' } });

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

  it('returns an MCP error (not a crash) for a non-2xx response with no setup URL', async () => {
    stubFetch(400, { error: { code: 400, message: 'Invalid request' } });

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
    const { fn, calls } = stubFetch(200, {
      summary: 'Quick call',
      htmlLink: 'https://calendar.google.com/event?eid=empty-guests',
    });

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Quick call',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
      guests: [],
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(calls[0].init!.body as string);
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

  it('returns an MCP error (not a throw) when fetch itself rejects (network failure)', async () => {
    globalThis.fetch = mock(async () => {
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
  });

  it('surfaces a clear timeout message when the request aborts (30s bound)', async () => {
    globalThis.fetch = mock(async () => {
      const e = new DOMException('The operation timed out.', 'TimeoutError');
      throw e;
    }) as unknown as typeof fetch;

    const result = await createCalendarEvent.handler({ calendar: 'uriel',
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain('timed out');
  });

  it('prefers attendees actually echoed back by Google over what was requested', async () => {
    // Google dropped one of the two requested guests (e.g. invalid/blocked)
    // — the confirmation must reflect that, not just restate the request.
    stubFetch(200, {
      summary: 'Team sync',
      attendees: [{ email: 'a@example.com' }],
      htmlLink: 'https://calendar.google.com/event?eid=partial-guests',
    });

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
    stubFetch(200, { summary: 'Team sync' });

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

  it('declines a missing calendar argument, no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await deleteCalendarEvent.handler({ eventId: 'evt-1' });
    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines an unknown calendar value, no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await deleteCalendarEvent.handler({ calendar: 'devora', eventId: 'evt-1' });
    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines when neither eventId nor eventQuery is given, no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await deleteCalendarEvent.handler({ calendar: 'uriel' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('eventId or eventQuery');
    expect(fn).not.toHaveBeenCalled();
  });

  it('confirm omitted: previews a direct eventId without deleting — no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('evt-1');
    expect(result.content[0].text.toLowerCase()).toContain('not deleted');
    expect(result.content[0].text).toContain('confirm: true');
    expect(fn).not.toHaveBeenCalled();
  });

  it('confirm: false explicitly: previews a direct eventId without deleting — no fetch attempted', async () => {
    const fn = stubFetchThrows();
    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', confirm: false });
    expect(result.isError).toBeFalsy();
    expect(fn).not.toHaveBeenCalled();
  });

  it('confirm: true with a direct eventId — DELETE to the exact event URL, no search call', async () => {
    const { fn, calls } = stubFetch(200, {});

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-known', confirm: true });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-known');
    expect(calls[0].init?.method).toBe('DELETE');
  });

  it('routes calendar: "devorah" to her calendar ID in the DELETE URL', async () => {
    const { calls } = stubFetch(200, {});
    await deleteCalendarEvent.handler({ calendar: 'devorah', eventId: 'evt-1', confirm: true });
    expect(calls[0].url).toContain(encodeURIComponent('adardevora@gmail.com'));
  });

  it('eventId takes priority over eventQuery when both are given — no search call made', async () => {
    const { fn, calls } = stubFetch(200, {});

    const result = await deleteCalendarEvent.handler({
      calendar: 'uriel',
      eventId: 'evt-direct',
      eventQuery: 'this should be ignored',
      confirm: true,
    });

    expect(result.isError).toBeFalsy();
    expect(fn).toHaveBeenCalledTimes(1); // one call: the DELETE, no search GET
    expect(calls[0].url).toContain('/events/evt-direct');
    expect(calls[0].init?.method).toBe('DELETE');
  });

  it('resolves a single search match and previews it (with real details) without deleting', async () => {
    const { fn } = stubFetchSequence([
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
    ]);

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventQuery: 'dentist' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Dentist');
    expect(result.content[0].text).toContain('evt-found');
    expect(result.content[0].text.toLowerCase()).toContain('not deleted');
    expect(fn).toHaveBeenCalledTimes(1); // search only, no DELETE
  });

  it('resolves a single search match and deletes it when confirm: true, echoing real event details', async () => {
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

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventQuery: 'dentist', confirm: true });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Dentist');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[1].url).toContain('/events/evt-found');
    expect(calls[1].init?.method).toBe('DELETE');
  });

  it('declines with zero search matches, no DELETE attempted, and states the window searched', async () => {
    const { fn } = stubFetchSequence([{ status: 200, body: { items: [] } }]);

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
    expect(fn).toHaveBeenCalledTimes(1); // search only, no DELETE
  });

  it('returns a numbered candidate list (not an error) on multiple search matches, no DELETE attempted', async () => {
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

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventQuery: 'team sync', confirm: true });

    expect(result.isError).toBeFalsy(); // discovery response, not an error
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('evt-a');
    expect(text).toContain('evt-b');
    expect(text).toContain('1.');
    expect(text).toContain('2.');
    expect(fn).toHaveBeenCalledTimes(1); // search only, no DELETE — even with confirm: true, ambiguity blocks it
  });

  it('surfaces the gateway connect_url when not connected (401)', async () => {
    stubFetch(401, { connect_url: 'https://onecli.example/connect/google-calendar' });
    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', confirm: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('https://onecli.example/connect/google-calendar');
  });

  it('does NOT relabel a real 403 (no setup URL) as "not connected"', async () => {
    stubFetch(403, { error: { message: 'requiredAccessLevel' } });
    const result = await deleteCalendarEvent.handler({ calendar: 'devorah', eventId: 'evt-1', confirm: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).not.toContain('not connected');
    expect(result.content[0].text).toContain('403');
  });

  it('returns an MCP error (not a throw) when the DELETE fetch itself rejects', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', confirm: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network unreachable');
  });

  it('surfaces a clear timeout message on the DELETE 30s bound', async () => {
    globalThis.fetch = mock(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }) as unknown as typeof fetch;

    const result = await deleteCalendarEvent.handler({ calendar: 'uriel', eventId: 'evt-1', confirm: true });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('timed out');
  });
});
