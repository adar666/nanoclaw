import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { isAttachmentDropRisk, findAttachmentDropRisks, type WiringRow } from './audit-attachment-drop-risk.js';

function wiring(overrides: Partial<WiringRow> = {}): WiringRow {
  return {
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '^\\.',
    ignored_message_policy: 'drop',
    ...overrides,
  };
}

describe('isAttachmentDropRisk (pure decision function)', () => {
  it('flags pattern engage with a real regex and drop policy — the exact live incident', () => {
    expect(isAttachmentDropRisk(wiring())).toBe(true);
  });

  it('does not flag the always-engage "." sentinel, even with drop policy', () => {
    expect(isAttachmentDropRisk(wiring({ engage_pattern: '.' }))).toBe(false);
  });

  it('treats a null engage_pattern the same as "." (router default)', () => {
    expect(isAttachmentDropRisk(wiring({ engage_pattern: null }))).toBe(false);
  });

  it('does not flag accumulate policy — attachments still get staged there', () => {
    expect(isAttachmentDropRisk(wiring({ ignored_message_policy: 'accumulate' }))).toBe(false);
  });

  it('does not flag non-pattern engage modes (mention, mention-sticky)', () => {
    expect(isAttachmentDropRisk(wiring({ engage_mode: 'mention' }))).toBe(false);
    expect(isAttachmentDropRisk(wiring({ engage_mode: 'mention-sticky' }))).toBe(false);
  });
});

describe('findAttachmentDropRisks (real DB)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-attachment-drop-risk-test-'));
    dbPath = path.join(tempDir, 'v2.db');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE messaging_group_agents (
        id TEXT PRIMARY KEY,
        messaging_group_id TEXT,
        agent_group_id TEXT,
        engage_mode TEXT,
        engage_pattern TEXT,
        ignored_message_policy TEXT
      );
    `);
    db.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags the real-shape incident end to end, with group/agent names resolved', () => {
    const db = new Database(dbPath);
    db.prepare('INSERT INTO messaging_groups (id, name) VALUES (?, ?)').run('mg-1', 'אשת חיל');
    db.prepare('INSERT INTO agent_groups (id, name) VALUES (?, ?)').run('ag-1', 'אשת חיל');
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, ignored_message_policy)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('mga-1', 'mg-1', 'ag-1', 'pattern', '^\\.', 'drop');
    db.close();

    const findings = findAttachmentDropRisks(dbPath);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      wiringId: 'mga-1',
      groupName: 'אשת חיל',
      agentName: 'אשת חיל',
      engagePattern: '^\\.',
    });
  });

  it('reports the current, fixed configuration as clean (accumulate policy)', () => {
    const db = new Database(dbPath);
    db.prepare('INSERT INTO messaging_groups (id, name) VALUES (?, ?)').run('mg-1', 'אשת חיל');
    db.prepare('INSERT INTO agent_groups (id, name) VALUES (?, ?)').run('ag-1', 'אשת חיל');
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, ignored_message_policy)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('mga-1', 'mg-1', 'ag-1', 'pattern', '^\\.', 'accumulate');
    db.close();

    expect(findAttachmentDropRisks(dbPath)).toEqual([]);
  });

  it('reports DM-shaped always-engage wirings as clean', () => {
    const db = new Database(dbPath);
    db.prepare('INSERT INTO messaging_groups (id, name) VALUES (?, ?)').run('mg-1', 'Yulanda');
    db.prepare('INSERT INTO agent_groups (id, name) VALUES (?, ?)').run('ag-1', 'Yulanda');
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, ignored_message_policy)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('mga-1', 'mg-1', 'ag-1', 'pattern', '.', 'drop');
    db.close();

    expect(findAttachmentDropRisks(dbPath)).toEqual([]);
  });

  it('falls back to raw ids when the group/agent name lookup misses', () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, ignored_message_policy)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('mga-1', 'mg-missing', 'ag-missing', 'pattern', '^\\.', 'drop');
    db.close();

    const findings = findAttachmentDropRisks(dbPath);
    expect(findings).toHaveLength(1);
    expect(findings[0].groupName).toBe('mg-missing');
    expect(findings[0].agentName).toBe('ag-missing');
  });
});
