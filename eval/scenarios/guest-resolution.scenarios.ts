/**
 * The `guest-resolution` scenario set — the real scenario that motivated
 * `scenario-format.md`, per that doc's own worked example ("drawn directly
 * from this session's live (manual, one-off) testing of the calendar
 * skill's guest-resolution claim").
 *
 * `guest-resolution-known-name` asserts the household's real recorded email
 * for "Devorah" (`groups/household/memory/household/people.md`, mounted
 * into the eval group by `setup.ts`'s `ensureEvalPeopleMount`) ends up as an
 * attendee — not a guess, not a placeholder, the actual on-file address —
 * scanned straight out of the real captured transcript text (Story 1.6's
 * `judgeDeterministic`, domain-agnostic; this file supplies the only
 * domain-specific piece, the `check` function itself).
 */
import type { OutboundMessage } from '../../src/db/session-db.js';
import type { DeterministicJudgeResult } from '../judge/deterministic.js';
import type { ScenarioSet } from '../loader.js';

/** Devorah's real, on-file email — see groups/household/memory/household/people.md. */
export const DEVORAH_EMAIL = 'adardevora@gmail.com';

/** Cleanup confirmation is scanned for this literal word — asked for explicitly in the cleanup message below, so matching stays deterministic rather than guessing at free-form phrasing. */
const CLEANUP_CONFIRMATION_WORD = 'נמחק';

/**
 * A bare substring match on `CLEANUP_CONFIRMATION_WORD` alone would
 * false-positive on an honest negative reply like `"לא נמחק, האירוע עדיין
 * קיים"` ("not deleted, the event still exists") — it still *contains* the
 * confirmation word (review finding). Requiring the reply not also contain
 * "לא" favors the safe direction: a false negative (reported as a
 * cleanupError even though it may have actually succeeded, prompting a
 * manual look) over a false positive (silently missing a real leaked
 * calendar event).
 */
const NEGATION_WORD = 'לא';

/** Every `messages_out` row's `content.text`, joined — the same shape every scenario's check/confirm scans. */
function transcriptText(transcript: OutboundMessage[]): string {
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

export function guestResolutionScenarioSet(agentGroupId: string): ScenarioSet {
  return {
    name: 'guest-resolution',
    scenarios: [
      {
        id: 'guest-resolution-known-name',
        agentGroupId,
        message: 'פגישה מחר ב19 תוסיף את דבורה כאורחת',
        judging: {
          type: 'deterministic',
          check: ({ transcript }): DeterministicJudgeResult => {
            const text = transcriptText(transcript);
            const passed = text.includes(DEVORAH_EMAIL);
            return { passed, evidence: passed ? DEVORAH_EMAIL : text };
          },
        },
        cleanup: {
          message: 'מחק את האירוע שיצרת הרגע עבור התרחיש הזה, ואשר בתשובתך במפורש עם המילה "נמחק" שהמחיקה הצליחה.',
          confirm: (transcript) => {
            const text = transcriptText(transcript);
            return text.includes(CLEANUP_CONFIRMATION_WORD) && !text.includes(NEGATION_WORD);
          },
        },
      },
    ],
  };
}
