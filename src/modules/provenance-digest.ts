/**
 * On-Demand Cross-Domain Digest (spec 2-4) — federates the three provenance
 * surfaces stories 2.1-2.3 already built (task `content.provenance`,
 * `self-mod-log.md`, document `FillHistoryEntry.provenance`) into one
 * read-only summary, pulled on demand via `ncl groups provenance-digest`.
 * No new storage, no new provenance shape — this reads the three existing
 * ones as-is and never writes anything.
 *
 * Each section is present even when it has nothing to show — never silently
 * omitted, never an error (see the spec's Boundaries & I/O Matrix).
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

import { GROUPS_DIR } from '../config.js';
import { resolveGroupTimezone } from '../container-config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getContainerConfig } from '../db/container-configs.js';
import { findTaskSessions } from '../db/sessions.js';
import { log } from '../log.js';
import { readSelfModLog } from './self-mod/self-mod-log.js';
import type { TaskProvenance } from './scheduling/create.js';
import { inboundDbPath, withInboundDb } from '../session-manager.js';
import { formatLocalTime } from '../timezone.js';

// Recency caps — same reasoning as the underlying stores' own caps
// (self-mod-log.md / FillHistoryEntry are each capped at 20): a digest
// answering "what have you automated *recently*" doesn't need a user's
// entire lifetime history in one call.
// review round 1: tasks had no cap at all — unlike the other two sections,
// live task series aren't bounded by any underlying store's own cap, so
// this digest must impose one itself.
const TASK_DIGEST_LIMIT = 10;
const SELF_MOD_DIGEST_LIMIT = 10;
const DOCUMENT_DIGEST_LIMIT = 10;

export interface TaskDigestItem {
  series_id: string;
  session_id: string;
  status: string;
  prompt: string;
  triggered_by: 'user' | 'agent' | null;
  requester_user_id: string | null;
  reason: string | null;
  provenance_at: string | null;
  created_at: string;
  created_at_local: string;
}

export interface DocumentDigestItem {
  target: string;
  /** review round 1: a pre-refresh snapshot carries provenance too, but isn't a real fill — label it, don't let it read as one. */
  kind: 'fill' | 'pre-refresh-snapshot';
  triggered_by: 'agent';
  requester_user_id: string | null;
  reason: string | null;
  provenance_at: string;
  timestamp: string;
  timestamp_local: string;
}

export interface ProvenanceDigestSection<T> {
  /** Always present, plain-language — never omitted, never an error. */
  summary: string;
  items: T[];
}

export interface ProvenanceDigest {
  agent_group_id: string;
  tasks: ProvenanceDigestSection<TaskDigestItem>;
  self_mod: { summary: string; entries: string[] };
  documents: ProvenanceDigestSection<DocumentDigestItem>;
}

// ---------------------------------------------------------------------------
// Tasks — content.provenance on live (pending/paused) task series.
//
// tasks.ts's own parseProvenance/selectLiveTasks/isTaskThread are
// module-private (not exported). Exporting them purely for this one new
// caller would be a larger refactor of already-shipped, well-tested code
// than this story's narrow aggregation purpose warrants (see the spec's
// Design Notes) — so this re-implements the same small query/parse against
// the same real schema instead.
// ---------------------------------------------------------------------------

interface LiveTaskRow {
  row_id: string;
  series_id: string | null;
  status: string;
  content: string;
  timestamp: string;
}

// Present only when the parsed JSON has a `provenance` key of the right
// shape — anything else (missing, wrong type, hand-corrupted) resolves to
// undefined, never a thrown error. Mirrors tasks.ts's own parseProvenance.
function parseProvenance(value: unknown): TaskProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const p = value as Record<string, unknown>;
  if (p.triggeredBy !== 'user' && p.triggeredBy !== 'agent') return undefined;
  if (typeof p.at !== 'string') return undefined;
  const provenance: TaskProvenance = { triggeredBy: p.triggeredBy, at: p.at };
  if (typeof p.requesterUserId === 'string') provenance.requesterUserId = p.requesterUserId;
  if (typeof p.reason === 'string') provenance.reason = p.reason;
  return provenance;
}

