import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getOutboundDb } from '../db/connection.js';
import { transcribeAudio } from './transcribe-audio.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('transcribe_audio MCP tool', () => {
  it('writes a system row with the transcribe_audio action and returns immediately', async () => {
    const result = await transcribeAudio.handler({ path: 'inbox/msg1/call.m4a' });

    expect(result.isError).toBeFalsy();
    const rows = getOutboundDb()
      .prepare("SELECT kind, content FROM messages_out WHERE kind = 'system' ORDER BY seq DESC LIMIT 1")
      .all() as Array<{ kind: string; content: string }>;
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content);
    expect(content.action).toBe('transcribe_audio');
    expect(content.path).toBe('inbox/msg1/call.m4a');
    expect(content.note).toBeUndefined();
  });

  it('passes note through when given', async () => {
    await transcribeAudio.handler({ path: 'inbox/msg2/call.m4a', note: 'client call' });

    const rows = getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    const content = JSON.parse(rows[0].content);
    expect(content.note).toBe('client call');
  });

  it('rejects a call with no path', async () => {
    const result = await transcribeAudio.handler({});

    expect(result.isError).toBe(true);
  });

  it('tool metadata declares path as required', () => {
    expect(transcribeAudio.tool.name).toBe('transcribe_audio');
    expect(transcribeAudio.tool.inputSchema).toMatchObject({
      required: ['path'],
    });
  });
});
