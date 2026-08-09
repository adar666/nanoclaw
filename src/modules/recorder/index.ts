/**
 * Recorder module — start/stop negotiator's call-recorder process on the
 * host, scoped to Yulanda (dm-with-uriel) only. See ./guard.ts for why this
 * is auto-allow rather than admin-approval-held, and ./apply.ts for what
 * "allow" actually executes.
 *
 * Registers two guard-wrapped delivery actions (recorder_start,
 * recorder_stop) — neither ever holds (see ./guard.ts's decide, which only
 * ever returns allow or deny), so requestHold is unreachable in normal
 * operation; still required by DeliveryGuardSpec's shape, so it logs loudly
 * and tells the user something's wrong if it's ever somehow invoked (that
 * would mean a decide() regression, not a real approval flow).
 *
 * Also exports sweepRecorderCap, wired into src/host-sweep.ts's per-tick
 * MODULE-HOOK — enforces RECORDER_MAX_DURATION_MS independent of whether
 * the agent ever calls recorder.stop (the requester forgetting "סיימתי"
 * is the expected failure mode, not an edge case).
 *
 * Without this module: the recorder MCP tools in the container still write
 * outbound system messages with these actions, but delivery logs "Unknown
 * system action" and drops them — negotiator never starts.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import {
  applyRecorderStart,
  applyRecorderStop,
  reconciledRunningSession,
  RECORDER_MAX_DURATION_MS,
  stopAndIngest,
} from './apply.js';
import { recorderStart, recorderStop } from './guard.js';

function unreachableHold(action: string) {
  return async (_content: Record<string, unknown>, session: Session): Promise<void> => {
    log.error(`${action}: reached requestHold — decide() should never return hold for this action`, {
      agentGroupId: session.agent_group_id,
    });
    notifyAgent(session, `${action} hit an unexpected approval path and did nothing. This is a bug — tell Uriel.`);
  };
}

registerDeliveryAction('recorder_start', applyRecorderStart, {
  guardAction: recorderStart,
  requestHold: unreachableHold('recorder_start'),
  onDeny: (_content, session, reason) => notifyAgent(session, `Recorder start denied: ${reason}`),
});
registerDeliveryAction('recorder_stop', applyRecorderStop, {
  guardAction: recorderStop,
  requestHold: unreachableHold('recorder_stop'),
  onDeny: (_content, session, reason) => notifyAgent(session, `Recorder stop denied: ${reason}`),
});

/**
 * Host-sweep hook (src/host-sweep.ts's MODULE-HOOK:recorder-cap-sweep).
 * Once per 60s tick: first reconciles the DB's "active" row against
 * call.sh's real process state (apply.ts's reconciledRunningSession) — a
 * stale row left behind by a failed stop self-heals here within about a
 * minute, with no user action required. Only once that's settled does it
 * check RECORDER_MAX_DURATION_MS: if a genuinely-still-running session has
 * been going past the cap, stop it and ingest — same path as an
 * agent-triggered stop, tagged stop_reason='cap' so the notification says
 * what actually happened.
 */
export async function sweepRecorderCap(): Promise<void> {
  const running = await reconciledRunningSession();
  if (!running) return;

  const elapsed = Date.now() - Date.parse(running.started_at);
  if (elapsed < RECORDER_MAX_DURATION_MS) return;

  const session = getSession(running.session_id);
  if (!session) {
    log.error('Recorder cap fired but its owning session no longer exists', { recorderSessionId: running.id });
    return;
  }
  log.warn('Recorder hit max duration — auto-stopping', { recorderSessionId: running.id, elapsedMs: elapsed });
  await stopAndIngest(session, 'cap');
}
