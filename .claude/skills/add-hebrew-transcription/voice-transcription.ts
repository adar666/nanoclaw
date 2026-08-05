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
 * (`file_name`). Before extraction: absence of `name` is the signal.
 * After extraction: check if the name looks auto-derived (timestamp pattern).
 */
export function isTranscribableVoiceAttachment(att: Record<string, unknown>): boolean {
  if (att.type !== 'audio' || att.mimeType !== 'audio/ogg') {
    return false;
  }
  // Pre-extraction: no name field means voice note
  if (!att.name) {
    return true;
  }
  // Post-extraction: check if name looks auto-derived (attachment-<timestamp>.ogg).
  // The pattern must match the format produced by deriveAttachmentName() in
  // src/attachment-naming.ts. If that module's naming convention changes, this
  // detection will silently fail — see the test that validates this coupling.
  // Edge case: a user-uploaded file literally named "attachment-<digits>.ogg"
  // will be misdetected as a voice note, but this is acceptable given the low
  // likelihood and the architectural constraint that attachment metadata is
  // lost after extraction.
  const name = String(att.name);
  return /^attachment-\d+\.ogg$/.test(name);
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
