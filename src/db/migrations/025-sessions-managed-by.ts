import type { Migration } from './index.js';

/**
 * AD-6 exclusion marker for eval-harness sessions. `eval/session.ts`'s
 * `resolveEvalSession` sets this to `'eval'` on every session it creates —
 * the marker `host-sweep.ts`'s own exclusion (Story 1.5) will filter on so
 * an eval scenario run is never swept/recovered like a real user session.
 *
 * Nullable, no default: existing rows and every non-eval caller of
 * `createSession` are unaffected — `managed_by` stays NULL for real sessions.
 */
export const migration025: Migration = {
  version: 25,
  name: 'sessions-managed-by',
  up(db) {
    db.exec(`ALTER TABLE sessions ADD COLUMN managed_by TEXT;`);
  },
};
