/**
 * Domain-agnostic executor for deterministic (non-LLM) scenario judging
 * (AD-5): this module never knows or cares what a specific check (e.g.
 * "guest-resolution") looks like — it just calls whatever function it's
 * handed against the already-captured transcript and returns the result.
 *
 * Operates purely on `transcript` (`OutboundMessage[]`, Story 1.4's own
 * output) — never a live second call against Google Calendar or any other
 * external API. A scenario file's `check` function is domain-specific
 * scenario content (Story 1.7's scope), not this generic executor's
 * concern.
 *
 * Pure: no I/O, no `Date.now()`/randomness of its own. Judging the exact
 * same `(transcript, check)` pair twice must produce byte-identical
 * results, satisfying CAP-2's reproducibility requirement by construction.
 *
 * If `check` throws, `judgeDeterministic` does not catch it — a throwing
 * check is a scenario-authoring bug, and swallowing it would silently turn
 * a broken check into a false verdict rather than a loud, attributable
 * failure. Surfacing that across a multi-scenario run is Story 1.7's CLI/
 * reporter, not built yet — out of scope here.
 */
import type { OutboundMessage } from '../../src/db/session-db.js';

export interface DeterministicCheckContext {
  transcript: OutboundMessage[];
}

export interface DeterministicJudgeResult {
  passed: boolean;
  /**
   * Optional so a bare boolean-returning check still works. Present
   * whenever the check function provides it, on a pass or a fail — Story
   * 1.7's own report needs to show real evidence (e.g. a resolved email)
   * even on a passing scenario, not just on failure.
   */
  evidence?: unknown;
}

/**
 * Deliberately synchronous — a `check` returning a `Promise` does not
 * structurally satisfy this type, so an async check is a compile-time
 * error, not a runtime one to guard against here.
 */
export type DeterministicCheck = (ctx: DeterministicCheckContext) => boolean | DeterministicJudgeResult;

/**
 * Calls `check({ transcript })`. A bare `boolean` return is normalized to
 * `{ passed: <value> }` (no evidence); an object return passes through
 * unchanged.
 *
 * `DeterministicCheck`'s type already blocks a malformed return for any
 * correctly-typed scenario file, but this function's verdict is reported as
 * ground truth about agent behavior — a malformed return slipping past a
 * type-system gap (an `any` cast, a non-typechecked caller) shouldn't
 * silently become a false verdict. Guarded with a loud `TypeError` instead.
 */
export function judgeDeterministic(transcript: OutboundMessage[], check: DeterministicCheck): DeterministicJudgeResult {
  const result = check({ transcript });
  if (typeof result === 'boolean') return { passed: result };
  if (result === null || typeof result !== 'object' || typeof result.passed !== 'boolean') {
    throw new TypeError(
      `judgeDeterministic: check() must return a boolean or { passed: boolean, evidence?: unknown }, got ${JSON.stringify(result)}`,
    );
  }
  return result;
}
