# Local Hebrew Voice-Note Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telegram voice notes sent to any of the three NanoClaw agents get transcribed on-device with a Hebrew-finetuned Whisper model, injected into the message text with a clear source tag, while the sender gets an immediate non-blocking acknowledgment instead of tens of seconds of silence.

**Architecture:** A new host-only module (`src/voice-transcription.ts`) wraps `ffmpeg` (OGG→WAV) + whisper.cpp's `whisper-cli` (Hebrew-forced ASR) behind a small typed API. `router.ts` gets a 3-point reach-in: detect a transcribable voice attachment, fire a fire-and-forget Hebrew ack through the existing delivery adapter, and — after the message is written and before the container wakes — rewrite the row's `content.text` in place with a tag-prefixed transcript or failure marker. The feature is shipped as the `/add-hebrew-transcription` skill (host `brew` packages + a 1.6GB model download + a real-audio smoke test), matching every other install-shaped capability in this project.

**Tech Stack:** Node/TypeScript (host), `better-sqlite3`, `child_process.execFile`, `whisper-cpp`/`ffmpeg` via Homebrew, `ivrit-ai/whisper-large-v3-turbo-ggml` (Hugging Face), vitest.

## Global Constraints

Copied verbatim from the approved spec (`docs/superpowers/specs/2026-08-05-hebrew-voice-transcription-design.md`):

- Telegram voice notes only — not WhatsApp, not email attachments, not uploaded Telegram audio files.
- Transcription runs host-side only. The container gets zero new tooling.
- Detection gate: `att.type === 'audio' && att.mimeType === 'audio/ogg' && !att.name` (the `name`/`file_name` field is what `@chat-adapter/telegram` uses to distinguish an uploaded audio file from a true voice note).
- Model: `ivrit-ai/whisper-large-v3-turbo-ggml`, downloaded to `~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin`. Language token forced to `he` — this model's auto-detect is degraded by its finetune.
- Engine: whisper.cpp's `whisper-cli` (Homebrew, Metal-accelerated), not faster-whisper/Python.
- `ffmpeg` is a required additional host dependency — `whisper-cli` only accepts 16-bit WAV, it does not decode OGG/Opus.
- On this machine, Homebrew lives at `/opt/homebrew` (confirmed via `brew --prefix`); binaries are addressed by absolute path (`/opt/homebrew/bin/whisper-cli`, `/opt/homebrew/bin/ffmpeg`) because NanoClaw's launchd job's `PATH` (`/usr/local/bin:/usr/bin:/bin:/Users/uriel/.local/bin`) does not include it.
- Feature on/off switch: file presence only (both binaries + the model file). No DB config, no env var.
- 30-second wall-clock deadline shared across the ffmpeg + whisper-cli steps.
- Success tag: `[VOICE-TRANSCRIPT]`. Failure tag: `[VOICE-TRANSCRIPT-FAILED: <reason>]` where reason is `not-installed | timeout | error`. Both prepended to `content.text`; message is never dropped; the `.ogg` attachment (and its `[audio: ...]` line) is untouched in both outcomes.
- Ack text (fixed literal, not agent-generated): `🎙️ קיבלתי הודעה קולית, מעבדת…` — sent via `getDeliveryAdapter()?.deliver(...)`, fire-and-forget (never awaited on the message's critical path), `.catch()`-logged.
- Host log gets the specific failure reason at `WARN`; the chat tag is the only user-facing surfacing (no separate notification channel — this is a per-message failure, not a persistent-outage case).
- Smoke test must use real Hebrew audio (not silence/a tone) and assert non-empty, Hebrew-Unicode-matching output.
- Agent-group instruction updates go in `instructions.prepend.md` for `dm-with-uriel`, `dm-with-partner`, `household` — not `_ping-test`.
- Skill name: `/add-hebrew-transcription`, following the `/add-ollama-tool` convention (own folder, `SKILL.md` + `REMOVE.md`, files copied into the tree on apply).

---

## Task 1: Core module — `src/voice-transcription.ts`

**Files:**
- Create: `src/voice-transcription.ts`
- Test: `src/voice-transcription.test.ts`

**Interfaces:**
- Consumes: `openInboundDb(agentGroupId: string, sessionId: string): Database.Database` and `sessionDir(agentGroupId: string, sessionId: string): string`, both already exported from `src/session-manager.ts`.
- Produces (used by Task 2):
  - `export const VOICE_NOTE_ACK_TEXT: string`
  - `export function hasTranscribableVoiceAttachment(contentStr: string): boolean`
  - `export async function applyVoiceTranscription(agentGroupId: string, sessionId: string, messageId: string, transcribe?: (oggPath: string) => Promise<TranscribeResult>): Promise<void>`
  - `export type TranscribeResult = { ok: true; text: string } | { ok: false; reason: 'not-installed' | 'timeout' | 'error' }`

- [ ] **Step 1: Write the failing tests**

Create `src/voice-transcription.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/voice-transcription.test.ts`
Expected: FAIL — `Cannot find module './voice-transcription.js'` (or similar; the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/voice-transcription.ts`:

```ts
/**
 * Local Hebrew voice-note transcription — host-only, Telegram voice notes
 * only. See docs/superpowers/specs/2026-08-05-hebrew-voice-transcription-design.md.
 *
 * Model: ivrit-ai/whisper-large-v3-turbo-ggml (Hebrew finetune of Whisper
 * large-v3-turbo, ggml format). Engine: whisper.cpp's `whisper-cli` (Metal
 * on Apple Silicon). `ffmpeg` converts Telegram's OGG/Opus voice notes to
 * the 16kHz mono WAV whisper-cli requires — it does not decode Opus itself.
 *
 * The feature is off unless both binaries and the model file exist at their
 * fixed paths below — no DB config, no env toggle. Installed via the
 * `/add-hebrew-transcription` skill.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { log } from './log.js';
import { openInboundDb, sessionDir } from './session-manager.js';

const execFileAsync = promisify(execFile);

// This machine's Homebrew lives at /opt/homebrew (Apple Silicon). NanoClaw's
// launchd job's PATH does not include it (confirmed:
// /usr/local/bin:/usr/bin:/bin:/Users/uriel/.local/bin), so binaries are
// addressed by absolute path rather than relying on PATH lookup.
const HOMEBREW_BIN = '/opt/homebrew/bin';
const DEFAULT_WHISPER_CLI = path.join(HOMEBREW_BIN, 'whisper-cli');
const DEFAULT_FFMPEG = path.join(HOMEBREW_BIN, 'ffmpeg');
export const MODEL_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'models',
  'ivrit-whisper-large-v3-turbo-ggml.bin',
);

const DEFAULT_TIMEOUT_MS = 30_000;

/** Fixed literal — the agent hasn't run yet when this fires, so this is not agent-generated. */
export const VOICE_NOTE_ACK_TEXT = '🎙️ קיבלתי הודעה קולית, מעבדת…';

export const VOICE_TRANSCRIPT_TAG = '[VOICE-TRANSCRIPT]';

export function voiceTranscriptFailedTag(reason: TranscribeFailure['reason']): string {
  return `[VOICE-TRANSCRIPT-FAILED: ${reason}]`;
}

export interface TranscribeSuccess {
  ok: true;
  text: string;
}
export interface TranscribeFailure {
  ok: false;
  reason: 'not-installed' | 'timeout' | 'error';
}
export type TranscribeResult = TranscribeSuccess | TranscribeFailure;

/**
 * True Telegram voice notes only. `@chat-adapter/telegram` maps both
 * `raw.voice` (a real voice note) and `raw.audio` (an uploaded audio file)
 * to `{type:'audio'}` — but only `raw.audio` carries a `name`
 * (`file_name`). Absence of `name` is the reliable signal.
 */
export function isTranscribableVoiceAttachment(att: Record<string, unknown>): boolean {
  return att.type === 'audio' && att.mimeType === 'audio/ogg' && !att.name;
}

/** Parses inbound content once; true if it carries a transcribable voice note. */
export function hasTranscribableVoiceAttachment(contentStr: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contentStr);
  } catch {
    return false;
  }
  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  return Array.isArray(attachments) && attachments.some(isTranscribableVoiceAttachment);
}

