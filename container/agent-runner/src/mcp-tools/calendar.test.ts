import { describe, it, expect, afterEach, mock } from 'bun:test';

import { createCalendarEvent } from './calendar.js';
import { TIMEZONE, parseZonedToUtc } from '../timezone.js';

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

describe('create_calendar_event MCP tool', () => {
  it('declares title/start/end as required', () => {
    expect(createCalendarEvent.tool.name).toBe('create_calendar_event');
    expect(createCalendarEvent.tool.inputSchema).toMatchObject({
      required: ['title', 'start', 'end'],
    });
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    await createCalendarEvent.handler({ title: 'Tz check', start, end });

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

    const result = await createCalendarEvent.handler({ title: 'Offset check', start, end });

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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines an empty-string title the same as a missing one', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({
      title: '',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines a missing start with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({
      title: 'Team sync',
      end: '2026-08-20T16:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines a missing end with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines end == start (zero duration) with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({
      title: 'Team sync',
      start: '2026-08-20T15:00:00',
      end: '2026-08-20T15:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines end before start with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({
      title: 'Team sync',
      start: '2026-08-20T16:00:00',
      end: '2026-08-20T15:00:00',
    });

    expect(result.isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it('declines a malformed guests argument (not an array) with no partial API call attempted', async () => {
    const fn = stubFetchThrows();

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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

    const result = await createCalendarEvent.handler({
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
