import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-voice-transcription' };
});

import {
  isTranscribableVoiceAttachment,
  hasTranscribableVoiceAttachment,
  transcribeVoiceNote,
  applyVoiceTranscription,
  VOICE_TRANSCRIPT_TAG,
  voiceTranscriptFailedTag,
  type TranscribeResult,
} from './voice-transcription.js';
import { initSessionFolder, writeSessionMessage, inboundDbPath } from './session-manager.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import Database from 'better-sqlite3';

const TEST_DIR = '/tmp/nanoclaw-test-voice-transcription';
const AG = 'ag-voice-test';
const SESS = 'sess-voice-test';

function now() {
  return new Date().toISOString();
}

function readRow(messageId: string): { content: string } {
  const db = new Database(inboundDbPath(AG, SESS), { readonly: true });
  try {
    return db.prepare('SELECT content FROM messages_in WHERE id = ?').get(messageId) as { content: string };
  } finally {
    db.close();
  }
}

describe('isTranscribableVoiceAttachment', () => {
  it('is true for a real Telegram voice note (no name)', () => {
    expect(isTranscribableVoiceAttachment({ type: 'audio', mimeType: 'audio/ogg', size: 123 })).toBe(true);
  });

  it('is false for an uploaded audio file (carries name)', () => {
    expect(
      isTranscribableVoiceAttachment({ type: 'audio', mimeType: 'audio/ogg', name: 'song.ogg', size: 123 }),
    ).toBe(false);
  });

  it('is false for a non-ogg mime type', () => {
    expect(isTranscribableVoiceAttachment({ type: 'audio', mimeType: 'audio/mpeg', size: 123 })).toBe(false);
  });

  it('is false for a non-audio attachment', () => {
    expect(isTranscribableVoiceAttachment({ type: 'image', mimeType: 'audio/ogg', size: 123 })).toBe(false);
  });
});

describe('hasTranscribableVoiceAttachment', () => {
  it('is true when content has a matching attachment', () => {
    const content = JSON.stringify({ text: '', attachments: [{ type: 'audio', mimeType: 'audio/ogg' }] });
    expect(hasTranscribableVoiceAttachment(content)).toBe(true);
  });

  it('is false when content has no attachments', () => {
    expect(hasTranscribableVoiceAttachment(JSON.stringify({ text: 'hi' }))).toBe(false);
  });

  it('is false on invalid JSON', () => {
    expect(hasTranscribableVoiceAttachment('not json')).toBe(false);
  });
});

describe('transcribeVoiceNote', () => {
  const FAKE_DIR = '/tmp/nanoclaw-test-voice-bins';
  const FAKE_WHISPER = path.join(FAKE_DIR, 'whisper-cli');
  const FAKE_FFMPEG = path.join(FAKE_DIR, 'ffmpeg');
  const FAKE_MODEL = path.join(FAKE_DIR, 'model.bin');

  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdirSync(FAKE_DIR, { recursive: true });
    fs.writeFileSync(FAKE_WHISPER, '');
    fs.writeFileSync(FAKE_FFMPEG, '');
    fs.writeFileSync(FAKE_MODEL, '');
  });

  afterEach(() => {
    fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  });

  function mockedExecFile() {
    return execFile as unknown as ReturnType<typeof vi.fn>;
  }

  it('returns not-installed when the whisper-cli binary is missing', async () => {
    fs.rmSync(FAKE_WHISPER);
    const result = await transcribeVoiceNote('/tmp/x.ogg', {
      whisperCli: FAKE_WHISPER,
      ffmpeg: FAKE_FFMPEG,
      modelPath: FAKE_MODEL,
    });
    expect(result).toEqual({ ok: false, reason: 'not-installed' });
    expect(mockedExecFile()).not.toHaveBeenCalled();
  });

  it('returns not-installed when the model file is missing', async () => {
    fs.rmSync(FAKE_MODEL);
    const result = await transcribeVoiceNote('/tmp/x.ogg', {
      whisperCli: FAKE_WHISPER,
      ffmpeg: FAKE_FFMPEG,
      modelPath: FAKE_MODEL,
    });
    expect(result).toEqual({ ok: false, reason: 'not-installed' });
  });

  it('converts then transcribes, forcing Hebrew, and returns trimmed stdout', async () => {
    mockedExecFile().mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      cb(null, { stdout: '', stderr: '' });
    });
    // First call is ffmpeg (no meaningful stdout), second is whisper-cli.
    let call = 0;
    mockedExecFile().mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      call++;
      if (call === 1) return cb(null, { stdout: '', stderr: '' });
      cb(null, { stdout: '  שלום עולם  \n', stderr: '' });
    });

    const result = await transcribeVoiceNote('/tmp/x.ogg', {
      whisperCli: FAKE_WHISPER,
      ffmpeg: FAKE_FFMPEG,
      modelPath: FAKE_MODEL,
    });

    expect(result).toEqual({ ok: true, text: 'שלום עולם' });
    const [whisperCall] = mockedExecFile().mock.calls.filter((c) => c[0] === FAKE_WHISPER);
    expect(whisperCall[1]).toEqual(expect.arrayContaining(['-l', 'he', '-m', FAKE_MODEL]));
  });

  it('returns error when ffmpeg fails', async () => {
    mockedExecFile().mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      cb(new Error('ffmpeg exploded'), { stdout: '', stderr: '' });
    });
    const result = await transcribeVoiceNote('/tmp/x.ogg', {
      whisperCli: FAKE_WHISPER,
      ffmpeg: FAKE_FFMPEG,
      modelPath: FAKE_MODEL,
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
  });

  it('returns timeout when a step is killed for exceeding the deadline', async () => {
    mockedExecFile().mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      const err = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
      cb(err, { stdout: '', stderr: '' });
    });
    const result = await transcribeVoiceNote('/tmp/x.ogg', {
      whisperCli: FAKE_WHISPER,
      ffmpeg: FAKE_FFMPEG,
      modelPath: FAKE_MODEL,
      timeoutMs: 30_000,
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('returns error when whisper-cli produces empty output', async () => {
    let call = 0;
    mockedExecFile().mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      call++;
      cb(null, { stdout: call === 1 ? '' : '   \n', stderr: '' });
    });
    const result = await transcribeVoiceNote('/tmp/x.ogg', {
      whisperCli: FAKE_WHISPER,
      ffmpeg: FAKE_FFMPEG,
      modelPath: FAKE_MODEL,
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
  });
});

