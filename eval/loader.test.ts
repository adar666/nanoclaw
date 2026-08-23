import { describe, expect, it } from 'vitest';

import { loadScenarios, SCENARIO_SETS } from './loader.js';

const AG = 'ag-loader-test';

describe('loadScenarios', () => {
  it('is registered with a "guest-resolution" entry', () => {
    expect(Object.keys(SCENARIO_SETS)).toContain('guest-resolution');
  });

  it('returns a ScenarioSet whose name matches the registered key and stamps every scenario with the given agentGroupId', () => {
    const set = loadScenarios('guest-resolution', AG);

    expect(set.name).toBe('guest-resolution');
    expect(set.scenarios.length).toBeGreaterThan(0);
    for (const scenario of set.scenarios) {
      expect(scenario.agentGroupId).toBe(AG);
    }
  });

  it('includes the guest-resolution-known-name scenario with a deterministic judging check', () => {
    const set = loadScenarios('guest-resolution', AG);
    const scenario = set.scenarios.find((s) => s.id === 'guest-resolution-known-name');

    expect(scenario).toBeDefined();
    expect(scenario!.judging.type).toBe('deterministic');
    expect(scenario!.message).toContain('דבורה');
    expect(scenario!.cleanup).toBeDefined();
  });

  it('re-running with a different agentGroupId produces freshly-stamped scenarios, not a cached/shared object', () => {
    const first = loadScenarios('guest-resolution', 'ag-one');
    const second = loadScenarios('guest-resolution', 'ag-two');

    expect(first.scenarios[0].agentGroupId).toBe('ag-one');
    expect(second.scenarios[0].agentGroupId).toBe('ag-two');
  });

  it('throws a clear error naming the unknown set for an unregistered name', () => {
    expect(() => loadScenarios('nonexistent', AG)).toThrow(/unknown scenario set "nonexistent"/i);
  });

  it("the unknown-set error names the known sets so it's actionable", () => {
    expect(() => loadScenarios('nonexistent', AG)).toThrow(/guest-resolution/);
  });
});
