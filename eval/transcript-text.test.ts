/**
 * Direct coverage of `transcriptText` — no mocking, no DB, pure function.
 * `sweep.test.ts`/`judge/llm.test.ts`/`guest-resolution.scenarios.test.ts`
 * already cover it indirectly through their own call sites; this file
 * exercises the function's own contract directly, matching
 * `error-text.test.ts`'s established convention for a shared eval/ helper.
 */
import { describe, expect, it } from 'vitest';

import type { OutboundMessage } from '../src/db/session-db.js';
import { transcriptText } from './transcript-text.js';

function row(content: string, id = 'm1'): OutboundMessage {
  return { id, kind: 'chat', platform_id: null, channel_type: null, thread_id: null, content, in_reply_to: null };
}

describe('transcriptText', () => {
  it('extracts .text from a single well-formed row', () => {
    expect(transcriptText([row(JSON.stringify({ text: 'hello' }))])).toBe('hello');
  });

  it('joins multiple rows with a newline, in order', () => {
    const rows = [row(JSON.stringify({ text: 'first' }), 'm1'), row(JSON.stringify({ text: 'second' }), 'm2')];
    expect(transcriptText(rows)).toBe('first\nsecond');
  });

  it('returns an empty string for an empty transcript', () => {
    expect(transcriptText([])).toBe('');
  });

  it('swallows a row whose content is not valid JSON, contributing an empty string for it', () => {
    const rows = [row('not json at all'), row(JSON.stringify({ text: 'real' }))];
    expect(transcriptText(rows)).toBe('\nreal');
  });

  it('swallows a row whose content is valid JSON but has no string .text field', () => {
    const rows = [row(JSON.stringify({ notText: 'nope' })), row(JSON.stringify({ text: 123 })), row(JSON.stringify({ text: 'real' }))];
    expect(transcriptText(rows)).toBe('\n\nreal');
  });
});
