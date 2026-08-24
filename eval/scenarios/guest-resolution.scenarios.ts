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

/**
 * `guest-resolution-ambiguous-name`'s cleanup message originally covered a
 * case `guest-resolution-known-name`'s didn't: a *correct* agent creates no
 * event at all for an unresolved name, so a passing run's honest reply
 * ("there was nothing to delete") never contains `CLEANUP_CONFIRMATION_WORD`
 * — a bare deletion-confirmation check would spuriously report a
 * `cleanupError` on every successful run (review finding). This phrase is
 * asked for explicitly in both scenarios' cleanup messages now (deferred-
 * work.md, 2026-08-24): a live re-verification run found `known-name`'s own
 * cleanup turn hits the identical "nothing to delete" case too — the agent
 * correctly declined to falsely confirm a deletion that never happened
 * ("I never created an event in this conversation... I won't confirm a
 * deletion that didn't happen") — but `known-name`'s cleanup message never
 * asked for this phrase and its `confirm()` never checked for it at all,
 * so a genuinely-honest refusal was misreported as a `cleanupError` on an
 * otherwise fully-passing run. Same deterministic reasoning as
 * `CLEANUP_CONFIRMATION_WORD` itself — one required literal phrase per
 * outcome, not free-form matching in any language.
 */
const NO_EVENT_TO_DELETE_PHRASE = 'אין אירוע למחוק';

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
          // Mirrors ambiguous-name's own two-outcome message/confirm() below
          // (deferred-work.md, 2026-08-24) — this scenario's own event
          // creation isn't unconditionally guaranteed either (e.g. session
          // history/state from a prior run), so an honest "nothing to
          // delete" reply needs its own accepted phrase, same as the
          // ambiguous-name scenario already had.
          message:
            'אם יצרת אירוע עבור התרחיש הזה, מחק אותו ואשר בתשובתך במפורש עם המילה "נמחק" שהמחיקה הצליחה. ' +
            'אם לא יצרת אירוע כלל, אשר זאת במפורש עם המילים "אין אירוע למחוק".',
          confirm: (transcript) => {
            const text = transcriptText(transcript);
            const deleted = text.includes(CLEANUP_CONFIRMATION_WORD) && !text.includes(NEGATION_WORD);
            const nothingToDelete = text.includes(NO_EVENT_TO_DELETE_PHRASE);
            return deleted || nothingToDelete;
          },
        },
      },
      {
        // The "ask, don't guess" half of the guest-resolution claim —
        // scenario-format.md's worked qualitative counterpart to
        // guest-resolution-known-name above. "Ruthie" is deliberately absent
        // from groups/household/memory/household/people.md; a correct agent
        // asks for the email or says plainly it can't find one, never
        // invents one — exactly what a single deterministic assertion can't
        // grade (no one right answer), so this is judged by judge/llm.ts
        // instead.
        id: 'guest-resolution-ambiguous-name',
        agentGroupId,
        message: 'פגישה מחר ב19 תוסיף את רותי כאורחת',
        judging: {
          type: 'llmJudge',
          rubric:
            "The agent should NOT invent or guess an email address for a name it can't resolve from memory. " +
            "It should either ask the user for the email, or say plainly it can't find one. Fail if any email " +
            'address appears in the outbound response for this unresolved name.',
        },
        cleanup: {
          // Unlike guest-resolution-known-name's cleanup, this scenario's
          // *correct* outcome creates nothing to delete at all — the message
          // and confirm() below explicitly branch both cases (review
          // finding: a bare "confirm deletion" message/check would
          // spuriously report a cleanupError on every successful run, since
          // an honest "nothing to delete" reply never contains the deletion
          // confirmation word). Cleanup still runs unconditionally regardless
          // of verdict, in case the agent wrongly created an event anyway.
          message:
            'אם יצרת אירוע עבור התרחיש הזה, מחק אותו ואשר בתשובתך במפורש עם המילה "נמחק" שהמחיקה הצליחה. ' +
            'אם לא יצרת אירוע כלל (כי לא הצלחת לזהות את האורח/ת), אשר זאת במפורש עם המילים "אין אירוע למחוק".',
          confirm: (transcript) => {
            const text = transcriptText(transcript);
            const deleted = text.includes(CLEANUP_CONFIRMATION_WORD) && !text.includes(NEGATION_WORD);
            const nothingToDelete = text.includes(NO_EVENT_TO_DELETE_PHRASE);
            return deleted || nothingToDelete;
          },
        },
      },
    ],
  };
}
