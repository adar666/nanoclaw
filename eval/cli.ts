/**
 * CLI entry point: `pnpm eval run <scenario-set-name>`, `pnpm eval sweep`,
 * `pnpm eval prune`, or `pnpm eval teardown`.
 *
 * `dispatchEvalCli` (bottom of this file) routes between the four: `run`
 * drives the whole pipeline this epic built — `loader → runner →
 * judge/deterministic (or judge/llm, depending on the scenario's judging
 * type) → reporter` — under one `withEvalLock` call (AD-8), matching
 * `lock.ts`'s own docstring expectation that this file is its first real
 * caller; `sweep` (Story 3.1) delegates to `./sweep.js`'s `runSweep()`, its
 * own standalone, differently-shaped operation; `prune`/`teardown`
 * (deferred-work.md's "no teardown/pruning story" finding) delegate to
 * `./teardown.js`'s `pruneEvalSessions()`/`decommissionEvalHarness()`. An
 * unknown subcommand, no subcommand, or (for `run`) an unregistered
 * scenario-set name is a clear error to stderr with `process.exitCode = 1`
 * and, per the I/O matrix, is thrown before `withEvalLock` ever acquires —
 * a bad invocation touches no session, no container, no lock file.
 */
import { EVAL_CLI_ONESHOT_TOKEN, killAllActiveContainers } from '../src/container-runner.js';
import { log } from '../src/log.js';
import { judgeDeterministic } from './judge/deterministic.js';
import { JudgeLlmError, judgeLlm } from './judge/llm.js';
import { loadScenarios, SCENARIO_SETS, type Scenario } from './loader.js';
import { releaseEvalLockIfOwned, withEvalLock } from './lock.js';
import { makeRunId, writeReport, type Report, type ScenarioReportEntry } from './reporter.js';
import { runScenarioTurn } from './runner.js';
import { EVAL_THREAD_PREFIX } from './session.js';
import { bootstrapDb, ensureEvalJudgeGroup, ensureEvalScenarioGroup } from './setup.js';
import { runSweep, type SweepResult } from './sweep.js';
import {
  decommissionEvalHarness,
  pruneEvalSessions,
  type DecommissionResult,
  type PruneResult,
} from './teardown.js';

interface ParsedArgs {
  scenarioSetName: string;
}

/**
 * A full `pnpm eval run` invocation can span several scenarios, each up to
 * `runScenarioTurn`'s own 5-minute default timeout — sometimes crossed twice
 * over for one scenario (its own turn plus a cleanup turn, plus a separate
 * judge turn for an `llmJudge` scenario). `lock.ts`'s own 30s default
 * `staleMs` is sized for `documents.ts`'s sub-second critical sections, not
 * this — a real multi-scenario run risks crossing it, which would let a
 * second invocation reclaim this run's own still-live lock as abandoned.
 * Sized generously rather than computed from the current scenario-set size,
 * since this file has no visibility into how large a future set might grow.
 */
