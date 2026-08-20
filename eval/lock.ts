/**
 * Run-exclusivity lock for the eval group's shared RW-mounted workspace
 * (memory, CLAUDE.md) — nothing else yet stops two concurrent invocations
 * (two scenario runs, or a run overlapping the future standalone sweep)
 * from racing on it.
 *
 * Reimplements (not imports — `container/agent-runner` is a separate
 * package tree, different runtime) the exact mtime-based stale-lock
 * algorithm already proven in
 * `container/agent-runner/src/mcp-tools/documents.ts`'s `withLock()`:
 * exclusive-create (`{ flag: 'wx' }`), retry on `EEXIST`, reclaim if the
 * existing lock's mtime is older than the staleness window, fail loud after
 * the retry budget is exhausted. Two deliberate deviations from the literal
 * source: (1) `fn` may return a `Promise<T>` — `documents.ts`'s callers are
 * synchronous, this module's real callers (a scenario run) are not; (2)
 * retry/stale timing is overridable via `opts`, defaulting to the exact same
 * values as `documents.ts` — needed so tests can exercise the stale-reclaim
 * and timeout paths without a real multi-second wait. Beyond those two, this
 * module also carries two real correctness fixes review found in the source
 * algorithm — see `withLock`'s own docstring below for both.
 *
 * `cli.ts`/`sweep.ts` (Story 1.7 / Epic 3) will call `withEvalLock` once
 * they exist — this story builds the primitive only, not its callers.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../src/config.js';
import { log } from '../src/log.js';

const DEFAULT_RETRY_MS = 25;
const DEFAULT_MAX_ATTEMPTS = 80; // ~2s worst case
const DEFAULT_STALE_MS = 30_000;

export interface LockOptions {
  /** Delay between exclusive-create retries. Default 25ms. */
  retryMs?: number;
  /** Total exclusive-create attempts before giving up. Default 80 (~2s worst case). */
  maxAttempts?: number;
  /** A lock file older than this is treated as abandoned and reclaimed. Default 30s. */
  staleMs?: number;
}

/** The concrete lock this story's own tests exercise — a lock file under the eval group's workspace (AD-8). */
export const EVAL_LOCK_PATH = path.join(GROUPS_DIR, 'eval', '.eval-run.lock');

function errnoCode(e: unknown): string | undefined {
  return e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
}

/**
 * Exclusive-create lock file at `lockPath`, retrying on contention with
 * mtime-based staleness recovery, running `fn` once acquired, and always
 * releasing before returning or rethrowing.
 *
 * Two correctness fixes beyond `documents.ts`'s literal algorithm (found by
 * review, both real — `documents.ts`'s fast, sub-second critical sections
 * make them nearly unreachable there; this module's real use case, a
 * multi-minute scenario run, makes them much more likely to actually fire):
 *
 * 1. **Fencing on release.** The original always unlinks unconditionally in
 *    `finally`. If this call's own `fn()` runs long enough to cross
 *    `staleMs`, a second caller can legitimately reclaim the lock as
 *    abandoned and start its own `fn()` — and when the first call's `fn()`
 *    finally finishes, its unconditional unlink would delete the SECOND
 *    caller's live lock, silently breaking mutual exclusion. Fixed by
 *    writing this call's own pid at acquire time and only unlinking at
 *    release if the file still holds that exact pid.
 * 2. **Off-by-one on a last-attempt stale reclaim.** The original's stale
 *    branch does `unlink; continue;` with no attempt-count adjustment — if
 *    that happens on the loop's *final* iteration, `continue` still runs the
 *    `for` loop's increment, `attempt` reaches `maxAttempts`, and the loop
 *    exits *without ever retrying the exclusive-create*. `fn()` would then
 *    run holding no lock at all, with no error. Fixed by decrementing
 *    `attempt` before `continue` so a stale reclaim always guarantees one
 *    more genuine acquire attempt.
 *
 * Defensively creates `lockPath`'s parent directory first — the eval
 * group's workspace might not exist yet if this is ever called before
 * `ensureEvalScenarioGroup()` has run once.
 */
export async function withLock<T>(lockPath: string, fn: () => T | Promise<T>, opts?: LockOptions): Promise<T> {
  const retryMs = opts?.retryMs ?? DEFAULT_RETRY_MS;
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`withLock: maxAttempts must be a positive integer, got ${maxAttempts}`);
  }
  if (!(staleMs > 0)) {
    throw new Error(`withLock: staleMs must be positive, got ${staleMs}`);
  }

  const myToken = String(process.pid);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.writeFileSync(lockPath, myToken, { flag: 'wx' });
      break;
    } catch (e) {
      if (errnoCode(e) !== 'EEXIST') throw e;

      // A crashed holder never releases its lock — recover instead of
      // failing every call against this path forever.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          log.warn('withLock: reclaimed a stale lock', { lockPath, ageMs: Date.now() - st.mtimeMs });
          attempt--; // guarantee a genuine re-acquire attempt, even on the last iteration (see fix #2 above)
          continue;
        }
      } catch {
        // Lock vanished between our failed create and this stat — another
        // holder likely just released it; fall through to the normal retry.
      }

      if (attempt === maxAttempts - 1) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      // Fencing (see fix #1 above): only release if this call still owns the
      // lock — a stale-reclaim by another caller may have already rewritten
      // it with a different pid, in which case deleting it would break that
      // caller's exclusivity instead of honoring ours.
      if (fs.readFileSync(lockPath, 'utf-8') === myToken) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Already gone (or never created) — nothing to clean up.
    }
  }
}

/** Convenience wrapper hardcoded to the eval group's own workspace lock. */
export function withEvalLock<T>(fn: () => T | Promise<T>, opts?: LockOptions): Promise<T> {
  return withLock(EVAL_LOCK_PATH, fn, opts);
}
