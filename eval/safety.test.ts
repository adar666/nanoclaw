import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../src/db/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { createDestination } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { assertIsEvalGroup, assertNoDestinations } from './safety.js';

const AG = 'ag-eval-safety-test';

beforeEach(() => {
  runMigrations(initTestDb());
  // folder must be exactly "eval" — assertIsEvalGroup's own tests below rely
  // on this fixture being one of the two provisioned eval groups;
  // assertNoDestinations doesn't care about folder either way.
  createAgentGroup({
    id: AG,
    name: 'Eval Safety Test',
    folder: 'eval',
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

describe('assertIsEvalGroup', () => {
  it('returns silently for a group provisioned under the "eval" folder', () => {
    expect(() => assertIsEvalGroup(AG)).not.toThrow();
  });

  it('returns silently for a group provisioned under the "eval-judge" folder', () => {
    const judgeId = 'ag-eval-safety-test-judge';
    createAgentGroup({
      id: judgeId,
      name: 'Eval Safety Test (Judge)',
      folder: 'eval-judge',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    expect(() => assertIsEvalGroup(judgeId)).not.toThrow();
  });

  it('throws, naming the group id, for a group under neither eval folder — even with zero destinations', () => {
    const prodId = 'ag-eval-safety-test-prod';
    createAgentGroup({
      id: prodId,
      name: 'A Real Production Group',
      folder: 'a-real-production-group',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    expect(() => assertIsEvalGroup(prodId)).toThrow(
      new RegExp(`${prodId}.*not one of the two provisioned eval groups`),
    );
  });

  it('throws for an id that resolves to no agent group at all', () => {
    expect(() => assertIsEvalGroup('ag-does-not-exist')).toThrow(/not one of the two provisioned eval groups/);
  });
});
