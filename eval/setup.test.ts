import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-eval-setup-test';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-eval-setup-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-eval-setup-test/groups',
}));

import { closeDb, initTestDb, runMigrations } from '../src/db/index.js';
import { getAllAgentGroups } from '../src/db/agent-groups.js';
import { getDestinations } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { ensureAgentGroup, ensureEvalScenarioGroup } from './setup.js';

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('ensureEvalScenarioGroup', () => {
  it('creates a new group with folder "eval" and zero destinations on first run', () => {
    const group = ensureEvalScenarioGroup();

    expect(group.folder).toBe('eval');
    expect(getDestinations(group.id)).toEqual([]);
  });

  it('is idempotent: re-running returns the same group, no duplicate row', () => {
    const first = ensureEvalScenarioGroup();
    const second = ensureEvalScenarioGroup();

    expect(second.id).toBe(first.id);
    expect(getAllAgentGroups().filter((g) => g.folder === 'eval')).toHaveLength(1);
  });
});

describe('ensureAgentGroup', () => {
  it('creates a fresh group and provisions its workspace filesystem', () => {
    const group = ensureAgentGroup('eval-generic', 'Generic Eval Group');

    expect(group.folder).toBe('eval-generic');
    expect(fs.existsSync(`${TEST_ROOT}/groups/eval-generic`)).toBe(true);
  });

  it('re-running on an existing folder repairs the workspace defensively instead of erroring', () => {
    const group = ensureAgentGroup('eval-repair', 'Repair Test');
    fs.rmSync(`${TEST_ROOT}/groups/eval-repair`, { recursive: true, force: true });
    expect(fs.existsSync(`${TEST_ROOT}/groups/eval-repair`)).toBe(false);

    const again = ensureAgentGroup('eval-repair', 'Repair Test');

    expect(again.id).toBe(group.id);
    expect(fs.existsSync(`${TEST_ROOT}/groups/eval-repair`)).toBe(true);
  });
});
