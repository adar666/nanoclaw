/**
 * Standalone stale-event sweep (Epic 3, Story 3.1).
 *
 * A scenario's own per-run `cleanup` (Epic 1/2) only fires on a clean
 * exit — a crashed or interrupted run can leave a real event behind on the
 * eval-test calendar indefinitely, with nothing to find or remove it. This
 * module reuses the exact same "host never touches Calendar directly"
 * pattern Story 1.7's cleanup already established: it sends a real message
 * to the scenario agent group's own container (the one with the eval-test
 * calendar override, Story 1.2) instructing it to find and delete every
 * event on its own calendar, then parses a fixed-format reply for what was
 * removed.
 *
 * Runs entirely inside `withEvalLock` (AD-8, `lock.ts` reused unmodified) —
 * the whole operation (group provisioning + the sweep turn) is one locked
 * critical section, same shape as `cli.ts`'s own `runCli`. `bootstrapDb()`
 * runs first, same as `runCli`, so a standalone `pnpm eval sweep` invocation
 * (which never goes through `runCli`'s own DB bootstrap) still works against
 * an initialized central DB.
 */
import type { OutboundMessage } from '../src/db/session-db.js';
import { log } from '../src/log.js';
import { truncateForError } from './error-text.js';
import { withEvalLock } from './lock.js';
import { runScenarioTurn } from './runner.js';
import { EVAL_THREAD_PREFIX } from './session.js';
import { bootstrapDb, ensureEvalScenarioGroup } from './setup.js';
import { findTrailingMatch } from './text-matching.js';

export interface SweepResult {
  removedCount: number;
  agentReplyText: string;
}

/** Distinct from any scenario's own thread id (`${EVAL_THREAD_PREFIX}:<scenario-id>`) and from the judge's (`${EVAL_THREAD_PREFIX}:judge:<scenario-id>`). */
const SWEEP_THREAD_ID = `${EVAL_THREAD_PREFIX}:sweep`;

const SWEEP_PROMPT = [
  'List every event on your calendar, then delete each one you find — leave nothing behind.',
  '',
  'Reply with your final answer as exactly one line, and nothing else after it:',
  'a line reading "SWEEP: REMOVED <n>" (where <n> is the number of events you deleted) if you deleted one or ' +
    'more, or a line reading "SWEEP: CLEAN" if there was nothing to delete (state only your actual outcome — ' +
    'write one of these two lines, never both).',
].join('\n');

/**
 * Case-insensitive, global — matched via `findTrailingMatch`
 * (`text-matching.ts`), which selects the last occurrence that starts a
 * sentence — never embedded mid-sentence/mid-clause — rather than merely the
 * chronologically last occurrence anywhere in the reply. That distinction
 * matters because the prompt's own instruction text mentions both forms,
 * which an agent can echo before its real answer — or quote while
 * *explaining a refusal* (embedded in the surrounding sentence). Only the
 * former should be forgiven.
 */
const SWEEP_PATTERN = /\bSWEEP:\s*(REMOVED\s+(\d+)|CLEAN)\b/gi;

/** Every `messages_out` row's `content.text`, joined — the same parse-or-skip-malformed-rows shape `judge/llm.ts` and `guest-resolution.scenarios.ts` both use. */
function transcriptText(transcript: OutboundMessage[]): string {
  return transcript
    .map((m) => {
      try {
        const parsed = JSON.parse(m.content) as { text?: unknown };
        return typeof parsed.text === 'string' ? parsed.text : '';
      } catch {
        return '';
      }
    })
    .join('\n');
}

/**
 * Parses `replyText` for the last `SWEEP: REMOVED <n>` or `SWEEP: CLEAN`
 * occurrence that starts a sentence (`findTrailingMatch`), returning the
 * removed count (`0` for `CLEAN`). Throws, naming what was expected and what
 * was actually received (truncated), when no qualifying match exists —
 * including when neither pattern matches at all, or when the agent quoted
 * the format mid-sentence while explaining a refusal — or when a matched
 * `<n>` isn't a plausible count (`\d+` alone doesn't bound magnitude — an
 * absurdly long digit string would lose precision or overflow through
 * `Number()` silently).
 */
function parseSweepReply(replyText: string): number {
  const last = findTrailingMatch(replyText, SWEEP_PATTERN);
  if (!last) {
    throw new Error(
      `runSweep: could not parse the agent's reply — expected a line matching "SWEEP: REMOVED <n>" or ` +
        `"SWEEP: CLEAN", got: ${JSON.stringify(truncateForError(replyText))}`,
    );
  }
  if (/^CLEAN$/i.test(last[1])) return 0;
  const n = Number(last[2]);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`runSweep: implausible removed count in the agent's reply: ${JSON.stringify(last[2])}`);
  }
  return n;
}

/**
 * Finds and removes every event on the eval-test calendar via a real turn
 * against the scenario agent group's own container, and reports what was
 * removed.
 *
 * Throws (never reports `removedCount: 0` for an outcome it couldn't
 * actually verify) when:
 * - the sweep turn doesn't reach `'completed'` — the thrown message names
 *   the actual status;
 * - the reply can't be parsed into either `SWEEP: REMOVED <n>` or
 *   `SWEEP: CLEAN` — the thrown message names what was expected and what was
 *   actually received (truncated).
 */
export async function runSweep(): Promise<SweepResult> {
  return withEvalLock(async (): Promise<SweepResult> => {
    bootstrapDb();
    const group = ensureEvalScenarioGroup();

    const turn = await runScenarioTurn(group.id, SWEEP_THREAD_ID, SWEEP_PROMPT);
    if (turn.status !== 'completed') {
      const message =
        `runSweep: sweep turn did not complete — expected status "completed", got "${turn.status}" ` +
        `(session ${turn.sessionId}); refusing to report a result for an unverified outcome`;
      log.error('Eval sweep turn did not complete', { status: turn.status, sessionId: turn.sessionId });
      throw new Error(message);
    }

    const agentReplyText = transcriptText(turn.transcript);
    let removedCount: number;
    try {
      removedCount = parseSweepReply(agentReplyText);
    } catch (err) {
      log.error('Eval sweep reply unparseable', { err });
      throw err;
    }

    console.log(
      removedCount > 0 ? `Sweep removed ${removedCount} event(s).` : 'Sweep found nothing to remove (already clean).',
    );
    console.log(`Agent reply:\n${truncateForError(agentReplyText)}`);
    log.info('Eval sweep completed', { removedCount, agentGroupId: group.id });

    return { removedCount, agentReplyText };
  });
}
