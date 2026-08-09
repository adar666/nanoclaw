/**
 * start_recorder MCP tool: `project` is optional raw text extracted from
 * whatever the user said (e.g. "פאפי") — this tool does NOT resolve it to
 * a directory; that happens on the host in
 * src/modules/recorder/project-aliases.ts, deterministically, never here.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { startRecorder } from './recorder.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('start_recorder MCP tool', () => {
  it('accepts an optional project field and writes it through untouched', async () => {
    await startRecorder.handler({ them: 'דניס', context: 'HoursReportWebApp', project: 'פאפי' });

    const [msg] = getUndeliveredMessages();
    const content = JSON.parse(msg.content);
    expect(content).toEqual({ action: 'recorder_start', them: 'דניס', context: 'HoursReportWebApp', project: 'פאפי' });
  });

  it('omits project entirely when not given, rather than writing an empty string', async () => {
    await startRecorder.handler({ them: 'דניס', context: 'HoursReportWebApp' });

    const [msg] = getUndeliveredMessages();
    const content = JSON.parse(msg.content);
    expect(content.project).toBeUndefined();
  });
});
