---
title: 'Eval Sessions Can Capture Output Without a Chat Destination'
type: 'bugfix'
created: '2026-08-23'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'c13aba0fb2773debfa771e3bfea0db8d38bf24b4'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The eval harness's first real live run (`pnpm eval run guest-resolution`, run twice, both reproducing identically) captured zero output for every scenario/cleanup/judge turn — `messages_out` stayed completely empty despite `processing_ack` reaching `'completed'`. Direct container-log inspection (live `docker logs -f` during a second diagnostic run) found the exact cause: `container/agent-runner/src/poll-loop.ts`'s `dispatchResultText` only ever writes to `messages_out` for text wrapped in `<message to="name">...</message>` blocks — and the agent, correctly and safely, refuses to invent a destination name when none exists (eval sessions have zero destinations by design, AD-1). The result: real, substantive agent replies ("No event exists tomorrow... I also still don't have an email on file for Ruti...") are produced but never persisted anywhere the harness — or a human — can read them. This is a gap in the original architecture design (SPEC/ARCHITECTURE-SPINE), not a defect in any of the 11 already-shipped eval-harness stories.

**Approach:** Give eval sessions the same treatment `SessionMode`'s existing `'task'` kind already gets for the identical structural problem (an isolated run with no attached chat) — add a third `SessionMode` variant, `{ kind: 'eval' }`, resolved the same way task mode is (a `system:eval` thread-id prefix check, mirroring `getTaskSeriesId()`'s own `system:tasks:` check), with its own accurate system-prompt framing (not the task-specific "recorded in `tasks/<id>.md`" text). At the `dispatchResultText` layer, extend the existing `taskRun` bypass (no `<message to>` required, final text auto-recorded) to also cover eval runs — auto-writing final text straight to `messages_out` as a new `'eval_log'` kind, mirroring `autoAppendTaskLog`'s already-proven mechanism exactly. On the `eval/` side, the fix is one line: `eval/runner.ts`'s `writeSessionMessage` call switches from `kind: 'chat'` to `kind: 'eval'` — every eval use case (scenario turns, cleanup, judge turns, sweep) already funnels through this one function, so nothing else in `eval/` needs to change; `readTranscript`/`transcriptText` already read any row generically regardless of kind.

## Boundaries & Constraints

**Always:**
- `container/agent-runner/src/db/session-routing.ts` exports `isEvalThread(): boolean`, mirroring `getTaskSeriesId()`'s exact mechanism: reads `getSessionRouting().thread_id`, true iff it equals `'system:eval'` or starts with `'system:eval:'` (matching `eval/session.ts`'s own `EVAL_THREAD_PREFIX` validation exactly — duplicated as a literal here since the container tree can't import from the host's `eval/` module).
- `container/agent-runner/src/destinations.ts`'s `SessionMode` type gains `{ kind: 'eval' }` (no extra fields needed, unlike `'task'`'s `taskId`). `buildDestinationsSection` gains an `eval` branch with its own accurate text: states plainly that this is an automated evaluation run with no attached chat, final output is captured directly (not sent to a destination), and — unlike the task branch — never references `tasks/<id>.md` or `ncl tasks append-log`.
- `container/agent-runner/src/index.ts`'s mode resolution becomes `taskId ? { kind: 'task', taskId } : isEvalThread() ? { kind: 'eval' } : { kind: 'chat' }` — task mode still takes priority (thread-id prefixes are mutually exclusive by construction, so this ordering is a formality, not a real conflict).
- `container/agent-runner/src/formatter.ts`'s `RoutingContext` gains `evalRun: boolean`; `extractRouting` derives it the same way `taskRun` is derived (`messages.length > 0 && messages.every((m) => m.kind === 'eval')`). `formatMessages`'s chat-message filter includes `kind === 'eval'` alongside `'chat'`/`'chat-sdk'` — eval messages render via the existing `formatChatMessages`/`.text` content shape unchanged, no new formatting function needed.
- `container/agent-runner/src/poll-loop.ts`'s `dispatchResultText`: the `hasUnwrapped` check becomes `!routing.taskRun && !routing.evalRun && sent === 0 && !!scratchpad` (never warns/drops for an eval run). The per-result-event handling that currently calls `autoAppendTaskLog` for `routing.taskRun` gains a parallel eval path — final text is written to `messages_out` as `kind: 'eval_log'`, `content: JSON.stringify({ text: line })` (same shape `autoAppendTaskLog` already uses, same 500-char line clamp, same inline-`<message to>`-block-to-prose handling for hygiene) — "never delivered to anyone," same as the task case.
- `eval/runner.ts`'s `writeSessionMessage` call: `kind: 'chat'` → `kind: 'eval'`. No other change anywhere in `eval/` — `readTranscript`'s query has no kind filter, `transcriptText` parses `.content.text` from any row.
- This is a container-side-only change (`container/agent-runner/src/**`) plus the one host-side line in `eval/runner.ts` — per this repo's own build/restart convention, needs only a fresh container spawn (killing the eval group's existing container), not `./container/build.sh` or a host service restart.

