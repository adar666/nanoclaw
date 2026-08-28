import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-eval-setup-test';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-eval-setup-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-eval-setup-test/groups',
}));

// Isolates the calendar-id resolution tests from whatever is actually in this
// checkout's .env — the real value must never leak into a test's "unset"
// case, and a mocked value must never leak into the "unset" case either.
//
// Broader blast radius than it looks: src/config.js also imports readEnvFile
// and calls it at module load for a dozen other keys (ONECLI_URL,
// ASSISTANT_NAME, DEFAULT_AGENT_PROVIDER, ...). Because config.js is mocked
// above via importOriginal() (which still runs the real module body), its
// internal env.js import resolves to this SAME mock for the whole file —
// Vitest's mock registry is keyed by resolved module id, not by importer. So
// every env-derived constant in config.js reads as unset/default here, not
// just EVAL_TEST_CALENDAR_ID. Harmless today (nothing below asserts on those
// other constants), but a real trap for a future test added to this file
// that assumes a real .env-derived value from config.js.
vi.mock('../src/env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Calls through to the real implementation by default (every existing test
// below relies on the real filesystem side effects) — only the rollback test
// overrides it, via mockImplementationOnce, to simulate the follow-up
// filesystem step throwing after the DB insert already committed.
vi.mock('../src/group-init.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/group-init.js')>();
  return { ...actual, initGroupFilesystem: vi.fn(actual.initGroupFilesystem) };
});

// Real mount-allowlist.json state (a real file at ~/.config/nanoclaw/...) is
// not deterministic across machines/CI — every test below needs a controlled
// verdict rather than whatever this host's real allowlist happens to say.
// Defaults to "allowed" so every pre-existing test (which doesn't care about
// mount-security specifically) keeps passing; only the dedicated tests below
// override it.
vi.mock('../src/modules/mount-security/index.js', () => ({
  validateMount: vi.fn(() => ({ allowed: true, reason: 'test default: allowed' })),
}));

import { closeDb, initTestDb, runMigrations } from '../src/db/index.js';
import { getAgentGroupByFolder, getAllAgentGroups } from '../src/db/agent-groups.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { getContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';
import { getDestinations } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { readEnvFile } from '../src/env.js';
import { validateMount } from '../src/modules/mount-security/index.js';
import {
  ensureAgentGroup,
  ensureEvalCalendarOverride,
  ensureEvalJudgeGroup,
  ensureEvalPeopleMount,
  ensureEvalScenarioGroup,
} from './setup.js';

const mockedReadEnvFile = vi.mocked(readEnvFile);

const PEOPLE_MD_PATH = `${TEST_ROOT}/groups/household/memory/household/people.md`;

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  // ensureEvalPeopleMount now fails loud if this doesn't exist (patch:
  // fail-fast check added after review) — every test exercising it or
  // ensureEvalScenarioGroup needs the fixture present.
  fs.mkdirSync(`${TEST_ROOT}/groups/household/memory/household`, { recursive: true });
  fs.writeFileSync(PEOPLE_MD_PATH, '# People\n\n- Devorah: adardevora@gmail.com\n');
  runMigrations(initTestDb());
  delete process.env.EVAL_TEST_CALENDAR_ID;
  mockedReadEnvFile.mockReturnValue({});
  vi.mocked(validateMount).mockReset().mockReturnValue({ allowed: true, reason: 'test default: allowed' });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  delete process.env.EVAL_TEST_CALENDAR_ID;
});

