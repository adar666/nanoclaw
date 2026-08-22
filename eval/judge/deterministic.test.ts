import { describe, expect, it, vi } from 'vitest';

import type { OutboundMessage } from '../../src/db/session-db.js';
import { judgeDeterministic } from './deterministic.js';

const TRANSCRIPT: OutboundMessage[] = [
  {
    id: 'msg-out-1',
    kind: 'chat',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: JSON.stringify({ text: 'hello' }),
    in_reply_to: 'eval-msg-1',
  },
];

describe('judgeDeterministic', () => {
  it('normalizes a bare `true` return to { passed: true } with no evidence', () => {
    const result = judgeDeterministic(TRANSCRIPT, () => true);
    expect(result).toEqual({ passed: true });
    expect(result).not.toHaveProperty('evidence');
  });

  it('normalizes a bare `false` return to { passed: false } with no evidence', () => {
    const result = judgeDeterministic(TRANSCRIPT, () => false);
    expect(result).toEqual({ passed: false });
    expect(result).not.toHaveProperty('evidence');
  });

  it('passes a passing object result through unchanged, including evidence', () => {
    const evidence = { attendees: ['adardevora@gmail.com'] };
    const result = judgeDeterministic(TRANSCRIPT, () => ({ passed: true, evidence }));
    expect(result).toEqual({ passed: true, evidence });
  });

  it('passes a failing object result through unchanged, including evidence — not just a bare false', () => {
    const evidence = { attendees: [] };
    const result = judgeDeterministic(TRANSCRIPT, () => ({ passed: false, evidence }));
    expect(result).toEqual({ passed: false, evidence });
  });

  it('produces byte-identical (deep-equal) results across two calls with the same (transcript, check) pair', () => {
    const check = ({ transcript }: { transcript: OutboundMessage[] }) => ({
      passed: transcript.length === 1,
      evidence: { count: transcript.length },
    });

    const first = judgeDeterministic(TRANSCRIPT, check);
    const second = judgeDeterministic(TRANSCRIPT, check);
    expect(first).toEqual(second);
  });

  it('propagates a thrown error unchanged, rather than swallowing it or converting it to a failed verdict', () => {
    const boom = new Error('scenario-authoring bug');
    expect(() =>
      judgeDeterministic(TRANSCRIPT, () => {
        throw boom;
      }),
    ).toThrow(boom);
  });

  it('calls check exactly once, with exactly { transcript }', () => {
    const check = vi.fn(() => true);
    judgeDeterministic(TRANSCRIPT, check);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith({ transcript: TRANSCRIPT });
  });

  it('passes a passing object result through unchanged when no evidence key is present at all', () => {
    const result = judgeDeterministic(TRANSCRIPT, () => ({ passed: true }));
    expect(result).toEqual({ passed: true });
    expect(result).not.toHaveProperty('evidence');
  });

  it('throws a TypeError, not a silent false verdict, when check returns a non-object, non-boolean value', () => {
    // @ts-expect-error -- exercising the runtime guard against a type-system bypass
    expect(() => judgeDeterministic(TRANSCRIPT, () => null)).toThrow(TypeError);
    // @ts-expect-error -- exercising the runtime guard against a type-system bypass
    expect(() => judgeDeterministic(TRANSCRIPT, () => 'yes')).toThrow(TypeError);
  });

  it('throws a TypeError, not a silent false verdict, when check returns an object missing a boolean `passed`', () => {
    // @ts-expect-error -- exercising the runtime guard against a type-system bypass
    expect(() => judgeDeterministic(TRANSCRIPT, () => ({ evidence: 'oops' }))).toThrow(TypeError);
  });
});
