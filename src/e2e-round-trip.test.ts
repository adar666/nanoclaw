/**
 * One narrow end-to-end smoke test: inbound message arrives → routed into
 * inbound.db → (agent responds, simulated here since no container is
 * spawned) → response lands in outbound.db → delivery.ts picks it up and
 * calls the channel adapter to send it back out.
 *
 * Why this exists: host-core.test.ts's 'router' describe block stops at
 * "message landed in inbound.db + container woken", and delivery.test.ts
 * exercises deliverSessionMessages in isolation (starting from a
 * pre-inserted outbound row) — no single test chains routeInbound through
 * to deliverSessionMessages. That full loop is exactly what tonight's live
 * manual test on Telegram verified by hand (audio message in → transcribed
 * → agent replied → delivered), after finding and fixing the missing
 * `await` in createPairingInterceptor (see telegram-pairing-interceptor.test.ts
 * for the regression coverage of that specific bug). This test encodes the
 * round trip itself as something CI checks on every run, not something that
 * only gets caught by a human sending a real message.
 *
 * Deliberately narrow: one channel (telegram-shaped), one agent, one
 * message each way. This is a smoke test, not a matrix — see
 * _bmad-output/test-artifacts/test-design/test-design-system.md for why a
 * personal/household-scale project doesn't need a broader E2E suite.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./voice-transcription.js', async () => {
  const actual = await vi.importActual<typeof import('./voice-transcription.js')>('./voice-transcription.js');
  return { ...actual, applyVoiceTranscription: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('./media-ingestion.js', () => ({
  ingestTelegramMedia: vi.fn().mockResolvedValue(null),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-e2e-round-trip',
    GROUPS_DIR: '/tmp/nanoclaw-test-e2e-round-trip/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-e2e-round-trip';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { findSession, getSession } from './db/sessions.js';
import { inboundDbPath, outboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import type { InboundEvent } from './channels/adapter.js';

function now(): string {
  return new Date().toISOString();
}

function insertOutboundReply(agentGroupId: string, sessionId: string, text: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:456', 'telegram', ?)`,
  ).run('out-reply-1', JSON.stringify({ text }));
  db.close();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('E2E smoke: inbound message → routed → agent replies → delivered', () => {
  it('carries a message from routeInbound through to the channel adapter', async () => {
    const { routeInbound } = await import('./router.js');

    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:456',
      name: 'Test Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const delivered: Array<{ platformId: string; text: string }> = [];
    setDeliveryAdapter({
      async deliver(_channelType, platformId, _threadId, _kind, content) {
        delivered.push({ platformId, text: JSON.parse(content).text });
        return 'sent-msg-id';
      },
    });

    // Step 1: an inbound event arrives, as a channel adapter's onInbound
    // would hand it to the host after its own interceptor chain.
    const event: InboundEvent = {
      channelType: 'telegram',
      platformId: 'telegram:456',
      threadId: null,
      message: {
        id: 'msg-in-1',
        kind: 'chat',
        content: JSON.stringify({ sender: 'User', text: 'Please summarize this audio file' }),
        timestamp: now(),
      },
    };
    await routeInbound(event);

    // Step 2: prove it actually reached inbound.db (the part that the
    // missing-await bug silently broke for large attachments).
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();
    const inDb = new Database(inboundDbPath('ag-1', session!.id));
    const inRows = inDb.prepare('SELECT * FROM messages_in').all() as Array<{ content: string }>;
    inDb.close();
    expect(inRows).toHaveLength(1);
    expect(JSON.parse(inRows[0].content).text).toBe('Please summarize this audio file');

    // Step 3: simulate the agent-runner's side of the loop — it would have
    // polled inbound.db, produced a reply, and written it to outbound.db.
    // No container is spawned in this test; this stands in for that half.
    insertOutboundReply('ag-1', session!.id, 'Here is your summary.');

    // Step 4: delivery.ts's poll picks up the outbound row and hands it to
    // the channel adapter — this is the real, unmocked deliverSessionMessages.
    const resolved = getSession(session!.id)!;
    await deliverSessionMessages(resolved);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual({ platformId: 'telegram:456', text: 'Here is your summary.' });
  });
});
