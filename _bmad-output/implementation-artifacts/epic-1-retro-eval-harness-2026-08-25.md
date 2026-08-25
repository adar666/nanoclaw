---
epic: 1
date: 2026-08-25
verdict: accepted-with-open-items
criteria: profiled
headless: true
---

# Epic 1 Retrospective: Agent Evaluation Harness — Walking Skeleton

## Epic summary

**Epic:** epic-1 (eval-harness track, `_bmad-output/implementation-artifacts/sprint-status-eval-harness.yaml`) — 7 stories: 1-1 scaffold the isolated eval agent group and safety checks, 1-2 calendar isolation and household people.md mount, 1-3 run-exclusivity lock, 1-4 spawn the real container and capture the outbound transcript, 1-5 host-sweep exclusion for eval sessions, 1-6 deterministic judging, 1-7 CLI entry point cleanup and report.

**Diff range:** `a40d4f33^..c15c2443`, 7 non-merge commits, one per story, building the `eval/` subsystem from scratch plus host-side wiring (`src/db/sessions.ts`, `src/host-sweep.ts`, `container/agent-runner/src/`).

**Stories completed:** all 7. `detect-epic --epic 1` confirmed `pending_stories: []` after correcting a tracker staleness issue (see below).

**Scope note — this retro covers epic-1 alongside epics 2 and 3, not in isolation.** The Agent Evaluation Harness is one tightly-sequential initiative (walking skeleton → LLM judging → standalone sweep, each phase building directly on the last), and the review that produced this retro's findings was run once, against the *whole* initiative's diff (`a40d4f33^..fb2991dc`, all 3 epics + 5 post-initiative fixes together) rather than three separate passes — exactly because the retrospective's own purpose is catching what no single epic's own review boundary could see. Findings below are the epic-1-relevant subset of that one consolidated review; the epic-2 and epic-3 retros (`epic-2-retro-eval-harness-2026-08-25.md`, `epic-3-retro-eval-harness-2026-08-25.md`) reference this same evidence rather than repeating it.