function parseTaskContent(raw: string): { prompt: string; provenance: TaskProvenance | undefined } {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      provenance: parseProvenance(parsed.provenance),
    };
  } catch {
    // LEGACY-COMPAT(v1-tasks): plain-string content from rows that predate
    // the JSON envelope. Removable once no pre-v2 session DBs remain.
    return { prompt: raw, provenance: undefined };
  }
}

// GROUP BY series_id with un-aggregated columns (id/status/content/timestamp)
// alongside MAX(seq) relies on SQLite's "bare column" extension — the
// non-aggregated columns come from the row holding the max, same as
// tasks.ts's own selectLiveTasks (this file's own precedent, module-private
// there) already relies on. Deliberate, not an accidental portability gap.
function selectLiveTaskRows(db: Database.Database): LiveTaskRow[] {
  return db
    .prepare(
      `SELECT id AS row_id, series_id, status, content, timestamp, MAX(seq) AS seq
         FROM messages_in
        WHERE kind = 'task'
          AND status IN ('pending', 'paused')
        GROUP BY series_id
        ORDER BY timestamp ASC`,
    )
    .all() as LiveTaskRow[];
}

function truncate(text: string, max: number): string {
  if (max <= 3) return text.slice(0, Math.max(max, 0));
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

function taskDigestItems(agentGroupId: string, timezone: string): TaskDigestItem[] {
  const items: TaskDigestItem[] = [];
  for (const session of findTaskSessions(agentGroupId)) {
    if (!fs.existsSync(inboundDbPath(agentGroupId, session.id))) continue;
    let rows: LiveTaskRow[];
    try {
      rows = withInboundDb(agentGroupId, session.id, selectLiveTaskRows);
    } catch (e) {
      // review round 1: a locked/corrupted/schema-mismatched session DB must
      // not take down the whole digest — same tolerant posture as the
      // self-mod/document readers, which never throw on a bad individual
      // source. Skip this one session, keep going.
      log.warn('provenance-digest: could not read a task session — skipped', {
        agentGroupId,
        sessionId: session.id,
        err: e,
      });
      continue;
    }
    for (const row of rows) {
      const { prompt, provenance } = parseTaskContent(row.content);
      items.push({
        series_id: row.series_id ?? row.row_id,
        session_id: session.id,
        status: row.status,
        prompt: truncate(prompt, 120),
        triggered_by: provenance?.triggeredBy ?? null,
        requester_user_id: provenance?.requesterUserId ?? null,
        reason: provenance?.reason ? truncate(provenance.reason, 120) : null,
        provenance_at: provenance?.at ?? null,
        created_at: row.timestamp,
        created_at_local: formatLocalTime(row.timestamp, timezone),
      });
    }
  }
  // review round 1: each session's own rows were already ordered, but never
  // sorted globally across sessions, and had no recency cap at all — unlike
  // the other two sections. Newest first, then capped, matching documents'
  // own treatment.
  items.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return items.slice(0, TASK_DIGEST_LIMIT);
}

// ---------------------------------------------------------------------------
// Documents — FillHistoryEntry.provenance across `.fill-history/*.json`.
//
// Cross-runtime note (same accepted tradeoff as specs 1.1/1.2/2.2's
// `-shared`/`WORKSPACE_EXTRA_DIR` convention): host `src/**` and container
// `container/agent-runner/src/**` are separate packages/runtimes — no
// shared TS import is possible, so this independently re-encodes
// documents.ts's `.fill-history/<slug>.json` shape, reading only the
// fields this digest needs (timestamp, target, provenance), tolerant of
// anything else, mirroring readFillHistory's own tolerant-reader posture.
// Only entries that actually carry a `provenance` object count for this
// digest — an entry (or a whole directory) with none is, from this
// digest's perspective, indistinguishable from "no document fill history."
// ---------------------------------------------------------------------------

function documentFillHistoryDir(agentGroupId: string): string | undefined {
  const ag = getAgentGroup(agentGroupId);
  if (!ag) return undefined;
  return path.join(GROUPS_DIR, ag.folder, 'memory', 'documents', '.fill-history');
}

function readDocumentProvenanceEntries(agentGroupId: string): Array<Omit<DocumentDigestItem, 'timestamp_local'>> {
  const dir = documentFillHistoryDir(agentGroupId);
  if (!dir) return [];

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    // review round 1: ENOENT (never filled anything yet) is genuinely
    // "nothing to show" and stays silent — anything else (permissions, a
    // real I/O error) is a real problem an operator should be able to find,
    // same posture as this codebase's mount-rejection precedent.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('provenance-digest: could not list document fill-history directory', { agentGroupId, dir, err: e });
    }
    return [];
  }

  const entries: Array<Omit<DocumentDigestItem, 'timestamp_local'>> = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, file), 'utf-8');
    } catch (e) {
      log.warn('provenance-digest: could not read a fill-history file — skipped', { agentGroupId, file, err: e });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      log.warn('provenance-digest: a fill-history file is not valid JSON — skipped', { agentGroupId, file, err: e });
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    for (const candidateRaw of parsed) {
      if (!candidateRaw || typeof candidateRaw !== 'object') continue;
      const candidate = candidateRaw as Record<string, unknown>;
      if (typeof candidate.timestamp !== 'string' || typeof candidate.target !== 'string') continue;

      const rawProvenance = candidate.provenance;
      if (!rawProvenance || typeof rawProvenance !== 'object') continue;
      const p = rawProvenance as Record<string, unknown>;
      if (p.triggeredBy !== 'agent' || typeof p.at !== 'string') continue;

      entries.push({
        target: candidate.target,
        // review round 1: a pre-refresh snapshot carries provenance too but
        // isn't a real fill — label it the same way documents.ts's own
        // list_document_versions already does, so it never reads as an
        // actual field-fill with a reason.
        kind: candidate.kind === 'pre-refresh-snapshot' ? 'pre-refresh-snapshot' : 'fill',
        triggered_by: 'agent',
        requester_user_id: typeof p.requesterUserId === 'string' ? p.requesterUserId : null,
        reason: typeof p.reason === 'string' ? truncate(p.reason, 200) : null,
        provenance_at: p.at,
        timestamp: candidate.timestamp,
      });
    }
  }

  // Newest first.
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return entries;
}

