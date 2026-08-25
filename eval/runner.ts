/**
 * Drives one real scenario turn end to end, entirely via existing host
 * functions (AD-2 — no raw handles against the central DB; the poll query
 * below is a direct query against the already-open per-session outbound.db,
 * which AD-2 doesn't cover).
 *
 * Flow, in order: `assertNoDestinations` (before any write or spawn, AD-4)
 * → `resolveEvalSession` → `writeSessionMessage` → `wakeContainer` → poll
 * `processing_ack` on the session's own outbound.db until the specific
 * message reaches a terminal status or `opts.timeoutMs` elapses → read
 * `messages_out` filtered by `in_reply_to` and return it as the transcript.
 *
 * Filtering the transcript by `in_reply_to` (rather than returning every row
 * in messages_out) is what makes a reused session (same scenario id run
 * twice) safe: a prior run's messages never leak into a new capture.
 */
import { randomUUID } from 'crypto';

import { wakeContainer } from '../src/container-runner.js';
import type { OutboundMessage } from '../src/db/session-db.js';
import { openOutboundDb, writeSessionMessage } from '../src/session-manager.js';
import { assertIsEvalGroup, assertNoDestinations } from './safety.js';
import { resolveEvalSession } from './session.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Container-reported terminal states for a message's `processing_ack` row. */
const TERMINAL_ACK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface RunOptions {
  /** Give up waiting for a terminal `processing_ack` after this long. Default 300_000 (5 min). */
  timeoutMs?: number;
  /** Delay between `processing_ack` polls. Default 1_000. */
  pollIntervalMs?: number;
}

/**
 * `'timeout'` is this module's own outcome (the poll loop gave up) — distinct
 * from the three container-reported terminal statuses.
 */
export type ScenarioTurnStatus = 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface ScenarioTurnResult {
  status: ScenarioTurnStatus;
  transcript: OutboundMessage[];
  sessionId: string;
}

/**
 * Drive one real scenario turn: write `message` into the eval session for
 * `agentGroupId`/`threadId`, wake its container, and wait for the reply.
 *
 * Throws before creating any session row, writing anything, or waking a
 * container if the agent group has any destination configured —
 * `assertNoDestinations` runs first, ahead of `resolveEvalSession`, so a
 * failed check never leaves an orphaned session row/workspace behind (a
 * review finding: the original order created the session first).
 *
 * Also throws on a malformed `opts` (`timeoutMs`/`pollIntervalMs` not
 * positive) before touching anything, and if `wakeContainer` itself reports
 * spawn failure (`false`) — that fails fast with a clear error instead of
 * silently polling for the full `timeoutMs` waiting for a container that
 * never started (a review finding: the original version ignored the return
 * value entirely).
 *
 * Never throws on a poll timeout — that's a real, reportable scenario
 * outcome (`status: 'timeout'`), not an exceptional condition.
 */
export async function runScenarioTurn(
  agentGroupId: string,
  threadId: string,
  message: string,
  opts?: RunOptions,
): Promise<ScenarioTurnResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!(timeoutMs > 0)) throw new Error(`runScenarioTurn: timeoutMs must be positive, got ${timeoutMs}`);
  if (!(pollIntervalMs > 0)) {
    throw new Error(`runScenarioTurn: pollIntervalMs must be positive, got ${pollIntervalMs}`);
  }

  // AD-4: loud failure before any write or spawn, not a silent skip — and
  // before resolveEvalSession, so a failed check never persists an orphaned
  // session row for an agent group that turns out not to be one of the two
  // provisioned eval groups, or that turns out to have a destination.
  assertIsEvalGroup(agentGroupId);
  assertNoDestinations(agentGroupId);

  const { session } = resolveEvalSession(agentGroupId, threadId);

  const messageId = `eval-msg-${randomUUID()}`;
  writeSessionMessage(agentGroupId, session.id, {
    id: messageId,
    kind: 'eval',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ text: message }),
    trigger: 1,
  });

  // Re-check immediately before the real spawn — closes the TOCTOU window
  // between the checks above and this point (resolveEvalSession +
  // writeSessionMessage both do real DB I/O in between). A destination added
  // to this agent group, or a group-identity mixup, landing in that window
  // must not slip an eval turn into a group's real memory/CLAUDE.md
  // undetected — AD-4 again, one spawn-call closer to the actual container.
  assertIsEvalGroup(agentGroupId);
  assertNoDestinations(agentGroupId);

  const spawned = await wakeContainer(session);
  if (!spawned) {
    throw new Error(
      `runScenarioTurn: wakeContainer failed to spawn a container for session ${session.id} — see host logs`,
    );
  }

  const status = await pollForTerminalStatus(agentGroupId, session.id, messageId, timeoutMs, pollIntervalMs);
  const transcript = readTranscript(agentGroupId, session.id, messageId);

  return { status: status ?? 'timeout', transcript, sessionId: session.id };
}

/**
 * Poll `processing_ack` for `messageId` until it reaches a terminal status or
 * `timeoutMs` elapses. Opens and closes the outbound DB on every iteration —
 * required for cross-mount visibility of the container's writes (see the
 * "Cross-mount visibility invariants" note atop `session-manager.ts`); a
 * long-lived handle would freeze on its first-read view.
 *
 * Always checks once more after the loop exits (a review finding: the
 * original version didn't) — a completion written during the final sleep,
 * right at the deadline, would otherwise be reported as `'timeout'` even
 * though the real answer was sitting there unread.
 */
async function pollForTerminalStatus(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<'completed' | 'failed' | 'cancelled' | undefined> {
  const deadline = Date.now() + timeoutMs;

  const checkOnce = (): 'completed' | 'failed' | 'cancelled' | undefined => {
    const db = openOutboundDb(agentGroupId, sessionId);
    try {
      const row = db.prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(messageId) as
        | { status: string }
        | undefined;
      return row && TERMINAL_ACK_STATUSES.has(row.status)
        ? (row.status as 'completed' | 'failed' | 'cancelled')
        : undefined;
    } finally {
      db.close();
    }
  };

  while (Date.now() < deadline) {
    const status = checkOnce();
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return checkOnce();
}

/** Every `messages_out` row this run's own message produced, in write order. */
function readTranscript(agentGroupId: string, sessionId: string, messageId: string): OutboundMessage[] {
  const db = openOutboundDb(agentGroupId, sessionId);
  try {
    return db
      .prepare('SELECT * FROM messages_out WHERE in_reply_to = ? ORDER BY seq ASC')
      .all(messageId) as OutboundMessage[];
  } finally {
    db.close();
  }
}
