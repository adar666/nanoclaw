/**
 * CRUD for recorder_sessions — see migration 021 for the schema rationale.
 * `getRunningRecorderSession` is the single source of truth for "is
 * negotiator currently running" from the host's perspective (as opposed to
 * asking negotiator's own `.run/negotiator.pid`, which apply.ts never reads
 * directly — run.sh itself is the only thing that touches that file).
 */
import { getDb } from '../../db/connection.js';

export interface RecorderSessionRow {
  id: string;
  agent_group_id: string;
  session_id: string;
  them: string;
  context: string;
  started_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
}

export function createRecorderSession(row: {
  id: string;
  agent_group_id: string;
  session_id: string;
  them: string;
  context: string;
  started_at: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO recorder_sessions (id, agent_group_id, session_id, them, context, started_at)
       VALUES (@id, @agent_group_id, @session_id, @them, @context, @started_at)`,
    )
    .run(row);
}

/** The currently-running session, if any. At most one row should ever match
 *  (see migration 021's header) — DESC + LIMIT 1 is defensive, not relied on. */
export function getRunningRecorderSession(): RecorderSessionRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM recorder_sessions WHERE stopped_at IS NULL ORDER BY started_at DESC LIMIT 1`)
    .get() as RecorderSessionRow | undefined;
}

export function markRecorderSessionStopped(id: string, stoppedAt: string, reason: 'user' | 'cap' | 'reconciled'): void {
  getDb()
    .prepare(`UPDATE recorder_sessions SET stopped_at = @stoppedAt, stop_reason = @reason WHERE id = @id`)
    .run({ id, stoppedAt, reason });
}
