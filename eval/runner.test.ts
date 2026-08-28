/**
 * Fast, mocked-spawn coverage for `runScenarioTurn`'s poll/timeout/
 * transcript-filtering/marker logic. No Docker, no real Claude call.
 *
 * Mocks only the spawn boundary (`wakeContainer`) — everything else runs
 * against a real temp `outbound.db`/`inbound.db`, matching Story 1.1/1.2's
 * real-DB-not-mocked convention. `wakeContainer`'s mock implementation reads
 * the message `runScenarioTurn` just wrote to `inbound.db` (real flow order:
 * `writeSessionMessage` happens before `wakeContainer`) so it can write a
 * `processing_ack`/`messages_out` pair keyed to that exact message id —
 * exactly what a real container would have done in response.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-eval-runner-test';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-eval-runner-test/data',
}));

vi.mock('../src/container-runner.js', () => ({
  wakeContainer: vi.fn(),
}));

import { wakeContainer } from '../src/container-runner.js';
import { closeDb, initTestDb, runMigrations } from '../src/db/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { getSessionsByAgentGroup } from '../src/db/sessions.js';
import { createDestination } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { openInboundDb, openOutboundDbRw } from '../src/session-manager.js';
import type { Session } from '../src/types.js';
import { EVAL_THREAD_PREFIX } from './session.js';
import { runScenarioTurn } from './runner.js';

const AG = 'ag-eval-runner-test';

/** The message id `runScenarioTurn` just wrote — read back from inbound.db, newest row first. */
function latestInboundMessageId(session: Session): string {
  const db = openInboundDb(session.agent_group_id, session.id);
  try {
    const row = db.prepare('SELECT id FROM messages_in ORDER BY seq DESC LIMIT 1').get() as { id: string } | undefined;
    if (!row) throw new Error('latestInboundMessageId: no messages_in row found — writeSessionMessage did not run');
    return row.id;
  } finally {
    db.close();
  }
}

/**
 * Simulates a real container: writes a terminal processing_ack + a reply row
 * for `messageId`. Container writes use odd `seq` (host uses even — see
 * CLAUDE.md's Two-DB Session Split); the fixture matches that convention
 * rather than just incrementing by 2 from whatever's there, so it's a
 * faithful stand-in for a real container write, not just "some new row."
 */
