/**
 * Idempotent creation of the isolated eval agent group(s).
 *
 * Mirrors `src/cli/resources/groups.ts`'s `create` handler exactly — same
 * getAgentGroupByFolder → createAgentGroup + initGroupFilesystem shape, just
 * without the CLI's --template branch (eval groups are never stamped from a
 * template). `eval/` mirrors `scripts/`: imports host modules directly,
 * runs via `tsx`, has no separate package.json.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { CALENDAR_ID_RE, type AdditionalMountConfig } from '../src/container-config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { getContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { readEnvFile } from '../src/env.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup } from '../src/types.js';

/**
 * Idempotent on `folder`. Returns the existing group (re-running
 * `initGroupFilesystem` defensively — repairs a missing workspace) or
 * creates + provisions a new one.
 */
export function ensureAgentGroup(folder: string, name: string): AgentGroup {
  const existing = getAgentGroupByFolder(folder);
  if (existing) {
    initGroupFilesystem(existing);
    return existing;
  }
  const id = `ag-${randomUUID()}`;
  const group: AgentGroup = { id, name, folder, agent_provider: null, created_at: new Date().toISOString() };
  createAgentGroup(group);
  initGroupFilesystem(group);
  return group;
}

/**
 * The dedicated, isolated agent group that eval scenario turns run in.
 *
 * See the sibling `ensureEvalJudgeGroup()` below (folder `eval-judge`) —
 * structurally distinct from this group (AD-3).
 */
export function ensureEvalScenarioGroup(): AgentGroup {
  const group = ensureAgentGroup('eval', 'Eval Harness (Scenario)');
  ensureEvalCalendarOverride(group.id);
  ensureEvalPeopleMount(group.id);
  return group;
}

/**
 * Registers a `calendar_registry` override so a scenario resolving "uriel"
 * lands on the dedicated eval test calendar, never Uriel's real calendar
 * (AD-4: loud failure, not silent skip, when isolation can't be confirmed).
 *
 * Mirrors `src/cli/resources/groups.ts`'s `config add-calendar` handler body
 * exactly, minus the CLI arg parsing — reads the id from `.env`/`process.env`
 * instead of `--calendar-id`.
 */
export function ensureEvalCalendarOverride(agentGroupId: string): void {
  const calendarId = (
    process.env.EVAL_TEST_CALENDAR_ID || readEnvFile(['EVAL_TEST_CALENDAR_ID']).EVAL_TEST_CALENDAR_ID
  )?.trim();
  if (!calendarId) {
    throw new Error(
      'EVAL_TEST_CALENDAR_ID is not set — the eval harness needs a dedicated Google Calendar, isolated from ' +
        'Uriel\'s real calendar, so a scenario resolving "uriel" never touches real events. Manual setup: ' +
        'create a dedicated Google Calendar, share it with the connected OneCLI account, then set ' +
        'EVAL_TEST_CALENDAR_ID in .env (or process.env) to its calendar id.',
    );
  }
  if (!CALENDAR_ID_RE.test(calendarId)) {
    throw new Error(
      `EVAL_TEST_CALENDAR_ID "${calendarId}" doesn't look like a real Google Calendar id — expected "primary" or ` +
        'an email-shaped id (e.g. "user@gmail.com" or "...@group.calendar.google.com")',
    );
  }

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`No container config for group: ${agentGroupId}`);

  const registry = JSON.parse(row.calendar_registry) as Array<{ name: string; calendarId: string }>;
  const filtered = registry.filter((e) => e.name !== 'uriel');
  filtered.push({ name: 'uriel', calendarId });
  updateContainerConfigJson(agentGroupId, 'calendar_registry', filtered);
}

/**
 * Read-only-mounts household's real `people.md` into the eval group at the
 * exact `hostPath`/`containerPath` triple already live on
 * `dm-with-uriel`/`dm-with-partner` (verified against the real DB) and
 * already present in `~/.config/nanoclaw/mount-allowlist.json` — no
 * allowlist change needed. Gives the eval group guest-resolution ground
 * truth (household member names → real people) without which a scenario has
 * no memory to resolve a guest name against.
 *
 * Mirrors `src/cli/resources/groups.ts`'s `config add-mount` handler body
 * exactly, minus the CLI arg parsing.
 */
export function ensureEvalPeopleMount(agentGroupId: string): void {
  const hostPath = path.join(GROUPS_DIR, 'household', 'memory', 'household', 'people.md');
  const containerPath = 'household-shared/people.md';

  // Fail loud, not silent: a missing/renamed source file would otherwise
  // produce a mount config that only breaks much later, at container spawn
  // (and possibly masked further by a mount-security allowlist rejection) —
  // AD-4's "loud failure, not silent skip" stance applies here too, since a
  // silently-empty guest-resolution mount defeats the whole point of this
  // scenario domain.
  if (!fs.existsSync(hostPath)) {
    throw new Error(
      `ensureEvalPeopleMount: expected household's people.md at "${hostPath}" but it doesn't exist — ` +
        'the eval group would otherwise get a mount config pointing at nothing.',
    );
  }

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`No container config for group: ${agentGroupId}`);

  const mount: AdditionalMountConfig = { hostPath, containerPath, readonly: true };
  const existing = JSON.parse(row.additional_mounts) as AdditionalMountConfig[];
  if (!existing.some((m) => m.hostPath === hostPath && m.containerPath === containerPath)) {
    existing.push(mount);
    updateContainerConfigJson(agentGroupId, 'additional_mounts', existing);
  }
}

/**
 * The dedicated, isolated agent group that eval judge turns will run in
 * (Story 2.2 adds the actual judge session/spawn logic — this story only
 * provisions the group itself).
 *
 * Structurally separate from `ensureEvalScenarioGroup()`'s group (AD-3 in
 * the eval-harness architecture spine — a different AD-3 exists in the
 * Google-Calendar epic's own spine, unrelated: a judge bug must never touch
 * the scenario's own session/group state). No calendar override, no
 * `people.md` mount — the judge is only meant to read a transcript and a
 * rubric, never Calendar or guest data.
 */
export function ensureEvalJudgeGroup(): AgentGroup {
  return ensureAgentGroup('eval-judge', 'Eval Harness (Judge)');
}

/**
 * Central-DB bootstrap for standalone execution, matching
 * scripts/init-first-agent.ts. Exported — Story 1.7's `cli.ts` reuses this
 * exact path rather than a second DB-init implementation.
 */
export function bootstrapDb(): void {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent
}

// CLI entry point — only runs when this file is executed directly (`tsx
// eval/setup.ts`), not when imported by tests or other eval/ modules.
if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrapDb();
  const scenarioGroup = ensureEvalScenarioGroup();
  console.log(`Eval scenario agent group ready: ${scenarioGroup.id} (${scenarioGroup.folder})`);
  const judgeGroup = ensureEvalJudgeGroup();
  console.log(`Eval judge agent group ready: ${judgeGroup.id} (${judgeGroup.folder})`);
}
