/**
 * Session-creation helper for eval scenario runs.
 *
 * Safety by construction, not convention: `messaging_group_id: null` is
 * hardcoded below — no parameter exists that could override it, so a
 * scenario session structurally cannot resolve to a live chat destination.
 * The thread id must be `system:eval`-prefixed, mirroring how
 * `resolveTaskSession` (src/session-manager.ts) scopes scheduled-task
 * sessions under `system:tasks:<seriesId>`.
 */
import { randomUUID } from 'crypto';

import { findSystemSession, createSession } from '../src/db/sessions.js';
import { log } from '../src/log.js';
import { initSessionFolder } from '../src/session-manager.js';
import type { Session } from '../src/types.js';

export const EVAL_THREAD_PREFIX = 'system:eval';

/**
 * Find or create the isolated eval session for a given thread id.
 *
 * `threadId` must be exactly `EVAL_THREAD_PREFIX` or start with
 * `` `${EVAL_THREAD_PREFIX}:` `` — anything else throws before any DB call.
 */
export function resolveEvalSession(agentGroupId: string, threadId: string): { session: Session; created: boolean } {
  if (threadId !== EVAL_THREAD_PREFIX && !threadId.startsWith(`${EVAL_THREAD_PREFIX}:`)) {
    throw new Error(
      `resolveEvalSession: threadId must be "${EVAL_THREAD_PREFIX}" or start with ` +
        `"${EVAL_THREAD_PREFIX}:", got "${threadId}"`,
    );
  }

  const existing = findSystemSession(agentGroupId, threadId);
  if (existing) return { session: existing, created: false };

  const id = `eval-${randomUUID()}`;
  const session: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };

  createSession(session);
  initSessionFolder(agentGroupId, id);
  log.info('Eval session created', { id, agentGroupId, threadId });

  return { session, created: true };
}
