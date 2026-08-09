import type { Migration } from './index.js';

/**
 * recorder_sessions — one row per negotiator start/stop cycle triggered
 * through the recorder module (src/modules/recorder/). `stopped_at IS NULL`
 * marks the currently-running session — there is only ever one at a time
 * (negotiator itself refuses a second `start` while one is running, and
 * the module's own precheck mirrors that before even trying). Used by
 * host-sweep's cap enforcement to find a running session's start time
 * without touching any container's session DBs.
 */
export const migration021: Migration = {
  version: 21,
  name: 'recorder-sessions',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS recorder_sessions (
        id             TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        them           TEXT NOT NULL,
        context        TEXT NOT NULL,
        started_at     TEXT NOT NULL,
        stopped_at     TEXT,
        stop_reason    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_recorder_sessions_running ON recorder_sessions(stopped_at);
    `);
  },
};
