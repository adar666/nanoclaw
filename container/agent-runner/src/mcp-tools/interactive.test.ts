/**
 * Regression coverage for the task-session routing gap: ask_user_question /
 * send_card used to write outbound rows with null platform_id/channel_type
 * whenever the session had no ambient chat bound to it (a task session —
 * `resolveTaskSession` creates those with `messaging_group_id: null`). The
 * card would then silently never deliver (`src/delivery.ts`'s
 * "Message missing routing fields" WARN swallows it) while the tool kept
 * polling for an answer nobody ever saw. `initTestSessionDb()`'s in-memory
 * schema doesn't create a `session_routing` table at all, so every test
 * here already runs in the "no ambient chat" shape by construction —
 * exactly the task-session case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { askUserQuestion, sendCard } from './interactive.js';

function seedDestination(name: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function latestOutboundRow(): { platform_id: string | null; channel_type: string | null; content: string } {
  return getOutboundDb()
    .prepare('SELECT platform_id, channel_type, content FROM messages_out ORDER BY seq DESC LIMIT 1')
    .get() as { platform_id: string | null; channel_type: string | null; content: string };
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('ask_user_question — routing fallback when no chat is bound to the session', () => {
  it('errors instead of silently writing an undeliverable card when there are no destinations at all', async () => {
    const result = await askUserQuestion.handler({
      title: 'Confirm',
      question: 'Delete it?',
      options: ['Yes', 'No'],
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('No chat destination available');
    // Nothing should have been written — a card nobody can ever answer is worse than no card.
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('errors instead of guessing when multiple channel destinations exist and none is bound', async () => {
    seedDestination('telegram-devora', 'telegram', 'telegram:111');
    seedDestination('telegram-uriel', 'telegram', 'telegram:222');

    const result = await askUserQuestion.handler({
      title: 'Confirm',
      question: 'Delete it?',
      options: ['Yes', 'No'],
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('telegram-devora');
    expect(text).toContain('telegram-uriel');
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('falls back to the single channel destination when exactly one exists (the real dm-with-partner-style shape)', async () => {
    seedDestination('telegram-devora', 'telegram', 'telegram:5190599655');

    // Short timeout — this test only cares about what got written before the
    // poll loop starts, not the (unchanged) wait-for-answer behavior.
    const result = await askUserQuestion.handler({
      title: 'Confirm deletion',
      question: 'Delete this duplicate event?',
      options: ['Yes', 'No'],
      timeout: 0.05,
    });

    expect(result.isError).toBe(true); // times out — no one answered in this test
    const row = latestOutboundRow();
    expect(row.platform_id).toBe('telegram:5190599655');
    expect(row.channel_type).toBe('telegram');
    expect(JSON.parse(row.content).type).toBe('ask_question');
  });
});

describe('send_card — same routing fallback', () => {
  it('errors instead of silently writing an undeliverable card when there are no destinations', async () => {
    const result = await sendCard.handler({ card: { title: 'Hi' } });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('No chat destination available');
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
  });

  it('resolves the single channel destination and writes a deliverable row', async () => {
    seedDestination('telegram-devora', 'telegram', 'telegram:5190599655');

    const result = await sendCard.handler({ card: { title: 'Summary' } });

    expect(result.isError).toBeUndefined();
    const row = latestOutboundRow();
    expect(row.platform_id).toBe('telegram:5190599655');
    expect(row.channel_type).toBe('telegram');
  });
});
