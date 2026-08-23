/**
 * Eval-run auto-capture — spec-eval-session-output-capture.
 *
 * Mirrors task-delivery.test.ts's coverage of the analogous task-run path:
 * dispatchResultText's hasUnwrapped bypass for a run with no attached chat,
 * and the auto-recorded log write (autoAppendEvalLog, mirroring
 * autoAppendTaskLog exactly under a distinct 'eval_log' kind).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { autoAppendEvalLog, dispatchResultText } from './poll-loop.js';
import type { RoutingContext } from './formatter.js';

const evalRouting: RoutingContext = {
  platformId: null,
  channelType: null,
  threadId: 'system:eval:guest-resolution-known-name',
  inReplyTo: 'eval-msg-1',
  taskRun: false,
  evalRun: true,
};

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('dispatchResultText — eval run bypass', () => {
  it('never flags plain final text (no <message to>) as unwrapped for an eval run', () => {
    const { sent, hasUnwrapped } = dispatchResultText(
      "No event exists tomorrow. I also still don't have an email on file for Ruti.",
      evalRouting,
    );

    expect(sent).toBe(0);
    expect(hasUnwrapped).toBe(false);
    // Nothing gets sent anywhere — eval sessions have zero destinations by
    // design (AD-1) and nothing delivers plain text regardless.
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('still flags an unwrapped chat-session reply as unwrapped (real behavior unchanged)', () => {
    const { hasUnwrapped } = dispatchResultText('plain reply, no wrapper', {
      ...evalRouting,
      evalRun: false,
    });

    expect(hasUnwrapped).toBe(true);
  });

  it('a stray <message to> block in an eval run resolves as an unknown destination (never delivered) — AD-1 untouched', () => {
    const { sent } = dispatchResultText('<message to="someone">hi</message>', evalRouting);

    expect(sent).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('autoAppendEvalLog', () => {
  it('writes an eval_log row from final text, distinct from task_log', () => {
    autoAppendEvalLog('No event exists tomorrow.', 'eval-msg-1');

    const rows = getOutboundDb().prepare("SELECT kind, content FROM messages_out WHERE kind = 'eval_log'").all() as {
      kind: string;
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('No event exists tomorrow.');

    expect(getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE kind = 'task_log'").all()).toHaveLength(0);
  });

  it("sets in_reply_to to the given id — the exact field eval/runner.ts's readTranscript filters on (regression: without this, the harness would never see the row at all)", () => {
    autoAppendEvalLog('No event exists tomorrow.', 'eval-msg-42');

    const row = getOutboundDb().prepare("SELECT in_reply_to FROM messages_out WHERE kind = 'eval_log'").get() as {
      in_reply_to: string | null;
    };
    expect(row.in_reply_to).toBe('eval-msg-42');
  });

  it('folds an inline <message to> block into undelivered prose, matching autoAppendTaskLog hygiene', () => {
    autoAppendEvalLog('Checked the calendar. <message to="ruti">no events</message> Done.', 'eval-msg-1');

    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'eval_log'").get() as {
      content: string;
    };
    const line = JSON.parse(row.content).text as string;
    expect(line).not.toContain('<message');
    expect(line).toContain('[undelivered → ruti] no events');
  });

  it("writes no row when the text is empty after clamping (mirrors autoAppendTaskLog's guard)", () => {
    autoAppendEvalLog('   ', 'eval-msg-1');
    expect(getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE kind = 'eval_log'").all()).toHaveLength(0);
  });

  it('is additive alongside other outbound rows, never overwrites', () => {
    writeMessageOut({ id: 'unrelated', kind: 'system', content: JSON.stringify({ action: 'noop' }) });
    autoAppendEvalLog('final answer', 'eval-msg-1');
    expect(getOutboundDb().prepare("SELECT 1 FROM messages_out WHERE kind = 'eval_log'").all()).toHaveLength(1);
    expect(getOutboundDb().prepare('SELECT 1 FROM messages_out').all()).toHaveLength(2);
  });

  it('preserves up to 4000 characters — a much wider budget than task_log, since a judge does substring matching against the full reply', () => {
    const longReply = 'a'.repeat(5000);
    autoAppendEvalLog(longReply, 'eval-msg-1');

    const row = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'eval_log'").get() as {
      content: string;
    };
    expect((JSON.parse(row.content).text as string).length).toBe(4000);
  });
});
