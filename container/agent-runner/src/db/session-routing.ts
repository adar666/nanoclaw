/**
 * Current chat/thread routing for this session — written by the host on every
 * container wake (see src/session-manager.ts `writeSessionRouting`).
 *
 * Read by MCP tools to preserve the current thread when an explicitly named
 * destination resolves to the chat this session is bound to.
 */
import { getInboundDb } from './connection.js';

export interface SessionRouting {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export function getSessionRouting(): SessionRouting {
  const db = getInboundDb();
  try {
    const row = db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
      | SessionRouting
      | undefined;
    if (row) return row;
  } catch {
    // Table may not exist on an older session DB — fall through to defaults.
  }
  return { channel_type: null, platform_id: null, thread_id: null };
}

const TASK_THREAD_PREFIX = 'system:tasks:';

/** The task id encoded in this isolated task session's canonical thread id. */
export function getTaskSeriesId(): string | null {
  const threadId = getSessionRouting().thread_id;
  return threadId?.startsWith(TASK_THREAD_PREFIX) ? threadId.slice(TASK_THREAD_PREFIX.length) : null;
}

/**
 * `eval/session.ts`'s `EVAL_THREAD_PREFIX` — duplicated as a literal since
 * this tree (a separate Bun package) can't import from the host's `eval/`
 * module. Keep in sync by hand if that value ever changes.
 */
const EVAL_THREAD_PREFIX = 'system:eval';

/**
 * True iff this is an isolated eval-harness session (no attached chat).
 *
 * The single canonical "is this an eval run" check for this whole process —
 * `index.ts` calls it directly to pick `SessionMode` for the system prompt,
 * and `formatter.ts`'s `extractRouting()` calls it for `RoutingContext.evalRun`
 * (the dispatch/auto-log bypass signal) instead of re-deriving its own
 * message-kind-based answer. Consolidated here (deferred-work.md finding,
 * spec-eval-session-output-capture.md) specifically because this function's
 * signal — the session's own thread id, set once by `eval/session.ts`'s
 * `resolveEvalSession` — can't drift the way a per-message `kind` tag could.
 */
export function isEvalThread(): boolean {
  const threadId = getSessionRouting().thread_id;
  return threadId === EVAL_THREAD_PREFIX || (threadId?.startsWith(`${EVAL_THREAD_PREFIX}:`) ?? false);
}
