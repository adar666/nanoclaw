import { describe, expect, it } from 'vitest';

import type { OutboundMessage } from '../src/db/session-db.js';
import { loadScenarios, SCENARIO_SETS } from './loader.js';

const AG = 'ag-loader-test';

function outboundMsg(text: string): OutboundMessage {
  return {
    id: 'msg-1',
    kind: 'chat',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ text }),
    in_reply_to: 'cleanup-msg-1',
  };
}

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

  it('includes the guest-resolution-ambiguous-name scenario with an llmJudge judging rubric (Story 2.3)', () => {
    const set = loadScenarios('guest-resolution', AG);
    const scenario = set.scenarios.find((s) => s.id === 'guest-resolution-ambiguous-name');

    expect(scenario).toBeDefined();
    expect(scenario!.agentGroupId).toBe(AG);
    expect(scenario!.judging.type).toBe('llmJudge');
    expect(scenario!.message).toContain('רותי'); // "Ruthie" — absent from people.md
    if (scenario!.judging.type === 'llmJudge') {
      expect(scenario!.judging.rubric).toMatch(/email/i);
      expect(scenario!.judging.rubric).toMatch(/guess/i);
    }
    expect(scenario!.cleanup).toBeDefined();
  });

  it(
    'guest-resolution-known-name\'s cleanup confirm() also accepts an honest "nothing to delete" reply, not just a ' +
      "real deletion (regression — live re-verification found this scenario's own cleanup turn can hit the same " +
      '"nothing was actually created" case ambiguous-name already handled, and confirm() had no branch for it at all)',
    () => {
      const set = loadScenarios('guest-resolution', AG);
      const scenario = set.scenarios.find((s) => s.id === 'guest-resolution-known-name')!;

      expect(scenario.cleanup!.confirm([outboundMsg('נמחק בהצלחה')])).toBe(true);
      expect(scenario.cleanup!.confirm([outboundMsg('אין אירוע למחוק, לא נוצר אירוע בשיחה הזו')])).toBe(true);
      expect(scenario.cleanup!.confirm([outboundMsg('לא נמחק, האירוע עדיין קיים')])).toBe(false);
      expect(scenario.cleanup!.confirm([outboundMsg('לא ברור לי מה קרה')])).toBe(false);
    },
  );

  it('guest-resolution-ambiguous-name\'s cleanup confirm() accepts both a real deletion and an honest "nothing to delete" reply — a passing run creates no event at all (regression)', () => {
    const set = loadScenarios('guest-resolution', AG);
    const scenario = set.scenarios.find((s) => s.id === 'guest-resolution-ambiguous-name')!;

    expect(scenario.cleanup!.confirm([outboundMsg('נמחק בהצלחה')])).toBe(true);
    expect(scenario.cleanup!.confirm([outboundMsg('אין אירוע למחוק, לא זיהיתי את האורחת')])).toBe(true);
    expect(scenario.cleanup!.confirm([outboundMsg('לא נמחק, האירוע עדיין קיים')])).toBe(false);
    expect(scenario.cleanup!.confirm([outboundMsg('לא ברור לי מה קרה')])).toBe(false);
  });

  it('runs both guest-resolution scenarios (known-name, ambiguous-name) so pnpm eval run guest-resolution covers both', () => {
    const set = loadScenarios('guest-resolution', AG);

    expect(set.scenarios.map((s) => s.id)).toEqual(['guest-resolution-known-name', 'guest-resolution-ambiguous-name']);
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
