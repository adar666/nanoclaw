/**
 * The one eval safety check that construction *can't* close.
 *
 * `resolveEvalSession` hardcodes `messaging_group_id: null` at creation
 * time, but destinations (`agent_destinations`) are a separate table that
 * unrelated code (`ncl destinations add`, agent-to-agent wiring, self-mod)
 * can populate at any later point in an eval agent group's lifetime. Any
 * future spawn-path code (Story 1.4) must call this immediately before
 * spawning a container for an eval session — AD-4: loud failure, not a
 * silent skip.
 */
import { getDestinations } from '../src/modules/agent-to-agent/db/agent-destinations.js';

export function assertNoDestinations(agentGroupId: string): void {
  const destinations = getDestinations(agentGroupId);
  if (destinations.length > 0) {
    const noun = destinations.length === 1 ? 'destination' : 'destinations';
    throw new Error(
      `assertNoDestinations: agent group "${agentGroupId}" has ${destinations.length} ${noun} — ` +
        'the eval harness requires zero destinations so a scenario session structurally cannot leak a reply into a live chat',
    );
  }
}
