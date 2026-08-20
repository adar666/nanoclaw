import type { Migration } from './index.js';

/**
 * AD-6 exclusion marker for eval-harness sessions. `eval/session.ts`'s
 * `resolveEvalSession` sets this to `'eval'` on every session it creates —
 * `src/db/sessions.ts`'s `getActiveSessions`/`getRunningSessions` (Story 1.5)
 * filter these out, so an eval scenario run is never swept/recovered like a
 * real user session.
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
