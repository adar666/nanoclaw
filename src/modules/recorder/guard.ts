/**
 * Recorder guard adapter — start/stop negotiator's call-recorder process on
 * the host, composed at the module edge (imported by ./index.ts).
 *
 * Scoped to exactly one agent group (dm-with-uriel, "Yulanda") — every
 * other agent group is denied outright, never held. Auto-allow (no
 * admin-approval hold, unlike self-mod) is deliberate: the only human who
 * could ever approve this is Uriel himself, on the same Telegram thread
 * that just made the request — a hold here buys no security, only friction
 * at the exact moment (about to join a call) latency matters most. See
 * ./apply.ts for what "allow" actually executes: a fixed binary
 * (negotiator's run.sh) invoked with an argv array, never a shell string —
 * the two free-text values the agent supplies (them/context) can only ever
 * land as flag VALUES, never change which program runs or add commands.
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { ALLOW, DENY, defineGuardedAction, type GuardDecision, type GuardInput } from '../../guard/index.js';

/** The one agent group allowed to control the recorder. Resolved by folder
 *  name at consult time (not a hardcoded id) so a reseeded/migrated DB
 *  doesn't silently lose this wiring. */
const RECORDER_AGENT_GROUP_FOLDER = 'dm-with-uriel';

function isRecorderEnabled(agentGroupId: string | undefined): boolean {
  if (!agentGroupId) return false;
  return getAgentGroupByFolder(RECORDER_AGENT_GROUP_FOLDER)?.id === agentGroupId;
}

function recorderDecide(label: string) {
  return (input: GuardInput): GuardDecision => {
    if (input.actor.kind !== 'agent') return DENY(`${label} is a container-originated action.`);
    if (!isRecorderEnabled(input.actor.agentGroupId)) {
      return DENY(`${label} is not enabled for this agent group`);
    }
    return ALLOW(
      `${label} is a bounded, reversible, single-purpose host action — pre-authorized for this agent group, no per-call approval`,
    );
  };
}

export const recorderStart = defineGuardedAction({
  action: 'recorder.start',
  decide: recorderDecide('recorder.start'),
});

export const recorderStop = defineGuardedAction({
  action: 'recorder.stop',
  decide: recorderDecide('recorder.stop'),
});
