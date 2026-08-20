---
title: 'Run-Exclusivity Lock'
type: 'feature'
created: '2026-08-20'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '7c33e3779ec6b8874666f90d1163aa39a1e2c0d1'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing yet stops two concurrent invocations against the eval group — two scenario runs, or a run overlapping the future standalone sweep — from racing on the eval group's shared RW-mounted workspace (memory, `CLAUDE.md`).

**Approach:** `eval/lock.ts` reimplements (not imports — `container/agent-runner` is a separate package tree, different runtime) the exact mtime-based stale-lock algorithm already proven in `container/agent-runner/src/mcp-tools/documents.ts`'s `withLock()`: exclusive-create (`{ flag: 'wx' }`), retry on `EEXIST`, reclaim if the existing lock's mtime is older than the staleness window, fail loud after the retry budget is exhausted. A generic `withLock` plus a convenience `withEvalLock` (hardcoded to the eval group's own workspace) — ready for `cli.ts`/`sweep.ts` to call once they exist (Story 1.7 / Epic 3); this story builds the primitive, not its callers, matching how Stories 1.1/1.2 built the safety substrate ahead of `runner.ts`.

## Boundaries & Constraints

**Always:**
- `eval/lock.ts` exports `withLock<T>(lockPath: string, fn: () => T | Promise<T>, opts?: LockOptions): Promise<T>` — same retry/reclaim algorithm as `documents.ts`'s `withLock` (exclusive-create, `EEXIST` → check mtime → reclaim if stale else sleep+retry, throw a clear timeout error after the retry budget, `finally`-unlink on release). Two deliberate deviations from the literal source, both justified: (1) `fn` may return a `Promise<T>` — `documents.ts`'s callers are synchronous, this module's real callers (a scenario run) are not; (2) retry/stale timing is overridable via `opts` (`retryMs`, `maxAttempts`, `staleMs`), defaulting to the exact same values (`25`, `80`, `30_000`) — needed so tests can exercise the stale-reclaim and timeout paths without a real multi-second wait.
- `withLock` defensively `fs.mkdirSync(path.dirname(lockPath), { recursive: true })` before attempting the exclusive-create — the eval group's workspace might not exist yet if this is ever called before `ensureEvalScenarioGroup()` has run once.
- `eval/lock.ts` exports `EVAL_LOCK_PATH = path.join(GROUPS_DIR, 'eval', '.eval-run.lock')` and `withEvalLock<T>(fn): Promise<T>` wrapping `withLock(EVAL_LOCK_PATH, fn)` — the concrete lock this story's own tests exercise, matching AD-8's "a lock file under the eval group's workspace."

**Never:**
- Never wires this into `cli.ts` or `sweep.ts` — neither exists yet (Story 1.7 / Epic 3). This story ships the primitive only.
- Never changes `documents.ts` itself — read for the pattern, not modified.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No lock held | Lock file absent | Acquires immediately, runs `fn`, releases | N/A |
| Lock held by a live process | A fresh lock file exists (mtime within `staleMs`) | Second caller retries until the budget is exhausted | Throws a clear "another eval run is in progress" style error naming `lockPath` |
| Lock left by a crashed process | Lock file exists, mtime older than `staleMs` | Reclaimed and acquired on the very next retry attempt, no need to exhaust the full retry budget | N/A |
| `fn` throws | Lock acquired, `fn()` rejects/throws | Lock is still released (`finally`) | Original error propagates unchanged |
| Workspace directory missing | `groups/eval/` doesn't exist yet | Directory created defensively, lock acquired normally | N/A |
| `withEvalLock` convenience | Any of the above, via `withEvalLock` instead of `withLock` | Identical behavior, `lockPath` fixed to `EVAL_LOCK_PATH` | Same as above |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/documents.ts` (`withLock`, `LOCK_RETRY_MS`/`LOCK_MAX_ATTEMPTS`/`LOCK_STALE_MS`) — the exact algorithm this story reimplements; read for the pattern, a separate package tree so not importable.
- `src/config.ts` (`GROUPS_DIR`) — reused unmodified for `EVAL_LOCK_PATH`.
- `eval/setup.ts` (`ensureEvalScenarioGroup`) — the folder `'eval'` literal `EVAL_LOCK_PATH` assumes; not modified by this story.

## Tasks & Acceptance

**Execution:**
- [x] `eval/lock.ts` -- `withLock`, `LockOptions`, `EVAL_LOCK_PATH`, `withEvalLock` -- run-exclusivity primitive, ready for Story 1.7/Epic 3 to wire in
- [x] `eval/lock.test.ts` -- vitest coverage for the I/O matrix above, using small `opts` overrides (not the real 30s/2s defaults) so the contention/timeout test stays fast; the stale-reclaim test backdates a real lock file's mtime via `fs.utimesSync` rather than waiting

**Acceptance Criteria:**
- Given no lock file exists, when `withLock` runs, then it acquires, runs `fn`, and the lock file is gone afterward.
- Given a fresh (non-stale) lock file already exists, when a second `withLock` call is made with a small retry budget, then it throws after exhausting that budget, naming `lockPath`.
- Given a lock file whose mtime is older than `staleMs`, when `withLock` runs, then it reclaims and acquires without exhausting the retry budget.
- Given `fn` throws, when `withLock` runs, then the lock file is removed afterward and the original error propagates.
- Given `groups/eval/` doesn't exist, when `withEvalLock` runs, then the directory is created and the lock still acquires normally.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors
- `pnpm exec vitest run eval/` -- expected: all tests pass, full run stays well under a few seconds (no real 2s/30s waits)
- `pnpm test` (full suite) -- expected: all pass, no regressions

## Suggested Review Order

**The two correctness fixes review found (entry point)**

- Start here — the docstring names both bugs and why they matter more here than in the source they came from: a slow scenario run makes the 30s staleness window realistic to cross, not just theoretical.
  [`lock.ts:49`](../../eval/lock.ts#L49)

- Fencing on release: only unlink if the file still holds this call's own token — the actual one-line fix for "don't delete someone else's live lock."
  [`lock.ts:82`](../../eval/lock.ts#L82)

**Regression tests for both, plus the opts-validation review also asked for**

- Off-by-one: `maxAttempts: 1` forces the reclaim to happen on the loop's one and only iteration — the exact boundary the bug lived on.
  [`lock.test.ts:131`](../../eval/lock.test.ts#L131)

- Fencing: simulates another holder rewriting the lock file mid-hold; asserts this call's own release is a no-op.
  [`lock.test.ts:158`](../../eval/lock.test.ts#L158)

- The real (non-staleness) contention path — a second waiter succeeding after the first releases normally — wasn't covered by any test before review.
  [`lock.test.ts:179`](../../eval/lock.test.ts#L179)

- `maxAttempts`/`staleMs` validation, added so a misuse (0, negative, non-integer) fails loud instead of silently running `fn()` completely unlocked.
  [`lock.test.ts:119`](../../eval/lock.test.ts#L119)

**The primitive itself and its one real caller-facing gap**

- `withEvalLock` — the concrete lock, now accepting an `opts` override (it didn't before review) so a future long-running caller isn't stuck with the 30s default.
  [`lock.ts:143`](../../eval/lock.ts#L143)
