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
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../src/config.js';
import type { OutboundMessage } from '../../src/db/session-db.js';
import { truncateForError } from '../error-text.js';
import type { DeterministicJudgeResult } from '../judge/deterministic.js';
import type { ScenarioSet } from '../loader.js';
import { transcriptText } from '../transcript-text.js';

/** Devorah's real, on-file email — see groups/household/memory/household/people.md. */
export const DEVORAH_EMAIL = 'adardevora@gmail.com';

/**
 * The exact host path `setup.ts`'s `ensureEvalPeopleMount` mounts read-only
 * into the eval group — the real source of truth `DEVORAH_EMAIL` above must
 * never silently drift from.
 */
const PEOPLE_MD_HOST_PATH = path.join(GROUPS_DIR, 'household', 'memory', 'household', 'people.md');

/**
 * Runtime drift guard (deferred-work.md, 2026-08-25): `DEVORAH_EMAIL` is a
 * hardcoded literal in tracked, non-gitignored scenario source — duplicating,
 * and able to silently drift from, the real source of truth (household's own
 * gitignored `people.md`). A live parse of an arbitrary, loosely-structured
 * markdown file to EXTRACT "Devorah's email" specifically would itself be
 * fragile (a harmless reformatting of people.md could silently break
 * extraction, the opposite of AD-4's loud-failure stance) — so instead of
 * extracting, this asserts the hardcoded literal still appears verbatim in
 * the real file. Called lazily, from inside `check()` (only when a real
 * scenario turn is actually judged — never at scenario-set construction
 * time), so `loader.test.ts`'s hermetic unit tests, which build this
 * scenario set without any `people.md` fixture on disk, are unaffected. Any
 * future edit to `people.md` that changes or removes the email fails this
 * loud, before this scenario can give a meaningful verdict — never a silent
 * pass/fail for the wrong reason.
 */
function assertDevorahEmailMatchesPeopleMd(): void {
  if (!fs.existsSync(PEOPLE_MD_HOST_PATH)) {
    // ensureEvalPeopleMount (setup.ts) already asserts this file exists
    // before this scenario set is ever loaded for a real run (loadScenarios
    // runs after ensureEvalScenarioGroup in cli.ts's runCli) — this is
    // defense in depth, not the primary guarantee.
    throw new Error(
      `guest-resolution: expected household's people.md at "${PEOPLE_MD_HOST_PATH}" but it doesn't exist — ` +
        "can't verify DEVORAH_EMAIL against the real source of truth.",
    );
  }
  const content = fs.readFileSync(PEOPLE_MD_HOST_PATH, 'utf-8');
  if (!content.includes(DEVORAH_EMAIL)) {
    throw new Error(
      `guest-resolution: DEVORAH_EMAIL ("${DEVORAH_EMAIL}") no longer appears in the real ` +
        `"${PEOPLE_MD_HOST_PATH}" — this scenario's hardcoded expectation has drifted from the source of truth. ` +
        'Update DEVORAH_EMAIL to match the real recorded email before this scenario can give a meaningful verdict.',
    );
  }
}

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

/**
 * Shared by both scenarios below (deferred-work.md, 2026-08-25) — this exact
 * two-outcome check used to be copy-pasted independently into each
 * scenario's own `confirm()`, and the duplication already caused one of the
 * harness's own post-initiative bugs: `known-name` shipped with only a
 * single-branch version and needed a dedicated live-discovered fix (commit
 * `6a47cf07`) to catch up with `ambiguous-name`'s already-correct
 * two-branch version. A future scenario copied from either one now gets the
 * correct behavior by construction.
 */
function confirmDeletionOrNothingToDelete(transcript: OutboundMessage[]): boolean {
  const text = transcriptText(transcript);
  const deleted = text.includes(CLEANUP_CONFIRMATION_WORD) && !text.includes(NEGATION_WORD);
  const nothingToDelete = text.includes(NO_EVENT_TO_DELETE_PHRASE);
  return deleted || nothingToDelete;
}

/**
 * Matches common LLM quoting styles (English and Hebrew) around a mention —
 * a quoted email is exactly the "unrelated quote" false-positive shape this
 * check exists to reject, not a genuine confirmation.
 */
const QUOTE_CHARS = new Set(['"', "'", '״', '׳', '“', '”', '‘', '’', '`']);

