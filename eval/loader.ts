/**
 * Scenario-set type definitions + a small static registry (Story 1.7's own
 * "structural seed" piece per the epic context — `cli.ts` is this module's
 * only real caller).
 *
 * Schema follows `_bmad-output/specs/spec-eval-harness/scenario-format.md`
 * exactly: `judging` is the discriminated union documented there
 * (`deterministic` | `llmJudge`) — `cli.ts` executes both branches for real
 * (`deterministic` via Story 1.6's `judgeDeterministic`, `llmJudge` via
 * Epic 2's `judge/llm.ts`, wired in Story 2.3), with zero changes needed to
 * this module for either — this module only loads/registers scenarios, it
 * never judges them.
 *
 * A scenario set is registered as a *factory* (`agentGroupId => ScenarioSet`),
 * not a precomputed constant: `agentGroupId` is only known once
 * `ensureEvalScenarioGroup()` has actually run (it's the isolated eval
 * group's id, resolved at run time, never a real production group per
 * scenario-format.md's own `EVAL_AGENT_GROUP_ID` placeholder) — a scenario
 * file can't stamp it onto its own `Scenario` objects at module-load time.
 */
import type { OutboundMessage } from '../src/db/session-db.js';
import type { DeterministicCheck } from './judge/deterministic.js';
import { guestResolutionScenarioSet } from './scenarios/guest-resolution.scenarios.js';

/**
 * Runs as a same-thread follow-up turn after judging, regardless of verdict
 * (`cli.ts`'s own responsibility to drive that turn — this is plain data,
 * not a self-executing step). `confirm` inspects the cleanup turn's own
 * transcript and reports whether the agent's reply actually confirms the
 * cleanup succeeded; a `false` (or a turn that never reaches `completed`) is
 * what `cli.ts` turns into a reported `cleanupError`.
 */
export interface ScenarioCleanup {
  message: string;
  confirm: (transcript: OutboundMessage[]) => boolean;
}

export type ScenarioJudging =
  | { type: 'deterministic'; check: DeterministicCheck }
  | { type: 'llmJudge'; rubric: string };

export interface Scenario {
  id: string;
  agentGroupId: string;
  message: string;
  judging: ScenarioJudging;
  cleanup?: ScenarioCleanup;
}

export interface ScenarioSet {
  name: string;
  scenarios: Scenario[];
}

export type ScenarioSetFactory = (agentGroupId: string) => ScenarioSet;

/** Static registry — add a new scenario set by adding one entry here. */
export const SCENARIO_SETS: Record<string, ScenarioSetFactory> = {
  'guest-resolution': guestResolutionScenarioSet,
};

/**
 * Throws a clear error for an unregistered `name`, naming the known sets —
 * never returns a partially-built or empty `ScenarioSet` for a bad name.
 */
export function loadScenarios(name: string, agentGroupId: string): ScenarioSet {
  const factory = Object.prototype.hasOwnProperty.call(SCENARIO_SETS, name) ? SCENARIO_SETS[name] : undefined;
  if (!factory) {
    const known = Object.keys(SCENARIO_SETS);
    throw new Error(
      `loadScenarios: unknown scenario set "${name}" — known sets: ${known.length ? known.join(', ') : '(none registered)'}`,
    );
  }
  return factory(agentGroupId);
}