**Never:**
- Never touches `destinations.ts`'s actual `getAllDestinations()`/`findByName` resolution or the real `destinations` table — AD-1's zero-destinations safety guarantee (verified by `assertNoDestinations`) is completely untouched; this fix only changes what happens when zero destinations legitimately exist, never adds a synthetic/fake one.
- Never changes `'task'` mode's own existing behavior, text, or code paths — `'eval'` is a new, independent sibling variant, not a repurposing of `'task'`.
- Never changes anything about how a real production chat group (with real destinations) behaves — every new branch is gated on `mode.kind === 'eval'` / `routing.evalRun`, both derived only from the `system:eval` thread-id prefix, which no real production session can ever have.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Eval session, agent produces final text, no `<message to>` block | `thread_id` starts with `system:eval` | Text written to `messages_out` as `kind: 'eval_log'`; no warning logged | N/A |
| Eval session, agent's text does include a `<message to="name">` block anyway | Same thread-id prefix | Same as task mode: block is inert (never delivered), its inner text folds into the auto-recorded log as `[undelivered → name] ...`, matching `autoAppendTaskLog`'s existing hygiene | N/A |
| Real production chat session (no `system:eval`/`system:tasks:` prefix), zero destinations somehow | `mode.kind: 'chat'` | Unchanged — still warns/drops, exactly as today | N/A (pre-existing, unaffected) |
| Task session (`system:tasks:` prefix) | `mode.kind: 'task'` | Completely unchanged — untouched code path | N/A |
| Eval session, agent's text is empty/whitespace-only | `line` after clamping is empty | No `messages_out` row written (mirrors `autoAppendTaskLog`'s own `if (!line) return;` guard) — the eval harness's own existing "unparseable"/"turn didn't complete" handling (Stories 1.6/1.7/2.2/3.1) already covers a resulting empty transcript | N/A (pre-existing eval/ error handling covers this) |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/db/session-routing.ts` — `getSessionRouting()`, `getTaskSeriesId()` (`TASK_THREAD_PREFIX` pattern this story's `isEvalThread()` mirrors exactly).
- `container/agent-runner/src/destinations.ts` — `SessionMode`, `buildSystemPromptAddendum`, `buildDestinationsSection` (the `mode.kind === 'task'` branch, lines ~115-122, this story's `'eval'` branch sits beside).
- `container/agent-runner/src/index.ts:68-72` — mode resolution call site.
- `container/agent-runner/src/formatter.ts` — `RoutingContext` (`taskRun` field), `extractRouting`, `formatMessages`'s kind-filter section.
- `container/agent-runner/src/poll-loop.ts` — `dispatchResultText` (the `routing.taskRun` branch at line ~734, `hasUnwrapped` at line ~763), `autoAppendTaskLog` (line ~810, the exact mechanism this story's eval-log write mirrors), the `routing.taskRun && !taskBlockNudged` call site (line ~568).
- `eval/runner.ts` — `runScenarioTurn`'s `writeSessionMessage` call, the one line changing `kind: 'chat'` → `kind: 'eval'`. Every eval turn (scenario, cleanup, judge via `judgeLlm`, sweep) already funnels through this one function.
- `eval/session.ts` — `EVAL_THREAD_PREFIX = 'system:eval'`, the exact string `isEvalThread()` mirrors (can't import cross-tree; container/agent-runner is a separate Bun package).
- Live evidence this spec is grounded in: two real `pnpm eval run guest-resolution` invocations today (reports at `eval/reports/2026-08-23T125530.548Z/` and `.../2026-08-23T142453.693Z/`), plus direct `docker logs -f` capture during the second run showing the agent's real, substantive, but never-persisted replies.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/src/db/session-routing.ts` — add `isEvalThread()`
- [x] `container/agent-runner/src/destinations.ts` — extend `SessionMode`, add the `'eval'` branch to `buildDestinationsSection`
- [x] `container/agent-runner/src/index.ts` — extend mode resolution
- [x] `container/agent-runner/src/formatter.ts` — `RoutingContext.evalRun`, `extractRouting` derivation, `formatMessages` filter update
- [x] `container/agent-runner/src/poll-loop.ts` — extend `hasUnwrapped`, add the eval auto-log write (generalized `autoAppendTaskLog`'s write path into a shared `writeAutoLog` helper; kept `'task_log'` vs `'eval_log'` kinds distinct via two thin named exports, `autoAppendTaskLog`/`autoAppendEvalLog`)
- [x] `eval/runner.ts` — one-line `kind: 'chat'` → `kind: 'eval'`
- [x] Container-side unit tests (`bun:test`, matching this tree's own convention) for `isEvalThread`, `extractRouting`'s new `evalRun` derivation, `buildDestinationsSection`'s new branch, and `dispatchResultText`'s eval bypass + auto-log write — new `db/session-routing.test.ts`, additions to `formatter.test.ts`/`destinations.test.ts`/`poll-loop.test.ts`, new `eval-delivery.test.ts`
- [x] `eval/runner.test.ts` — new test covering the `kind: 'eval'` write

**Acceptance Criteria:**
- Given an eval session with zero destinations, when the agent produces final text with no `<message to>` block, then that text lands in `messages_out` as a real, readable row — not silently dropped.
- Given the exact same input on a real production chat session (not `system:eval`-prefixed), when it has zero destinations, then behavior is byte-for-byte unchanged from today (still the existing warn-and-drop).
- Given a task session, when it runs, then nothing about its behavior changes at all — `'eval'` is additive, not a repurposing of `'task'`.
- **Live re-verification** (operator-gated, real container/Claude cost, same standing rule as every real eval run): after this fix, kill the eval group's existing container and re-run `pnpm eval run guest-resolution` for real — `messages_out` should now contain real rows, and at least the deterministic `guest-resolution-known-name` scenario should be judgeable (pass or fail on its merits, not `evidence: ""`).

## Verification

**Commands:**
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no errors -- ran, no errors
- `cd container/agent-runner && bun test` -- expected: all pass, including new tests -- ran, 490/490 pass (8 pre-existing skips)
- `pnpm run typecheck:eval` -- expected: no errors -- ran, no errors
- `pnpm exec vitest run eval/` -- expected: all pass -- ran, all pass
- `pnpm test` (full host suite) -- expected: all pass, no regressions -- ran, 1548/1548 pass (1 skipped), no regressions
- Manual/operator-gated: a real `pnpm eval run guest-resolution` after the container respawns — confirms the fix against the exact live failure this spec is grounded in, not just unit tests.

## Suggested Review Order

1. `container/agent-runner/src/poll-loop.ts:806-863` -- `autoAppendTaskLog`/`autoAppendEvalLog`/`writeAutoLog`: the critical fix from review — the first version never set `in_reply_to` on the written row at all, which would have silently defeated this entire change (`eval/runner.ts`'s `readTranscript` filters `messages_out` by `in_reply_to`; a `null` value there never matches, so the harness's transcript would have stayed empty even after everything else in this spec shipped). Also: the error-result branch (`sent === 0 && event.isError === true`) now excludes `evalRun` too, matching `taskRun`'s own exclusion (was missing, would have double-written a stray `kind: 'chat'` row into a zero-destination eval session). Also: `eval_log` gets its own 4000-char budget, not `task_log`'s tighter 500 — a judge does substring matching against the full reply.
2. `container/agent-runner/src/destinations.ts:24-44` -- the new `resolveSessionMode()`, extracted out of `index.ts`'s untestable `main()` (review finding: `index.wiring.test.ts`'s own comment already documents why `main()` can't be driven in-process — nothing exercised this exact resolution logic before, so a regression here would have shipped invisibly).
3. `container/agent-runner/src/db/session-routing.ts`, `container/agent-runner/src/formatter.ts`, `container/agent-runner/src/index.ts` -- unchanged from the first pass, all independently re-verified.
4. `container/agent-runner/src/eval-delivery.test.ts`, `container/agent-runner/src/destinations.test.ts` -- new regression tests for both fixes above (`in_reply_to` round-trip, `resolveSessionMode`'s task/eval precedence).
5. `eval/runner.ts:93`, `docs/db-session.md`, `docs/agent-runner-details.md` -- unchanged one-liner plus doc updates (the `RoutingContext` code sample there was already stale for `taskRun` before this story; fixed alongside adding `evalRun`).

**Review notes:** all 3 review layers converged independently on the same class of gap in different forms — blind-hunter found the fix-invalidating `in_reply_to` omission directly by tracing `readTranscript`'s own query; edge-case-hunter and verification-gap both flagged the error-branch missing `!routing.evalRun`; edge-case-hunter and blind-hunter both flagged the 500-char truncation risk for judge-consumed text; verification-gap's own primary finding (the untested `index.ts` ternary) led to extracting `resolveSessionMode`. Given the `in_reply_to` bug would have made the whole fix silently non-functional, this review cycle is exactly why the spec's own "Live re-verification" acceptance criterion wasn't attempted before this patch pass — it would have cost real tokens to discover the same thing this static review found for free. Two findings deferred (both matching pre-existing, already-accepted patterns elsewhere in this codebase, not novel here): three independent "is this eval" checks kept in sync by convention (mirrors task mode's identical, pre-existing duality); `kind: 'eval'` no longer matching slash-command passthrough gating (real but unreachable in practice — eval messages are authored constants, never user-typed).
