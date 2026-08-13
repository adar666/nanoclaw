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

/** Not imported from media-ingestion.ts's sanitizeFilenameFragment (which
 *  handles Hebrew fine too, via \p{L}) — duplicated instead because that
 *  helper lives in a module this one deliberately doesn't depend on (see
 *  spec § "Explicitly out of scope" — no second-brain/media-ingestion
 *  coupling), and because this slug uses a narrower, explicit charset
 *  (ASCII alnum + the Hebrew block) rather than the general \p{L} class. */
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

/**
 * Writes the ONLY terminal signal the session ever gets for a given
 * transcribe_audio request. The MCP tool that triggers this flow already
 * told the agent "Transcription started — you will get a message tagged
 * [AUDIO-TRANSCRIPT-COMPLETE]", and the paired instructions.md tells the
 * agent not to poll or remind the user it's waiting — so every early-exit
 * path (bad input, refused path, missing file) and every job-level failure
 * MUST route through here, or the request silently vanishes forever.
 */
function deliverFailure(agentGroupId: string, sessionId: string, reason: 'not-installed' | 'timeout' | 'error'): void {
  writeSessionMessage(agentGroupId, sessionId, {
    id: `audio-transcript-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat-sdk',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ text: audioTranscriptFailedTag(reason), sender: 'system' }),
  });
}

const WORKSPACE_PREFIX = '/workspace/';

export async function handleTranscribeAudioImpl(
  content: Record<string, unknown>,
  session: Session,
  runJob: RunTranscriptionJob,
): Promise<void> {
  const rawPath = typeof content.path === 'string' ? content.path : undefined;
  if (!rawPath) {
    log.warn('transcribe_audio: missing path', { sessionId: session.id });
    deliverFailure(session.agent_group_id, session.id, 'error');
    return;
  }

  // The agent's context shows the file at the full mounted path
  // (/workspace/inbox/<msgId>/name) even though instructions.md asks it to
  // pass the path relative to the session dir. Strip the mount prefix
  // defensively so a copy-pasted full path still resolves correctly instead
  // of failing the containment check below for no visible reason.
  const relPath = rawPath.startsWith(WORKSPACE_PREFIX) ? rawPath.slice(WORKSPACE_PREFIX.length) : rawPath;

  const sessDir = sessionDir(session.agent_group_id, session.id);
  const hostPath = path.resolve(sessDir, relPath);
  if (!isPathInside(sessDir, hostPath)) {
    log.warn('transcribe_audio: path escapes session dir, refusing', { sessionId: session.id, relPath });
    deliverFailure(session.agent_group_id, session.id, 'error');
    return;
  }
  if (!fs.existsSync(hostPath)) {
    log.warn('transcribe_audio: file not found', { sessionId: session.id, hostPath });
    deliverFailure(session.agent_group_id, session.id, 'error');
    return;
  }

  // The string check above only rules out `../`-style traversal in the
  // agent-declared path itself — it does not follow symlinks. The session
  // dir is agent-writable, so a compromised/prompt-injected agent could
  // pre-place a symlink inside its own inbox pointing at an arbitrary host
  // path and then declare that path; isPathInside would pass (it's
  // textually inside sessDir) and fs.existsSync would follow the link.
  // Resolve both sides and re-check containment on the realpaths — same
  // idea as ensureContainedInboxDir's realpath guard for the write path
  // (src/inbox-safety.ts), adapted for this read path.
  let realSessDir: string;
  let realHostPath: string;
  try {
    realSessDir = fs.realpathSync(sessDir);
    realHostPath = fs.realpathSync(hostPath);
  } catch (err) {
    log.warn('transcribe_audio: failed to resolve real path, refusing', { sessionId: session.id, hostPath, err });
    deliverFailure(session.agent_group_id, session.id, 'error');
    return;
  }
  if (!isPathInside(realSessDir, realHostPath)) {
    log.warn('transcribe_audio: resolved path escapes session dir, refusing', {
      sessionId: session.id,
      hostPath,
      realHostPath,
    });
    deliverFailure(session.agent_group_id, session.id, 'error');
    return;
  }
  if (!fs.statSync(realHostPath).isFile()) {
    log.warn('transcribe_audio: resolved path is not a regular file, refusing', {
      sessionId: session.id,
      realHostPath,
    });
    deliverFailure(session.agent_group_id, session.id, 'error');
    return;
  }

  // Pass the already-resolved, already-validated realHostPath — not the
  // original hostPath — to the background job. runJob runs later, un-awaited;
  // between this check and whenever ffmpeg actually opens the file, a
  // compromised/prompt-injected agent has a window to swap hostPath for a
  // symlink pointing outside the session dir. Handing the job the raw
  // hostPath would let that swap defeat the containment check we just did —
  // the validated path and the path actually read must be the same path.
  const note = typeof content.note === 'string' ? content.note : undefined;
  void runJob(session.agent_group_id, session.id, realHostPath, note);
}

/**
 * The background job: transcribe, persist, deliver a tagged completion
 * message into the same session, wake the container if it's idle. Never
 * called awaited from the delivery-action handler (see above) — this is
 * where the actual multi-minute wait lives, fully decoupled from the
 * outbound-delivery poll loop.
 *
 * This feature is fire-and-forget by design: there's no job-status row or
 * polling tool, so the [AUDIO-TRANSCRIPT-COMPLETE]/[AUDIO-TRANSCRIPT-FAILED]
 * message this function writes is the ONLY terminal signal the user ever
 * gets. transcribeAudioFile itself never throws, but the persistence step
 * (saveTranscript's fs.writeFileSync) can — disk full, DB lock, etc. Without
 * a catch here, that exception would only reach the process-wide
 * unhandledRejection handler (log-and-continue) and the request would
 * silently vanish with zero user-visible indication anything happened. The
 * catch below still attempts to write a failure message so the session
 * always gets a terminal reply.
 *
 * The first try only wraps transcription + saveTranscript, deliberately —
 * and, on the failure-result branch, delivers the failure tag inline rather
 * than after the try, so a throw from transcribeAudioFile/saveTranscript
 * can't be confused with a clean not-ok result. Once saveTranscript has
 * succeeded (or a failure tag has already been delivered), the outcome is
 * decided: a failure in the steps after that point (writing the completion
 * message, waking the container) must NOT be reported as
 * [AUDIO-TRANSCRIPT-FAILED] — on the success path the transcript already
 * exists durably on disk and re-reporting it as failed would be actively
 * misleading; on the failure path a failure message was already delivered.
 * At most, log it.
 */
export async function runTranscriptionJob(
  agentGroupId: string,
  sessionId: string,
  hostAudioPath: string,
  _note?: string,
): Promise<void> {
  let text: string | undefined;
  try {
    const result = await transcribeAudioFile(hostAudioPath);
    if (result.ok) {
      const transcriptPath = saveTranscript(agentGroupId, path.basename(hostAudioPath), result.text);
      text = `${AUDIO_TRANSCRIPT_COMPLETE_TAG}\n${result.text}\n\n(נשמר גם ב-transcripts/${path.basename(transcriptPath)})`;
    } else {
      deliverFailure(agentGroupId, sessionId, result.reason);
    }
  } catch (err) {
    log.error('transcribe_audio: job failed unexpectedly', { agentGroupId, sessionId, hostAudioPath, err });
    try {
      deliverFailure(agentGroupId, sessionId, 'error');
    } catch (writeErr) {
      log.error('transcribe_audio: failed to deliver the failure message too', {
        agentGroupId,
        sessionId,
        writeErr,
      });
    }
    return;
  }

  try {
    if (text !== undefined) {
      writeSessionMessage(agentGroupId, sessionId, {
        id: `audio-transcript-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat-sdk',
        timestamp: new Date().toISOString(),
        content: JSON.stringify({ text, sender: 'system' }),
      });
    }

    if (!isContainerRunning(sessionId)) {
      const fresh = getSession(sessionId);
      if (fresh) {
        await wakeContainer(fresh);
      }
    }
  } catch (err) {
    log.error('transcribe_audio: post-result delivery step failed (message/wake did not complete)', {
      agentGroupId,
      sessionId,
      hostAudioPath,
      err,
    });
  }
}
