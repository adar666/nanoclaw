import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { isSuspiciousTenantMount, findMountPrivacyIssues, type AgentGroupRow, type AdditionalMount } from './audit-mount-privacy.js';

describe('isSuspiciousTenantMount (pure decision function)', () => {
  const household: AgentGroupRow = { id: 'ag-1', name: 'אשת חיל', folder: 'household' };
  const dmWithUriel: AgentGroupRow = { id: 'ag-2', name: 'Yulanda', folder: 'dm-with-uriel' };

  it('flags a group mounting a tenant DB that does not match its own folder name', () => {
    const mount: AdditionalMount = { hostPath: '/data/second-brain-data/uriel.db' };
    expect(isSuspiciousTenantMount(household, mount, ['uriel.db', 'partner.db', 'household.db'])).toBe(true);
  });

  it('does not flag a DM group mounting its own tenant DB', () => {
    const mount: AdditionalMount = { hostPath: '/data/second-brain-data/uriel.db' };
    expect(isSuspiciousTenantMount(dmWithUriel, mount, ['uriel.db', 'partner.db', 'household.db'])).toBe(false);
  });

  it('never flags household.db — it is the intentionally shared file', () => {
    const mount: AdditionalMount = { hostPath: '/data/second-brain-data/household.db' };
    expect(isSuspiciousTenantMount(household, mount, ['uriel.db', 'partner.db', 'household.db'])).toBe(false);
  });

  it('does not flag when there are no sibling tenant DBs (not a multi-tenant directory)', () => {
    const mount: AdditionalMount = { hostPath: '/data/some-other-place/config.db' };
    expect(isSuspiciousTenantMount(household, mount, ['config.db'])).toBe(false);
  });

  it('ignores non-.db mounts entirely', () => {
    const mount: AdditionalMount = { hostPath: '/data/second-brain-data/uriel-notes.md' };
    expect(isSuspiciousTenantMount(household, mount, ['uriel.db', 'partner.db'])).toBe(false);
  });
});

describe('findMountPrivacyIssues (real DB + real filesystem)', () => {
  let tempDir: string;
  let dbPath: string;
  let dataDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-mount-privacy-test-'));
    dbPath = path.join(tempDir, 'v2.db');
    dataDir = path.join(tempDir, 'second-brain-data');
    fs.mkdirSync(dataDir);

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT, folder TEXT);
      CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, additional_mounts TEXT);
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function seed(rows: { group: AgentGroupRow; mounts: AdditionalMount[] | null }[]) {
    const db = new Database(dbPath);
    for (const { group, mounts } of rows) {
      db.prepare('INSERT INTO agent_groups (id, name, folder) VALUES (?, ?, ?)').run(group.id, group.name, group.folder);
      db.prepare('INSERT INTO container_configs (agent_group_id, additional_mounts) VALUES (?, ?)').run(
        group.id,
        mounts ? JSON.stringify(mounts) : null,
      );
    }
    db.close();
  }

  it('flags a real cross-tenant mount end to end', () => {
    fs.writeFileSync(path.join(dataDir, 'uriel.db'), '');
    fs.writeFileSync(path.join(dataDir, 'partner.db'), '');
    fs.writeFileSync(path.join(dataDir, 'household.db'), '');

    seed([
      {
        group: { id: 'ag-1', name: 'אשת חיל', folder: 'household' },
        mounts: [{ hostPath: path.join(dataDir, 'uriel.db') }], // misconfigured on purpose for this test
      },
    ]);

    const findings = findMountPrivacyIssues(dbPath);
    expect(findings).toHaveLength(1);
    expect(findings[0].groupFolder).toBe('household');
    expect(findings[0].hostPath).toContain('uriel.db');
    expect(findings[0].siblings.sort()).toEqual(['household.db', 'partner.db']);
  });

  it('reports the current, correctly-configured shape as clean (household.db only)', () => {
    fs.writeFileSync(path.join(dataDir, 'uriel.db'), '');
    fs.writeFileSync(path.join(dataDir, 'partner.db'), '');
    fs.writeFileSync(path.join(dataDir, 'household.db'), '');

    seed([
      {
        group: { id: 'ag-1', name: 'אשת חיל', folder: 'household' },
        mounts: [{ hostPath: path.join(dataDir, 'household.db'), readonly: true }],
      },
      {
        group: { id: 'ag-2', name: 'Yulanda', folder: 'dm-with-uriel' },
        mounts: [{ hostPath: path.join(dataDir, 'uriel.db') }],
      },
    ]);

    expect(findMountPrivacyIssues(dbPath)).toEqual([]);
  });

  it('skips groups with no additionalMounts configured', () => {
    seed([{ group: { id: 'ag-1', name: 'אשת חיל', folder: 'household' }, mounts: null }]);
    expect(findMountPrivacyIssues(dbPath)).toEqual([]);
  });

  it('skips malformed JSON without throwing', () => {
    const db = new Database(dbPath);
    db.prepare('INSERT INTO agent_groups (id, name, folder) VALUES (?, ?, ?)').run('ag-1', 'x', 'household');
    db.prepare('INSERT INTO container_configs (agent_group_id, additional_mounts) VALUES (?, ?)').run('ag-1', '{not json');
    db.close();

    expect(findMountPrivacyIssues(dbPath)).toEqual([]);
  });
});
