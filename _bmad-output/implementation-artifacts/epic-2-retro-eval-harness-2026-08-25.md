---
epic: 2
date: 2026-08-25
verdict: accepted-with-open-items
criteria: profiled
headless: true
---

# Epic 2 Retrospective: Agent Evaluation Harness — LLM Judging

## Epic summary

**Epic:** epic-2 (eval-harness track) — 3 stories: 2-1 judge's own isolated agent group, 2-2 LLM-judge verdict with reasoning, 2-3 ambiguous-name scenario and full report.

**Diff range:** `c15c2443..661c6ad7`, 3 non-merge commits.

**Stories completed:** all 3, `pending_stories: []` confirmed after the same tracker correction described in `epic-1-retro-eval-harness-2026-08-25.md`.

**Review scope:** see `epic-1-retro-eval-harness-2026-08-25.md`'s Epic Summary — this retro shares one consolidated whole-initiative review (all 3 eval-harness epics reviewed together, `a40d4f33^..fb2991dc`) rather than a separate pass. This document covers the subset of that review's findings landing in epic-2's own code (`eval/judge/`, `eval/scenarios/`); epic-1's retro covers the safety/container-lifecycle findings, epic-3's covers the sweep-specific ones.

**Evidence inventory:** same sources as epic-1's retro (epic spec `epics-eval-harness.md`'s Epic 2 section, all 3 `spec-eval-2-*.md` files with their own Spec Change Logs, `git_evidence.py`, no previous retro for this track, no separate session logs).

## Findings

Epic-2-relevant findings from the whole-initiative review (full detail in fix commit `78d7ebcc`/`f5aebccf`, `main`):

| # | Finding | Disposition |
|---|---------|--------------|
| 1 | **[Fixed]** `guest-resolution-known-name`'s deterministic check used unguarded substring matching (`text.includes(DEVORAH_EMAIL)`) — the exact false-positive shape (a match anywhere in the text, including inside a refusal or an unrelated quote) that `findTrailingMatch`'s sentence-boundary guard was built to prevent for the LLM-judge/sweep parsers (story 2.2/2.3's own prior fix, `8219c6fb`), never applied to this scenario's own check. | Fixed, commit `78d7ebcc` — domain-appropriate equivalent guard added (last-occurrence + reject-if-quoted + reject-if-negated-in-sentence); literal `findTrailingMatch` reuse didn't fit this domain (its sentence-*start* requirement rejects the real passing case, email embedded mid-sentence after a colon) — documented in-code as an explicit deviation from the original fix instruction. |
| 2 | **[Fixed]** `transcriptText()` (the "parse `content` as JSON, extract `.text`, join, swallow malformed rows" helper) was copy-pasted verbatim into `eval/sweep.ts`, `eval/judge/llm.ts`, and `eval/scenarios/guest-resolution.scenarios.ts` — the same duplication class `truncateForError` was extracted to prevent one file earlier (`c23246d2`), recurring here. | Fixed, commit `78d7ebcc` — extracted into `eval/transcript-text.ts`, all 3 call sites updated. Also applied `truncateForError` to bound the transcript embedded in `judge/llm.ts`'s prompt, previously unbounded. |
| 3 | **[Fixed]** The cleanup two-outcome `confirm()` logic (deleted vs. nothing-to-delete) was duplicated per-scenario across both `guest-resolution` scenarios rather than shared — this exact duplication already caused one live-discovered bug (`known-name` shipped with only a single-branch version, needed a dedicated post-initiative fix, `6a47cf07`, to catch up with `ambiguous-name`'s already-correct version). | Fixed, commit `78d7ebcc` — extracted `confirmDeletionOrNothingToDelete`, both scenarios now call it. |
| 4 | **[Fixed]** A real household member's actual email (`DEVORAH_EMAIL`) was hardcoded as a bare literal in tracked (non-gitignored) scenario source, duplicating and able to silently drift from the real source of truth — the mounted, gitignored `people.md` this scenario is meant to verify against. | Fixed, commit `78d7ebcc` — a runtime drift check now asserts the hardcoded constant still matches the real mounted file, failing loud instead of silently passing/failing for the wrong reason. Reading it live at scenario-load time wasn't clean (would break `loader.test.ts`'s hermetic no-fixture tests), so the check runs lazily inside `check()` instead. **Not attempted:** removing the email from git history — a separate, disruptive, operator-only decision, explicitly out of scope for this fix. |
| 5 | **[Fixed]** `VERDICT_PATTERN` (`eval/judge/llm.ts`) lacked the `\b` word-boundary anchor its sibling `SWEEP_PATTERN` (`eval/sweep.ts`) already had — an inconsistency between two near-identical parsers built together in the same initiative. | Fixed, commit `78d7ebcc`. |
| 6 | **[Fixed]** A failing scenario's `evidence` field (`eval/scenarios/guest-resolution.scenarios.ts`) had no size cap before being written to `report.json`, unlike the `truncateForError` discipline applied to reply text elsewhere in the same initiative. | Fixed, commit `78d7ebcc` — folded into finding 1's `check()` rewrite. |
| — | Container-lifecycle/safety findings (SIGINT handling, `killAllActiveContainers` guard, `assertIsEvalGroup`, cleanup-threadId test, `deliverErrorResult` guard test, partial-report-on-failure) | See `epic-1-retro-eval-harness-2026-08-25.md` — these belong to epic-1's own core deliverables, not epic-2's. |

### Spec-to-implementation reconciliation

No epic-2-specific scope divergence found. The one notable implementation-detail deviation is finding 1's fix itself: the fix instruction asked for literal `findTrailingMatch` reuse, and the implementer correctly judged that this didn't fit the domain (`findTrailingMatch`'s sentence-*start* anchoring would have rejected the real passing case) and built an equivalent, differently-shaped guard instead — documented in-code rather than silently deviating. Recorded here as the retrospective's own record of that judgment call, matching this repo's established "log the deviation, don't hide it" convention (per every story spec's own Spec Change Log format).

## Behavior verification

See epic-1's retro — same shared evidence: this codebase's own memory record documents live `pnpm eval run guest-resolution` runs (real container, real Claude call) passing both scenarios with real evidence, plus this retro's own fix commit verified via the full automated suite (`pnpm test` 1599/1600, `bun test` 558/566, all typechecks clean).

## Previous-retro follow-through

None — first retrospective for this track (see epic-1's retro for the same note).

## Action items

All fix-now items (1-6) already applied and merged, commit `78d7ebcc`/`f5aebccf`, under this session's standing autopilot authorization.

## Acceptance verdict

**Accepted-with-open-items** — same epic-level verdict and reasoning as `epic-1-retro-eval-harness-2026-08-25.md`; all findings landing in this epic's own code were fixed and verified before this verdict was rendered.

## Open questions

See `epic-1-retro-eval-harness-2026-08-25.md` — shared across all 3 eval-harness epic retros.

## Assumptions

See `epic-1-retro-eval-harness-2026-08-25.md`'s Assumptions section — the same headless-run choices (epic selection, tracker correction, consolidated review scope, fix-now application, machine verdict) apply identically to this epic's retro, since both were rendered in the same pass.
