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
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
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

/**
 * The two, and only two, folders `setup.ts`'s `ensureEvalScenarioGroup()`/
 * `ensureEvalJudgeGroup()` ever provision (`ensureAgentGroup('eval', ...)`/
 * `ensureAgentGroup('eval-judge', ...)`) — the stable identifier this check
 * verifies against. A group's own `id` is a `randomUUID()`, unknowable
 * statically, so "verify against the two provisioned eval group ids" cashes
 * out as "resolve those two ids by their well-known folder and check
 * membership," not a hardcoded id literal.
 */
const EVAL_GROUP_FOLDERS = ['eval', 'eval-judge'] as const;

/**
 * `assertNoDestinations` only checks destination *count* — nothing verifies
 * `agentGroupId` is actually one of the two isolated eval groups in the
 * first place. A future caller passing a real, zero-destination production
 * group's id would pass `assertNoDestinations` cleanly and spawn a real turn
 * inside that group's real memory/CLAUDE.md — the exact leak AD-4 exists to
 * prevent, just from a different angle than the destinations check covers.
 *
 * Reads the two provisioned groups by folder (no side effects, never
 * creates them) and checks `agentGroupId` against their ids. AD-4: loud
 * failure, not a silent skip — including when neither eval group has been
 * provisioned yet, which should never be true by the time this runs (every
 * real caller provisions both via `ensureEvalScenarioGroup()`/
 * `ensureEvalJudgeGroup()` earlier in the same `withEvalLock` critical
 * section, before any scenario turn spawns).
 */
export function assertIsEvalGroup(agentGroupId: string): void {
  const knownIds = EVAL_GROUP_FOLDERS.map((folder) => getAgentGroupByFolder(folder)?.id).filter(
    (id): id is string => id != null,
  );
  if (!knownIds.includes(agentGroupId)) {
    throw new Error(
      `assertIsEvalGroup: agent group "${agentGroupId}" is not one of the two provisioned eval groups ` +
        '(folder "eval" or "eval-judge") — refusing to spawn an eval-harness turn inside a group that was never ' +
        "created via ensureEvalScenarioGroup()/ensureEvalJudgeGroup(), even if it currently has zero destinations",
    );
  }
}
