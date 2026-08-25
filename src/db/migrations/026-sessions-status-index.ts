import type { Migration } from './index.js';

/**
 * `getRunningSessions()` (`src/db/sessions.ts`) backs `delivery.ts`'s
 * 1-second `pollActive` loop, not just `host-sweep.ts`'s 60s sweep — a full
 * table scan on `sessions` runs every second. `getActiveSessions()` shares
 * the same shape (`status`/`container_status` equality plus the `managed_by
 * <> 'eval'` exclusion, migration 025). Neither had a supporting index
 * before this (deferred-work.md finding, pre-existing) — eval sessions are a
 * new, actively-growing contributor to the table both queries scan (no
 * teardown/pruning path exists for them yet, a separate open item), so the
 * scan cost only grows over time without this.
 *
 * A single composite index on `(status, container_status)` covers both
 * queries' equality predicates; `managed_by` isn't part of it — it's an
 * exclusion (`<> 'eval'`), not an equality lookup, so a composite including it
 * wouldn't be selective the way a leading equality column needs to be.
 */
export const migration026: Migration = {
  version: 26,
  name: 'sessions-status-index',
  up(db) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, container_status);`);
  },
};