describe('ensureEvalScenarioGroup', () => {
  beforeEach(() => {
    process.env.EVAL_TEST_CALENDAR_ID = 'eval-test@group.calendar.google.com';
  });

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

  it('provisions the calendar override and the people.md mount in one call', () => {
    const group = ensureEvalScenarioGroup();

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.calendar_registry)).toEqual([
      { name: 'uriel', calendarId: 'eval-test@group.calendar.google.com' },
    ]);
    expect(JSON.parse(config.additional_mounts)).toContainEqual({
      hostPath: `${TEST_ROOT}/groups/household/memory/household/people.md`,
      containerPath: 'household-shared/people.md',
      readonly: true,
    });
  });

  it('throws when EVAL_TEST_CALENDAR_ID is unset, naming the manual setup step, and writes nothing', () => {
    delete process.env.EVAL_TEST_CALENDAR_ID;

    expect(() => ensureEvalScenarioGroup()).toThrow(/EVAL_TEST_CALENDAR_ID/);

    // The group itself is created by ensureAgentGroup before the calendar
    // check runs, but its config must stay untouched — the failure happens
    // before either write.
    const group = getAgentGroupByFolder('eval')!;
    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.calendar_registry)).toEqual([]);
    expect(JSON.parse(config.additional_mounts)).toEqual([]);
  });

  it('never reaches the mount step when the calendar override throws first (ordering guarantee)', () => {
    delete process.env.EVAL_TEST_CALENDAR_ID;

    expect(() => ensureEvalScenarioGroup()).toThrow();

    const group = getAgentGroupByFolder('eval')!;
    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.additional_mounts)).toEqual([]);
  });
});

describe('ensureEvalJudgeGroup', () => {
  it('creates a new group with folder "eval-judge", the expected display name, and zero destinations on first run', () => {
    const group = ensureEvalJudgeGroup();

    expect(group.folder).toBe('eval-judge');
    expect(group.name).toBe('Eval Harness (Judge)');
    expect(getDestinations(group.id)).toEqual([]);
  });

  it('is idempotent: re-running returns the same group, no duplicate row', () => {
    const first = ensureEvalJudgeGroup();
    const second = ensureEvalJudgeGroup();

    expect(second.id).toBe(first.id);
    expect(getAllAgentGroups().filter((g) => g.folder === 'eval-judge')).toHaveLength(1);
  });

  it('does not touch the calendar registry or additional mounts', () => {
    const group = ensureEvalJudgeGroup();

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.calendar_registry)).toEqual([]);
    expect(JSON.parse(config.additional_mounts)).toEqual([]);
  });

  it('leaves the scenario group untouched', () => {
    process.env.EVAL_TEST_CALENDAR_ID = 'eval-test@group.calendar.google.com';
    const scenarioGroup = ensureEvalScenarioGroup();
    const scenarioConfigBefore = getContainerConfig(scenarioGroup.id)!;

    ensureEvalJudgeGroup();

    const scenarioConfigAfter = getContainerConfig(scenarioGroup.id)!;
    expect(scenarioConfigAfter.calendar_registry).toEqual(scenarioConfigBefore.calendar_registry);
    expect(scenarioConfigAfter.additional_mounts).toEqual(scenarioConfigBefore.additional_mounts);
    expect(getDestinations(scenarioGroup.id)).toEqual([]);
    expect(getAllAgentGroups().filter((g) => g.folder === 'eval')).toHaveLength(1);
  });
});