const RUN_LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Validates argv shape — exactly `["run", "<scenario-set-name>"]` — and that
 * the name is registered. Throws on any violation; never itself prints or
 * sets `process.exitCode` (the top-level handler at the bottom of this file
 * does that), so `cli.test.ts` can assert on the thrown error directly.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const [subcommand, scenarioSetName, ...rest] = argv;
  if (subcommand !== 'run' || !scenarioSetName || rest.length > 0) {
    throw new Error(`Usage: pnpm eval run <scenario-set-name>. Got: ${JSON.stringify(argv)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(SCENARIO_SETS, scenarioSetName)) {
    const known = Object.keys(SCENARIO_SETS);
    throw new Error(
      `Unknown scenario set "${scenarioSetName}" — known sets: ${known.length ? known.join(', ') : '(none registered)'}`,
    );
  }
  return { scenarioSetName };
}

/**
 * Runs one scenario's turn, judging, and cleanup, producing its report
 * entry. Never throws for a scenario-level outcome (a failed/timed-out turn,
 * a failing verdict, a `check` that throws, a `judgeLlm` `JudgeLlmError`, a
 * failed cleanup) — all of those are reported, not raised, so one scenario's
 * fate never aborts the rest of the run. Only a structural failure (bad
 * opts, a destination violation, a spawn failure — AD-4 loud-failure
 * conditions) propagates out of this function, which is deliberate: those
 * are environmental problems the whole run should abort loudly for, not a
 * per-scenario verdict. This applies uniformly whether the structural
 * failure comes from the scenario's own (uncaught) `runScenarioTurn` call or
 * leaks out of `judgeLlm`'s internal one — the `llmJudge` branch's catch
 * only absorbs `JudgeLlmError`, rethrowing anything else (deferred-work.md
 * finding, spec-eval-2-3).
 *
 * `judgeAgentGroupId` is infrastructure (which isolated agent group the
 * judge's own turn spawns under), never scenario content — `runCli`
 * provisions it once via `ensureEvalJudgeGroup()` and passes it to every
 * call, unconditionally, even for a scenario set with zero `llmJudge`
 * scenarios.
 *
 * Exported for `cli.test.ts`'s own direct unit coverage of the `llmJudge`
 * branch — the registered `guest-resolution` set's own `llmJudge` scenario
 * (`guest-resolution-ambiguous-name`) exercises it through `runCli` too, but
 * a hand-built `Scenario` gives finer-grained control over pass/fail/throw
 * cases without needing three separate scenario-set fixtures.
 */
export async function runOneScenario(scenario: Scenario, judgeAgentGroupId: string): Promise<ScenarioReportEntry> {
  const threadId = `${EVAL_THREAD_PREFIX}:${scenario.id}`;
  const turn = await runScenarioTurn(scenario.agentGroupId, threadId, scenario.message);

  let entry: ScenarioReportEntry;
  if (turn.status !== 'completed') {
    // A turn that never reached 'completed' is reported failed, with the
    // status as evidence — neither judge is ever called against an
    // incomplete transcript.
    entry = {
      id: scenario.id,
      status: turn.status,
      judging: scenario.judging.type,
      passed: false,
      evidence: `turn did not complete: status=${turn.status}`,
    };
  } else if (scenario.judging.type === 'llmJudge') {
    try {
      const judgeThreadId = `${EVAL_THREAD_PREFIX}:judge:${scenario.id}`;
      const verdict = await judgeLlm(judgeAgentGroupId, judgeThreadId, turn.transcript, scenario.judging.rubric);
      entry = {
        id: scenario.id,
        status: 'completed',
        judging: 'llmJudge',
        passed: verdict.verdict === 'pass',
        evidence: verdict.reasoning,
      };
    } catch (err) {
      // Mirrors the deterministic branch's own check()-throwing case below —
      // but ONLY for judgeLlm's own documented business-logic failure modes
      // (an incomplete judge turn, an unparseable judge reply), signaled via
      // `JudgeLlmError` — caught here rather than left to propagate, since a
      // judging failure on one scenario must not abort the whole run, skip
      // that scenario's own cleanup, or discard every other scenario's
      // already-computed report entry.
      //
      // Anything else — a genuine AD-4-style structural failure that leaked
      // out of judgeLlm's own internal runScenarioTurn call (a destination
      // violation, a spawn failure, malformed opts) rather than one of its
      // documented failure modes — must propagate loud and abort the whole
      // run, exactly like the scenario's own (uncaught) runScenarioTurn call
      // above, NOT get silently absorbed into a per-scenario 'judge-error'
      // outcome (deferred-work.md finding, spec-eval-2-3).
      if (!(err instanceof JudgeLlmError)) throw err;

      const message = err.message;
      log.error('Scenario llmJudge threw', { scenarioId: scenario.id, err });
      entry = {
        id: scenario.id,
        status: 'judge-error',
        judging: 'llmJudge',
        passed: false,
        evidence: `judgeLlm threw: ${message}`,
      };
    }
  } else {
    try {
      const judged = judgeDeterministic(turn.transcript, scenario.judging.check, scenario.id);
      entry = {
        id: scenario.id,
        status: 'completed',
        judging: 'deterministic',
        passed: judged.passed,
        evidence: judged.evidence,
      };
    } catch (err) {
      // A throwing check is a scenario-authoring bug — judge/deterministic.ts's
      // own docs say it deliberately never catches this itself. Caught here
      // rather than left to propagate (review finding, all 3 review layers
      // converged on this independently): an authoring bug in one scenario's
      // check must not abort the whole run, skip that scenario's own cleanup,
      // or discard every other scenario's already-computed report entry.
      const message = err instanceof Error ? err.message : String(err);
      log.error('Scenario judging threw', { scenarioId: scenario.id, err });
      entry = {
        id: scenario.id,
        status: 'judge-error',
        judging: 'deterministic',
        passed: false,
        evidence: `check() threw: ${message}`,
      };
    }
  }

  // Cleanup always runs, regardless of verdict or turn status — a
  // failed/timed-out turn may still have created a real event. Caught,
  // logged loud, and recorded — never thrown out of this function.
  if (scenario.cleanup) {
    try {
      const cleanupTurn = await runScenarioTurn(scenario.agentGroupId, threadId, scenario.cleanup.message);
      if (cleanupTurn.status !== 'completed' || !scenario.cleanup.confirm(cleanupTurn.transcript)) {
        throw new Error(`cleanup follow-up did not confirm success (turn status: ${cleanupTurn.status})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Scenario cleanup failed', { scenarioId: scenario.id, err });
      entry.cleanupError = message;
    }
  }

  return entry;
}

