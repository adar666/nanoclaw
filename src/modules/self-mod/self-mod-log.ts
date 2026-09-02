/**
 * Self-mod change provenance log — one host-timestamped line per applied
 * self-mod change (`install_packages` / `add_mcp_server` / `add_calendar`),
 * at `<GROUPS_DIR>/<group folder>/self-mod-log.md`. Mirrors
 * `run-log.ts`'s existing file-per-group markdown-log pattern (see
 * `_bmad-output/implementation-artifacts/spec-2-2-self-mod-change-provenance.md`).
 *
 * Host-only writer, single Node host process, synchronous read-then-write in
 * one function body — no lock needed (same reasoning already applied to
 * `run-log.ts` and the `config add-X` race family in deferred-work.md; see
 * the spec's Design Notes for the full argument). The file is mounted
 * read-only into its own group's container (`container-runner.ts`'s
 * `buildMounts`) so the agent can never tamper with its own audit trail.
 */
import fs from 'fs';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { cleanReason } from '../provenance.js';

/** Oldest entries beyond this count are trimmed before the new line is appended. */
export const SELF_MOD_LOG_CAP = 20;

export function appendSelfModLog(agentGroupId: string, action: string, reason?: string): void {
  const ag = getAgentGroup(agentGroupId);
  if (!ag) throw new Error(`agent group not found: ${agentGroupId}`);

  const dir = `${GROUPS_DIR}/${ag.folder}`;
  const file = `${dir}/self-mod-log.md`;
  fs.mkdirSync(dir, { recursive: true });

  const existing = fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter((line) => line.length > 0)
    : [];
  const trimmed = existing.length >= SELF_MOD_LOG_CAP ? existing.slice(-(SELF_MOD_LOG_CAP - 1)) : existing;

  // epic retro (cross-story finding): this used to be its own narrower
  // regex-only cleaner (\r?\n only, no whitespace-run collapse, no trim, no
  // reject-if-whitespace-only) that quietly diverged from documents.ts's
  // cleanReason despite a comment claiming parity. Now the same shared
  // helper every provenance writer uses — a literal newline still can't
  // fragment this '\n'-split file into extra "entries" either way.
  const reasonClean = cleanReason(reason);

  const line = `${new Date().toISOString()} — ${action}${reasonClean ? ': ' + reasonClean : ''}`;
  trimmed.push(line);
  fs.writeFileSync(file, trimmed.join('\n') + '\n');
}

/**
 * Read the most recent `limit` lines of a group's self-mod-log.md, newest
 * last (same order the file is written in). Never throws: an unknown group
 * or a missing log file (no self-mod history yet) both resolve to `[]` —
 * this is a read for a digest, not a mutating operation, so there is no
 * "agent group not found" throw the way `appendSelfModLog` has.
 */
export function readSelfModLog(agentGroupId: string, limit = 10): string[] {
  // review round 1: slice(-0) === slice(0), which returns the WHOLE array,
  // not none — guard limit <= 0 explicitly rather than relying on that
  // surprising JS behavior for a caller who means "give me nothing."
  if (limit <= 0) return [];

  const ag = getAgentGroup(agentGroupId);
  if (!ag) return [];

  const file = `${GROUPS_DIR}/${ag.folder}/self-mod-log.md`;
  // review round 1: read directly rather than existsSync-then-read — a
  // TOCTOU gap (deleted/unreadable between the check and the read) would
  // otherwise throw despite this function's own contract of never doing so.
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }

  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .slice(-limit);
}

export interface SelfModLogEntry {
  at: string;
  action: string;
  reason: string | null;
}

/**
 * Parses one line back into its structured parts — the exact inverse of
 * `appendSelfModLog`'s own `${at} — ${action}${reason ? ': ' + reason : ''}`
 * format, which this file alone controls (never hand-edited by anything
 * else in this codebase). Not a fragile guess at someone else's format —
 * parsing this module's own well-defined output.
 *
 * epic retro (cross-story finding): `provenance-digest.ts`'s `self_mod`
 * section used to carry raw, unparsed lines while `tasks`/`documents` both
 * used the shared `ProvenanceDigestSection<T>` shape — an asymmetry in the
 * one place meant to federate all three domains under one shared shape.
 * This gives self-mod entries the same `{at, action, reason}` structure
 * without changing the file's own plain-text format (AD-9's own explicit
 * choice, unchanged).
 */
export function parseSelfModLogLine(line: string): SelfModLogEntry | undefined {
  const match = /^(\S+) — (\S+)(?:: (.*))?$/.exec(line);
  if (!match) return undefined;
  const [, at, action, reason] = match;
  return { at, action, reason: reason && reason.length > 0 ? reason : null };
}
