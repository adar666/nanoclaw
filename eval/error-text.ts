/**
 * Shared "bound how much of a pathological/verbose agent reply lands in a
 * thrown error message" helper — extracted from `sweep.ts` and
 * `judge/llm.ts`, which each defined an identical, independently-copied
 * `truncateForError`/`MAX_ERROR_TEXT_CHARS` pair (Story 3.1 duplicated
 * Story 2.2's own version rather than sharing it, same class of drift this
 * `eval/` tree's other shared helpers — `text-matching.ts` — were pulled
 * out to avoid).
 *
 * Fixes a real, if narrow, pre-existing bug in both original copies: a plain
 * `text.slice(0, max)` can land exactly between the two UTF-16 code units of
 * a surrogate pair (an emoji or other character outside the Basic
 * Multilingual Plane), embedding a lone, unpaired surrogate — an invalid/
 * malformed character — in the truncated output. Only reachable with a
 * multi-KB reply and a surrogate pair landing exactly at the cut point, so
 * purely cosmetic (a malformed character in an already-truncated diagnostic
 * string, no functional/security impact) — but free to fix once both
 * copies are unified into one.
 */

/** Bounds how much of a pathological/verbose reply lands in a thrown error message — logs/error trackers shouldn't take an unbounded string. */
export const MAX_ERROR_TEXT_CHARS = 500;

/**
 * Truncates `text` to at most `max` characters, appending a
 * `"… (truncated, <n> chars total)"` marker when it does. Never splits a
 * surrogate pair — if the naive cut point (`max`) would land on a high
 * surrogate (the first half of a two-unit character), the cut backs up by
 * one so the whole character is dropped together, not half-embedded.
 */
export function truncateForError(text: string, max = MAX_ERROR_TEXT_CHARS): string {
  if (text.length <= max) return text;
  const isHighSurrogate = text.charCodeAt(max - 1) >= 0xd800 && text.charCodeAt(max - 1) <= 0xdbff;
  const end = isHighSurrogate ? max - 1 : max;
  return `${text.slice(0, end)}… (truncated, ${text.length} chars total)`;
}
