import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

const mockReadEnvFile = vi.fn();
vi.mock('./env.js', () => ({
  readEnvFile: (...args: unknown[]) => mockReadEnvFile(...args),
}));

const mockGetOwners = vi.fn();
const mockGetGlobalAdmins = vi.fn();
vi.mock('./modules/permissions/db/user-roles.js', () => ({
  getOwners: () => mockGetOwners(),
  getGlobalAdmins: () => mockGetGlobalAdmins(),
}));

import { notifyStartupFailure } from './startup-notify.js';
import { log } from './log.js';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetOwners.mockReturnValue([]);
  mockGetGlobalAdmins.mockReturnValue([]);
  mockReadEnvFile.mockReturnValue({ TELEGRAM_BOT_TOKEN: 'test-token' });
  vi.stubGlobal('fetch', mockFetch);
});

describe('notifyStartupFailure', () => {
  it('sends via the Telegram Bot API using the owner telegram identity', async () => {
    mockGetOwners.mockReturnValue([{ user_id: 'telegram:12345', role: 'owner', agent_group_id: null }]);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    await notifyStartupFailure('runtime is down');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ chat_id: '12345', text: 'runtime is down' }),
      }),
    );
    expect(log.info).toHaveBeenCalledWith('Startup-failure Telegram notification sent');
  });

  it('falls back to a global admin telegram identity when there is no owner', async () => {
    mockGetOwners.mockReturnValue([{ user_id: 'slack:U123', role: 'owner', agent_group_id: null }]);
    mockGetGlobalAdmins.mockReturnValue([{ user_id: 'telegram:999', role: 'admin', agent_group_id: null }]);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    await notifyStartupFailure('runtime is down');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify({ chat_id: '999', text: 'runtime is down' }) }),
    );
  });

  it('skips without throwing when no owner/admin has a telegram identity', async () => {
    mockGetOwners.mockReturnValue([{ user_id: 'slack:U123', role: 'owner', agent_group_id: null }]);

    await expect(notifyStartupFailure('runtime is down')).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Startup-failure Telegram notification skipped: no owner/admin has a telegram identity',
    );
  });

  it('skips without throwing when TELEGRAM_BOT_TOKEN is not set', async () => {
    mockGetOwners.mockReturnValue([{ user_id: 'telegram:12345', role: 'owner', agent_group_id: null }]);
    mockReadEnvFile.mockReturnValue({});

    await expect(notifyStartupFailure('runtime is down')).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Startup-failure Telegram notification skipped: TELEGRAM_BOT_TOKEN not set in .env',
    );
  });

  it('never throws when the Telegram API call itself fails', async () => {
    mockGetOwners.mockReturnValue([{ user_id: 'telegram:12345', role: 'owner', agent_group_id: null }]);
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    await expect(notifyStartupFailure('runtime is down')).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith('Startup-failure Telegram notification threw', { err: expect.any(Error) });
  });

  it('logs a warning without throwing on a non-ok HTTP response', async () => {
    mockGetOwners.mockReturnValue([{ user_id: 'telegram:12345', role: 'owner', agent_group_id: null }]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });

    await expect(notifyStartupFailure('runtime is down')).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith('Startup-failure Telegram notification failed', {
      status: 401,
      body: 'Unauthorized',
    });
  });
});
