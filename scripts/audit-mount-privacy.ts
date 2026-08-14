#!/usr/bin/env node
/**
 * Audit every agent group's `additionalMounts` for a cross-tenant privacy
 * leak: a mount that exposes another person's private second-brain tenant
 * DB (`<name>.db`) to a group that isn't that person's own DM.
 *
 * Why this exists (not a code-level guard): `validateAdditionalMounts`
 * (src/modules/mount-security/index.ts) is a generic secrets/system-path
 * blocklist (.ssh, .aws, credentials, etc.) — it has no idea what a
 * "tenant" is, so it would happily allow a group's additionalMounts to be
 * misconfigured to include someone else's private DB. The household
 * group's actual protection today is that its `additionalMounts` config
 * happens to name the single `household.db` file rather than the
 * containing directory or another tenant's file — a data fact, not a
 * code guarantee. This script is the regression net for that data fact:
 * run it after any change to container_configs (a `ncl groups config
 * update`, a migration, manual DB surgery) to catch a misconfiguration
 * before it ships to a live container.
 *
 * Heuristic (install-agnostic, not hardcoded to any one group/tenant):
 *   - A mount hostPath matching `<something>.db` inside a directory that
 *     also contains sibling `<other-name>.db` files (the second-brain
 *     per-tenant pattern: uriel.db, partner.db, household.db side by side)
 *     is flagged UNLESS the mounted file's basename is `household.db`
 *     (the intentionally shared/projected file) or matches this group's
 *     own DM identity (best-effort: folder name containing the person's
 *     name fragment).
 *   - This is a heuristic, not a proof — it flags for human review, it
 *     does not silently "fix" anything, and a false positive is expected
 *     and fine (better to ask than to miss a real leak).
 *
 * Usage: pnpm exec tsx scripts/audit-mount-privacy.ts [path/to/v2.db]
 * Exit code: 0 = clean, 1 = findings (for optional CI/pre-commit use).
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export interface AgentGroupRow {
  id: string;
  name: string;
  folder: string;
}
export interface ContainerConfigRow {
  agent_group_id: string;
  additional_mounts: string | null;
}
export interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;
}
export interface Finding {
  groupName: string;
  groupFolder: string;
  hostPath: string;
  siblings: string[];
}

/**
 * Pure decision function: given one group and one of its mounts, plus the
 * sibling `.db` filenames found in that mount's directory, decide whether
 * this looks like a cross-tenant leak. No filesystem or DB access — easy
 * to test with fabricated inputs.
 */
export function isSuspiciousTenantMount(group: AgentGroupRow, mount: AdditionalMount, siblingDbFiles: string[]): boolean {
  const base = path.basename(mount.hostPath);
  if (!base.endsWith('.db')) return false;
  if (base === 'household.db') return false; // intentionally shared
  if (siblingDbFiles.filter((f) => f !== base).length === 0) return false; // no evidence of a multi-tenant directory

  const tenantName = base.replace(/\.db$/, '');
  const looksLikeOwnTenant = group.folder.toLowerCase().includes(tenantName.toLowerCase());
  return !looksLikeOwnTenant;
}

/** Reads real DB rows + real sibling directory listings, applies the pure decision function above. */
export function findMountPrivacyIssues(dbPath: string): Finding[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const groups = db.prepare('SELECT id, name, folder FROM agent_groups').all() as AgentGroupRow[];
    const configs = db
      .prepare('SELECT agent_group_id, additional_mounts FROM container_configs')
      .all() as ContainerConfigRow[];
    const configByGroup = new Map(configs.map((c) => [c.agent_group_id, c]));

    const findings: Finding[] = [];

    for (const group of groups) {
      const config = configByGroup.get(group.id);
      if (!config?.additional_mounts) continue;

      let mounts: AdditionalMount[];
      try {
        mounts = JSON.parse(config.additional_mounts);
      } catch {
        continue; // malformed JSON is a separate concern, not this audit's job
      }

      for (const mount of mounts) {
        const dir = path.dirname(mount.hostPath);
        let siblingDbFiles: string[] = [];
        try {
          siblingDbFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
        } catch {
          continue; // directory not readable from here — nothing to compare against
        }
        if (isSuspiciousTenantMount(group, mount, siblingDbFiles)) {
          findings.push({
            groupName: group.name,
            groupFolder: group.folder,
            hostPath: mount.hostPath,
            siblings: siblingDbFiles.filter((f) => f !== path.basename(mount.hostPath)),
          });
        }
      }
    }

    return findings;
  } finally {
    db.close();
  }
}

// CLI entry point — only runs when this file is executed directly, not when imported for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] ?? path.join(process.cwd(), 'data', 'v2.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`No DB found at ${dbPath}`);
    process.exit(2);
  }
  const findings = findMountPrivacyIssues(dbPath);
  if (findings.length === 0) {
    console.log('✅ No cross-tenant mount findings.');
    process.exit(0);
  }
  for (const f of findings) {
    console.log(
      `🚨 ${f.groupName} (folder: ${f.groupFolder}) mounts "${f.hostPath}" — ` +
        `a per-tenant DB in a directory with sibling tenant files (${f.siblings.join(', ')}), ` +
        `and the group's own folder name doesn't obviously match its tenant. Verify this is intentional.`,
    );
  }
  console.log(`\n${findings.length} finding(s) above — review each, this is a heuristic not a proof.`);
  process.exit(1);
}