interface TranscribeOpts {
  whisperCli?: string;
  ffmpeg?: string;
  modelPath?: string;
  timeoutMs?: number;
}

function isKilledForTimeout(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string } | null;
  return !!e && (e.killed === true || e.signal === 'SIGTERM');
}

/**
 * ffmpeg OGG/Opus -> 16kHz mono WAV, then whisper-cli forced to Hebrew
 * (`-l he` — the model's language auto-detection is degraded by its
 * finetune, per ivrit-ai's own README). Both steps share one wall-clock
 * deadline (default 30s). Temp WAV is always cleaned up.
 */
export async function transcribeVoiceNote(oggPath: string, opts: TranscribeOpts = {}): Promise<TranscribeResult> {
  const whisperCli = opts.whisperCli ?? DEFAULT_WHISPER_CLI;
  const ffmpeg = opts.ffmpeg ?? DEFAULT_FFMPEG;
  const modelPath = opts.modelPath ?? MODEL_PATH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!fs.existsSync(whisperCli) || !fs.existsSync(ffmpeg) || !fs.existsSync(modelPath)) {
    return { ok: false, reason: 'not-installed' };
  }

  const deadline = Date.now() + timeoutMs;
  const tempWav = path.join(os.tmpdir(), `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);

  try {
    const ffmpegBudget = deadline - Date.now();
    if (ffmpegBudget <= 0) return { ok: false, reason: 'timeout' };
    try {
      await execFileAsync(ffmpeg, ['-y', '-i', oggPath, '-ar', '16000', '-ac', '1', tempWav], {
        timeout: ffmpegBudget,
      });
    } catch (err) {
      if (isKilledForTimeout(err)) return { ok: false, reason: 'timeout' };
      log.warn('Voice-note ffmpeg conversion failed', { oggPath, err });
      return { ok: false, reason: 'error' };
    }

    const whisperBudget = deadline - Date.now();
    if (whisperBudget <= 0) return { ok: false, reason: 'timeout' };
    let stdout: string;
    try {
      // -l he: force Hebrew (required — see module header). -nt: no
      // timestamps. -np: suppress whisper-cli's own progress/log prints so
      // stdout is just the transcript.
      const result = await execFileAsync(whisperCli, ['-m', modelPath, '-l', 'he', '-nt', '-np', '-f', tempWav], {
        timeout: whisperBudget,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
    } catch (err) {
      if (isKilledForTimeout(err)) return { ok: false, reason: 'timeout' };
      log.warn('Voice-note whisper-cli transcription failed', { oggPath, err });
      return { ok: false, reason: 'error' };
    }

    const text = stdout.trim();
    if (!text) {
      log.warn('Voice-note transcription produced empty output', { oggPath });
      return { ok: false, reason: 'error' };
    }
    return { ok: true, text };
  } finally {
    await fs.promises.rm(tempWav, { force: true }).catch(() => {});
  }
}

/**
 * Re-reads a just-inserted inbound row, transcribes any transcribable voice
 * attachment it carries, and rewrites the row's `content.text` in place
 * with a [VOICE-TRANSCRIPT]/[VOICE-TRANSCRIPT-FAILED: reason] tag prepended.
 * No-op if the row has no matching attachment or no longer exists. Must run
 * after writeSessionMessage and before the container wakes, so the agent
 * never sees the pre-transcription text. The attachment entry itself (and
 * thus the saved .ogg + its `[audio: ...]` line) is untouched either way.
 *
 * `transcribe` is injectable for tests; production callers use the default.
 */
export async function applyVoiceTranscription(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  transcribe: (oggPath: string) => Promise<TranscribeResult> = transcribeVoiceNote,
): Promise<void> {
  const readDb = openInboundDb(agentGroupId, sessionId);
  let row: { content: string } | undefined;
  try {
    row = readDb.prepare('SELECT content FROM messages_in WHERE id = ?').get(messageId) as
      | { content: string }
      | undefined;
  } finally {
    readDb.close();
  }
  if (!row) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.content);
  } catch {
    return;
  }
  const attachments = parsed.attachments as Array<Record<string, unknown>> | undefined;
  const voiceAtt = attachments?.find(isTranscribableVoiceAttachment);
  if (!voiceAtt || typeof voiceAtt.localPath !== 'string') return;

  const oggPath = path.join(sessionDir(agentGroupId, sessionId), voiceAtt.localPath);
  const result = await transcribe(oggPath);

  const existingText = typeof parsed.text === 'string' ? parsed.text : '';
  parsed.text = result.ok
    ? `${VOICE_TRANSCRIPT_TAG}\n${result.text}\n\n${existingText}`
    : `${voiceTranscriptFailedTag(result.reason)}\n${existingText}`;

  const writeDb = openInboundDb(agentGroupId, sessionId);
  try {
    writeDb.prepare('UPDATE messages_in SET content = ? WHERE id = ?').run(JSON.stringify(parsed), messageId);
  } finally {
    writeDb.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/voice-transcription.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: `TypeScript: No errors found`

- [ ] **Step 6: Commit**

```bash
git add src/voice-transcription.ts src/voice-transcription.test.ts
git commit -m "feat: Hebrew voice-note transcription core module

isTranscribableVoiceAttachment/hasTranscribableVoiceAttachment gate on
true Telegram voice notes (no name field). transcribeVoiceNote wraps
ffmpeg OGG->WAV + whisper-cli forced to Hebrew, 30s shared deadline.
applyVoiceTranscription rewrites an inbound row's content.text with a
success/failure tag after the fact, before the container wakes.

Not wired into the router yet — that's the next commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Wire `router.ts` — ack + transcription hook

**Files:**
- Modify: `src/router.ts:20-37` (imports), `src/router.ts:470-528` (`deliverToAgent`)
- Test: `src/host-core.test.ts` (append a new `describe` block; add two mocks near the existing top-level mocks)

**Interfaces:**
- Consumes (from Task 1): `hasTranscribableVoiceAttachment`, `applyVoiceTranscription`, `VOICE_NOTE_ACK_TEXT` from `./voice-transcription.js`.
- Consumes (existing): `getDeliveryAdapter(): ChannelDeliveryAdapter | null` from `./delivery.js` (`ChannelDeliveryAdapter.deliver(channelType, platformId, threadId, kind, content): Promise<string | undefined>`).

- [ ] **Step 1: Write the failing tests**

In `src/host-core.test.ts`, add two mocks alongside the existing ones near the top of the file (after the existing `vi.mock('./container-runner.js', ...)` block, before the `vi.mock('./config.js', ...)` block — order among `vi.mock` calls doesn't matter, hoisting handles it):

```ts
const mockDeliver = vi.fn();
vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: vi.fn(() => ({ deliver: mockDeliver })),
}));

vi.mock('./voice-transcription.js', async () => {
  const actual = await vi.importActual<typeof import('./voice-transcription.js')>('./voice-transcription.js');
  return { ...actual, applyVoiceTranscription: vi.fn().mockResolvedValue(undefined) };
});
```

Then append this new `describe` block at the end of the file (after the closing `});` of `describe('delivery', ...)` at line 1434):

```ts
describe('router — voice-note transcription', () => {
  beforeEach(() => {
    mockDeliver.mockReset().mockResolvedValue(undefined);
    createAgentGroup({
      id: 'ag-voice',
      name: 'Voice Agent',
      folder: 'voice-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-voice',
      channel_type: 'telegram',
      platform_id: 'tg-chat-1',
      name: 'Voice Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-voice',
      messaging_group_id: 'mg-voice',
      agent_group_id: 'ag-voice',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  function voiceEvent(id: string): InboundEvent {
    return {
      channelType: 'telegram',
      platformId: 'tg-chat-1',
      threadId: null,
      message: {
        id,
        kind: 'chat-sdk',
        content: JSON.stringify({
          text: '',
          attachments: [{ type: 'audio', mimeType: 'audio/ogg', size: 999 }],
        }),
        timestamp: now(),
      },
    };
  }

  it('sends the Hebrew ack and calls applyVoiceTranscription before the container wakes', async () => {
    const { routeInbound } = await import('./router.js');
    const { applyVoiceTranscription, VOICE_NOTE_ACK_TEXT } = await import('./voice-transcription.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(voiceEvent('msg-voice-1'));
    // Flush the fire-and-forget ack promise's microtask queue.
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockDeliver).toHaveBeenCalledWith(
      'telegram',
      'tg-chat-1',
      null,
      'chat-sdk',
      JSON.stringify({ text: VOICE_NOTE_ACK_TEXT }),
    );
    expect(applyVoiceTranscription).toHaveBeenCalledWith('ag-voice', expect.any(String), expect.stringContaining('msg-voice-1'));

    const ackOrder = mockDeliver.mock.invocationCallOrder[0];
    const transcribeOrder = (applyVoiceTranscription as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const wakeOrder = (wakeContainer as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(transcribeOrder).toBeLessThan(wakeOrder);
    expect(ackOrder).toBeLessThan(wakeOrder);
  });

  it('does not send an ack or call applyVoiceTranscription for a plain text message', async () => {
    const { routeInbound } = await import('./router.js');
    const { applyVoiceTranscription } = await import('./voice-transcription.js');

    await routeInbound({
      channelType: 'telegram',
      platformId: 'tg-chat-1',
      threadId: null,
      message: { id: 'msg-plain-1', kind: 'chat-sdk', content: JSON.stringify({ text: 'hi' }), timestamp: now() },
    });

    expect(mockDeliver).not.toHaveBeenCalled();
    expect(applyVoiceTranscription).not.toHaveBeenCalled();
  });

  it('a failed ack does not block message delivery', async () => {
    mockDeliver.mockRejectedValue(new Error('telegram rate limited'));
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    await expect(routeInbound(voiceEvent('msg-voice-2'))).resolves.toBeUndefined();
    expect(wakeContainer).toHaveBeenCalled();

    const dbPath = inboundDbPath('ag-voice', findSession('mg-voice', null)!.id);
    const db = new Database(dbPath);
    const row = db.prepare('SELECT * FROM messages_in WHERE id LIKE ?').get('%msg-voice-2%');
    db.close();
    expect(row).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/host-core.test.ts -t "voice-note transcription"`
Expected: FAIL — `mockDeliver` never called / `applyVoiceTranscription` never called (router doesn't wire either yet).

- [ ] **Step 3: Wire router.ts**

Edit `src/router.ts`. Add to the import block (after the existing `session-manager.js` import line):

```ts
import { resolveSession, writeSessionMessage, writeOutboundDirect } from './session-manager.js';
import { getDeliveryAdapter } from './delivery.js';
import { hasTranscribableVoiceAttachment, applyVoiceTranscription, VOICE_NOTE_ACK_TEXT } from './voice-transcription.js';
```

In `deliverToAgent`, right after `deliveryAddr` is computed (after the closing `};` of the `const deliveryAddr = ...` block, before the `// Command gate:` comment), insert:

```ts
  // Hebrew voice-note transcription (Telegram voice notes only — see
  // src/voice-transcription.ts). The ack fires immediately, fire-and-forget:
  // a slow or failing adapter call must never delay or block the message
  // it's announcing.
  const hasVoiceNote = hasTranscribableVoiceAttachment(event.message.content);
  if (hasVoiceNote) {
    const adapter = getDeliveryAdapter();
    if (adapter) {
      void adapter
        .deliver(deliveryAddr.channelType, deliveryAddr.platformId, deliveryAddr.threadId, 'chat-sdk', JSON.stringify({ text: VOICE_NOTE_ACK_TEXT }))
        .catch((err) => log.warn('Voice-note ack failed to send', { err }));
    }
  }

```

Change the `writeSessionMessage` call to capture the message id in a local (was inlined before):

```ts
  const messageId = messageIdForAgent(event.message.id, agent.agent_group_id);

  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageId,
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: event.message.content,
    trigger: wake ? 1 : 0,
  });

  if (hasVoiceNote) {
    await applyVoiceTranscription(session.agent_group_id, session.id, messageId);
  }

```

(This replaces the old inline `id: messageIdForAgent(event.message.id, agent.agent_group_id),` in the `writeSessionMessage` call with `id: messageId,`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/host-core.test.ts`
Expected: PASS — all tests in the file, including the 3 new ones and every pre-existing one (the two new mocks must not perturb unrelated describe blocks).

- [ ] **Step 5: Full host suite + typecheck**

Run: `pnpm test && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: all green, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/router.ts src/host-core.test.ts
git commit -m "feat: wire Hebrew voice-note transcription into the router

Ack fires fire-and-forget the moment a transcribable voice attachment
is detected — never awaited, so a slow/failed Telegram call can't
delay or block the message. applyVoiceTranscription runs after the
row is written and before the container wakes, so the agent only ever
sees the tagged text.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Install host dependencies on this machine

This task has no test in the vitest sense — it's provisioning the actual machine `voice-transcription.ts`'s hardcoded paths expect. Task 4 verifies it.

- [ ] **Step 1: Install whisper-cpp and ffmpeg**

```bash
brew install whisper-cpp ffmpeg
```

Expected: both install successfully (or report already-installed). Verify:

```bash
ls -la /opt/homebrew/bin/whisper-cli /opt/homebrew/bin/ffmpeg
```

Expected: both paths exist.

- [ ] **Step 2: Download the ivrit-ai ggml model**

```bash
mkdir -p ~/.config/nanoclaw/models
curl -L -o ~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin \
  https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin
```

Expected: download completes, file size ~1.6GB.

```bash
ls -la ~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin
```

Expected: `-rw-...` file, size close to `1624555275` bytes (confirmed exact size via `HEAD` during the spec's research phase).

- [ ] **Step 3: No commit** — this step only changes machine state (installed packages, downloaded model), not the repo. Proceed to Task 4.

---

## Task 4: Real-binary flag verification + Hebrew fixture + manual smoke test

**Files:**
- Modify: `src/voice-transcription.ts` (only if `whisper-cli`'s actual flags differ from the `-nt -np` assumption baked in during Task 1 — verify against the real binary before touching anything)
- Create (temporary, moved into the skill folder in Task 5): a short Hebrew audio fixture

**Interfaces:** none new — this task validates Task 1's assumptions against ground truth now that the real binary exists (Task 3).

- [ ] **Step 1: Confirm whisper-cli's actual CLI flags**

```bash
/opt/homebrew/bin/whisper-cli --help | head -60
```

Check specifically for: a language flag (expected `-l LANG, --language LANG`), a no-timestamps flag (expected `-nt, --no-timestamps`), and a way to suppress non-transcript output to stdout (expected `-np, --no-prints`, but confirm the exact spelling — some whisper.cpp releases use `--print-progress false` / different flag names). **If any of `-l`, `-nt`, `-np` don't match what `--help` shows, edit the `execFileAsync(whisperCli, [...])` args array in `src/voice-transcription.ts`'s `transcribeVoiceNote` to the correct flags, and re-run `pnpm exec vitest run src/voice-transcription.test.ts`** (the tests assert on argument *content* via `expect.arrayContaining(['-l', 'he', '-m', FAKE_MODEL])`, not full-array equality, so a flag-name fix here shouldn't break them unless `-l`/`-m` themselves changed — if the language or model flag spelling differs, update both the implementation and that assertion).

- [ ] **Step 2: Generate a Hebrew audio fixture**

macOS's built-in `Carmit` voice (`he_IL`) is confirmed available on this machine (`say -v '?' | grep -i hebrew` → `Carmit he_IL`).

```bash
mkdir -p /tmp/voice-fixture
say -v Carmit "שלום, זוהי בדיקת מערכת" -o /tmp/voice-fixture/hebrew-sample.aiff
/opt/homebrew/bin/ffmpeg -y -i /tmp/voice-fixture/hebrew-sample.aiff -c:a libopus /tmp/voice-fixture/hebrew-sample.ogg
```

Expected: `/tmp/voice-fixture/hebrew-sample.ogg` exists, a few KB, playable (`afplay /tmp/voice-fixture/hebrew-sample.aiff` to sanity-check the source audio says something intelligible).

- [ ] **Step 3: Run a real end-to-end transcription against the fixture**

```bash
cd /Users/uriel/Projects/nanoclaw-v2
pnpm exec tsx -e "
import { transcribeVoiceNote } from './src/voice-transcription.js';
transcribeVoiceNote('/tmp/voice-fixture/hebrew-sample.ogg').then((r) => {
  console.log(JSON.stringify(r, null, 2));
});
"
```

Expected: `{ "ok": true, "text": "<some Hebrew text>" }`, single-digit seconds. Confirm the output text matches the Hebrew Unicode block (`[֐-׿]`) — eyeball it, it should contain recognizable Hebrew characters, not necessarily a perfect transcription of the exact phrase (ASR isn't perfect, that's fine — this step verifies the pipeline works end-to-end, not transcription accuracy).

If the result is `{ "ok": false, "reason": "error" }`, re-run Step 1 more carefully — the most likely cause is a flag mismatch that made whisper-cli exit non-zero or print to stdout in a way that breaks the "empty output = error" check.

- [ ] **Step 4: Copy the working fixture into the repo for Task 5**

```bash
mkdir -p /tmp/nanoclaw-hebrew-fixture-staging
cp /tmp/voice-fixture/hebrew-sample.ogg /tmp/nanoclaw-hebrew-fixture-staging/
```

(Staged here; Task 5 moves it into the skill folder as part of packaging.)

- [ ] **Step 5: If flags changed, run the full suite and commit**

Only if Step 1 required an edit to `src/voice-transcription.ts`:

```bash
pnpm exec vitest run src/voice-transcription.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
git add src/voice-transcription.ts
git commit -m "fix: correct whisper-cli flags against the real installed binary

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

If no edit was needed, no commit for this task.

---

## Task 5: Package as the `/add-hebrew-transcription` skill

**Files:**
- Create: `.claude/skills/add-hebrew-transcription/SKILL.md`
- Create: `.claude/skills/add-hebrew-transcription/REMOVE.md`
- Create: `.claude/skills/add-hebrew-transcription/voice-transcription.ts` (copy of `src/voice-transcription.ts`)
- Create: `.claude/skills/add-hebrew-transcription/voice-transcription.test.ts` (copy of `src/voice-transcription.test.ts`)
- Create: `.claude/skills/add-hebrew-transcription/router.host-core.test.snippet.md` (the `describe('router — voice-note transcription', ...)` block + its two mocks, as a doc snippet apply instructions can reference — since it's an *append into an existing large test file*, not a standalone file copy)
- Create: `.claude/skills/add-hebrew-transcription/fixtures/hebrew-sample.ogg` (from Task 4)
- Create: `.claude/skills/add-hebrew-transcription/smoke-test.sh`

**Interfaces:** none — this is packaging, not new runtime behavior. The files already work (Tasks 1-4); this task makes them reinstallable/removable for future installs and upgrades.

- [ ] **Step 1: Create the skill folder and copy canonical source files**

```bash
mkdir -p .claude/skills/add-hebrew-transcription/fixtures
cp src/voice-transcription.ts .claude/skills/add-hebrew-transcription/voice-transcription.ts
cp src/voice-transcription.test.ts .claude/skills/add-hebrew-transcription/voice-transcription.test.ts
cp /tmp/nanoclaw-hebrew-fixture-staging/hebrew-sample.ogg .claude/skills/add-hebrew-transcription/fixtures/hebrew-sample.ogg
```

- [ ] **Step 2: Write the smoke-test script**

Create `.claude/skills/add-hebrew-transcription/smoke-test.sh`:

```bash
#!/bin/bash
# Real-audio smoke test for /add-hebrew-transcription. A model that loads
# and returns empty passes a trivial smoke test and fails in production —
# this project already hit exactly that failure shape once with Ollama
# returning valid-JSON-but-empty summaries. This asserts non-empty AND
# Hebrew-matching output against a real Hebrew audio fixture, not silence
# or a tone.
set -euo pipefail

FIXTURE="$(dirname "$0")/fixtures/hebrew-sample.ogg"

RESULT=$(cd "$(git rev-parse --show-toplevel)" && pnpm exec tsx -e "
import { transcribeVoiceNote } from './src/voice-transcription.js';
transcribeVoiceNote('$FIXTURE').then((r) => {
  if (!r.ok) { console.error('SMOKE TEST FAILED:', JSON.stringify(r)); process.exit(1); }
  if (!r.text.trim()) { console.error('SMOKE TEST FAILED: empty transcript'); process.exit(1); }
  if (!/[֐-׿]/.test(r.text)) { console.error('SMOKE TEST FAILED: no Hebrew characters in output:', r.text); process.exit(1); }
  console.log('SMOKE TEST PASSED:', r.text);
});
")

echo "$RESULT"
```

```bash
chmod +x .claude/skills/add-hebrew-transcription/smoke-test.sh
```

- [ ] **Step 3: Run the smoke test to confirm it passes on this (already-applied) install**

```bash
.claude/skills/add-hebrew-transcription/smoke-test.sh
```

Expected: `SMOKE TEST PASSED: <hebrew text>`, exit code 0.

- [ ] **Step 4: Write the test-append snippet doc**

Create `.claude/skills/add-hebrew-transcription/router.host-core.test.snippet.md`:

```markdown
# Router test snippet — apply into `src/host-core.test.ts`

Add these two mocks near the file's existing top-level `vi.mock` calls
(after `vi.mock('./container-runner.js', ...)`):

​```ts
const mockDeliver = vi.fn();
vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: vi.fn(() => ({ deliver: mockDeliver })),
}));

vi.mock('./voice-transcription.js', async () => {
  const actual = await vi.importActual<typeof import('./voice-transcription.js')>('./voice-transcription.js');
  return { ...actual, applyVoiceTranscription: vi.fn().mockResolvedValue(undefined) };
});
​```

Then append the full `describe('router — voice-note transcription', ...)`
block from this skill's own history (see the implementation plan commit
that added it, or `git log -p --follow src/host-core.test.ts` for the
exact text) at the end of the file. Skip this step entirely if the block
is already present (`grep -q "voice-note transcription" src/host-core.test.ts`).
```

- [ ] **Step 5: Write SKILL.md**

Create `.claude/skills/add-hebrew-transcription/SKILL.md`:

```markdown
---
name: add-hebrew-transcription
description: Add local, free, on-device Hebrew voice-note transcription for Telegram — ivrit-ai's Hebrew-finetuned Whisper via whisper.cpp, host-only, no cloud API.
---

# Add Hebrew Voice-Note Transcription

Telegram voice notes are received by NanoClaw today but never transcribed —
the agent only sees `[audio: name — saved to path]`. This skill adds local,
on-device transcription using [ivrit-ai/whisper-large-v3-turbo-ggml](https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml)
(a Hebrew finetune of Whisper large-v3-turbo) via [whisper.cpp](https://github.com/ggml-org/whisper.cpp) —
the same "runs locally, no API key, no per-call cost" principle as the
Ollama integration. Telegram voice notes only; uploaded audio files,
WhatsApp voice messages, and email attachments are untouched.

An immediate Hebrew acknowledgment is sent the moment a voice note is
detected — fire-and-forget, so a slow or failed ack can never delay or
block the actual message. Transcription runs host-side only; the container
gets no new tooling.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/voice-transcription.ts` exists. If it does, skip to Phase 3
(Verify).

### Check prerequisites

This skill targets Apple Silicon Macs with Homebrew at `/opt/homebrew`
(confirm: `brew --prefix` should print `/opt/homebrew`). On Intel Macs or
Linux, the hardcoded `/opt/homebrew/bin` paths in `voice-transcription.ts`
need adjusting to match `brew --prefix`'s actual output — do that first if
this isn't an Apple Silicon Mac.

## Phase 2: Apply

### Install host dependencies

​```bash
brew install whisper-cpp ffmpeg
​```

### Download the model

​```bash
mkdir -p ~/.config/nanoclaw/models
curl -L -o ~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin \
  https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin
​```

This is a ~1.6GB download. The feature is off (every voice note gets a
`[VOICE-TRANSCRIPT-FAILED: not-installed]` tag, never dropped) until both
the binaries and this file are in place — there's no separate config flag.

### Copy the skill's source and tests into the host tree

​```bash
S=.claude/skills/add-hebrew-transcription
cp $S/voice-transcription.ts      src/voice-transcription.ts
cp $S/voice-transcription.test.ts src/voice-transcription.test.ts
​```

### Wire the router reach-in

Edit `src/router.ts`. Add to the import block (after the existing
`session-manager.js` import):

​```ts
import { getDeliveryAdapter } from './delivery.js';
import { hasTranscribableVoiceAttachment, applyVoiceTranscription, VOICE_NOTE_ACK_TEXT } from './voice-transcription.js';
​```

In `deliverToAgent`, right after `deliveryAddr` is computed and before the
`// Command gate:` comment, insert:

​```ts
  const hasVoiceNote = hasTranscribableVoiceAttachment(event.message.content);
  if (hasVoiceNote) {
    const adapter = getDeliveryAdapter();
    if (adapter) {
      void adapter
        .deliver(deliveryAddr.channelType, deliveryAddr.platformId, deliveryAddr.threadId, 'chat-sdk', JSON.stringify({ text: VOICE_NOTE_ACK_TEXT }))
        .catch((err) => log.warn('Voice-note ack failed to send', { err }));
    }
  }

​```

Change `writeSessionMessage`'s call to use a named `messageId` local instead
of the inline `messageIdForAgent(...)` call, and add the transcription call
right after it:

​```ts
  const messageId = messageIdForAgent(event.message.id, agent.agent_group_id);

  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageId,
    // ...unchanged fields
  });

  if (hasVoiceNote) {
    await applyVoiceTranscription(session.agent_group_id, session.id, messageId);
  }
​```

### Apply the router test snippet

Follow `$S/router.host-core.test.snippet.md` to add the mocks and the
`describe('router — voice-note transcription', ...)` block into
`src/host-core.test.ts`. Skip if already present.

### Add the smoke-test fixture

​```bash
mkdir -p $S/fixtures  # already present if copying the skill folder verbatim
​```

The fixture (`fixtures/hebrew-sample.ogg`) ships with this skill — no
generation needed on a fresh install.

## Phase 3: Verify

​```bash
pnpm exec vitest run src/voice-transcription.test.ts src/host-core.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
.claude/skills/add-hebrew-transcription/smoke-test.sh
​```

All three must pass: unit + router integration tests green, no type
errors, and the real-audio smoke test prints `SMOKE TEST PASSED: <hebrew
text>`. The smoke test is the one that actually exercises the installed
`whisper-cli` binary and downloaded model — the vitest suite mocks the
subprocess boundary, so it can't catch a bad install by itself.

## Next steps

Update the agent groups' instructions so they know what the
`[VOICE-TRANSCRIPT]`/`[VOICE-TRANSCRIPT-FAILED: reason]` tags mean and to
confirm consequential content (names, numbers, emails) from a transcribed
message before acting on it — see
`docs/superpowers/specs/2026-08-05-hebrew-voice-transcription-design.md`'s
"Agent instructions" section for the exact guidance to add per group.

## Troubleshooting

- **Every voice note gets `[VOICE-TRANSCRIPT-FAILED: not-installed]`**:
  `ls -la /opt/homebrew/bin/whisper-cli /opt/homebrew/bin/ffmpeg
  ~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin` — one of
  the three is missing.
- **`[VOICE-TRANSCRIPT-FAILED: timeout]` routinely**: run the smoke test
  directly and time it; if a single short voice note is taking anywhere
  near 30s, something is wrong with the install (falling back to CPU
  instead of Metal is the most likely cause) — this isn't expected
  behavior to just wait out.
- **`[VOICE-TRANSCRIPT-FAILED: error]`**: check `logs/nanoclaw.error.log`
  for the underlying ffmpeg/whisper-cli error NanoClaw logged at `WARN`.
```

- [ ] **Step 6: Write REMOVE.md**

Create `.claude/skills/add-hebrew-transcription/REMOVE.md`:

```markdown
# Remove Hebrew Voice-Note Transcription

Reverses everything `SKILL.md` applied.

## Revert the router reach-in

Edit `src/router.ts`:
- Delete the two import lines added for this skill (`getDeliveryAdapter`
  from `./delivery.js` and the `voice-transcription.js` import).
- Delete the `hasVoiceNote`/ack block inserted after `deliveryAddr`.
- Delete the `if (hasVoiceNote) { await applyVoiceTranscription(...); }`
  block after `writeSessionMessage`.
- Revert `writeSessionMessage`'s `id:` field back to the inline
  `messageIdForAgent(event.message.id, agent.agent_group_id)` call and
  remove the now-unused `messageId` local, OR leave the local in place if
  nothing else in the function depends on removing it — either is fine,
  just make sure the transcription call site is gone.

## Remove copied files

​```bash
rm src/voice-transcription.ts
rm src/voice-transcription.test.ts
​```

## Remove the test-append block

Delete the `describe('router — voice-note transcription', ...)` block and
its two `vi.mock` calls (`./delivery.js`, `./voice-transcription.js`) from
`src/host-core.test.ts`.

## Remove the downloaded model (optional — ask first)

​```bash
rm -f ~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin
​```

## Uninstall host packages (optional — ask first)

`whisper-cpp` and `ffmpeg` may be used by other tools on this machine.
Confirm with the operator before uninstalling:

​```bash
brew uninstall whisper-cpp ffmpeg
​```

## Remove agent-instruction blocks

If the "Next steps" guidance was added to any `groups/<name>/instructions.prepend.md`
files (marked with `<!-- add-hebrew-transcription:start -->` /
`<!-- add-hebrew-transcription:end -->` comments), delete each marked
block.

## Verify

​```bash
pnpm exec vitest run
pnpm exec tsc --noEmit -p tsconfig.json
​```

Both green, no leftover references to `voice-transcription` anywhere in
`src/`.
```

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/add-hebrew-transcription/
git commit -m "feat: package Hebrew voice-note transcription as /add-hebrew-transcription

Follows the /add-ollama-tool convention: skill folder carries the
canonical source, tests, a real-Hebrew-audio smoke test (not silence/
a tone — this project already hit the 'valid but empty' failure shape
once with Ollama), SKILL.md apply steps, and a REMOVE.md that reverses
every change including the router reach-in.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Agent-instruction updates

**Files:**
- Modify: `groups/dm-with-uriel/instructions.prepend.md`
- Modify: `groups/dm-with-partner/instructions.prepend.md`
- Modify: `groups/household/instructions.prepend.md`

**Interfaces:** none — documentation only, no code.

- [ ] **Step 1: Append the shared block to all three files**

For each of the three files, append (using marker comments so `REMOVE.md`
can strip exactly this block later):

```markdown

<!-- add-hebrew-transcription:start -->
## Voice notes

Telegram voice notes are transcribed automatically before you see them.
Two tags mark this:

- `[VOICE-TRANSCRIPT]` — transcription succeeded. The text that follows is
  what speech recognition heard, not what was typed.
- `[VOICE-TRANSCRIPT-FAILED: reason]` — transcription failed (reason is
  `not-installed`, `timeout`, or `error`). The voice note itself is still
  attached (`[audio: ...]` line) but you have no transcript. Say so plainly
  — "I got a voice note but couldn't transcribe it" — rather than acting on
  nothing or asking a confused follow-up.

A transcribed message was **spoken, not typed**, and passed through
automatic speech recognition — names, numbers, and email addresses in it
may be wrong. If a transcribed message contains something that would
trigger an action with consequences (a sender address to classify, a
person's name to record, an amount), **confirm it back before acting**
rather than treating it as literal.
<!-- add-hebrew-transcription:end -->
```

Run for each file:

```bash
for f in groups/dm-with-uriel/instructions.prepend.md \
         groups/dm-with-partner/instructions.prepend.md \
         groups/household/instructions.prepend.md; do
  cat >> "$f" << 'EOF'

<!-- add-hebrew-transcription:start -->
## Voice notes

Telegram voice notes are transcribed automatically before you see them.
Two tags mark this:

- `[VOICE-TRANSCRIPT]` — transcription succeeded. The text that follows is
  what speech recognition heard, not what was typed.
- `[VOICE-TRANSCRIPT-FAILED: reason]` — transcription failed (reason is
  `not-installed`, `timeout`, or `error`). The voice note itself is still
  attached (`[audio: ...]` line) but you have no transcript. Say so plainly
  — "I got a voice note but couldn't transcribe it" — rather than acting on
  nothing or asking a confused follow-up.

A transcribed message was **spoken, not typed**, and passed through
automatic speech recognition — names, numbers, and email addresses in it
may be wrong. If a transcribed message contains something that would
trigger an action with consequences (a sender address to classify, a
person's name to record, an amount), **confirm it back before acting**
rather than treating it as literal.
<!-- add-hebrew-transcription:end -->
EOF
done
```

- [ ] **Step 2: Verify**

```bash
for f in groups/dm-with-uriel/instructions.prepend.md \
         groups/dm-with-partner/instructions.prepend.md \
         groups/household/instructions.prepend.md; do
  grep -q "add-hebrew-transcription:start" "$f" && echo "OK: $f" || echo "MISSING: $f"
done
grep -q "add-hebrew-transcription" groups/_ping-test/instructions.prepend.md && echo "UNEXPECTED: _ping-test got it" || echo "OK: _ping-test untouched"
```

Expected: `OK` for all four lines.

- [ ] **Step 3: Commit**

Installation-specific files (per this project's PR hygiene rules, `groups/`
content is install-specific and normally excluded from upstream PRs) — commit
locally for this install's own history, but note it's not upstream-PR
material:

```bash
git add groups/dm-with-uriel/instructions.prepend.md \
        groups/dm-with-partner/instructions.prepend.md \
        groups/household/instructions.prepend.md
git commit -m "docs: teach the three agents about voice-transcript tags

VOICE-TRANSCRIPT / VOICE-TRANSCRIPT-FAILED meaning, and to confirm
consequential content (sender addresses, names, amounts) from a
transcribed message before acting on it rather than treating ASR
output as literal.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Final verification and live end-to-end check

**Files:** none new — this task only runs and observes.

- [ ] **Step 1: Full test suite**

```bash
pnpm test
```

Expected: every test file passes, including the new `voice-transcription.test.ts` and the expanded `host-core.test.ts`.

- [ ] **Step 2: Typecheck and build**

```bash
pnpm exec tsc --noEmit -p tsconfig.json
pnpm run build
```

Expected: both clean.

- [ ] **Step 3: Skill smoke test one more time**

```bash
.claude/skills/add-hebrew-transcription/smoke-test.sh
```

Expected: `SMOKE TEST PASSED: <hebrew text>`.

- [ ] **Step 4: Verify the packaged skill's docs haven't drifted from the live source**

This exact failure shape already happened once in this plan: Task 5's
`SKILL.md` and `router.host-core.test.snippet.md` were packaged from plan
text written *before* Task 2's review found the missing-`mg.instance` bug,
so they briefly documented stale, already-fixed code. Reading carefully
didn't catch it — a mechanical check does. Since the plan text that
generates a skill's docs is written once and the source it describes can
change underneath it (exactly what happened here), this check belongs in
every future run of this pattern, not just this one.

Extract every fenced ` ```ts ` code block from the skill's `SKILL.md` and
`router.host-core.test.snippet.md`, and confirm each is a verbatim
(byte-for-byte) substring of the live file it's meant to mirror:

```bash
S=.claude/skills/add-hebrew-transcription
rm -rf /tmp/skill-drift-check
mkdir -p /tmp/skill-drift-check

awk '/^```ts$/{n++; f="/tmp/skill-drift-check/skill-block" n ".ts"; capture=1; next} /^```$/{capture=0} capture{print > f}' "$S/SKILL.md"
awk '/^```ts$/{n++; f="/tmp/skill-drift-check/snippet-block" n ".ts"; capture=1; next} /^```$/{capture=0} capture{print > f}' "$S/router.host-core.test.snippet.md"

drift_found=0
for f in /tmp/skill-drift-check/skill-block*.ts; do
  [ -s "$f" ] || continue
  block=$(cat "$f")
  live=$(cat src/router.ts)
  if [[ "$live" != *"$block"* ]]; then
    echo "DRIFT: $f is not a verbatim substring of src/router.ts"
    drift_found=1
  fi
done
for f in /tmp/skill-drift-check/snippet-block*.ts; do
  [ -s "$f" ] || continue
  block=$(cat "$f")
  live=$(cat src/host-core.test.ts)
  if [[ "$live" != *"$block"* ]]; then
    echo "DRIFT: $f is not a verbatim substring of src/host-core.test.ts"
    drift_found=1
  fi
done
rm -rf /tmp/skill-drift-check

if [ "$drift_found" = "1" ]; then
  echo "FAIL: packaged skill docs have drifted from the live source"
  exit 1
fi
echo "OK: all packaged code snippets are verbatim substrings of the live source"
```

Expected: `OK: all packaged code snippets are verbatim substrings of the
live source`, no `DRIFT:` lines. If any block doesn't match, fix the
skill's `.md` file (not the live source) so it reflects reality, then
re-run this check.

- [ ] **Step 5: Restart the NanoClaw service so the running process picks up the change**

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
sleep 3
launchctl print gui/$(id -u)/$(launchd_label) 2>&1 | grep -E "state|pid"
tail -30 logs/nanoclaw.log
```

Expected: `state = running`, a `pid`, clean startup log (no new errors).

- [ ] **Step 6: Manual end-to-end check — ask the user to send a real Telegram voice note**

This is the one step that can't be automated: ask the user to send a short
Hebrew voice note to one of the three agents (e.g. Yulanda, the original
use case) and confirm, in order:
1. A Hebrew ack (`🎙️ קיבלתי הודעה קולית, מעבדת…`) arrives within ~1 second.
2. The agent's eventual reply shows it understood the spoken content (not
   `[audio: ...]`-only confusion).
3. Check `logs/nanoclaw.log` / `logs/nanoclaw.error.log` for any `WARN`
   from the transcription path — there shouldn't be one on a successful run.

If the ack arrives but the reply looks like transcription failed, check
the session's `inbound.db` directly for the actual tag written:

```bash
pnpm exec tsx scripts/q.ts data/v2-sessions/<agent-group>/<session>/inbound.db \
  "SELECT content FROM messages_in ORDER BY seq DESC LIMIT 1"
```

- [ ] **Step 6b: Manual regression check — plain text messages must be completely unaffected**

Task 6's instructions.prepend.md addition tells the agent to confirm
consequential content back before acting when a message carries the
`[VOICE-TRANSCRIPT]`/`[VOICE-TRANSCRIPT-FAILED: reason]` tag. That
guidance must be strictly gated on the tag's presence — a plain typed
message never had the tag and must produce byte-identical behavior to
before this feature existed. This matters most for `dm-with-uriel`
(Yulanda): she can now write sender rules and start the recorder off
spoken input, so an over-broad reading of "confirm before acting" that
leaks into ordinary typed messages — the agent hedging, re-confirming, or
second-guessing normal requests it would have just acted on before — would
be a worse regression than the transcription-accuracy problem the
instruction exists to prevent.

Ask the user to send one ordinary plain-text message (not a voice note) to
each of the three real agent groups (`dm-with-uriel`, `dm-with-partner`,
`household`) — something that would normally just get acted on directly,
ideally including at least one message to Yulanda that would trigger a
consequential action (e.g. "recall the last email from X" or a sender-rule
edit) so the check exercises the exact class of action the instruction
addendum is about. Confirm for each:
1. No confirmation-loop or hedging language appears that wasn't there
   before this feature (compare against how the same agent handled a
   similar plain-text request prior to this change, if recent chat history
   allows a comparison).
2. The agent acts on the request normally — it does not ask "did you mean
   to send a voice note" or otherwise reference transcription at all.
3. `inbound.db` for that message's session confirms the row's `content.text`
   has no `[VOICE-TRANSCRIPT...]` tag (sanity-check that detection
   correctly didn't fire for a text-only message):

```bash
pnpm exec tsx scripts/q.ts data/v2-sessions/<agent-group>/<session>/inbound.db \
  "SELECT content FROM messages_in ORDER BY seq DESC LIMIT 1"
```

This step needs the user to actually send the three messages — it can't be
simulated from the controller session without impersonating them on a real
channel.

- [ ] **Step 7: No commit** — this task is verification only. If Step 6 surfaces a bug, fix it as a new commit outside this plan's scope (or loop back to the relevant task above if it's small).

---

## Task 8: Verify recorder control end-to-end from Telegram; fix the same PATH bug if it's there

Unrelated feature, same bug class, found in passing while investigating this
plan's own PATH issue. The recorder feature (`src/modules/recorder/`,
built earlier today, never tested end-to-end) triggers negotiator's
`run.sh`, which backgrounds `node run.js`, which bare-`spawn`s `ffmpeg` in
three places in the sibling `negotiator` repo (`src/capture.js:41`,
`src/wav-split.js:43`, `src/devices.js:9`) — none of them on NanoClaw's
launchd job's PATH (`/usr/local/bin:/usr/bin:/bin:/Users/uriel/.local/bin`,
confirmed via the plist; `/opt/homebrew/bin/ffmpeg` is not in it). `node`
itself happens to resolve (`/usr/local/bin/node` is on that PATH), so
`run.sh start` would report success and negotiator's process would stay
alive — while capturing no audio. This is invisible to `pnpm test`:
`recorder.test.ts` mocks `node:child_process`'s `execFile` entirely, so it
asserts argv shape, never real binary resolution.

**Files:**
- Modify: `src/modules/recorder/apply.ts:33-39` (add a shared `SPAWN_ENV` constant), `:69-73`, `:110`, `:130-134` (pass it)
- Modify: `src/modules/recorder/recorder.test.ts:142-150`, `:193-208` (assert the widened `PATH` is actually passed)

**Interfaces:** no new exports — `SPAWN_ENV` is a module-private constant, not consumed outside `apply.ts`.

- [ ] **Step 1: Reproduce the bug live, before touching any code**

Send a Telegram message to the `dm-with-uriel` agent asking it to start a
test recording (the guard in `src/modules/recorder/guard.ts:22-27` only
allows this agent group — sending it from any other chat will be denied,
which is expected and not the thing under test here). E.g.: "תתחילי הקלטת בדיקה, מישהו בשם בדיקה".

Wait ~5 seconds, then check what actually happened on the host:

```bash
cat ~/Projects/negotiator/.run/negotiator.pid 2>/dev/null
kill -0 "$(cat ~/Projects/negotiator/.run/negotiator.pid 2>/dev/null)" 2>&1 && echo "process alive" || echo "process dead"
ls -t ~/Projects/negotiator/logs/run-*.log | head -1 | xargs tail -30
```

Expected (bug present): the pidfile exists and the process is alive (`node
run.js` resolved fine), but the log tail shows an `ENOENT`/`spawn ffmpeg
ENOENT`-shaped error, or no audio-segment activity — success reported to
Telegram, no real capture happening. This is the "confusing" failure mode
the earlier investigation predicted: it doesn't crash, it just doesn't
work.

Stop the (non-functional) test recording before proceeding:

```bash
~/Projects/negotiator/run.sh stop --no-summary
```

(`--no-summary` skips negotiator's own transcript-summarization step,
which has nothing to summarize since no audio was captured.)

If Step 1 shows the recording actually worked (audio segments present, no
ENOENT in the log) — the bug isn't present, possibly because something
already fixed the PATH elsewhere. **Stop here, don't apply Steps 2-5, and
tell the user the recorder already works** rather than making an
unnecessary change.

- [ ] **Step 2: Write the failing test assertions**

Edit `src/modules/recorder/recorder.test.ts`. In the `applyRecorderStart`
describe block, extend the existing "invokes run.sh" test:

```ts
  it('invokes run.sh with a fixed binary and them/context as argv values, never a shell string', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'HoursReportWebApp' }, session);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockExecFile.mock.calls[0]!;
    expect(bin).toMatch(/run\.sh$/);
    expect(args).toEqual(['start', '--', '--lang', 'he', '--them', 'דניס', '--context', 'HoursReportWebApp']);
    // /opt/homebrew/bin isn't on NanoClaw's launchd job's PATH — negotiator's
    // run.sh backgrounds a bare `ffmpeg` spawn three levels down, which
    // would silently fail to resolve without this. See apply.ts's SPAWN_ENV.
    expect((opts as { env?: Record<string, string> }).env?.PATH).toContain('/opt/homebrew/bin');
  });
```

And in `applyRecorderStop / stopAndIngest`, extend the "stops, marks the
row stopped..." test:

```ts
  it('stops, marks the row stopped, chains into the second-brain ingest, and notifies "stopped"', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockExecFile.mockClear();
    mockNotifyAgent.mockClear();

    await applyRecorderStop({}, session);

    expect(mockExecFile).toHaveBeenCalledTimes(2); // run.sh stop, then the ingest
    const [stopBin, stopArgs, stopOpts] = mockExecFile.mock.calls[0]!;
    expect(stopBin).toMatch(/run\.sh$/);
    expect(stopArgs).toEqual(['stop']);
    expect((stopOpts as { env?: Record<string, string> }).env?.PATH).toContain('/opt/homebrew/bin');
    const [ingestBin, ingestArgs] = mockExecFile.mock.calls[1]!;
    expect(ingestArgs).toContain('--dir');
    expect(ingestArgs.some((a: string) => a.includes('ingest-recorder'))).toBe(true);
    void ingestBin;

    const running = getRunningRecorderSession();
    expect(running).toBeUndefined();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('stopped'));
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm exec vitest run src/modules/recorder/recorder.test.ts`
Expected: FAIL on both new `PATH` assertions — `apply.ts` doesn't pass an
`env` option to `execFileAsync` yet, so `opts.env` is `undefined`.

- [ ] **Step 4: Fix `apply.ts`**

Edit `src/modules/recorder/apply.ts`. Add the shared env constant right
after the existing root constants (after the `NEGOTIATOR_LOGS_DIR` line):

```ts
const NEGOTIATOR_ROOT = process.env.NEGOTIATOR_ROOT || join(homedir(), 'Projects', 'negotiator');
const SECOND_BRAIN_ROOT = process.env.SECOND_BRAIN_ROOT || join(homedir(), 'Projects', 'second-brain');
const NEGOTIATOR_LOGS_DIR = join(NEGOTIATOR_ROOT, 'logs');

// Homebrew on Apple Silicon lives at /opt/homebrew, which is NOT on
// NanoClaw's launchd job's PATH (/usr/local/bin:/usr/bin:/bin:/Users/uriel/.local/bin
// — confirmed via ~/Library/LaunchAgents/com.nanoclaw-v2-*.plist). run.sh
// backgrounds `node run.js` bare (resolves fine, /usr/local/bin/node is on
// that PATH) which in turn bare-spawns `ffmpeg` three levels down
// (negotiator's capture.js/wav-split.js/devices.js) — NOT on that PATH.
// Every execFileAsync call below passes this widened PATH so the whole
// downstream chain inherits it, without touching the sibling negotiator
// repo. Same class of bug, same fix, as voice-transcription.ts's absolute
// binary paths — see docs/superpowers/specs/2026-08-05-hebrew-voice-transcription-design.md.
const SPAWN_ENV = {
  ...process.env,
  PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin`,
};
```

Then add `env: SPAWN_ENV` to each of the three `execFileAsync` calls'
options objects:

```ts
    await execFileAsync(
      join(NEGOTIATOR_ROOT, 'run.sh'),
      ['start', '--', '--lang', 'he', '--them', them, '--context', context],
      { cwd: NEGOTIATOR_ROOT, timeout: 15_000, env: SPAWN_ENV },
    );
```

```ts
    await execFileAsync(join(NEGOTIATOR_ROOT, 'run.sh'), ['stop'], {
      cwd: NEGOTIATOR_ROOT,
      timeout: 30_000,
      env: SPAWN_ENV,
    });
```

```ts
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(SECOND_BRAIN_ROOT, 'dist/bin/ingest-recorder.js'), '--dir', NEGOTIATOR_LOGS_DIR],
      { cwd: SECOND_BRAIN_ROOT, timeout: 60_000, env: SPAWN_ENV },
    );
```

(The ingest call doesn't need `ffmpeg`, but passing the same widened
`PATH` is harmless and keeps all three call sites consistent rather than
special-casing one.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/modules/recorder/recorder.test.ts`
Expected: PASS, all cases including the two new `PATH` assertions.

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: `TypeScript: No errors found`

- [ ] **Step 7: Rebuild and restart, then re-verify live**

Since this changes host code, rebuild and restart the running service so
the fix is actually live before re-testing:

```bash
pnpm run build
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
sleep 3
```

Repeat Step 1's live Telegram test (start a recording, wait ~5s, check the
pidfile/process/log tail, stop it). Expected this time: the log tail shows
no `ENOENT`, and — the real confirmation — actual transcript activity:

```bash
ls -t ~/Projects/negotiator/logs/transcript-*.jsonl 2>/dev/null | head -1
```

Expected: a transcript file from just now exists and is non-empty. Stop
the recording (`~/Projects/negotiator/run.sh stop`) and confirm the
agent's Telegram reply reports it stopped and ingested successfully (per
`apply.ts`'s `stopAndIngest` wording), not the ingest-failure branch.

- [ ] **Step 8: Commit**

```bash
git add src/modules/recorder/apply.ts src/modules/recorder/recorder.test.ts
git commit -m "fix: recorder control silently failed to capture audio under launchd

Same class of bug as voice-transcription.ts: NanoClaw's launchd job's
PATH doesn't include /opt/homebrew/bin. node itself resolved fine (on
PATH), so run.sh start reported success and the negotiator process
stayed alive — but its downstream bare ffmpeg spawns (capture.js,
wav-split.js, devices.js) couldn't resolve, so no audio was ever
captured. Confirmed live before fixing, not just inferred. Every
execFileAsync call in apply.ts now passes a widened PATH so the whole
run.sh -> node run.js -> ffmpeg chain inherits it, with no changes
needed in the sibling negotiator repo.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