**Evidence inventory:**
- Epic spec: `_bmad-output/planning-artifacts/epics-eval-harness.md`'s Epic 1 section — available, read.
- Story specs: all 7 `spec-eval-1-*.md` files, each with a filled Spec Change Log — available, read.
- Diff range and commit attribution: `git_evidence.py` ran successfully; unlike the document-memory epic-2 retro, this track's commit subjects already carry `(Story N.M)` in a form the script partially matched for some commits — attribution cross-checked manually against `git log --reverse` regardless, full confidence.
- Diff-scope review: **the first-generated diff artifact was incomplete** — a path-filtered `git diff` excluded `src/db/sessions.ts`, `src/db/sessions.test.ts`, `src/db/migrations/025-sessions-managed-by.ts`, `src/types.ts` (the entire AD-6 host-sweep-exclusion mechanism, story 1.5's own core deliverable), `src/container-runner.test.ts`, and several other files — caught independently by 2 of the 3 review lenses, which worked around it by pulling the missing files directly from the repo rather than reviewing blind. Recorded here as a real gap in this retro's own process, not hidden: future retros on this repo should generate diff artifacts with an unfiltered `git diff <range>` rather than a path-scoped one.
- Sprint status: available; corrected before this retro (see below).
- Previous retrospective: none — this is the eval-harness track's first retrospective of any epic.
- Session logs: none exist as separate persisted files, same gap as the document-memory epic-2 retro — process observations drawn from firsthand session knowledge and this repo's own memory record, not a re-read transcript.

**Tracker correction made before this retro:** `sprint-status-eval-harness.yaml` had all 11 stories across all 3 epics stuck at `review` and all 3 epics at `in-progress`, despite the codebase's own persisted memory record stating the initiative was closed, all stories merged, and live-verified in production (including 2 post-initiative bugs found and fixed via real runs — the harness testing itself for real, not synthetically). Verified independently against git history before touching the tracker: all 11 story commits plus 5 post-initiative fix commits confirmed reachable from `main` via `git merge-base --is-ancestor`. Corrected to `done` (all 3 epics, all 11 stories) before running `detect-epic`, matching the same correction already applied to the document-memory track's epic-2 earlier in this session.

## Findings

### Epic-1-relevant findings from the whole-initiative review

Consolidated across the aggregate-views pass and 3 `bmad-review` lenses (adversarial, edge-case-hunter, verification-gap) run against the full 3-epic diff. Full finding text and file:line references live in the fix commit (`78d7ebcc` / `f5aebccf`, `main`); summarized here with disposition.

| # | Finding | Epic-1 relevance | Disposition |
|---|---------|-------------------|--------------|
| 1 | **[Fixed]** No `SIGINT`/`SIGTERM` handler in `eval/cli.ts`/`eval/sweep.ts` — a `finally`-block container teardown doesn't run on an operator's Ctrl-C, reopening the exact container-leak incident `killAllActiveContainers` (added in a post-epic-3 fix, `fb2991dc`) was built to prevent. | The container-spawn/teardown machinery this exploits is story 1.4/1.3's own (spawn + run-exclusivity lock). | Fixed, commit `78d7ebcc` — signal handlers added to both entry points. |
| 2 | **[Fixed]** `killAllActiveContainers` (`src/container-runner.ts`) relied solely on a doc comment, not a structural guard, to prevent being called from the long-running host process (which would kill every live user's container at once). | Directly in story 1.3/1.4's own container-lifecycle code. | Fixed, commit `78d7ebcc` — added a required `callerToken` parameter checked against a literal only `eval/`'s one-shot CLI processes hold. |
| 3 | **[Fixed]** The multi-container kill loop itself was untested beyond the trivial empty-map case; a single container's kill failure could stop the rest of the loop. | Same story 1.3/1.4 code. | Fixed, commit `78d7ebcc` — test-only registration hooks added, loop made per-container-failure-resilient. |
| 4 | **[Fixed]** The eval isolation guarantee (AD-4) was convention-only on the workspace/memory axis — `assertNoDestinations` (story 1.1's own safety-check deliverable) checked destination count but never that the agent group was actually one of the two provisioned eval groups; no re-check immediately before the real spawn (a TOCTOU window). | **This is story 1.1's own core deliverable** ("scaffold the isolated eval agent group and safety checks") — the single most epic-1-central finding in the whole review. | Fixed, commit `78d7ebcc` — added `assertIsEvalGroup` plus a re-check immediately before `wakeContainer`. |
| 5 | **[Fixed]** No test asserted the cleanup turn reuses the exact same `threadId` as the main turn (`eval/cli.ts`, story 1.7's own CLI orchestration) — the mechanism giving cleanup its conversational context, previously verified only by call-count, never call-arguments. | Story 1.7. | Fixed, commit `78d7ebcc`. |
| 6 | **[Fixed]** The `!routing.evalRun` guard on `deliverErrorResult` (`container/agent-runner/src/poll-loop.ts`) — preventing a duplicate chat-row from polluting an eval transcript on an error-terminated turn — had zero test coverage in either direction. | Story 1.4/1.6's transcript-capture and judging path. | Fixed, commit `78d7ebcc`. |
| 7 | **[Fixed]** `eval/cli.ts`'s scenario loop wrote zero report artifact on a mid-run structural failure — scenarios after the failing one were silently never attempted, indistinguishable from the run never having been invoked. | Story 1.7's own report-writing deliverable. | Fixed, commit `78d7ebcc` — partial report with `aborted`/`abortError` fields written before rethrowing. |
| 8 | **[Fixed]** `eval/cli.ts`'s scenario loop had no `evalBlockNudged`-style guard against multiple `result` events firing `autoAppendEvalLog` in one turn (a corrective-retry cycle), unlike the existing `taskBlockNudged` pattern it should have mirrored. | Story 1.6's judging-log-capture path. | Fixed, commit `78d7ebcc`. |
| — | Other findings from the same review (transcript-text extraction, cleanup-confirm duplication, the hardcoded household email, `VERDICT_PATTERN` word-boundary fix, evidence truncation) | Belong primarily to epic-2's judge/scenario code (`eval/judge/llm.ts`, `eval/scenarios/`) | See `epic-2-retro-eval-harness-2026-08-25.md`. |

### Spec-to-implementation reconciliation

No epic-1-specific divergence found between `epics-eval-harness.md`'s planned scope and what shipped — the 7 stories' own Spec Change Logs each record their own in-flight deviations (already resolved at story time), and the whole-initiative review's findings are additive hardening on top of correctly-shipped functionality, not evidence of scope drift.

## Behavior verification

Not re-exercised end-to-end in this retro pass — this initiative already has the strongest behavior-verification record of any epic retro'd on this repo so far: per this codebase's own persisted memory, `pnpm eval run guest-resolution` was run live (real container, real Claude call) at least twice, including once against a freshly-reset session, both scenarios passing with real evidence; `pnpm eval sweep`'s first-ever real run found a genuine bug (a refusal-laundering parse issue), which was fixed and live-reverified the same day. That is stronger verification than a synthetic re-run within this retro would add. Verified instead, for this retro's own fix commit, via the full automated suite: `pnpm test` (host) — 1599 pass / 1 skip; `cd container/agent-runner && bun test` — 558 pass / 8 skip / 0 fail; `pnpm exec tsc --noEmit -p .`, `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, `pnpm run typecheck:eval` — all clean.

## Previous-retro follow-through

None — this is the eval-harness track's first retrospective (no prior epic-1/2/3 retro exists to check follow-through against).

## Action items

All fix-now items above (1-8) were already applied and merged in this same session (commit `78d7ebcc`/`f5aebccf`), going beyond this skill's normal "propose, don't apply" scope under this session's standing autopilot authorization from the operator. Recorded as completed, not pending.

**Process lesson:** two of this epic's own safety-critical deliverables (story 1.1's `assertNoDestinations`, and the container-lifecycle machinery from 1.3/1.4) shipped with either an incomplete guarantee (finding 4, convention-only on one axis) or a comment-only safety boundary (finding 2) that a synthetic whole-initiative review caught, not the story's own individual build-time review. Both match a pattern this repo's own `CLAUDE.md` pitfalls file already names generally ("a comment claiming 'safe because X' needs to name which *process*/*boundary* X actually holds for, not just assert it") — worth keeping in mind specifically for safety/isolation-critical code in future epics: a structural guard, not a comment, for anything a mistake could make expensive.

## Acceptance verdict

**Accepted-with-open-items** (epic-level verdict; the same verdict applies to epic-2 and epic-3 of this track, since all three share one consolidated review and fix pass — see their own retro docs for epic-specific evidence).

- Criteria: profiled (no single central epic-1 acceptance document beyond each story's own AC).
- All 7 stories `done`, no unfinished delivery.
- No blocking findings remain open — the two most consequential ones for this epic specifically (findings 2 and 4, both touching this epic's own core safety deliverables) were fixed and verified before this verdict was rendered.
- This retro's evidence-inventory gap (the incomplete diff artifact, caught and worked around by 2 of 3 lenses) is itself an open item worth naming for future retro runs on this repo — recorded in Open questions below, not blocking this verdict.

## Open questions

- Whether to fix the diff-artifact generation gap (unfiltered `git diff` instead of path-scoped) prospectively for future retros on this repo — a process note, not a code change.
- Whether the eval-harness track's existing live-verification record (2 real bugs found via real runs) should count as a standing substitute for full synthetic behavior-verification in future retros on this same track, or whether a fresh live run should still be requested per retro regardless — an operator scope decision.

## Assumptions

Headless run (`-H`) — every choice below was made without a human present:

- Epic selection: explicitly supplied by the operator, resolved via `detect-epic --file _bmad-output/implementation-artifacts/sprint-status-eval-harness.yaml --epic 1`.
- Tracker correction: all 11 stories/3 epics were at `review`/`in-progress` on first `detect-epic` call. Verified against git history (all commits confirmed on `main`) and this repo's own persisted memory record before correcting to `done` — a data-correction decision made without human confirmation, recorded for visibility.
- Review scope: ran ONE consolidated whole-initiative review (all 3 epics together) rather than 3 separate per-epic reviews, judged more faithful to this retrospective methodology's own stated purpose ("what no single session/diff-hunk could see") given how tightly sequential the 3 epics are — a scope decision, not a shortcut around the methodology.
- Fix-now items: applied and merged directly in this same session rather than only proposed, under this session's standing autopilot authorization ("finish everything open in bmad") — beyond this skill's normal "propose, don't apply" scope, recorded explicitly.
- Machine verdict: accepted-with-open-items, rendered without human confirmation (headless).
- Team discussion (Phase 3): skipped — not requested, never runs headless by default.