function printSummaryLine(entry: ScenarioReportEntry): void {
  const verdict = entry.passed ? 'PASS' : 'FAIL';
  const cleanupNote = entry.cleanupError ? ` (cleanup FAILED: ${entry.cleanupError})` : '';
  console.log(`[${verdict}] ${entry.id} — status=${entry.status} judging=${entry.judging}${cleanupNote}`);
}

/**
 * Drives one full `pnpm eval run <scenario-set-name>` invocation end to end.
 * Exported (rather than only reachable via the bottom-of-file main-module
 * guard) so `cli.test.ts` can call it directly with `runner.ts`/
 * `judge/deterministic.ts` mocked — no real container spawn in that test
 * file.
 *
 * Sets `process.exitCode` from the aggregate pass/fail (a run with zero
 * scenarios, or any scenario not `passed: true`, exits non-zero) — never
 * calls `process.exit()` itself, so a caller (or a test) always sees the
 * function actually return. Returns the finished `Report` (already written
 * to disk by the time this resolves) so a test can assert on it directly
 * instead of re-reading the file it just wrote.
 */
export async function runCli(argv: string[]): Promise<Report> {
  const { scenarioSetName } = parseArgs(argv);

  let report: Report;
  try {
    report = await withEvalLock(async (): Promise<Report> => {
      bootstrapDb();
      const group = ensureEvalScenarioGroup();
      // Provisioned unconditionally, even for a scenario set with zero
      // llmJudge scenarios — idempotent, cheap, matches this file's existing
      // "provision everything up front" pattern (mirrors ensureEvalScenarioGroup
      // just above).
      const judgeGroup = ensureEvalJudgeGroup();
      const scenarioSet = loadScenarios(scenarioSetName, group.id);

      const startedAt = new Date().toISOString();
      const entries: ScenarioReportEntry[] = [];
      try {
        for (const scenario of scenarioSet.scenarios) {
          const entry = await runOneScenario(scenario, judgeGroup.id);
          printSummaryLine(entry);
          entries.push(entry);
        }
      } catch (err) {
        // A structural (AD-4) failure out of runOneScenario/runScenarioTurn
        // itself — spawn failure, malformed opts — used to propagate straight
        // out of this loop uncaught: writeReport never ran, so scenarios
        // after the one that threw were silently never attempted with no
        // diagnostic trail at all, indistinguishable from the run never
        // having been invoked. Write a partial report (every entry computed
        // so far, plus `aborted: true`/`abortError`) before rethrowing, so an
        // operator has something to look at instead of nothing.
        const abortedAt = new Date().toISOString();
        const message = err instanceof Error ? err.message : String(err);
        const partial: Report = {
          runId: makeRunId(),
          scenarioSetName: scenarioSet.name,
          startedAt,
          finishedAt: abortedAt,
          entries,
          aborted: true,
          abortError: message,
        };
        const reportPath = writeReport(partial);
        console.error(`eval: scenario loop aborted by a structural failure — partial report written to ${reportPath}`);
        throw err;
      }
      const finishedAt = new Date().toISOString();

      const passedCount = entries.filter((e) => e.passed).length;
      const cleanupFailureCount = entries.filter((e) => e.cleanupError).length;
      console.log(
        `${passedCount}/${entries.length} passed` +
          (cleanupFailureCount ? `, ${cleanupFailureCount} cleanup failure(s)` : ''),
      );

      const built: Report = {
        runId: makeRunId(),
        scenarioSetName: scenarioSet.name,
        startedAt,
        finishedAt,
        entries,
      };
      const reportPath = writeReport(built);
      console.log(`Report written to ${reportPath}`);
      return built;
    }, { staleMs: RUN_LOCK_STALE_MS });
  } finally {
    // Every eval container this invocation spawned (scenario + judge groups
    // alike) is torn down before the process exits, regardless of outcome —
    // eval containers have no idle-timeout/decommission path of their own
    // (host-sweep deliberately excludes them, AD-6), so leaving one running
    // past this invocation is what let two separate `pnpm eval` runs end up
    // with two real containers polling the identical session DB concurrently
    // (found live, 2026-08-24). See killAllActiveContainers's own doc for why
    // this is safe only because this process's activeContainers map can only
    // ever contain containers this same invocation itself spawned.
    killAllActiveContainers('eval run complete', EVAL_CLI_ONESHOT_TOKEN);
  }

  const allPassed = report.entries.length > 0 && report.entries.every((e) => e.passed);
  const anyCleanupFailed = report.entries.some((e) => e.cleanupError);
  // A distinct exit code for "every verdict passed, but at least one
  // scenario's cleanup didn't confirm success" (deferred-work.md finding) —
  // an operator scripting on exit code alone previously had no way to tell
  // this apart from a fully-clean run; `2` is deliberately never returned for
  // an actual verdict failure (that's still `1`), so a caller checking
  // `=== 0` for "fully clean" or `!== 0` for "something to look at" both
  // still work unchanged.
  process.exitCode = !allPassed ? 1 : anyCleanupFailed ? 2 : 0;
  return report;
}

