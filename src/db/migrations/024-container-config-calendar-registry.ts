import type { Migration } from './index.js';

/**
 * Config-driven calendar registry on `container_configs` (spec cal-2.3).
 *
 * DEFAULT '[]' — empty, not the two built-ins (`uriel`/`devorah`), since a
 * core-codebase migration must not hardcode personal data for every
 * install/fork. The built-in `CALENDAR_IDS` map in
 * `container/agent-runner/src/mcp-tools/calendar.ts` stays hardcoded and
 * keeps working with zero config; entries here extend it, and an entry
 * reusing a built-in name overrides it (config wins on collision).
 *
 * JSON array of `{ name: string, calendarId: string }`.
 */
export const migration024: Migration = {
  version: 24,
  name: 'container-config-calendar-registry',
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN calendar_registry TEXT NOT NULL DEFAULT '[]';`);
  },
};