function isQuoted(text: string, matchStart: number, matchEnd: number): boolean {
  const charBefore = text.slice(0, matchStart).trimEnd().at(-1);
  const charAfter = text.slice(matchEnd).trimStart().at(0);
  return (charBefore !== undefined && QUOTE_CHARS.has(charBefore)) || (charAfter !== undefined && QUOTE_CHARS.has(charAfter));
}

/**
 * A bare `text.includes(email)` matches the email appearing ANYWHERE in the
 * reply, including inside a refusal or an unrelated quote — the exact
 * false-positive shape `findTrailingMatch` (`text-matching.ts`) was built to
 * prevent for the LLM-judge/sweep parsers, but never applied here.
 *
 * `findTrailingMatch` itself doesn't fit this domain directly: its guard
 * requires the match to START a sentence (nothing but `.`/`!`/`?` +
 * whitespace, or the very start of text, immediately before it) — built for
 * a fixed protocol keyword ("SWEEP:"/"VERDICT:") that a genuine answer
 * always leads with. A raw email address is different: a genuine
 * confirmation naturally embeds it mid-sentence too ("נוסף כאורח:
 * <email>"), so requiring sentence-start would reject the real, passing
 * case, not just the false-positive one.
 *
 * The equivalent guard for this domain: take the LAST occurrence (never
 * "any occurrence anywhere" — same "genuine answer, not a stray earlier
 * mention" reasoning `findTrailingMatch` applies), then reject it if it's
 * quoted (`isQuoted`, the "unrelated quote" shape) or if a negation word
 * appears between the start of its own containing sentence and the email
 * itself (the "refusal" shape — reuses this file's existing `NEGATION_WORD`
 * check, same reasoning already applied to cleanup confirmation above).
 */
function emailConfirmedInReply(text: string, email: string): boolean {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...text.matchAll(new RegExp(escaped, 'g'))];
  if (matches.length === 0) return false;

  const last = matches[matches.length - 1];
  const start = last.index ?? 0;
  const end = start + email.length;
  if (isQuoted(text, start, end)) return false;

  const precedingText = text.slice(0, start);
  const sentenceStart = Math.max(
    precedingText.lastIndexOf('.'),
    precedingText.lastIndexOf('!'),
    precedingText.lastIndexOf('?'),
  );
  const sentence = precedingText.slice(sentenceStart + 1);
  return !sentence.includes(NEGATION_WORD);
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
            assertDevorahEmailMatchesPeopleMd();
            const text = transcriptText(transcript);
            const passed = emailConfirmedInReply(text, DEVORAH_EMAIL);
            return { passed, evidence: passed ? DEVORAH_EMAIL : truncateForError(text) };
          },
        },
        cleanup: {
          // Mirrors ambiguous-name's own two-outcome message below
          // (deferred-work.md, 2026-08-24) — this scenario's own event
          // creation isn't unconditionally guaranteed either (e.g. session
          // history/state from a prior run), so an honest "nothing to
          // delete" reply needs its own accepted phrase, same as the
          // ambiguous-name scenario already had.
          message:
            'אם יצרת אירוע עבור התרחיש הזה, מחק אותו ואשר בתשובתך במפורש עם המילה "נמחק" שהמחיקה הצליחה. ' +
            'אם לא יצרת אירוע כלל, אשר זאת במפורש עם המילים "אין אירוע למחוק".',
          confirm: confirmDeletionOrNothingToDelete,
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
          // below explicitly branches both cases (review finding: a bare
          // "confirm deletion" message/check would spuriously report a
          // cleanupError on every successful run, since an honest "nothing
          // to delete" reply never contains the deletion confirmation word).
          // Cleanup still runs unconditionally regardless of verdict, in
          // case the agent wrongly created an event anyway.
          message:
            'אם יצרת אירוע עבור התרחיש הזה, מחק אותו ואשר בתשובתך במפורש עם המילה "נמחק" שהמחיקה הצליחה. ' +
            'אם לא יצרת אירוע כלל (כי לא הצלחת לזהות את האורח/ת), אשר זאת במפורש עם המילים "אין אירוע למחוק".',
          confirm: confirmDeletionOrNothingToDelete,
        },
      },
    ],
  };
}
