/**
 * applyInstallPackages/applyAddMcpServer/applyAddCalendar regression coverage
 * — the handler bodies that run only on an approved self-mod replay (see
 * ./apply.ts's own doc comment). Real central DB (matches request.test.ts's
 * approach); container-runner is mocked so no real Docker process is
 * touched. `appendSelfModLog` (spec-2-2: self-mod-change-provenance) is
 * mocked here too — its own real-filesystem behavior is covered by
 * ./self-mod-log.test.ts; this file only asserts each apply function calls
 * it with the right action name and reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { applyAddCalendar, applyAddMcpServer, applyInstallPackages } from './apply.js';

vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn(),
  killContainer: vi.fn((_sessionId: string, _reason: string, onExit?: () => void) => onExit?.()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

vi.mock('./self-mod-log.js', () => ({
  appendSelfModLog: vi.fn(),
}));

function now(): string {
  return new Date().toISOString();
}

let session: Session;

beforeEach(() => {
  vi.clearAllMocks();
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  ensureContainerConfig('ag-1');
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  createSession(session);
});

afterEach(() => {
  closeDb();
});

describe('applyAddCalendar', () => {
  it('adds a new entry to an empty registry', async () => {
    await applyAddCalendar({ name: 'family', calendarId: 'family-cal@group.calendar.google.com' }, session);

    const row = getContainerConfig('ag-1')!;
    expect(JSON.parse(row.calendar_registry)).toEqual([
      { name: 'family', calendarId: 'family-cal@group.calendar.google.com' },
    ]);
  });

  it('overrides an existing entry with the same name rather than duplicating it', async () => {
    updateContainerConfigJson('ag-1', 'calendar_registry', [{ name: 'family', calendarId: 'old@x.com' }]);

    await applyAddCalendar({ name: 'family', calendarId: 'new@x.com' }, session);

    const row = getContainerConfig('ag-1')!;
    expect(JSON.parse(row.calendar_registry)).toEqual([{ name: 'family', calendarId: 'new@x.com' }]);
  });

  it('preserves other existing entries when adding a new one', async () => {
    updateContainerConfigJson('ag-1', 'calendar_registry', [{ name: 'other', calendarId: 'other@x.com' }]);

    await applyAddCalendar({ name: 'family', calendarId: 'family@x.com' }, session);

    const row = getContainerConfig('ag-1')!;
    expect(JSON.parse(row.calendar_registry)).toEqual([
      { name: 'other', calendarId: 'other@x.com' },
      { name: 'family', calendarId: 'family@x.com' },
    ]);
  });

  it('writes an on_wake agent-facing note naming the calendar', async () => {
    const { writeSessionMessage } = await import('../../session-manager.js');

    await applyAddCalendar({ name: 'family', calendarId: 'family@x.com' }, session);

    expect(writeSessionMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(writeSessionMessage).mock.calls[0];
    const content = JSON.parse(call[2].content);
    expect(content.text).toContain('"family"');
    expect(call[2].onWake).toBe(1);
  });

  it('kills the container so the next spawn materializes the new registry entry', async () => {
    const { killContainer } = await import('../../container-runner.js');

    await applyAddCalendar({ name: 'family', calendarId: 'family@x.com' }, session);

    expect(killContainer).toHaveBeenCalledWith(session.id, 'calendar registry updated', expect.any(Function));
  });

  it('notifies instead of throwing when the agent group is missing', async () => {
    const { writeSessionMessage } = await import('../../session-manager.js');
    const missingSession: Session = { ...session, agent_group_id: 'ag-does-not-exist' };

    await applyAddCalendar({ name: 'family', calendarId: 'family@x.com' }, missingSession);

    expect(writeSessionMessage).toHaveBeenCalled();
    const call = vi.mocked(writeSessionMessage).mock.calls[0];
    const content = JSON.parse(call[2].content);
    expect(content.text).toMatch(/agent group missing/);
  });

  it('notifies instead of throwing when the container config is missing', async () => {
    const { writeSessionMessage } = await import('../../session-manager.js');
    createAgentGroup({
      id: 'ag-no-config',
      name: 'NoConfig',
      folder: 'no-config',
      agent_provider: null,
      created_at: now(),
    });
    const noConfigSession: Session = { ...session, agent_group_id: 'ag-no-config' };

    await applyAddCalendar({ name: 'family', calendarId: 'family@x.com' }, noConfigSession);

    expect(writeSessionMessage).toHaveBeenCalled();
    const call = vi.mocked(writeSessionMessage).mock.calls[0];
    const content = JSON.parse(call[2].content);
    expect(content.text).toMatch(/container config missing/);
  });

  // spec-2-2: self-mod-change-provenance — every applied change gets one
  // durable line in the group's self-mod-log.md, written by this call.
  it('appends a self-mod-log entry with the action name and reason', async () => {
    const { appendSelfModLog } = await import('./self-mod-log.js');

    await applyAddCalendar({ name: 'family', calendarId: 'family@x.com', reason: 'shared family schedule' }, session);

    expect(appendSelfModLog).toHaveBeenCalledWith('ag-1', 'add_calendar', 'shared family schedule', undefined);
  });

  // epic retro action item: the approved-replay path threads the resolved
  // approver identity down to this call — no longer discarded.
  it('threads approverUserId through to appendSelfModLog when the caller provides one', async () => {
    const { appendSelfModLog } = await import('./self-mod-log.js');

    await applyAddCalendar(
      { name: 'family', calendarId: 'family@x.com', reason: 'shared family schedule' },
      session,
      'telegram:dana',
    );

    expect(appendSelfModLog).toHaveBeenCalledWith('ag-1', 'add_calendar', 'shared family schedule', 'telegram:dana');
  });

  it('does not append a self-mod-log entry when the agent group is missing (nothing was applied)', async () => {
    const { appendSelfModLog } = await import('./self-mod-log.js');
    const missingSession: Session = { ...session, agent_group_id: 'ag-does-not-exist' };

    await applyAddCalendar({ name: 'family', calendarId: 'family@x.com' }, missingSession);

    expect(appendSelfModLog).not.toHaveBeenCalled();
  });
});

describe('applyInstallPackages', () => {
  it('adds new apt/npm packages to the container config', async () => {
    await applyInstallPackages({ apt: ['ffmpeg'], npm: ['sharp'] }, session);

    const row = getContainerConfig('ag-1')!;
    expect(JSON.parse(row.packages_apt)).toEqual(['ffmpeg']);
    expect(JSON.parse(row.packages_npm)).toEqual(['sharp']);
  });

  it('rebuilds the image and kills the container', async () => {
    const { buildAgentGroupImage, killContainer } = await import('../../container-runner.js');

    await applyInstallPackages({ apt: ['ffmpeg'] }, session);

    expect(buildAgentGroupImage).toHaveBeenCalledWith(session.agent_group_id);
    expect(killContainer).toHaveBeenCalledWith(session.id, 'rebuild applied', expect.any(Function));
  });

  // spec-2-2: self-mod-change-provenance
  it('appends a self-mod-log entry with the action name and reason', async () => {
    const { appendSelfModLog } = await import('./self-mod-log.js');

    await applyInstallPackages({ apt: ['ffmpeg'], reason: 'need it for audio transcription' }, session);

    expect(appendSelfModLog).toHaveBeenCalledWith(
      'ag-1',
      'install_packages',
      'need it for audio transcription',
      undefined,
    );
  });

  it('does not append a self-mod-log entry when the agent group is missing (nothing was applied)', async () => {
    const { appendSelfModLog } = await import('./self-mod-log.js');
    const missingSession: Session = { ...session, agent_group_id: 'ag-does-not-exist' };

    await applyInstallPackages({ apt: ['ffmpeg'] }, missingSession);

    expect(appendSelfModLog).not.toHaveBeenCalled();
  });

  // review round 1 (spec 2-2): the log call moved inside the try block,
  // after a successful rebuild — a failed rebuild must NOT produce a
  // provenance entry claiming the change was applied.
  it('does not append a self-mod-log entry when the rebuild fails', async () => {
    const { appendSelfModLog } = await import('./self-mod-log.js');
    const { buildAgentGroupImage } = await import('../../container-runner.js');
    vi.mocked(buildAgentGroupImage).mockRejectedValueOnce(new Error('build failed'));

    await applyInstallPackages({ apt: ['ffmpeg'], reason: 'test' }, session);

    expect(appendSelfModLog).not.toHaveBeenCalled();
  });

  it('does not throw when appendSelfModLog itself fails — the applied change is not lost over a log-write error', async () => {
    const { appendSelfModLog } = await import('./self-mod-log.js');
    vi.mocked(appendSelfModLog).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(applyInstallPackages({ apt: ['ffmpeg'] }, session)).resolves.toBeUndefined();
    const row = getContainerConfig('ag-1')!;
    expect(JSON.parse(row.packages_apt)).toEqual(['ffmpeg']);
  });
});

describe('applyAddMcpServer', () => {
  it('adds the new server to the mcp_servers map', async () => {
    await applyAddMcpServer({ name: 'weather', command: 'npx', args: ['weather-mcp'] }, session);

    const row = getContainerConfig('ag-1')!;
    expect(JSON.parse(row.mcp_servers)).toEqual({
      weather: { command: 'npx', args: ['weather-mcp'], env: {} },
    });
  });

  it('kills the container so the next spawn materializes the new server', async () => {
    const { killContainer } = await import('../../container-runner.js');

    await applyAddMcpServer({ name: 'weather', command: 'npx', args: [] }, session);

    expect(killContainer).toHaveBeenCalledWith(session.id, 'mcp server added', expect.any(Function));
  });

  // spec-2-2: self-mod-change-provenance — add_mcp_server's payload has no
  // `reason` field at all, so the call must pass undefined, not a colon with
  // empty text.
  it('appends a self-mod-log entry with the action name and undefined reason (no reason field on this payload)', async () => {
    const { appendSelfModLog } = await import('./self-mod-log.js');

    await applyAddMcpServer({ name: 'weather', command: 'npx', args: [] }, session);

    expect(appendSelfModLog).toHaveBeenCalledWith('ag-1', 'add_mcp_server', undefined, undefined);
  });

  it('does not append a self-mod-log entry when the agent group is missing (nothing was applied)', async () => {
    const { appendSelfModLog } = await import('./self-mod-log.js');
    const missingSession: Session = { ...session, agent_group_id: 'ag-does-not-exist' };

    await applyAddMcpServer({ name: 'weather', command: 'npx', args: [] }, missingSession);

    expect(appendSelfModLog).not.toHaveBeenCalled();
  });

  // review round 1 (spec 2-2): try/catch added around every appendSelfModLog
  // call site — a log-write failure must never propagate after the config
  // change + container kill already happened.
  it('does not throw when appendSelfModLog itself fails', async () => {
    const { appendSelfModLog } = await import('./self-mod-log.js');
    vi.mocked(appendSelfModLog).mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    await expect(applyAddMcpServer({ name: 'weather', command: 'npx', args: [] }, session)).resolves.toBeUndefined();
  });
});
