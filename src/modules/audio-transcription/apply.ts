/**
 * On-demand audio-file transcription — the agent-invoked counterpart to
 * src/voice-transcription.ts's automatic short-voice-note pipeline. Handles
 * uploaded audio FILES (raw.audio with a file_name), which that pipeline
 * explicitly leaves untouched. See
 * docs/superpowers/specs/2026-08-13-audio-file-transcription-report-design.md.
 *
 * This file has two halves:
 *   - saveTranscript / tag helpers (this task) — pure persistence, no I/O
 *     beyond the filesystem.
 *   - handleTranscribeAudio / runTranscriptionJob (added next) — the
 *     delivery-action handler and the background job it fires without
 *     awaiting.
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { isContainerRunning, wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import type { DeliveryActionHandler } from '../../delivery.js';
import { isPathInside } from '../../inbox-safety.js';
import { log } from '../../log.js';
import { sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { transcribeAudioFile } from '../../voice-transcription.js';

export const AUDIO_TRANSCRIPT_COMPLETE_TAG = '[AUDIO-TRANSCRIPT-COMPLETE]';

export function audioTranscriptFailedTag(reason: 'not-installed' | 'timeout' | 'error'): string {
  return `[AUDIO-TRANSCRIPT-FAILED: ${reason}]`;
}

/** Same charset policy as media-ingestion.ts's sanitizeFilenameFragment
 *  (control chars stripped, path separators stripped) but keeps Hebrew —
 *  source filenames are routinely Hebrew (e.g. a forwarded call recording's
 *  auto-generated Telegram name). Duplicated rather than imported: that
 *  helper lives in a module this one deliberately doesn't depend on (see
 *  spec § "Explicitly out of scope" — no second-brain/media-ingestion
 *  coupling). */
function slugify(sourceFilename: string): string {
  const base = sourceFilename.replace(/\.[^./]+$/, '');
  const slug = base
    .replace(/[^a-zA-Z0-9֐-׿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'audio';
}

/**
 * Persists a transcript into the agent group's own durable workspace —
 * `groups/<folder>/transcripts/<timestamp>-<slug>.md` — so it's available
 * for future reference independent of whether a report was ever requested
 * from it, and survives session/container churn (the session inbox has no
 * host-side GC but is not a *guaranteed* durable store either — see spec
 * § "Current state").  Creates the transcripts/ directory on first write.
 * Returns the absolute path written.
 */
export function saveTranscript(agentGroupId: string, sourceFilename: string, transcriptText: string): string {
  const group = getAgentGroup(agentGroupId);
  if (!group) {
    throw new Error(`saveTranscript: unknown agent group ${agentGroupId}`);
  }

  const transcriptsDir = path.join(GROUPS_DIR, group.folder, 'transcripts');
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const slug = slugify(sourceFilename);

  // Handle potential collisions from rapid consecutive calls in same millisecond
  let filePath = path.join(transcriptsDir, `${timestamp}-${slug}.md`);
  let counter = 1;
  while (fs.existsSync(filePath)) {
    filePath = path.join(transcriptsDir, `${timestamp}-${slug}-${counter}.md`);
    counter++;
  }

  const body = [
    `# Transcript: ${sourceFilename}`,
    '',
    `- Date: ${now.toISOString()}`,
    `- Source: ${sourceFilename}`,
    '',
    '---',
    '',
    transcriptText,
    '',
  ].join('\n');

  fs.writeFileSync(filePath, body, 'utf-8');
  return filePath;
}

type RunTranscriptionJob = (
  agentGroupId: string,
  sessionId: string,
  hostAudioPath: string,
  note?: string,
) => Promise<void>;

/**
 * Delivery-action handler for the `transcribe_audio` system action (written
 * by the container's `transcribe_audio` MCP tool). Resolves the
 * agent-declared relative path against the session dir, refuses anything
 * that escapes it, and — if the file exists — fires the background job
 * WITHOUT awaiting it (`void runJob(...)`). This is a hard requirement: the
 * outbound-delivery poll loop that calls this handler must never be blocked
 * by a multi-minute whisper-cli run. `runJob` is injectable for tests
 * (default: the real `runTranscriptionJob`), same pattern as
 * voice-transcription.ts's `applyVoiceTranscription`.
 */
export const handleTranscribeAudio: DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
) => handleTranscribeAudioImpl(content, session, runTranscriptionJob);

export async function handleTranscribeAudioImpl(
  content: Record<string, unknown>,
  session: Session,
  runJob: RunTranscriptionJob,
): Promise<void> {
  const relPath = typeof content.path === 'string' ? content.path : undefined;
  if (!relPath) {
    log.warn('transcribe_audio: missing path', { sessionId: session.id });
    return;
  }

  const sessDir = sessionDir(session.agent_group_id, session.id);
  const hostPath = path.resolve(sessDir, relPath);
  if (!isPathInside(sessDir, hostPath)) {
    log.warn('transcribe_audio: path escapes session dir, refusing', { sessionId: session.id, relPath });
    return;
  }
  if (!fs.existsSync(hostPath)) {
    log.warn('transcribe_audio: file not found', { sessionId: session.id, hostPath });
    return;
  }

  const note = typeof content.note === 'string' ? content.note : undefined;
  void runJob(session.agent_group_id, session.id, hostPath, note);
}

/**
 * The background job: transcribe, persist, deliver a tagged completion
 * message into the same session, wake the container if it's idle. Never
 * called awaited from the delivery-action handler (see above) — this is
 * where the actual multi-minute wait lives, fully decoupled from the
 * outbound-delivery poll loop.
 */
export async function runTranscriptionJob(
  agentGroupId: string,
  sessionId: string,
  hostAudioPath: string,
  _note?: string,
): Promise<void> {
  const result = await transcribeAudioFile(hostAudioPath);

  let text: string;
  if (result.ok) {
    const transcriptPath = saveTranscript(agentGroupId, path.basename(hostAudioPath), result.text);
    text = `${AUDIO_TRANSCRIPT_COMPLETE_TAG}\n${result.text}\n\n(נשמר גם ב-transcripts/${path.basename(transcriptPath)})`;
  } else {
    text = audioTranscriptFailedTag(result.reason);
  }

  writeSessionMessage(agentGroupId, sessionId, {
    id: `audio-transcript-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat-sdk',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ text }),
  });

  if (!isContainerRunning(sessionId)) {
    const fresh = getSession(sessionId);
    if (fresh) {
      await wakeContainer(fresh);
    }
  }
}
