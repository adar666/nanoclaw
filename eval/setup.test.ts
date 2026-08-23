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

import { closeDb, initTestDb, runMigrations } from '../src/db/index.js';
import { getAgentGroupByFolder, getAllAgentGroups } from '../src/db/agent-groups.js';
import { getContainerConfig } from '../src/db/container-configs.js';
import { getDestinations } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { readEnvFile } from '../src/env.js';
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
