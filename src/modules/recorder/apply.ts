/**
 * Guarded handler bodies for recorder start/stop.
 *
 * Both bodies run negotiator's own call.sh — a fixed binary path, invoked
 * with an argv array (never a shell string), so the free-text values the
 * agent supplies (them/context/project) can only ever land as flag VALUES.
 * call.sh (not run.sh) is the entry point: it starts capture, the notes UI,
 * and notes.js as one orchestrated session, rolls all three back if any
 * fails to become ready (G33), runs a mandatory audio preflight before
 * starting (G45/G46 — BLOCKS on failure; see applyRecorderStart's error
 * path, never pass --skip-preflight automatically), and on `end` refuses
 * to report success for a session that produced no usable transcript
 * (G56 — see stopAndIngest's error path). See ./guard.ts for why this
 * never holds for approval.
 *
 * `stopAndIngest` is shared by the agent-triggered stop (recorder.stop) and
 * host-sweep's cap enforcement (./index.ts's sweepRecorderCap) — same
 * shutdown + ingest chain either way, only the notification wording and
 * the stored `stop_reason` differ.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import {
  createRecorderSession,
  getRunningRecorderSession,
  markRecorderSessionStopped,
  type RecorderSessionRow,
} from './db.js';
import { resolveProjectAlias } from './project-aliases.js';

const execFileAsync = promisify(execFile);

// Overridable for tests; real deployments are both repos checked out as
// siblings under ~/Projects (see hq's and second-brain's own defaults).
const NEGOTIATOR_ROOT = process.env.NEGOTIATOR_ROOT || join(homedir(), 'Projects', 'negotiator');
const SECOND_BRAIN_ROOT = process.env.SECOND_BRAIN_ROOT || join(homedir(), 'Projects', 'second-brain');
const NEGOTIATOR_LOGS_DIR = join(NEGOTIATOR_ROOT, 'logs');

// Homebrew on Apple Silicon lives at /opt/homebrew, which is NOT on
// NanoClaw's launchd job's PATH (/usr/local/bin:/usr/bin:/bin:/Users/uriel/.local/bin
// — confirmed via ~/Library/LaunchAgents/com.nanoclaw-v2-*.plist). call.sh
// backgrounds `node run.js` bare (resolves fine, /usr/local/bin/node is on
// that PATH) which in turn bare-spawns `ffmpeg` three levels down — NOT on
// that PATH. Every execFileAsync call below passes this widened PATH so
// the whole downstream chain inherits it, without touching the sibling
// negotiator repo.
const SPAWN_ENV = {
  ...process.env,
  PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin`,
};

// call.sh orchestrates three processes plus a mandatory preflight — a
// cold start (preflight + capture + ui + notes, each with up to
// NEGOTIATOR_CALL_READY_TIMEOUT_SEC=15s to become ready) can legitimately
// take longer than the old single-process run.sh path's 15s budget.
const CALL_START_TIMEOUT_MS = 60_000;
const CALL_END_TIMEOUT_MS = 60_000;

// 3 hours — a real meeting doesn't run longer than this; anything past it
// is almost certainly a forgotten "סיימתי". Enforced by host-sweep's
// sweepRecorderCap (./index.ts), not a setTimeout — survives a host
// restart mid-recording since it's derived from the DB row's started_at,
// not an in-memory timer.
export const RECORDER_MAX_DURATION_MS = 3 * 60 * 60 * 1000;

function newRecorderSessionId(): string {
  return `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function describe(row: Pick<RecorderSessionRow, 'them' | 'context'>): string {
  return row.context ? `${row.them}, re: ${row.context}` : row.them;
}

/** call.sh start echoes `[call] keyterms: <comma-list-or-<none>>` to
 *  stdout — this is the only way the bridge learns what keyterms a
 *  --project resolution actually produced, since that computation happens
 *  entirely inside call.sh/session-context.js. */
function extractKeyterms(stdout: string): string {
  const m = stdout.match(/^\[call\] keyterms: (.*)$/m);
  if (!m) return '';
  const val = m[1].trim();
  return val === '<none>' ? '' : val;
}

/** session-context.js warns to stderr (never stdout) when a --project dir
 *  doesn't exist on disk — surfaced here so an alias that resolves to a
 *  stale/renamed directory is still visible in the Telegram confirmation. */
function extractProjectWarnings(stderr: string): string[] {
  return (stderr.match(/^\[call\] warning:.*$/gm) ?? []).map((l) => l.replace(/^\[call\] warning:\s*/, ''));
}

function errorDetail(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  const detail = (e.stderr && e.stderr.trim()) || (e.stdout && e.stdout.trim());
  return detail || (err instanceof Error ? err.message : String(err));
}

