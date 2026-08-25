/**
 * Barrel re-exporting both judging executors — `judgeDeterministic`
 * (Story 1.6) and `judgeLlm` (Story 2.2) — so a consumer outside `eval/judge/`
 * can import either from one path instead of reaching into the two sibling
 * files directly. Neither executor's own module gains a new dependency from
 * this file existing; `cli.ts` (the only current consumer of both) is free to
 * keep importing the two files directly or switch to this barrel — both
 * resolve to the same exports (deferred-work.md finding: no barrel existed
 * while `judge/` only held one file; revisit noted for once a second file,
 * `llm.ts`, landed alongside it — it has).
 */
export type { DeterministicCheck, DeterministicCheckContext, DeterministicJudgeResult } from './deterministic.js';
export { judgeDeterministic } from './deterministic.js';
export type { LlmJudgeResult } from './llm.js';
export { judgeLlm } from './llm.js';
