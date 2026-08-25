/**
 * Direct coverage of `guest-resolution-known-name`'s own `check()` function —
 * previously untested anywhere: `cli.test.ts` mocks `judgeDeterministic`
 * wholesale (so the real `check` closure this file defines is never actually
 * invoked there), and `loader.test.ts` only inspects scenario metadata /
 * `cleanup.confirm`, never `judging.check`. Two things this file guards that
 * had no regression coverage before:
 *
 * 1. `check()`'s email-matching logic must reject the email appearing
 *    merely ANYWHERE in the reply (a refusal, a quoted mention) — not just
 *    accept a bare `text.includes(email)` (deferred-work.md, 2026-08-25).
 * 2. `DEVORAH_EMAIL`'s runtime drift guard against the real, mounted
 *    `people.md` — a hardcoded scenario constant that silently drifted from
 *    its source of truth would otherwise pass/fail this scenario for the
 *    wrong reason with no signal at all.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above every other top-level statement in
// this file (including const declarations) — the literal must be inlined
// here rather than referencing an outer TEST_ROOT/GROUPS_DIR variable, or
// the factory throws "Cannot access ... before initialization" the moment
// this module loads (matches cli.test.ts's/sweep.test.ts's own identical
// inlining for the same reason).
vi.mock('../../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-eval-guest-resolution-scenarios-test/groups',
}));

const TEST_ROOT = '/tmp/nanoclaw-eval-guest-resolution-scenarios-test';
const PEOPLE_MD_PATH = `${TEST_ROOT}/groups/household/memory/household/people.md`;

import { judgeDeterministic } from '../judge/deterministic.js';
import { DEVORAH_EMAIL, guestResolutionScenarioSet } from './guest-resolution.scenarios.js';

function outboundMsg(text: string) {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    kind: 'chat' as const,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ text }),
    in_reply_to: 'eval-msg-1',
  };
}

function knownNameCheck() {
  const set = guestResolutionScenarioSet('ag-guest-resolution-test');
  const scenario = set.scenarios.find((s) => s.id === 'guest-resolution-known-name')!;
  if (scenario.judging.type !== 'deterministic') throw new Error('expected a deterministic scenario');
  return scenario.judging.check;
}

function writePeopleMd(content: string): void {
  fs.mkdirSync(`${TEST_ROOT}/groups/household/memory/household`, { recursive: true });
  fs.writeFileSync(PEOPLE_MD_PATH, content);
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  writePeopleMd(`# People\n\n- Devorah: ${DEVORAH_EMAIL}\n`);
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('guest-resolution-known-name check() — email matching', () => {
  it('passes for the real production reply shape (email embedded mid-sentence after a colon)', () => {
    const check = knownNameCheck();
    const result = judgeDeterministic([outboundMsg(`נוסף כאורח: ${DEVORAH_EMAIL}`)], check);

    expect(result.passed).toBe(true);
    expect(result.evidence).toBe(DEVORAH_EMAIL);
  });

  it('rejects the email appearing only inside a refusal that negates it in the same sentence', () => {
    const check = knownNameCheck();
    const result = judgeDeterministic(
      [outboundMsg(`לא הוספתי את דבורה כאורחת עם ${DEVORAH_EMAIL}, כי לא קיבלתי אישור.`)],
      check,
    );

    expect(result.passed).toBe(false);
  });

  it('rejects the email appearing only inside a quoted/echoed mention', () => {
    const check = knownNameCheck();
    const result = judgeDeterministic([outboundMsg(`הפורמט המבוקש הוא "${DEVORAH_EMAIL}" כפי שצוין.`)], check);

    expect(result.passed).toBe(false);
  });

  it('takes the LAST occurrence when the reply mentions the email more than once', () => {
    const check = knownNameCheck();
    const result = judgeDeterministic(
      [outboundMsg(`שוקל להשתמש ב-${DEVORAH_EMAIL}... כן, נוסף כאורח: ${DEVORAH_EMAIL}`)],
      check,
    );

    expect(result.passed).toBe(true);
  });

  it('fails when no email appears anywhere in the reply, evidence carries the reply text', () => {
    const check = knownNameCheck();
    const result = judgeDeterministic([outboundMsg('לא הצלחתי למצוא כתובת מייל')], check);

    expect(result.passed).toBe(false);
    expect(result.evidence).toBe('לא הצלחתי למצוא כתובת מייל');
  });

  it('truncates a pathologically long failing reply in evidence rather than embedding it verbatim', () => {
    const check = knownNameCheck();
    const longReply = 'x'.repeat(2000);
    const result = judgeDeterministic([outboundMsg(longReply)], check);

    expect(result.passed).toBe(false);
    expect(typeof result.evidence).toBe('string');
    expect((result.evidence as string).length).toBeLessThan(2000);
    expect(result.evidence).toContain('truncated');
  });
});

describe('guest-resolution-known-name check() — DEVORAH_EMAIL drift guard', () => {
  it('throws loudly when the hardcoded email no longer appears in the real, mounted people.md', () => {
    writePeopleMd('# People\n\n- Devorah: someone-else@example.com\n');
    const check = knownNameCheck();

    expect(() => judgeDeterministic([outboundMsg(`נוסף כאורח: ${DEVORAH_EMAIL}`)], check)).toThrow(
      /no longer appears/,
    );
  });

  it('throws loudly when people.md does not exist at all', () => {
    fs.rmSync(PEOPLE_MD_PATH, { force: true });
    const check = knownNameCheck();

    expect(() => judgeDeterministic([outboundMsg(`נוסף כאורח: ${DEVORAH_EMAIL}`)], check)).toThrow(
      /doesn't exist/,
    );
  });
});