function writeFakeContainerResponse(
  session: Session,
  messageId: string,
  status: 'completed' | 'failed' | 'cancelled',
  replyContent: string,
): void {
  const db = openOutboundDbRw(session.agent_group_id, session.id);
  try {
    db.prepare('INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)').run(
      messageId,
      status,
      new Date().toISOString(),
    );
    const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), -1) AS s FROM messages_out').get() as { s: number }).s;
    const nextOddSeq = maxSeq % 2 === 1 ? maxSeq + 2 : maxSeq + 1;
    db.prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, content)
       VALUES (?, ?, ?, ?, 'chat', ?)`,
    ).run(`reply-${messageId}`, nextOddSeq, messageId, new Date().toISOString(), replyContent);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
  // folder must be exactly "eval" — assertIsEvalGroup (safety.ts) verifies
  // agentGroupId resolves to one of the two provisioned eval groups
  // (folder "eval" or "eval-judge"), not an arbitrary agent group, before
  // runScenarioTurn does anything else.
  createAgentGroup({
    id: AG,
    name: 'Eval Runner Test',
    folder: 'eval',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  vi.mocked(wakeContainer).mockReset();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('runScenarioTurn', () => {
  it("writes the scenario message as kind: 'eval', not 'chat' — spec-eval-session-output-capture", async () => {
    vi.mocked(wakeContainer).mockImplementation(async (session: Session) => {
      const messageId = latestInboundMessageId(session);
      writeFakeContainerResponse(session, messageId, 'completed', JSON.stringify({ text: 'hello back' }));
      return true;
    });

    const threadId = `${EVAL_THREAD_PREFIX}:turn-kind-eval`;
    const result = await runScenarioTurn(AG, threadId, 'hi there', { timeoutMs: 2_000, pollIntervalMs: 10 });

    const db = openInboundDb(AG, result.sessionId);
    try {
      const row = db.prepare('SELECT kind FROM messages_in ORDER BY seq DESC LIMIT 1').get() as
        | { kind: string }
        | undefined;
      expect(row?.kind).toBe('eval');
    } finally {
      db.close();
    }
  });

  it("returns status completed with a transcript containing exactly the reply to this run's own message", async () => {
    vi.mocked(wakeContainer).mockImplementation(async (session: Session) => {
      const messageId = latestInboundMessageId(session);
      writeFakeContainerResponse(session, messageId, 'completed', JSON.stringify({ text: 'hello back' }));
      return true;
    });

    const threadId = `${EVAL_THREAD_PREFIX}:turn-completes`;
    const result = await runScenarioTurn(AG, threadId, 'hi there', { timeoutMs: 2_000, pollIntervalMs: 10 });

    expect(result.status).toBe('completed');
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0].content).toBe(JSON.stringify({ text: 'hello back' }));
    expect(result.sessionId).toBeTruthy();

    // The AD-6 marker Story 1.5's exclusion will depend on — verify it
    // actually made the real DB round-trip, not just the in-memory object.
    const [persisted] = getSessionsByAgentGroup(AG);
    expect(persisted.managed_by).toBe('eval');
  });

  it('returns status failed when the container reports processing_ack: failed', async () => {
    vi.mocked(wakeContainer).mockImplementation(async (session: Session) => {
      const messageId = latestInboundMessageId(session);
      writeFakeContainerResponse(session, messageId, 'failed', JSON.stringify({ text: 'oops' }));
      return true;
    });

    const threadId = `${EVAL_THREAD_PREFIX}:turn-fails`;
    const result = await runScenarioTurn(AG, threadId, 'hi there', { timeoutMs: 2_000, pollIntervalMs: 10 });

    expect(result.status).toBe('failed');
    expect(result.transcript).toHaveLength(1);
  });

  it('returns status cancelled when the container reports processing_ack: cancelled', async () => {
    vi.mocked(wakeContainer).mockImplementation(async (session: Session) => {
      const messageId = latestInboundMessageId(session);
      writeFakeContainerResponse(session, messageId, 'cancelled', JSON.stringify({ text: 'cancelled mid-turn' }));
      return true;
    });

    const threadId = `${EVAL_THREAD_PREFIX}:turn-cancelled`;
    const result = await runScenarioTurn(AG, threadId, 'hi there', { timeoutMs: 2_000, pollIntervalMs: 10 });

    expect(result.status).toBe('cancelled');
    expect(result.transcript).toHaveLength(1);
  });

  it('throws when a spawn failure is reported (wakeContainer resolves false), without waiting out the full timeout', async () => {
    vi.mocked(wakeContainer).mockResolvedValue(false);

    const threadId = `${EVAL_THREAD_PREFIX}:turn-spawn-fails`;
    const start = Date.now();
    await expect(runScenarioTurn(AG, threadId, 'hi there', { timeoutMs: 5_000, pollIntervalMs: 10 })).rejects.toThrow(
      /wakeContainer failed/,
    );
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('rejects a non-positive timeoutMs/pollIntervalMs before writing anything', async () => {
    const threadId = `${EVAL_THREAD_PREFIX}:turn-bad-opts`;
    await expect(runScenarioTurn(AG, threadId, 'hi there', { timeoutMs: 0 })).rejects.toThrow(/timeoutMs/);
    await expect(runScenarioTurn(AG, threadId, 'hi there', { pollIntervalMs: -1 })).rejects.toThrow(/pollIntervalMs/);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('returns status timeout without throwing when processing_ack never reaches a terminal status', async () => {
    vi.mocked(wakeContainer).mockResolvedValue(true); // never writes processing_ack

    const threadId = `${EVAL_THREAD_PREFIX}:turn-times-out`;
    const result = await runScenarioTurn(AG, threadId, 'hi there', { timeoutMs: 50, pollIntervalMs: 10 });

    expect(result.status).toBe('timeout');
    expect(result.transcript).toEqual([]);
  });

  it(
    "returns status timeout within a bounded number of iterations even when the deadline check's own clock never " +
      'advances (belt-and-suspenders max-iteration cap, deferred-work.md spec-eval-1-4) — without the cap, a frozen ' +
      '`Date.now()` would make `Date.now() < deadline` stay true forever and this test would hang',
    async () => {
      vi.mocked(wakeContainer).mockResolvedValue(true); // never writes processing_ack

      const frozenAt = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(frozenAt);
      try {
        const threadId = `${EVAL_THREAD_PREFIX}:turn-frozen-clock`;
        // timeoutMs/pollIntervalMs chosen small so the real (unmocked) setTimeout
        // sleeps between iterations resolve quickly — the cap, not the deadline
        // check, is what has to end this loop.
        const result = await runScenarioTurn(AG, threadId, 'hi there', { timeoutMs: 200, pollIntervalMs: 20 });

        expect(result.status).toBe('timeout');
      } finally {
        dateNowSpy.mockRestore();
      }
    },
    10_000,
  );

  it("excludes an older run's messages_out rows when the same session is reused", async () => {
    vi.mocked(wakeContainer).mockImplementation(async (session: Session) => {
      const messageId = latestInboundMessageId(session);
      writeFakeContainerResponse(session, messageId, 'completed', JSON.stringify({ text: `reply to ${messageId}` }));
      return true;
    });

    const threadId = `${EVAL_THREAD_PREFIX}:turn-reused-session`;
    const first = await runScenarioTurn(AG, threadId, 'first message', { timeoutMs: 2_000, pollIntervalMs: 10 });
    const second = await runScenarioTurn(AG, threadId, 'second message', { timeoutMs: 2_000, pollIntervalMs: 10 });

    expect(first.sessionId).toBe(second.sessionId); // same eval session, reused (idempotent resolveEvalSession)
    expect(second.transcript).toHaveLength(1);
    expect(second.transcript[0].content).not.toBe(first.transcript[0].content);
    expect(second.transcript.some((m) => m.id === first.transcript[0].id)).toBe(false);
  });

  it('throws before creating a session, writing anything, or waking a container when the agent group has a destination', async () => {
    createDestination({
      agent_group_id: AG,
      local_name: 'household',
      target_type: 'agent',
      target_id: 'ag-some-other-group',
      created_at: new Date().toISOString(),
    });

    const threadId = `${EVAL_THREAD_PREFIX}:turn-blocked-by-destination`;
    await expect(runScenarioTurn(AG, threadId, 'should never send', { timeoutMs: 2_000 })).rejects.toThrow(
      /destination/,
    );

    expect(wakeContainer).not.toHaveBeenCalled();
    // assertNoDestinations now runs before resolveEvalSession (a review
    // finding — the original order created the session first) — no session
    // should exist for this agent group at all.
    expect(getSessionsByAgentGroup(AG)).toEqual([]);
  });

  it('throws before creating a session, writing anything, or waking a container when the agent group is not one of the two provisioned eval groups, even with zero destinations', async () => {
    const NOT_EVAL_AG = 'ag-eval-runner-test-not-eval';
    createAgentGroup({
      id: NOT_EVAL_AG,
      name: 'Some Production Group',
      folder: 'some-production-group',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    const threadId = `${EVAL_THREAD_PREFIX}:turn-blocked-by-group-identity`;
    await expect(runScenarioTurn(NOT_EVAL_AG, threadId, 'should never send', { timeoutMs: 2_000 })).rejects.toThrow(
      /not one of the two provisioned eval groups/,
    );

    expect(wakeContainer).not.toHaveBeenCalled();
    expect(getSessionsByAgentGroup(NOT_EVAL_AG)).toEqual([]);
  });
});

// AD-4's TOCTOU close (deferred-work.md, 2026-08-25): a real behavioral test
// would need to inject a destination row into the narrow synchronous window
// between the top-of-function check and the pre-spawn re-check — both
// resolveEvalSession and writeSessionMessage run in that window, but neither
// is mocked here (both run for real, matching this file's own convention),
// so there's no seam to hook a side effect into mid-call without mocking
// session-manager.js's live ESM bindings, which this file's existing tests
// deliberately avoid. Guarded structurally instead, the same convention
// container-runner.test.ts's own "ordering invariant" tests already use for
// exactly this shape of thing.
describe('spawn-path re-check (structural — TOCTOU close, AD-4)', () => {
  it('re-checks assertIsEvalGroup + assertNoDestinations immediately before wakeContainer, not only once at the top of the function', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'eval', 'runner.ts'), 'utf-8');
    const wakeCall = src.indexOf('await wakeContainer(session)');
    expect(wakeCall).toBeGreaterThan(-1);
    const before = src.slice(0, wakeCall);
    expect(before.match(/assertIsEvalGroup\(agentGroupId\)/g)).toHaveLength(2);
    expect(before.match(/assertNoDestinations\(agentGroupId\)/g)).toHaveLength(2);
  });
});
