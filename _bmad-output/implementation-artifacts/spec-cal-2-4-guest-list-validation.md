---
title: 'Automatic Guest-List Validation Against Household Memory'
type: 'feature'
created: '2026-08-18'
status: 'done'
route: 'one-shot'
---

# Automatic Guest-List Validation Against Household Memory

## Intent

**Problem:** A guest named by first name only ("invite Guy") has no way to resolve to a real email today — `create_calendar_event`'s `EMAIL_RE` check just rejects the string with a generic error, leaving the agent to figure out what to do next with no guidance.

**Approach:** `container/skills/calendar/SKILL.md`-only change (spec cal-2.4, AD-19 revised at spec stage after discovering `people.md` is free-form prose, not a fixed schema — a `calendar.ts` code parser would be fragile). Teaches the agent to resolve a first-name/nickname/Hebrew-name guest against `groups/household/memory/household/people.md` itself, proactively, before calling `create_calendar_event` — mirroring the file's own existing sender-identity resolution rule (AD-5). Single match resolves silently; ambiguous match asks via numbered list; no match (or a known person with no recorded email) asks directly. `calendar.ts`'s existing `EMAIL_RE`/`validateGuestEmails` is unchanged — it remains the structural floor underneath this persona-level behavior, not replaced by it.

One review round (blind-hunter, verification-gap) found and fixed several real gaps in the first draft: a recognized person with no recorded email wasn't covered by the original single-match/ambiguous/no-match three-way split; `update_calendar_event`'s own section said nothing about guests despite that tool having no `guests` argument at all; Hebrew/nickname name forms weren't addressed even though this group's own memory file records people that way; no fallback for a group with no `people.md`; no guidance for multiple guests in one request; no mention that a real guest invite emails that person (a genuine side effect, not a no-consequence guess); the "same as any other ambiguous reference" framing overclaimed structural parity with the tool-backed candidate lists elsewhere in the skill. All fixed in the shipped text. Verification-gap flagged (not a fixable finding, an inherent limitation, logged to `deferred-work.md`): this class of persona-level instruction is unfalsifiable in this codebase — no eval harness exists to check the agent actually follows it, and a wrong-but-valid-shaped guessed email would pass `EMAIL_RE` silently.

## Suggested Review Order

- The whole change — one bullet in `create_calendar_event`'s argument docs, plus a one-line cross-reference in `update_calendar_event`'s section.
  [`SKILL.md:66`](../../container/skills/calendar/SKILL.md#L66)
