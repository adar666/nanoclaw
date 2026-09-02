/**
 * Shared provenance helpers (retro action item, context-sharing-and-provenance
 * initiative) — `cleanReason`/`parseProvenance` were independently
 * re-implemented in `src/cli/resources/tasks.ts` and
 * `src/modules/provenance-digest.ts` (same host runtime/package — unlike the
 * genuinely cross-runtime duplication `container/agent-runner/src/mcp-tools/
 * documents.ts` has no choice but to carry its own copy of), and
 * `src/modules/self-mod/self-mod-log.ts` had its own narrower, inconsistent
 * cleaning. One shared implementation now backs all three host-side writers/
 * readers, closing the drift the epic-level retrospective found: a
 * whitespace-only reason was treated differently in each domain, and a fix
 * to one copy's malformed-shape handling never propagated to the others.
 */
import type { TaskProvenance } from './scheduling/create.js';

/** A stored reason longer than this is truncated — a one-line annotation, not a document. */
export const MAX_REASON_CHARS = 200;

/**
 * Collapses any whitespace run (including newlines — these are all stored
 * as single-line log/JSON entries) to a single space, trims, and caps
 * length. A whitespace-only or empty input resolves to `undefined`, never
 * an empty string — a caller checking `reason ? ... : null` must never see
 * `''` land on the "has a reason" branch.
 */
export function cleanReason(raw: unknown, maxChars: number = MAX_REASON_CHARS): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed.slice(0, maxChars) : undefined;
}

/**
 * Present only when `value` has the right shape — `triggeredBy` one of the
 * two known values and `at` a string. Anything else (missing, wrong type,
 * hand-corrupted) resolves to `undefined`, never a thrown error. `reason` is
 * re-cleaned on read too (not just at write time) — a hand-edited row, or a
 * future writer that skips `cleanReason`, must not break a single-line
 * rendering downstream.
 */
export function parseProvenance(value: unknown): TaskProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Record<string, unknown>;
  if (p.triggeredBy !== 'user' && p.triggeredBy !== 'agent') return undefined;
  if (typeof p.at !== 'string') return undefined;
  const provenance: TaskProvenance = { triggeredBy: p.triggeredBy, at: p.at };
  if (typeof p.requesterUserId === 'string') provenance.requesterUserId = p.requesterUserId;
  const reason = cleanReason(p.reason);
  if (reason) provenance.reason = reason;
  return provenance;
}