describe('ensureEvalCalendarOverride', () => {
  it('registers a "uriel" override with the configured calendar id', () => {
    process.env.EVAL_TEST_CALENDAR_ID = 'eval-test@group.calendar.google.com';
    const group = ensureAgentGroup('eval-cal', 'Eval Calendar Test');

    ensureEvalCalendarOverride(group.id);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.calendar_registry)).toEqual([
      { name: 'uriel', calendarId: 'eval-test@group.calendar.google.com' },
    ]);
  });

  it('falls back to readEnvFile when process.env is unset', () => {
    mockedReadEnvFile.mockReturnValue({ EVAL_TEST_CALENDAR_ID: 'eval-test@group.calendar.google.com' });
    const group = ensureAgentGroup('eval-cal-envfile', 'Eval Calendar Test (.env)');

    ensureEvalCalendarOverride(group.id);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.calendar_registry)).toEqual([
      { name: 'uriel', calendarId: 'eval-test@group.calendar.google.com' },
    ]);
  });

  it('throws naming the manual setup step when unset in both process.env and .env', () => {
    const group = ensureAgentGroup('eval-cal-missing', 'Eval Calendar Test (missing)');

    expect(() => ensureEvalCalendarOverride(group.id)).toThrow(/EVAL_TEST_CALENDAR_ID/);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.calendar_registry)).toEqual([]);
  });

  it('accepts the literal "primary" as a valid calendar id', () => {
    process.env.EVAL_TEST_CALENDAR_ID = 'primary';
    const group = ensureAgentGroup('eval-cal-primary', 'Eval Calendar Test (primary)');

    ensureEvalCalendarOverride(group.id);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.calendar_registry)).toEqual([{ name: 'uriel', calendarId: 'primary' }]);
  });

  it('trims incidental whitespace around a valid calendar id', () => {
    process.env.EVAL_TEST_CALENDAR_ID = '  eval-test@group.calendar.google.com  ';
    const group = ensureAgentGroup('eval-cal-whitespace', 'Eval Calendar Test (whitespace)');

    ensureEvalCalendarOverride(group.id);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.calendar_registry)).toEqual([
      { name: 'uriel', calendarId: 'eval-test@group.calendar.google.com' },
    ]);
  });

  it('throws on a malformed calendar id, writing nothing', () => {
    process.env.EVAL_TEST_CALENDAR_ID = 'not-an-id';
    const group = ensureAgentGroup('eval-cal-malformed', 'Eval Calendar Test (malformed)');

    expect(() => ensureEvalCalendarOverride(group.id)).toThrow(/doesn't look like a real Google Calendar id/);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.calendar_registry)).toEqual([]);
  });

  it('is idempotent: re-running keeps exactly one "uriel" entry', () => {
    process.env.EVAL_TEST_CALENDAR_ID = 'eval-test@group.calendar.google.com';
    const group = ensureAgentGroup('eval-cal-idempotent', 'Eval Calendar Test (idempotent)');

    ensureEvalCalendarOverride(group.id);
    ensureEvalCalendarOverride(group.id);

    const config = getContainerConfig(group.id)!;
    const registry = JSON.parse(config.calendar_registry) as Array<{ name: string; calendarId: string }>;
    expect(registry.filter((e) => e.name === 'uriel')).toHaveLength(1);
  });

  it('overwrites an existing "uriel" entry rather than appending a second one', () => {
    const group = ensureAgentGroup('eval-cal-overwrite', 'Eval Calendar Test (overwrite)');
    process.env.EVAL_TEST_CALENDAR_ID = 'old@group.calendar.google.com';
    ensureEvalCalendarOverride(group.id);
    process.env.EVAL_TEST_CALENDAR_ID = 'new@group.calendar.google.com';

    ensureEvalCalendarOverride(group.id);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.calendar_registry)).toEqual([
      { name: 'uriel', calendarId: 'new@group.calendar.google.com' },
    ]);
  });
});

