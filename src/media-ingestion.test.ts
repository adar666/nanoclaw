import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import {
  detectMedia,
  resolveMediaTenant,
  ingestTelegramMedia,
  MEDIA_TAG,
  MEDIA_FILED_TAG,
  MAX_MEDIA_BYTES,
} from './media-ingestion.js';
import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import type { AgentGroup } from './types.js';

const TMP_ROOT = '/tmp/nanoclaw-test-media-ingestion';
const now = () => new Date().toISOString();

function mockedExecFile() {
  return execFile as unknown as ReturnType<typeof vi.fn>;
}

function photoContent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    text: '',
    attachments: [{ type: 'image', size: 12_345, data: Buffer.from('fake-jpeg-bytes').toString('base64') }],
    ...overrides,
  });
}

function documentContent(mimeType: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    text: '',
    attachments: [
      { type: 'file', mimeType, name: 'bill.pdf', size: 999, data: Buffer.from('fake-pdf-bytes').toString('base64') },
    ],
    ...overrides,
  });
}

describe('detectMedia', () => {
  it('detects a Telegram photo (type: image) as telegram-photo/image-jpeg', () => {
    const detected = detectMedia(photoContent());
    expect(detected).not.toBeNull();
    expect(detected!.kind).toBe('telegram-photo');
    expect(detected!.mimeType).toBe('image/jpeg');
    expect(detected!.declaredBytes).toBe(12_345);
  });

  it('detects a document with a whitelisted image/PDF mime as telegram-document', () => {
    const detected = detectMedia(documentContent('application/pdf'));
    expect(detected!.kind).toBe('telegram-document');
    expect(detected!.mimeType).toBe('application/pdf');
  });

  it('does not detect a document with a non-whitelisted mime (e.g. docx) — later phase, not this one', () => {
    const detected = detectMedia(
      documentContent('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    );
    expect(detected).toBeNull();
  });

  it('returns null when there are no attachments', () => {
    expect(detectMedia(JSON.stringify({ text: 'hi' }))).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    expect(detectMedia('not json')).toBeNull();
  });

  it('does not detect a voice attachment (type: audio) — no overlap with voice-transcription', () => {
    expect(
      detectMedia(JSON.stringify({ text: '', attachments: [{ type: 'audio', mimeType: 'audio/ogg' }] })),
    ).toBeNull();
  });
});

describe('resolveMediaTenant', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    createAgentGroup({
      id: 'ag-uriel',
      name: 'Yulanda',
      folder: 'dm-with-uriel',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-partner',
      name: 'Tina',
      folder: 'dm-with-partner',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-household',
      name: 'Household',
      folder: 'household',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-other',
      name: 'Other',
      folder: 'some-other-group',
      agent_provider: null,
      created_at: now(),
    });

    createMessagingGroup({
      id: 'mg-dm-uriel',
      channel_type: 'telegram',
      platform_id: 'telegram:111',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-uriel',
      messaging_group_id: 'mg-dm-uriel',
      agent_group_id: 'ag-uriel',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    createMessagingGroup({
      id: 'mg-dm-partner',
      channel_type: 'telegram',
      platform_id: 'telegram:222',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-partner',
      messaging_group_id: 'mg-dm-partner',
      agent_group_id: 'ag-partner',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  afterEach(() => closeDb());

  function group(folder: string, id: string): AgentGroup {
    return { id, name: folder, folder, agent_provider: null, created_at: now() };
  }

  it('resolves dm-with-uriel to a fixed uriel tenant, no sender lookup needed', () => {
    const result = resolveMediaTenant(group('dm-with-uriel', 'ag-uriel'), null);
    expect(result).toEqual({ kind: 'fixed', tenant: 'uriel' });
  });

  it('resolves dm-with-partner to a fixed partner tenant', () => {
    const result = resolveMediaTenant(group('dm-with-partner', 'ag-partner'), 'telegram:999');
    expect(result).toEqual({ kind: 'fixed', tenant: 'partner' });
  });

  it("resolves household + a sender matching uriel's own DM platform_id to uriel", () => {
    const result = resolveMediaTenant(group('household', 'ag-household'), 'telegram:111');
    expect(result).toEqual({ kind: 'household-sender', tenant: 'uriel' });
  });

  it("resolves household + a sender matching partner's own DM platform_id to partner", () => {
    const result = resolveMediaTenant(group('household', 'ag-household'), 'telegram:222');
    expect(result).toEqual({ kind: 'household-sender', tenant: 'partner' });
  });

  it('rejects household + an unrecognized sender — no default tenant fallback', () => {
    const result = resolveMediaTenant(group('household', 'ag-household'), 'telegram:999-unknown-guest');
    expect(result).toEqual({ kind: 'unresolved-sender' });
  });

  it('rejects household + a null sender', () => {
    const result = resolveMediaTenant(group('household', 'ag-household'), null);
    expect(result).toEqual({ kind: 'unresolved-sender' });
  });

  it('returns not-configured for any other agent group folder', () => {
    const result = resolveMediaTenant(group('some-other-group', 'ag-other'), 'telegram:111');
    expect(result).toEqual({ kind: 'not-configured' });
  });
});

describe('ingestTelegramMedia', () => {
  const uriel = (): AgentGroup => ({
    id: 'ag-uriel',
    name: 'Yulanda',
    folder: 'dm-with-uriel',
    agent_provider: null,
    created_at: now(),
  });
  const household = (): AgentGroup => ({
    id: 'ag-household',
    name: 'Household',
    folder: 'household',
    agent_provider: null,
    created_at: now(),
  });
  const other = (): AgentGroup => ({
    id: 'ag-other',
    name: 'Other',
    folder: 'some-other-group',
    agent_provider: null,
    created_at: now(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SECOND_BRAIN_DATA_DIR = TMP_ROOT;
    process.env.SECOND_BRAIN_ROOT = '/tmp/fake-second-brain-root';
    if (fs.existsSync(TMP_ROOT)) fs.rmSync(TMP_ROOT, { recursive: true });
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    mockedExecFile().mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) =>
        cb(null, { stdout: 'inserted=1 skipped=0', stderr: '' }),
    );

    runMigrations(initTestDb());
    createAgentGroup({
      id: 'ag-uriel',
      name: 'Yulanda',
      folder: 'dm-with-uriel',
      agent_provider: null,
      created_at: now(),
    });
    createAgentGroup({
      id: 'ag-partner',
      name: 'Tina',
      folder: 'dm-with-partner',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-dm-uriel',
      channel_type: 'telegram',
      platform_id: 'telegram:111',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-uriel',
      messaging_group_id: 'mg-dm-uriel',
      agent_group_id: 'ag-uriel',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
    delete process.env.SECOND_BRAIN_DATA_DIR;
    delete process.env.SECOND_BRAIN_ROOT;
    if (fs.existsSync(TMP_ROOT)) fs.rmSync(TMP_ROOT, { recursive: true });
  });

  it('returns null (content untouched) when there is no eligible attachment', async () => {
    const result = await ingestTelegramMedia(JSON.stringify({ text: 'hi' }), uriel(), 'telegram:111', 'msg-1', now());
    expect(result).toBeNull();
    expect(mockedExecFile()).not.toHaveBeenCalled();
  });

  it('returns null for a group with no configured media tenant, even with an eligible attachment', async () => {
    const result = await ingestTelegramMedia(
      photoContent({ text: 'caption' }),
      other(),
      'telegram:111',
      'msg-1',
      now(),
    );
    expect(result).toBeNull();
    expect(mockedExecFile()).not.toHaveBeenCalled();
  });

  it('DM path: writes the file under the fixed tenant, calls the ingest CLI, and returns path+caption', async () => {
    const content = photoContent({ text: 'what is this bill' });
    const result = await ingestTelegramMedia(content, uriel(), 'telegram:111', 'msg-1', '2026-08-06T12:00:00.000Z');

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.text).toContain(MEDIA_TAG);
    expect(parsed.text).toContain('telegram-photo');
    expect(parsed.text).toContain('image/jpeg');
    expect(parsed.text).toContain('what is this bill');

    const expectedDir = path.join(TMP_ROOT, 'attachments', 'uriel', '2026-08');
    const files = fs.readdirSync(expectedDir);
    expect(files).toEqual(['msg-1-photo.jpg']);
    expect(fs.readFileSync(path.join(expectedDir, files[0]), 'utf-8')).toBe('fake-jpeg-bytes');

    expect(mockedExecFile()).toHaveBeenCalledTimes(1);
    const [, args] = mockedExecFile().mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining([
        '--tenant',
        'uriel',
        '--message-id',
        'msg-1',
        '--kind',
        'telegram-photo',
        '--caption',
        'what is this bill',
      ]),
    );
  });

  it("household-sender path: files under the sender's own tenant, returns MEDIA_FILED_TAG with no path", async () => {
    createAgentGroup({
      id: 'ag-household',
      name: 'Household',
      folder: 'household',
      agent_provider: null,
      created_at: now(),
    });
    const content = photoContent({ text: 'pay this' });
    const result = await ingestTelegramMedia(content, household(), 'telegram:111', 'msg-2', '2026-08-06T12:00:00.000Z');

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.text.startsWith(MEDIA_FILED_TAG)).toBe(true);
    expect(parsed.text).not.toContain(TMP_ROOT); // no path leaked into the household turn
    expect(parsed.text).toContain('pay this');

    // Still filed under uriel's own tenant dir, exactly as the DM case would.
    const expectedDir = path.join(TMP_ROOT, 'attachments', 'uriel', '2026-08');
    expect(fs.readdirSync(expectedDir)).toEqual(['msg-2-photo.jpg']);
  });

  it('household + unresolved sender: rejects, saves nothing anywhere', async () => {
    createAgentGroup({
      id: 'ag-household',
      name: 'Household',
      folder: 'household',
      agent_provider: null,
      created_at: now(),
    });
    const content = photoContent({ text: 'hi' });
    const result = await ingestTelegramMedia(content, household(), 'telegram:999-guest', 'msg-3', now());

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.text).toContain('[MEDIA-REJECTED: unresolved_sender]');
    expect(mockedExecFile()).not.toHaveBeenCalled();
    const attachmentsDir = path.join(TMP_ROOT, 'attachments');
    expect(fs.existsSync(attachmentsDir) ? fs.readdirSync(attachmentsDir) : []).toEqual([]);
  });

  it('rejects a file whose declared size exceeds the 20MB cap, before ever touching disk', async () => {
    const content = JSON.stringify({
      text: 'huge',
      attachments: [{ type: 'image', size: MAX_MEDIA_BYTES + 1, data: 'irrelevant' }],
    });
    const result = await ingestTelegramMedia(content, uriel(), 'telegram:111', 'msg-4', now());
    const parsed = JSON.parse(result!);
    expect(parsed.text).toContain('[MEDIA-REJECTED: too_large]');
    expect(mockedExecFile()).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(TMP_ROOT, 'attachments'))).toBe(false);
  });

  it('rejects on real byte length exceeding the cap even when declared size is missing or wrong', async () => {
    const oversized = Buffer.alloc(MAX_MEDIA_BYTES + 10, 'x').toString('base64');
    const content = JSON.stringify({ text: 'sneaky', attachments: [{ type: 'image', data: oversized }] });
    const result = await ingestTelegramMedia(content, uriel(), 'telegram:111', 'msg-5', now());
    const parsed = JSON.parse(result!);
    expect(parsed.text).toContain('[MEDIA-REJECTED: too_large]');
  });

  it('rejects when the attachment has no data (upstream download failed)', async () => {
    const content = JSON.stringify({ text: 'x', attachments: [{ type: 'image', size: 100 }] });
    const result = await ingestTelegramMedia(content, uriel(), 'telegram:111', 'msg-6', now());
    const parsed = JSON.parse(result!);
    expect(parsed.text).toContain('[MEDIA-REJECTED: download_failed]');
  });

  it('uses a [no caption] — actually just an empty text line — when there is no caption, but still files the media', async () => {
    const content = photoContent({ text: '' });
    const result = await ingestTelegramMedia(content, uriel(), 'telegram:111', 'msg-7', now());
    const parsed = JSON.parse(result!);
    expect(parsed.text.startsWith(MEDIA_TAG)).toBe(true);
    expect(mockedExecFile()).toHaveBeenCalledTimes(1);
  });

  it('the file stays safely on disk even if the second-brain ingest CLI itself fails', async () => {
    mockedExecFile().mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) =>
        cb(new Error('ingest CLI exploded'), { stdout: '', stderr: '' }),
    );
    const content = photoContent({ text: 'important bill' });
    const result = await ingestTelegramMedia(content, uriel(), 'telegram:111', 'msg-8', '2026-08-06T12:00:00.000Z');

    // Still returns the normal MEDIA tag+path — the file is real and
    // reachable even though the events-row insert failed.
    const parsed = JSON.parse(result!);
    expect(parsed.text).toContain(MEDIA_TAG);

    const expectedDir = path.join(TMP_ROOT, 'attachments', 'uriel', '2026-08');
    expect(fs.readdirSync(expectedDir)).toEqual(['msg-8-photo.jpg']);
  });

  it('document path: uses the sanitized original filename, not "photo.jpg"', async () => {
    const content = documentContent('application/pdf', { text: 'the lease' });
    const result = await ingestTelegramMedia(content, uriel(), 'telegram:111', 'msg-9', '2026-08-06T12:00:00.000Z');
    const parsed = JSON.parse(result!);
    expect(parsed.text).toContain('telegram-document');
    expect(parsed.text).toContain('application/pdf');

    const expectedDir = path.join(TMP_ROOT, 'attachments', 'uriel', '2026-08');
    expect(fs.readdirSync(expectedDir)).toEqual(['msg-9-bill.pdf']);
  });
});
