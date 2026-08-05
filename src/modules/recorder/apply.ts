/**
 * Guarded handler bodies for recorder start/stop.
 *
 * Both bodies run negotiator's own run.sh — a fixed binary path, invoked
 * with an argv array (never a shell string), so the two free-text values
 * the agent supplies (them/context) can only ever land as flag VALUES.
 * Runs are short-lived: `run.sh start` backgrounds negotiator via `nohup`
 * and returns in under a second; `run.sh stop` waits for a clean SIGTERM
 * exit (up to ~5s) and then runs negotiator's own summarize.sh
 * synchronously before returning. See ./guard.ts for why this never holds
 * for approval.
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

const execFileAsync = promisify(execFile);

// Overridable for tests; real deployments are both repos checked out as
// siblings under ~/Projects (see hq's and second-brain's own defaults).
const NEGOTIATOR_ROOT = process.env.NEGOTIATOR_ROOT || join(homedir(), 'Projects', 'negotiator');
const SECOND_BRAIN_ROOT = process.env.SECOND_BRAIN_ROOT || join(homedir(), 'Projects', 'second-brain');
const NEGOTIATOR_LOGS_DIR = join(NEGOTIATOR_ROOT, 'logs');

// Homebrew on Apple Silicon lives at /opt/homebrew, which is NOT on
// NanoClaw's launchd job's PATH (/usr/local/bin:/usr/bin:/bin:/Users/uriel/.local/bin
// — confirmed via ~/Library/LaunchAgents/com.nanoclaw-v2-*.plist). run.sh
// backgrounds `node run.js` bare (resolves fine, /usr/local/bin/node is on
// that PATH) which in turn bare-spawns `ffmpeg` three levels down
// (negotiator's capture.js/wav-split.js/devices.js) — NOT on that PATH.
// Every execFileAsync call below passes this widened PATH so the whole
// downstream chain inherits it, without touching the sibling negotiator
// repo. Same class of bug, same fix, as voice-transcription.ts's absolute
// binary paths — see docs/superpowers/specs/2026-08-05-hebrew-voice-transcription-design.md.
const SPAWN_ENV = {
  ...process.env,
  PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin`,
};

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

export async function applyRecorderStart(content: Record<string, unknown>, session: Session): Promise<void> {
  const them = typeof content.them === 'string' && content.them.trim() ? content.them.trim() : 'Other party';
  const context = typeof content.context === 'string' ? content.context.trim() : '';

  if (getRunningRecorderSession()) {
    notifyAgent(
      session,
      "Recorder is already running. Tell the user it's already recording — no need to start it again.",
    );
    return;
  }

  try {
    await execFileAsync(
      join(NEGOTIATOR_ROOT, 'run.sh'),
      ['start', '--', '--lang', 'he', '--them', them, '--context', context],
      { cwd: NEGOTIATOR_ROOT, timeout: 15_000, env: SPAWN_ENV },
    );
  } catch (err) {
    log.error('recorder.start failed', { err });
    notifyAgent(
      session,
      `Recorder failed to start: ${err instanceof Error ? err.message : String(err)}. Tell the user it did NOT start.`,
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

  log.info('Recorder started', { agentGroupId: session.agent_group_id, them, context });
  notifyAgent(session, `Recording started (${describe({ them, context })}). Tell the user it's live.`);
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

  try {
    await execFileAsync(join(NEGOTIATOR_ROOT, 'run.sh'), ['stop'], {
      cwd: NEGOTIATOR_ROOT,
      timeout: 30_000,
      env: SPAWN_ENV,
    });
  } catch (err) {
    log.error('recorder.stop failed', { err });
    notifyAgent(
      session,
      `Recorder stop command failed: ${err instanceof Error ? err.message : String(err)}. It may still be running — check manually.`,
    );
    return;
  }

  markRecorderSessionStopped(running.id, new Date().toISOString(), reason);

  // node dist/bin/... (not `pnpm run ...`) deliberately — no PATH
  // dependency on pnpm being resolvable from wherever the host process's
  // env came from (e.g. launchd), and no dev-toolchain dependency (tsx) at
  // runtime. Requires second-brain to have been built (`pnpm run build`)
  // — see its README's "plain node" invocation note. Re-run that build
  // after any change to second-brain's src/.
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
