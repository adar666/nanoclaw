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

import { findSystemSession, createSession, deleteSession, setSessionManagedBy } from '../src/db/sessions.js';
import { log } from '../src/log.js';
import { initSessionFolder } from '../src/session-manager.js';
import type { Session } from '../src/types.js';

export const EVAL_THREAD_PREFIX = 'system:eval';

/**
 * AD-6 exclusion marker value for eval-harness sessions — one named constant
 * so the literal string appears exactly once, not re-typed at each call site
 * (a typo like `'evla'` would type-check silently against `Session`'s loose
 * `managed_by?: string | null` and never match whatever `host-sweep.ts`'s
 * Story 1.5 exclusion filters on).
 */
export const EVAL_MANAGED_BY = 'eval';

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
  if (existing) {
    // Backfill: a session created before this marker existed (or by any
    // future path that doesn't set it) would otherwise stay permanently
    // unmarked and invisible to host-sweep.ts's Story 1.5 exclusion once
    // that lands — defensive, not currently reachable in this install (no
    // eval session predates this marker), but cheap to close.
    if (existing.managed_by !== EVAL_MANAGED_BY) {
      setSessionManagedBy(existing.id, EVAL_MANAGED_BY);
      existing.managed_by = EVAL_MANAGED_BY;
    }
    return { session: existing, created: false };
  }

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
    // AD-6 exclusion marker — host-sweep.ts's own exclusion (Story 1.5,
    // not yet built) will filter on this so an eval scenario session is
    // never swept/recovered like a real user session.
    managed_by: EVAL_MANAGED_BY,
  };

  createSession(session);
  try {
    initSessionFolder(agentGroupId, id);
  } catch (err) {
    // Rollback (deferred-work.md finding, spec-eval-1-1): the DB insert above
    // already committed — if the follow-up filesystem step throws, delete the
    // row rather than leave an orphaned `sessions` row with no matching
    // session folder/DBs for a later resolveEvalSession(agentGroupId,
    // threadId) call's `findSystemSession` to find and silently treat as
    // already-provisioned.
    deleteSession(id);
    throw err;
  }
  log.info('Eval session created', { id, agentGroupId, threadId });

  return { session, created: true };
}
