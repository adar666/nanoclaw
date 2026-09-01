/**
 * Regression test for #2525 — `ncl groups delete` must cascade dependent
 * rows in FK order so the final `DELETE FROM agent_groups` succeeds even
 * when the group has sessions, destinations, approvals, role grants, etc.
 *
 * The bug pre-fix: the generic single-table DELETE handler ran a bare
 * `DELETE FROM agent_groups WHERE id = ?` which always failed with a
 * `SQLITE_CONSTRAINT_FOREIGNKEY` when anything pointed at the group.
 *
 * The approval handler in `dispatch.ts` re-enters `dispatch()` with
 * `caller: 'host'` after admin approval, so the test invokes dispatch
 * with the host caller — same code path a real approval would take.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-groups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups';

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { dispatch } from '../dispatch.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
// Side-effect import: registers the `groups-*` commands (including delete).
import './groups.js';

function now(): string {
  return new Date().toISOString();
}

function count(sql: string, ...params: unknown[]): number {
  return (
    getDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

describe('groups CLI delete cascades dependent rows (#2525)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('deletes a group with sessions, destinations, approvals, members, roles, and wirings', async () => {
    const GID = 'ag-victim';
    const SID = 'sess-victim-1';
    const MGID = 'mg-1';
    const UID = 'tg:42';

    createAgentGroup({ id: GID, name: 'victim', folder: 'victim', agent_provider: null, created_at: now() });
    createSession({
      id: SID,
      agent_group_id: GID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    const db = getDb();

    // Direct inserts for the dependent tables. Keeps the fixture minimal —
    // we only need rows that establish FK relationships, not full domain
    // entities.
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'someone', ?)`).run(
      UID,
      now(),
    );
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'telegram', 'tg-1', 'telegram', 'chat', 1, 'strict', ?)`,
    ).run(MGID, now());

    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'chan', 'channel', ?, ?)`,
    ).run(GID, MGID, now());

    db.prepare(
      `INSERT INTO pending_questions (question_id, session_id, message_out_id, title, options_json, created_at)
       VALUES (?, ?, 'mout-1', 'q', '[]', ?)`,
    ).run('q-1', SID, now());

    db.prepare(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, status, title, options_json)
       VALUES (?, ?, 'req-1', 'cli_command', '{}', ?, ?, 'pending', '', '[]')`,
    ).run('pa-1', SID, now(), GID);

    db.prepare(
      `INSERT INTO pending_sender_approvals (id, messaging_group_id, agent_group_id, sender_identity, sender_name, original_message, approver_user_id, created_at)
       VALUES ('psa-1', ?, ?, 'tg:99', 'them', '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
       VALUES (?, ?, '{}', ?, ?)`,
    ).run(MGID, GID, UID, now());

    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-1', ?, ?, 'mention', 'all', 'drop', 'shared', 0, ?)`,
    ).run(MGID, GID, now());

    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
    ).run(UID, GID, now());

    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
    ).run(UID, GID, now());

    // Container config row exercises the ON DELETE CASCADE on container_configs.
    db.prepare(
      `INSERT INTO container_configs
         (agent_group_id, provider, model, effort, image_tag, assistant_name, max_messages_per_prompt,
          skills, mcp_servers, packages_apt, packages_npm, additional_mounts, cli_scope, updated_at)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, '"all"', '{}', '[]', '[]', '[]', 'group', ?)`,
    ).run(GID, now());

    const resp = await dispatch({ id: 'req-del', command: 'groups-delete', args: { id: GID } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { deleted: string; removed: Record<string, number> } }).data;
    expect(data.deleted).toBe(GID);
    expect(data.removed).toMatchObject({
      sessions: 1,
      pending_questions: 1,
      pending_approvals: 1,
      agent_destinations_owned: 1,
      agent_destinations_pointing: 0,
      pending_sender_approvals: 1,
      pending_channel_approvals: 1,
      messaging_group_agents: 1,
      agent_group_members: 1,
      user_roles: 1,
      container_configs: 1,
    });

    // The group and every dependent row must be gone.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM sessions WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_questions WHERE session_id = ?', SID)).toBe(0);
    expect(
      count('SELECT COUNT(*) AS c FROM pending_approvals WHERE agent_group_id = ? OR session_id = ?', GID, SID),
    ).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_sender_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM messaging_group_agents WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_group_members WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM user_roles WHERE agent_group_id = ?', GID)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM container_configs WHERE agent_group_id = ?', GID)).toBe(0);

    // Unrelated tables untouched.
    expect(count('SELECT COUNT(*) AS c FROM users WHERE id = ?', UID)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MGID)).toBe(1);
  });

  it('removes polymorphic agent_destinations that point at the deleted group', async () => {
    const A = 'ag-a';
    const B = 'ag-b';
    createAgentGroup({ id: A, name: 'a', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'b', folder: 'b', agent_provider: null, created_at: now() });

    const db = getDb();

    // B has a destination pointing at A. target_id is polymorphic — no FK
    // constraint enforces it, so without explicit cleanup the row would
    // dangle after A is deleted.
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, 'sibling', 'agent', ?, ?)`,
    ).run(B, A, now());

    const resp = await dispatch({ id: 'req-del-a', command: 'groups-delete', args: { id: A } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { removed: Record<string, number> } }).data;
    expect(data.removed.agent_destinations_pointing).toBe(1);

    // A is gone, B remains, and B's stale destination is cleaned up.
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', A)).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', B)).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM agent_destinations WHERE agent_group_id = ?', B)).toBe(0);
  });

  it('returns a handler error for an unknown group id', async () => {
    const resp = await dispatch(
      { id: 'req-missing', command: 'groups-delete', args: { id: 'ag-does-not-exist' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string; message: string } }).error.code).toBe('handler-error');
    expect((resp as { ok: false; error: { code: string; message: string } }).error.message).toMatch(/not found/i);
  });
});

describe('groups config add-mount / remove-mount (host-only)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('adds a mount idempotently and removes it (host caller)', async () => {
    const GID = 'ag-mount';
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    const args = { id: GID, host: '/data/.gmail-mcp', container: '/home/node/.gmail-mcp', ro: true };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(add.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([
      { hostPath: '/data/.gmail-mcp', containerPath: '/home/node/.gmail-mcp', readonly: true },
    ]);

    // idempotent: a second add does not duplicate
    await dispatch({ id: 'r2', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toHaveLength(1);

    const rm = await dispatch(
      {
        id: 'r3',
        command: 'groups-config-remove-mount',
        args: { id: GID, host: '/data/.gmail-mcp', container: '/home/node/.gmail-mcp' },
      },
      { caller: 'host' },
    );
    expect(rm.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([]);
  });

  it('a read-write mount (no --ro) writes an explicit readonly: false, not an omitted key', async () => {
    // Regression test: mount-security's validateMount() only grants RW when
    // mount.readonly === false EXACTLY — an omitted/undefined key is treated
    // as force-readonly (fail closed). If add-mount ever goes back to
    // omitting the key for the RW case, this silently breaks every RW mount
    // request with no error anywhere in the chain.
    const GID = 'ag-mount-rw';
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    const args = { id: GID, host: '/data/writable.db', container: 'writable.db' };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(add.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([
      { hostPath: '/data/writable.db', containerPath: 'writable.db', readonly: false },
    ]);
  });

  // spec 1.1 ("Read a Fact Shared by Another Agent Group"): a `*-shared/`
  // containerPath is the cross-group shared-facts convention
  // `read_shared_context` scans — it must never land RW by accident.
  it('rejects a *-shared/ containerPath without --ro, and writes nothing', async () => {
    const GID = 'ag-mount-shared-rw';
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    const args = {
      id: GID,
      host: '/data/groups/household/memory/household/shared-facts.md',
      container: 'household-shared/shared-facts.md',
    };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(add.ok).toBe(false);
    if (!add.ok) expect(add.error.message).toMatch(/--ro/);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([]);
  });

  it('allows a *-shared/ containerPath with --ro, exactly like any other mount (real eval/prod precedent)', async () => {
    // Exact containerPath shape already live in production (verified against
    // the real DB: every dm-with-uriel/dm-with-partner/household-eval
    // container_configs row already carries this exact hostPath/containerPath
    // pair, always with readonly: true) and used verbatim by
    // eval/setup.ts's ensureEvalPeopleMount. This confirms the new guard
    // doesn't regress the mount this convention was named after.
    const GID = 'ag-mount-shared-ro';
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    const args = {
      id: GID,
      host: '/data/groups/household/memory/household/people.md',
      container: 'household-shared/people.md',
      ro: true,
    };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(add.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([
      {
        hostPath: '/data/groups/household/memory/household/people.md',
        containerPath: 'household-shared/people.md',
        readonly: true,
      },
    ]);
  });

  // review_loop_iteration 1: the original `/-shared\//` regex required a
  // trailing slash, so a bare `<folder>-shared` (no filename) silently
  // bypassed the guard — the exact footgun this story exists to close.
  it('rejects a bare "<folder>-shared" containerPath (no filename) without --ro', async () => {
    const GID = 'ag-mount-shared-bare';
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    const args = {
      id: GID,
      host: '/data/groups/household/memory/household',
      container: 'household-shared',
    };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(add.ok).toBe(false);
    if (!add.ok) expect(add.error.message).toMatch(/--ro/);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([]);
  });

  it('a containerPath with no "-shared/" segment, without --ro, is unaffected by the new guard', async () => {
    const GID = 'ag-mount-plain';
    createAgentGroup({ id: GID, name: 'm', folder: 'm', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    // No "-shared/" anywhere in this containerPath — the new guard's regex
    // never fires, so behavior is exactly what add-mount already did before
    // this story, unaffected.
    const args = { id: GID, host: '/data/groups/household/memory/household/people.md', container: 'people.md' };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-mount', args }, { caller: 'host' });
    expect(add.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.additional_mounts)).toEqual([
      { hostPath: '/data/groups/household/memory/household/people.md', containerPath: 'people.md', readonly: false },
    ]);
  });
});

// spec cal-2.3: `ncl groups config add-calendar` / `config remove-calendar`,
// mirroring add-mcp-server/remove-mcp-server's exact shape.
describe('groups config add-calendar / remove-calendar', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('starts with an empty calendar_registry by default (fresh migration — no hardcoded personal data)', () => {
    const GID = 'ag-cal-default';
    createAgentGroup({ id: GID, name: 'c', folder: 'c', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    expect(JSON.parse(getContainerConfig(GID)!.calendar_registry)).toEqual([]);
  });

  it('adds a calendar and removes it (host caller)', async () => {
    const GID = 'ag-cal';
    createAgentGroup({ id: GID, name: 'c', folder: 'c', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);
    const args = { id: GID, name: 'family', 'calendar-id': 'family-cal@group.calendar.google.com' };

    const add = await dispatch({ id: 'r1', command: 'groups-config-add-calendar', args }, { caller: 'host' });
    expect(add.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.calendar_registry)).toEqual([
      { name: 'family', calendarId: 'family-cal@group.calendar.google.com' },
    ]);

    const rm = await dispatch(
      { id: 'r2', command: 'groups-config-remove-calendar', args: { id: GID, name: 'family' } },
      { caller: 'host' },
    );
    expect(rm.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.calendar_registry)).toEqual([]);
  });

  it('re-adding the same name replaces the entry (dedupe by name), not appends a duplicate', async () => {
    const GID = 'ag-cal-dedupe';
    createAgentGroup({ id: GID, name: 'c', folder: 'c', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);

    await dispatch(
      {
        id: 'r1',
        command: 'groups-config-add-calendar',
        args: { id: GID, name: 'family', 'calendar-id': 'old-cal@group.calendar.google.com' },
      },
      { caller: 'host' },
    );
    await dispatch(
      {
        id: 'r2',
        command: 'groups-config-add-calendar',
        args: { id: GID, name: 'family', 'calendar-id': 'new-cal@group.calendar.google.com' },
      },
      { caller: 'host' },
    );

    expect(JSON.parse(getContainerConfig(GID)!.calendar_registry)).toEqual([
      { name: 'family', calendarId: 'new-cal@group.calendar.google.com' },
    ]);
  });

  it('an entry reusing a built-in name ("uriel") is stored as an explicit override, not rejected', async () => {
    const GID = 'ag-cal-override';
    createAgentGroup({ id: GID, name: 'c', folder: 'c', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);

    const add = await dispatch(
      {
        id: 'r1',
        command: 'groups-config-add-calendar',
        args: { id: GID, name: 'uriel', 'calendar-id': 'something-else@group.calendar.google.com' },
      },
      { caller: 'host' },
    );
    expect(add.ok).toBe(true);
    expect(JSON.parse(getContainerConfig(GID)!.calendar_registry)).toEqual([
      { name: 'uriel', calendarId: 'something-else@group.calendar.google.com' },
    ]);
  });

  it('remove-calendar on a name that was never added declines clearly — no silent no-op', async () => {
    const GID = 'ag-cal-remove-missing';
    createAgentGroup({ id: GID, name: 'c', folder: 'c', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);

    const rm = await dispatch(
      { id: 'r1', command: 'groups-config-remove-calendar', args: { id: GID, name: 'doesnotexist' } },
      { caller: 'host' },
    );
    expect(rm.ok).toBe(false);
    expect((rm as { error?: { message?: string } }).error?.message ?? '').toContain('not found');
    // Registry stays empty — no accidental mutation on the decline path.
    expect(JSON.parse(getContainerConfig(GID)!.calendar_registry)).toEqual([]);
  });

  it('add-calendar requires --name and --calendar-id', async () => {
    const GID = 'ag-cal-validate';
    createAgentGroup({ id: GID, name: 'c', folder: 'c', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);

    const noName = await dispatch(
      {
        id: 'r1',
        command: 'groups-config-add-calendar',
        args: { id: GID, 'calendar-id': 'x@group.calendar.google.com' },
      },
      { caller: 'host' },
    );
    expect(noName.ok).toBe(false);

    const noCalendarId = await dispatch(
      { id: 'r2', command: 'groups-config-add-calendar', args: { id: GID, name: 'family' } },
      { caller: 'host' },
    );
    expect(noCalendarId.ok).toBe(false);
  });

  it('add-calendar rejects a --calendar-id that is not plausibly a real Google Calendar id', async () => {
    const GID = 'ag-cal-implausible';
    createAgentGroup({ id: GID, name: 'c', folder: 'c', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);

    const result = await dispatch(
      {
        id: 'r1',
        command: 'groups-config-add-calendar',
        args: { id: GID, name: 'family', 'calendar-id': 'not-a-real-id' },
      },
      { caller: 'host' },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: { message: string } }).error.message).toMatch(
      /doesn't look like a real Google Calendar id/,
    );

    // "primary" is the one non-email-shaped id that's real — must still work.
    const primary = await dispatch(
      { id: 'r2', command: 'groups-config-add-calendar', args: { id: GID, name: 'family', 'calendar-id': 'primary' } },
      { caller: 'host' },
    );
    expect(primary.ok).toBe(true);
  });
});

// spec 2-4 (on-demand-cross-domain-digest): `ncl groups provenance-digest`.
describe('groups provenance-digest', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    runMigrations(initTestDb());
  });
  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('returns the three-section digest for a real group (host caller)', async () => {
    const GID = 'ag-digest';
    createAgentGroup({ id: GID, name: 'digest', folder: 'digest', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);

    const resp = await dispatch(
      { id: 'r1', command: 'groups-provenance-digest', args: { id: GID } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const data = resp.data as { tasks: unknown; self_mod: unknown; documents: unknown; agent_group_id: string };
    expect(data.agent_group_id).toBe(GID);
    // Every section is present even with nothing recorded — never omitted.
    expect(data.tasks).toBeDefined();
    expect(data.self_mod).toBeDefined();
    expect(data.documents).toBeDefined();
  });

  it('fails clearly for a missing --id', async () => {
    const resp = await dispatch({ id: 'r1', command: 'groups-provenance-digest', args: {} }, { caller: 'host' });
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/--id is required/);
  });

  it("fails clearly for a group with no container config, matching config get's precedent", async () => {
    const resp = await dispatch(
      { id: 'r1', command: 'groups-provenance-digest', args: { id: 'ag-does-not-exist' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.message).toMatch(/No container config for group/);
  });

  it('an agent caller under cli_scope=group is auto-scoped to its own group', async () => {
    const GID = 'ag-digest-agent';
    createAgentGroup({ id: GID, name: 'digest', folder: 'digest-agent', agent_provider: null, created_at: now() });
    ensureContainerConfig(GID);

    const resp = await dispatch(
      { id: 'r1', command: 'groups-provenance-digest', args: {} },
      { caller: 'agent', agentGroupId: GID, sessionId: 'sess-1', messagingGroupId: 'mg-1' },
    );
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect((resp.data as { agent_group_id: string }).agent_group_id).toBe(GID);
  });
});
