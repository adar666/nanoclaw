/**
 * Group-timezone resolution (agent-level timezone feature).
 *
 * The chain is: valid per-group override → install-global TIMEZONE. An
 * invalid stored value (hand-edited DB — the ncl write path validates) must
 * fall back to the global timezone, not silently become UTC, and must never
 * be materialized into container.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TIMEZONE } from './config.js';
import { configFromDb, resolveGroupTimezone } from './container-config.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import type { AgentGroup } from './types.js';

const GROUP: AgentGroup = {
  id: 'ag-tz',
  name: 'tz',
  folder: 'tz',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

describe('resolveGroupTimezone', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    createAgentGroup(GROUP);
    ensureContainerConfig(GROUP.id);
  });
  afterEach(() => {
    closeDb();
  });

  it('returns the install-global timezone when no override is set', () => {
    expect(resolveGroupTimezone(GROUP.id)).toBe(TIMEZONE);
    expect(resolveGroupTimezone('ag-no-such-group')).toBe(TIMEZONE);
  });

  it('returns a valid override, and falls back to global on an invalid stored value', () => {
    updateContainerConfigScalars(GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(resolveGroupTimezone(GROUP.id)).toBe('Asia/Tokyo');

    updateContainerConfigScalars(GROUP.id, { timezone: 'Not/AZone' });
    expect(resolveGroupTimezone(GROUP.id)).toBe(TIMEZONE);
  });

  it('configFromDb ships a valid timezone to the container and drops an invalid one', () => {
    updateContainerConfigScalars(GROUP.id, { timezone: 'Asia/Tokyo' });
    expect(configFromDb(getContainerConfig(GROUP.id)!, GROUP).timezone).toBe('Asia/Tokyo');

    updateContainerConfigScalars(GROUP.id, { timezone: 'Not/AZone' });
    expect(configFromDb(getContainerConfig(GROUP.id)!, GROUP).timezone).toBeUndefined();
  });

  /**
   * Verification-gap review finding (spec cal-2.3): every calendar.ts test
   * stubs calendarConfigHooks and never exercises the real DB→configFromDb
   * round trip. This closes the host-side half — the container-side half
   * (loadConfig() parsing the materialized JSON) is covered separately in
   * container/agent-runner/src/config.test.ts.
   */
  it('configFromDb round-trips calendar_registry verbatim (empty by default, real entries after a write)', () => {
    expect(configFromDb(getContainerConfig(GROUP.id)!, GROUP).calendarRegistry).toEqual([]);

    const registry = [{ name: 'family', calendarId: 'family-cal@group.calendar.google.com' }];
    updateContainerConfigJson(GROUP.id, 'calendar_registry', registry);

    expect(configFromDb(getContainerConfig(GROUP.id)!, GROUP).calendarRegistry).toEqual(registry);
  });
});
