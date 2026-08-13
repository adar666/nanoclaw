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

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';

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
