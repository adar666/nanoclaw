/**
 * Shared "parse `content` as JSON, extract `.text`, join with `\n`, swallow
 * malformed rows" transcript-to-text helper.
 *
 * Extracted from `sweep.ts`, `judge/llm.ts`, and
 * `scenarios/guest-resolution.scenarios.ts`, which each independently
 * defined an identical, byte-for-byte copy of this function — the same
 * duplication class `truncateForError`/`MAX_ERROR_TEXT_CHARS` already had
 * before being extracted into `error-text.ts` (commit `c23246d2`), recurring
 * one file over. All three call sites now import this instead.
 */
import type { OutboundMessage } from '../src/db/session-db.js';

/** Every `messages_out` row's `content.text`, joined — the shared parse-or-skip-malformed-rows shape every scenario/judging/sweep module scans. */
export function transcriptText(transcript: OutboundMessage[]): string {
  return transcript
    .map((m) => {
      try {
        const parsed = JSON.parse(m.content) as { text?: unknown };
        return typeof parsed.text === 'string' ? parsed.text : '';
      } catch {
        return '';
      }
    })
    .join('\n');
}