/**
 * `pnpm eval prune` — deletes every eval-managed session (DB row + on-disk
 * dir) for the eval/eval-judge groups, keeping the groups themselves
 * provisioned. See `teardown.ts`'s own docstring for the full reasoning.
 * Always exits 0 — this isn't a pass/fail verdict the way `run` is, only a
 * summary of what got cleaned up (and what was skipped, if anything).
 */
async function runPrune(): Promise<PruneResult> {
  const result = await pruneEvalSessions();
  console.log(
    `Pruned ${result.removedSessions} eval session(s).` +
      (result.skippedRunning.length > 0 ? ` Skipped ${result.skippedRunning.length} still-running session(s).` : ''),
  );
  process.exitCode = 0;
  return result;
}

/**
 * `pnpm eval teardown` — `runPrune`'s own work, plus deletes the
 * eval/eval-judge agent groups themselves (workspace + DB rows). See
 * `teardown.ts`'s own docstring for why this is safe/recoverable, not a
 * one-way door. Always exits 0, same reasoning as `runPrune`.
 */
async function runTeardown(): Promise<DecommissionResult> {
  const result = await decommissionEvalHarness();
  console.log(
    `Decommissioned ${result.removedGroups.length} eval group(s) (${result.removedGroups.join(', ') || 'none'}), ` +
      `removed ${result.removedSessions} session(s).` +
      (result.skippedRunning.length > 0 ? ` Skipped ${result.skippedRunning.length} still-running session(s).` : ''),
  );
  process.exitCode = 0;
  return result;
}