function documentDigestItems(agentGroupId: string, timezone: string): DocumentDigestItem[] {
  return readDocumentProvenanceEntries(agentGroupId)
    .slice(0, DOCUMENT_DIGEST_LIMIT)
    .map((entry) => ({ ...entry, timestamp_local: formatLocalTime(entry.timestamp, timezone) }));
}

// ---------------------------------------------------------------------------
// Federation point
// ---------------------------------------------------------------------------

/**
 * Build the cross-domain provenance digest for one agent group. Throws with
 * the same "No container config for group" precedent as `config get` when
 * `agentGroupId` is bad or missing a container config — every other case
 * (no tasks, no self-mod history, no document history) resolves to an empty
 * section with a plain-language summary, never an error.
 */
export function buildProvenanceDigest(agentGroupId: string): ProvenanceDigest {
  if (!getContainerConfig(agentGroupId)) {
    throw new Error(`No container config for group: ${agentGroupId}`);
  }

  const timezone = resolveGroupTimezone(agentGroupId);

  const taskItems = taskDigestItems(agentGroupId, timezone);
  const selfModEntries = readSelfModLog(agentGroupId, SELF_MOD_DIGEST_LIMIT);
  const documentItems = documentDigestItems(agentGroupId, timezone);

  return {
    agent_group_id: agentGroupId,
    // review round 1: "N recent ..." reads as a complete count — none of
    // these sections can actually tell whether more exist beyond their own
    // cap, so the wording says "most recent" (a view, not a total) rather
    // than implying completeness.
    tasks: {
      summary:
        taskItems.length > 0
          ? `${taskItems.length} most recent active task${taskItems.length === 1 ? '' : 's'} (up to ${TASK_DIGEST_LIMIT} shown).`
          : 'No active tasks with recorded provenance.',
      items: taskItems,
    },
    self_mod: {
      summary:
        selfModEntries.length > 0
          ? `${selfModEntries.length} most recent self-modification entr${selfModEntries.length === 1 ? 'y' : 'ies'} (up to ${SELF_MOD_DIGEST_LIMIT} shown).`
          : 'No self-modification history recorded yet.',
      entries: selfModEntries,
    },
    documents: {
      summary:
        documentItems.length > 0
          ? `${documentItems.length} most recent document change${documentItems.length === 1 ? '' : 's'} with recorded provenance (up to ${DOCUMENT_DIGEST_LIMIT} shown).`
          : 'No document fill history with recorded provenance.',
      items: documentItems,
    },
  };
}