describe('applyVoiceTranscription', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: AG, name: 'Voice Test', folder: 'voice-test', agent_provider: null, created_at: now() });
    initSessionFolder(AG, SESS);
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  function seedVoiceMessage(messageId: string): void {
    writeSessionMessage(AG, SESS, {
      id: messageId,
      kind: 'chat-sdk',
      timestamp: now(),
      content: JSON.stringify({
        text: '',
        attachments: [
          {
            type: 'audio',
            mimeType: 'audio/ogg',
            size: 5,
            data: Buffer.from('dummy').toString('base64'),
          },
        ],
      }),
    });
  }

  it('prepends the success tag and leaves the attachment untouched', async () => {
    seedVoiceMessage('m-ok');
    const fakeTranscribe = vi.fn(async (): Promise<TranscribeResult> => ({ ok: true, text: 'שלום' }));

    await applyVoiceTranscription(AG, SESS, 'm-ok', fakeTranscribe);

    const parsed = JSON.parse(readRow('m-ok').content);
    expect(parsed.text).toBe(`${VOICE_TRANSCRIPT_TAG}\nשלום\n\n`);
    expect(parsed.attachments[0].localPath).toMatch(/^inbox\/m-ok\//);
    expect(parsed.attachments[0].data).toBeUndefined();
    expect(fakeTranscribe).toHaveBeenCalledTimes(1);
  });

  it('prepends the failure tag with the reason on failure', async () => {
    seedVoiceMessage('m-fail');
    const fakeTranscribe = vi.fn(async (): Promise<TranscribeResult> => ({ ok: false, reason: 'timeout' }));

    await applyVoiceTranscription(AG, SESS, 'm-fail', fakeTranscribe);

    const parsed = JSON.parse(readRow('m-fail').content);
    expect(parsed.text).toBe(`${voiceTranscriptFailedTag('timeout')}\n`);
    expect(parsed.attachments[0].localPath).toMatch(/^inbox\/m-fail\//);
  });

  it('is a no-op when the message has no transcribable attachment', async () => {
    writeSessionMessage(AG, SESS, {
      id: 'm-plain',
      kind: 'chat-sdk',
      timestamp: now(),
      content: JSON.stringify({ text: 'hello' }),
    });
    const fakeTranscribe = vi.fn();

    await applyVoiceTranscription(AG, SESS, 'm-plain', fakeTranscribe);

    expect(fakeTranscribe).not.toHaveBeenCalled();
    expect(JSON.parse(readRow('m-plain').content).text).toBe('hello');
  });

  it('is a no-op when the message id does not exist', async () => {
    const fakeTranscribe = vi.fn();
    await expect(applyVoiceTranscription(AG, SESS, 'm-missing', fakeTranscribe)).resolves.toBeUndefined();
    expect(fakeTranscribe).not.toHaveBeenCalled();
  });
});