/**
 * Top-level subcommand dispatcher (Story 3.1, extended for `prune`/
 * `teardown` — deferred-work.md's own "adding a subcommand is a scope
 * decision for a future story, not a review-cycle patch" note, made now
 * deliberately rather than under review-time pressure). Recognizes four
 * subcommands: `run` (delegates the full, unmodified `argv` to `runCli`,
 * which does its own scenario-set-name parsing/validation), `sweep`
 * (delegates to `runSweep()`), `prune` and `teardown` (delegate to
 * `runPrune()`/`runTeardown()` above) — the latter three all take no
 * arguments, a trailing extra argument is a usage error, same strictness
 * `run`'s own `parseArgs` already applies. Anything else — an unknown
 * subcommand, or no subcommand at all — is one clear, combined usage error
 * naming all four, thrown before any handler runs so a bad invocation never
 * touches a lock, a session, or a container.
 *
 * Declared `async` deliberately (review finding, converged across all 3
 * review layers): a plain function's own `throw` below is a *synchronous*
 * throw, not a promise rejection — the real CLI entry point at the bottom
 * of this file calls `dispatchEvalCli(argv).catch(...)`, and a synchronous
 * throw happens while evaluating that call expression, before `.catch` is
 * even attached, so it would have crashed as a raw uncaught exception
 * instead of the clean `eval: <message>` handling every other error path
 * in this file gets. `async` makes every throw in this function body
 * uniformly become a rejection, the same guarantee `runCli`'s own
 * `async` declaration already provides for `parseArgs`'s throw.
 *
 * Exported for `cli.test.ts`'s own direct coverage of the dispatch routing,
 * same reasoning as `runOneScenario` above.
 */
export async function dispatchEvalCli(argv: string[]): Promise<Report | SweepResult | PruneResult | DecommissionResult> {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'run') return runCli(argv);
  if (subcommand === 'sweep') {
    if (rest.length > 0) throw new Error(`Usage: pnpm eval sweep. Got: ${JSON.stringify(argv)}`);
    return runSweep();
  }
  if (subcommand === 'prune') {
    if (rest.length > 0) throw new Error(`Usage: pnpm eval prune. Got: ${JSON.stringify(argv)}`);
    return runPrune();
  }
  if (subcommand === 'teardown') {
    if (rest.length > 0) throw new Error(`Usage: pnpm eval teardown. Got: ${JSON.stringify(argv)}`);
    return runTeardown();
  }
  throw new Error(
    `Usage: pnpm eval run <scenario-set-name> | pnpm eval sweep | pnpm eval prune | pnpm eval teardown. Got: ${JSON.stringify(argv)}`,
  );
}

// CLI entry point — only runs when this file is executed directly (`tsx
// eval/cli.ts`, via the "eval" package.json script), not when imported by
// tests or other eval/ modules.
if (import.meta.url === `file://${process.argv[1]}`) {
  // runCli's own `finally` (see above) does NOT run when Node exits on an
  // unhandled SIGINT/SIGTERM — an operator hitting Ctrl-C mid-run (the
  // normal way to interrupt a real multi-minute eval run) bypasses it
  // entirely, reopening the exact incident killAllActiveContainers itself
  // was written to fix (two real containers left running concurrently
  // against the same session DB, found live 2026-08-24). These handlers are
  // the structural backstop, covering both `run` and `sweep` (this single
  // process entry point is the only place either subcommand actually runs
  // from — sweep.ts's own runSweep() carries an identical pair for the case
  // where it's invoked directly, outside this process entry).
  const handleInterrupt = (signal: 'SIGINT' | 'SIGTERM'): void => {
    console.error(`eval: received ${signal} — tearing down eval containers before exit`);
    killAllActiveContainers(`eval run interrupted (${signal})`, EVAL_CLI_ONESHOT_TOKEN);
    // process.exit() below does not drain pending promises, so withEvalLock's
    // own release logic (inside the in-flight runCli call, if any) never
    // runs — release it here explicitly, synchronously, before exiting, so a
    // later invocation isn't left waiting out RUN_LOCK_STALE_MS for a
    // process that is already gone.
    releaseEvalLockIfOwned();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => handleInterrupt('SIGINT'));
  process.on('SIGTERM', () => handleInterrupt('SIGTERM'));

  dispatchEvalCli(process.argv.slice(2)).catch((err) => {
    console.error(`eval: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
