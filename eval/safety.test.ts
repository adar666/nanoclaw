import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../src/db/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { createDestination } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { assertNoDestinations } from './safety.js';

const AG = 'ag-eval-safety-test';

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({
    id: AG,
    name: 'Eval Safety Test',
    folder: 'eval-safety-test',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(() => {
  closeDb();
});

describe('assertNoDestinations', () => {
  it('returns silently for a fresh group that never had a destination', () => {
    expect(() => assertNoDestinations(AG)).not.toThrow();
  });

  it('throws, naming the count, when a destination row exists', () => {
    createDestination({
      agent_group_id: AG,
      local_name: 'household',
      target_type: 'agent',
      target_id: 'ag-some-other-group',
      created_at: new Date().toISOString(),
    });

    expect(() => assertNoDestinations(AG)).toThrow(/1 destination/);
  });
});
