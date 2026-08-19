/**
 * applyAddCalendar regression coverage — the handler body that runs only on
 * an approved add_calendar replay (see ./apply.ts's own doc comment). Real
 * central DB (matches request.test.ts's approach); container-runner is
 * mocked so no real Docker process is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { applyAddCalendar } from './apply.js';

vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn(),
  killContainer: vi.fn((_sessionId: string, _reason: string, onExit?: () => void) => onExit?.()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

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
});