export async function applyRecorderStart(content: Record<string, unknown>, session: Session): Promise<void> {
  const them = typeof content.them === 'string' && content.them.trim() ? content.them.trim() : 'Other party';
  const context = typeof content.context === 'string' ? content.context.trim() : '';
  const rawProject = typeof content.project === 'string' ? content.project.trim() : '';

  if (getRunningRecorderSession()) {
    notifyAgent(
      session,
      "Recorder is already running. Tell the user it's already recording — no need to start it again.",
    );
    return;
  }

  // call.sh's --topic is required; the tool's existing "one-line
  // topic/subject" field (context) already carries that in the vast
  // majority of cases — but never fail a start over a missing one.
  const topic = context || `Call with ${them}`;

  const { dir: projectDir, warning: projectWarning } = resolveProjectAlias(rawProject);

  const args = ['start', '--topic', topic, '--lang', 'he', '--them', them];
  if (projectDir) args.push('--project', projectDir);

  let result: { stdout: string; stderr: string };
  try {
    result = await execFileAsync(join(NEGOTIATOR_ROOT, 'call.sh'), args, {
      cwd: NEGOTIATOR_ROOT,
      timeout: CALL_START_TIMEOUT_MS,
      env: SPAWN_ENV,
    });
  } catch (err) {
    log.error('recorder.start failed', { err });
    notifyAgent(
      session,
      `Recorder failed to start: ${errorDetail(err)}. Tell the user it did NOT start — this includes a failed audio ` +
        `preflight (the other party would not have been recorded) or a component that never became ready; nothing is running.`,
    );
    return;
  }

  createRecorderSession({
    id: newRecorderSessionId(),
    agent_group_id: session.agent_group_id,
    session_id: session.id,
    them,
    context,
    started_at: new Date().toISOString(),
  });

  const keyterms = extractKeyterms(result.stdout);
  const stderrWarnings = extractProjectWarnings(result.stderr);

  const lines: string[] = [];
  if (rawProject) {
    lines.push(projectDir ? `Project: "${rawProject}" → ${projectDir}` : `Project: ${projectWarning}`);
    lines.push(`Keyterms: ${keyterms || 'none'}`);
  }
  if (stderrWarnings.length) lines.push(...stderrWarnings);
  lines.push(`Recording started (${describe({ them, context })}). UI: http://localhost:8140.`);

  log.info('Recorder started', { agentGroupId: session.agent_group_id, them, context, project: projectDir });
  notifyAgent(session, `${lines.join(' ')} Tell the user it's live and give them the UI link.`);
}

export async function applyRecorderStop(_content: Record<string, unknown>, session: Session): Promise<void> {
  await stopAndIngest(session, 'user');
}

export async function stopAndIngest(session: Session, reason: 'user' | 'cap'): Promise<void> {
  const running = getRunningRecorderSession();
  if (!running) {
    if (reason === 'user') {
      notifyAgent(session, "Recorder is not running. Tell the user there's nothing to stop.");
    }
    return;
  }

  let stopFailed: string | null = null;
  try {
    await execFileAsync(join(NEGOTIATOR_ROOT, 'call.sh'), ['end'], {
      cwd: NEGOTIATOR_ROOT,
      timeout: CALL_END_TIMEOUT_MS,
      env: SPAWN_ENV,
    });
  } catch (err) {
    // call.sh end exits non-zero when the session produced no usable
    // transcript (FATAL abort, or genuinely zero utterances — call.sh's
    // G56 check) as well as on an unexpected shell failure. The processes
    // are stopped either way (call.sh stops them before this check runs),
    // so the DB row below is still marked stopped — but ingest never
    // runs and the confirmation must say so plainly, never "ask about it".
    stopFailed = errorDetail(err);
  }

  markRecorderSessionStopped(running.id, new Date().toISOString(), reason);

  if (stopFailed) {
    log.error('recorder.stop: call.sh end reported a failed session', { err: stopFailed });
    notifyAgent(
      session,
      `Recording stopped, but it did NOT produce a usable transcript — nothing was ingested. ` +
        `Tell the user this plainly, do not say it's ready to ask about:\n\n${stopFailed}`,
    );
    return;
  }

  let ingestSummary: string;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(SECOND_BRAIN_ROOT, 'dist/bin/ingest-recorder.js'), '--dir', NEGOTIATOR_LOGS_DIR],
      { cwd: SECOND_BRAIN_ROOT, timeout: 60_000, env: SPAWN_ENV },
    );
    ingestSummary = stdout.trim().split('\n').filter(Boolean).pop() || 'ingested';
  } catch (err) {
    log.error('recorder stop: ingest into second-brain failed', { err });
    ingestSummary = `ingest into uriel.db FAILED (transcript is safe on disk at ${NEGOTIATOR_LOGS_DIR}) — retry manually: ${err instanceof Error ? err.message : String(err)}`;
  }

  const label = describe(running);
  if (reason === 'cap') {
    const hours = RECORDER_MAX_DURATION_MS / 3_600_000;
    notifyAgent(
      session,
      `Recording auto-stopped after hitting the ${hours}h cap (started ${running.started_at}, ${label}) — looks like "סיימתי" never came. ${ingestSummary}. Tell the user this happened, unprompted — a recording that ended without them asking is something they should know about, not discover later.`,
    );
  } else {
    notifyAgent(
      session,
      `Recording stopped (${label}). ${ingestSummary}. Tell the user it's done and ready to ask about.`,
    );
  }
}
