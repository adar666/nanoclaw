import type { Migration } from './index.js';

/**
 * Per-agent-group idle-timeout override on `container_configs`.
 *
 * NULL = follow the instance-global absolute ceiling (`ABSOLUTE_CEILING_MS`
 * in src/host-sweep.ts, currently 30 min), matching pre-migration behavior
 * for every existing row — deliberately no backfill. A non-NULL value is a
 * whole number of minutes; the host sweep uses it in place of the global
 * ceiling for that group's containers (still floored by any longer
 * in-flight Bash-tool timeout — a running tool call is never killed early).
 */
export const migration022: Migration = {
  version: 22,
  name: 'container-config-idle-timeout',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN idle_timeout_minutes INTEGER;`);
  },
};
