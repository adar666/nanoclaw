/**
 * On-demand pruning/decommissioning for eval-harness state (deferred-work.md
 * finding — "no teardown/pruning story for eval sessions... extends
 * indefinitely" / "no decommission/teardown path... for the eval agent
 * group itself, only creation"). Every real scenario run reuses the SAME
 * deterministic thread id per scenario (`resolveEvalSession`'s
 * `findSystemSession` lookup, `system:eval:<scenario.id>` etc.), so session
 * *count* doesn't grow per-run — but each reused session's own
 * inbound.db/outbound.db accumulates every turn's messages forever, and a
 * scenario id that's ever retired leaves its session (DB row + on-disk
 * `data/v2-sessions/` dir) as pure dead weight nothing else ever reclaims.
 * Two operations here, two different blast radii:
 *
 * - `pruneEvalSessions()`: deletes every eval-managed session for the eval/
 *   eval-judge groups, but keeps the groups themselves — `pnpm eval run`/
 *   `sweep` work immediately again on the next invocation
 *   (`ensureEvalScenarioGroup`/`ensureEvalJudgeGroup` are idempotent no-ops
 *   against an already-provisioned group). The lighter, safer default: reset
 *   accumulated conversation state without touching provisioning.
 * - `decommissionEvalHarness()`: the above, plus deletes the eval/
 *   eval-judge `agent_groups` rows (`container_configs` cascades via its own
 *   `ON DELETE CASCADE`) and their workspace directories under `groups/` —
 *   a full reset. Still safe/recoverable, not a one-way door: both groups
 *   are disposable, deterministically-named infrastructure that
 *   `ensureEvalScenarioGroup()`/`ensureEvalJudgeGroup()` recreate from
 *   scratch on the very next `pnpm eval run`/`sweep` call. The only thing
 *   genuinely lost is accumulated memory/conversation state inside the eval
 *   group's own workspace — expected and desirable to reset, not data
 *   anyone depends on keeping.
 *
 * Both run inside `withEvalLock` — the same exclusivity `cli.ts`'s `runCli`/
 * `sweep.ts`'s `runSweep` use — so neither can race a concurrently-running
 * `pnpm eval run`/`sweep` invocation that might be actively writing to the
 * very session dirs being removed.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../src/config.js';
import { isContainerRunning } from '../src/container-runner.js';
import { deleteAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { deleteSession, getSessionsByAgentGroup } from '../src/db/sessions.js';
import { log } from '../src/log.js';
import { sessionDir } from '../src/session-manager.js';
import { withEvalLock } from './lock.js';
import { EVAL_MANAGED_BY } from './session.js';
import { bootstrapDb } from './setup.js';

/**
 * The two, and only two, folders this harness ever provisions — same
 * well-known-folder resolution `safety.ts`'s `assertIsEvalGroup` already
 * uses, so a destructive operation like this one only ever touches a group
 * it can positively identify as its own, never anything reached by a
 * caller-supplied id.
 */
const EVAL_GROUP_FOLDERS = ['eval', 'eval-judge'] as const;

export interface PruneResult {
  removedSessions: number;
  /** Session ids left alone because a container for them is currently marked running. */
  skippedRunning: string[];
}

function pruneSessionsForGroup(agentGroupId: string): { removed: number; skipped: string[] } {
  let removed = 0;
  const skipped: string[] = [];
  const sessions = getSessionsByAgentGroup(agentGroupId).filter((s) => s.managed_by === EVAL_MANAGED_BY);
  for (const session of sessions) {
    // A defensive check, not the real safety mechanism (withEvalLock's own
    // exclusivity is) — isContainerRunning's activeContainers map is
    // host-process-local, so it can only ever reflect a container THIS
    // same one-shot eval-CLI process spawned, never one a concurrent
    // invocation owns (that's what withEvalLock actually prevents). Kept
    // anyway: cheap, and closes the narrow same-process edge case where a
    // caller invoked prune/decommission mid-way through its own run.
    if (isContainerRunning(session.id)) {
      skipped.push(session.id);
      continue;
    }
    deleteSession(session.id);
    try {
      fs.rmSync(sessionDir(agentGroupId, session.id), { recursive: true, force: true });
    } catch (e) {
      log.warn('eval/teardown: failed to remove session dir', { sessionId: session.id, err: e });
    }
    removed++;
  }
  return { removed, skipped };
}

/**
 * Deletes every eval-managed session (DB row + on-disk dir) for the eval/
 * eval-judge groups. A group that was never provisioned (`getAgentGroupByFolder`
 * returns nothing) is silently skipped — nothing to prune.
 */
export async function pruneEvalSessions(): Promise<PruneResult> {
  return withEvalLock(() => {
    // Same reasoning as runCli's/runSweep's own first line: a standalone
    // `pnpm eval prune` may be the very first eval-harness invocation
    // against a fresh install, with no DB initialized/migrated yet.
    // Idempotent, cheap to call even when it isn't.
    bootstrapDb();
    let removedSessions = 0;
    const skippedRunning: string[] = [];
    for (const folder of EVAL_GROUP_FOLDERS) {
      const group = getAgentGroupByFolder(folder);
      if (!group) continue;
      const { removed, skipped } = pruneSessionsForGroup(group.id);
      removedSessions += removed;
      skippedRunning.push(...skipped);
    }
    log.info('eval prune completed', { removedSessions, skippedRunning: skippedRunning.length });
    return { removedSessions, skippedRunning };
  });
}

export interface DecommissionResult extends PruneResult {
  /** Folders actually removed — a folder can be skipped (see PruneResult.skippedRunning). */
  removedGroups: string[];
}

/**
 * Full reset: `pruneEvalSessions`'s own work, plus deletes the eval/
 * eval-judge `agent_groups` rows and their workspace directories.
 *
 * Sessions must be deleted BEFORE the group row — `sessions.agent_group_id`
 * has no `ON DELETE CASCADE` (migration 001), so a group with lingering
 * session rows would fail the FK check (`foreign_keys = ON` in this
 * codebase, `connection.ts`). A group whose sessions were skipped (a
 * container still marked running) is itself skipped too, for the same
 * reason this file never partially decommissions a group still in active
 * use — an operator re-running this once the run finishes will pick up
 * cleanly where it left off.
 */
export async function decommissionEvalHarness(): Promise<DecommissionResult> {
  return withEvalLock(() => {
    bootstrapDb(); // see pruneEvalSessions's identical first line for why
    let removedSessions = 0;
    const skippedRunning: string[] = [];
    const removedGroups: string[] = [];

    for (const folder of EVAL_GROUP_FOLDERS) {
      const group = getAgentGroupByFolder(folder);
      if (!group) continue;

      const { removed, skipped } = pruneSessionsForGroup(group.id);
      removedSessions += removed;
      if (skipped.length > 0) {
        skippedRunning.push(...skipped);
        log.warn('eval/teardown: leaving group provisioned — a session container for it is still running', {
          folder,
          skipped,
        });
        continue;
      }

      deleteAgentGroup(group.id); // container_configs cascades (ON DELETE CASCADE)
      try {
        fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
      } catch (e) {
        log.warn('eval/teardown: failed to remove group workspace dir', { folder, err: e });
      }
      removedGroups.push(folder);
    }

    log.info('eval decommission completed', {
      removedSessions,
      removedGroups,
      skippedRunning: skippedRunning.length,
    });
    return { removedSessions, skippedRunning, removedGroups };
  });
}