describe('ensureEvalPeopleMount', () => {
  it('mounts household/memory/household/people.md read-only', () => {
    const group = ensureAgentGroup('eval-mount', 'Eval Mount Test');

    ensureEvalPeopleMount(group.id);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.additional_mounts)).toEqual([
      {
        hostPath: `${TEST_ROOT}/groups/household/memory/household/people.md`,
        containerPath: 'household-shared/people.md',
        readonly: true,
      },
    ]);
  });

  it('is idempotent: re-running adds no duplicate entry', () => {
    const group = ensureAgentGroup('eval-mount-idempotent', 'Eval Mount Test (idempotent)');

    ensureEvalPeopleMount(group.id);
    ensureEvalPeopleMount(group.id);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.additional_mounts)).toHaveLength(1);
  });

  it('throws loud, writing nothing, when people.md does not exist on disk', () => {
    fs.rmSync(PEOPLE_MD_PATH);
    const group = ensureAgentGroup('eval-mount-missing-source', 'Eval Mount Test (missing source)');

    expect(() => ensureEvalPeopleMount(group.id)).toThrow(/people\.md/);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.additional_mounts)).toEqual([]);
  });

  it('validates the mount against mount-security before writing it, passing the real hostPath/containerPath/readonly (deferred-work.md, spec-eval-1-2)', () => {
    const group = ensureAgentGroup('eval-mount-validate-call', 'Eval Mount Test (validate call)');

    ensureEvalPeopleMount(group.id);

    expect(validateMount).toHaveBeenCalledWith({
      hostPath: `${TEST_ROOT}/groups/household/memory/household/people.md`,
      containerPath: 'household-shared/people.md',
      readonly: true,
    });
  });

  it('throws loud, writing nothing, when mount-security would reject the mount (missing allowlist entry) — never a silent WARN-rejection at spawn time', () => {
    vi.mocked(validateMount).mockReturnValue({
      allowed: false,
      reason: 'Path "/tmp/nanoclaw-eval-setup-test/groups/household/memory/household/people.md" is not under any allowed root',
    });
    const group = ensureAgentGroup('eval-mount-not-allowlisted', 'Eval Mount Test (not allowlisted)');

    expect(() => ensureEvalPeopleMount(group.id)).toThrow(/mount-allowlist\.json/);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.additional_mounts)).toEqual([]);
  });

  it('reconciles a pre-existing (hostPath, containerPath) entry whose readonly value disagrees with true, rather than leaving it writable (deferred-work.md, spec-eval-1-2)', () => {
    const group = ensureAgentGroup('eval-mount-reconcile', 'Eval Mount Test (reconcile)');
    const hostPath = `${TEST_ROOT}/groups/household/memory/household/people.md`;
    const containerPath = 'household-shared/people.md';
    // Seed a pre-existing entry for the identical (hostPath, containerPath)
    // pair, but writable — simulates a hand-edited/stale config row the old
    // (hostPath, containerPath)-only dedup check would have silently kept as-is.
    updateContainerConfigJson(group.id, 'additional_mounts', [{ hostPath, containerPath, readonly: false }]);

    ensureEvalPeopleMount(group.id);

    const config = getContainerConfig(group.id)!;
    expect(JSON.parse(config.additional_mounts)).toEqual([{ hostPath, containerPath, readonly: true }]);
  });

  it('does not rewrite the config when the existing entry already matches exactly', () => {
    const group = ensureAgentGroup('eval-mount-no-op', 'Eval Mount Test (no-op)');
    ensureEvalPeopleMount(group.id);
    const before = getContainerConfig(group.id)!.additional_mounts;

    ensureEvalPeopleMount(group.id);

    expect(getContainerConfig(group.id)!.additional_mounts).toBe(before);
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

  it('rolls back (deletes) the agent_groups row when the filesystem step throws after the DB insert commits (deferred-work.md, spec-eval-1-1)', () => {
    vi.mocked(initGroupFilesystem).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(() => ensureAgentGroup('eval-rollback', 'Rollback Test')).toThrow(/disk full/);

    // No orphaned row left behind for a later ensureAgentGroup(folder, ...)
    // call to find and treat as already-provisioned (silently skipping the
    // repair-on-existing branch, since initGroupFilesystem never finished).
    expect(getAgentGroupByFolder('eval-rollback')).toBeUndefined();
  });

  it('a later ensureAgentGroup call for the same folder after a rollback creates a fresh group rather than silently no-oping', () => {
    vi.mocked(initGroupFilesystem).mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => ensureAgentGroup('eval-rollback-retry', 'Rollback Retry Test')).toThrow();

    const group = ensureAgentGroup('eval-rollback-retry', 'Rollback Retry Test');

    expect(group.folder).toBe('eval-rollback-retry');
    expect(fs.existsSync(`${TEST_ROOT}/groups/eval-rollback-retry`)).toBe(true);
  });
});
