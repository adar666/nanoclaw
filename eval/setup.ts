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
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
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
 * Epic 2 Story 2.1 adds a sibling `ensureEvalJudgeGroup()` (folder
 * `eval-judge`) alongside this one — not built here.
 */
export function ensureEvalScenarioGroup(): AgentGroup {
  return ensureAgentGroup('eval', 'Eval Harness (Scenario)');
}

/** Central-DB bootstrap for standalone execution, matching scripts/init-first-agent.ts. */
function bootstrapDb(): void {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent
}

// CLI entry point — only runs when this file is executed directly (`tsx
// eval/setup.ts`), not when imported by tests or other eval/ modules.
if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrapDb();
  const group = ensureEvalScenarioGroup();
  console.log(`Eval scenario agent group ready: ${group.id} (${group.folder})`);
}
