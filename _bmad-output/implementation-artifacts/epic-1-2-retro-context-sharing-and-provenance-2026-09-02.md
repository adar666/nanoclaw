---
epic: 1-2
date: 09-02-2026
verdict: accepted-with-open-items
criteria: profiled
headless: false
---

# Retrospective — Context Sharing & Provenance (Epic 1: Cross-Group Context Sharing, Epic 2: Provenance & Receipts for Automated Actions)

Tracking file: `_bmad-output/implementation-artifacts/sprint-status-context-sharing-and-provenance.yaml`
Diff range: `067d628..f258732a` (6 commits, 0 merges)

## Epic summary

Two epics, six stories, all `done` at retro time:

| Epic | Story | Commit |
|---|---|---|
| 1 — Cross-Group Context Sharing | 1.1 read_shared_context | `1c332226` |
| 1 — Cross-Group Context Sharing | 1.2 eval: shared-context scenario set | `be368045` |
| 2 — Provenance & Receipts | 2.1 task/reminder provenance | `6dd01da7` |
| 2 — Provenance & Receipts | 2.2 self-mod change provenance | `81cf10a6` |
| 2 — Provenance & Receipts | 2.3 document write provenance | `fe42b6ef` |
| 2 — Provenance & Receipts | 2.4 on-demand cross-domain digest | `f258732a` |

All six stories were `review` at the point the retro gate ran; the user explicitly confirmed treating them as `done` and proceeding (each had already passed its own round-1 review during `bmad-build`, per the Spec Change Log in each story file). No story remained unfinished — `pending_stories` for both epics is empty. This is a **sprint-mode** epic pair from one initiative's `sprint-status-context-sharing-and-provenance.yaml`, retro'd together at the user's request ("רטרו ופוש" — run the retrospective, then push) since epic 2 reads all three provenance surfaces epic 1's own convention work sits alongside.

Evidence available: full diff (`067d628..f258732a`), all six story spec files with Spec Change Logs, `deferred-work.md` (append-only, all six stories' round-1 findings), `sprint-status-context-sharing-and-provenance.yaml`, and this session's own history (no separate session log file — the working conversation is the record). No evidence was missing for this retro.

## Findings

`bmad-review` ran the adversarial, edge-case-hunter, and verification-gap lenses against the full initiative diff, weighted specifically at cross-story boundary consistency: whether AD-7's shared provenance shape (`triggeredBy`/`requesterUserId`/`reason`/`at`) actually stayed byte-for-byte consistent across `scheduling/create.ts` (2-1), `self-mod-log.ts` (2-2), `documents.ts` (2-3), and `provenance-digest.ts` (2-4, which reads all three) — and whether the shared-context/mount-security convention (AD-2/AD-5/AD-13) stayed consistent between spec 1.1's tool and spec 1.2's eval fixture.

**Cross-story defects found and fixed this retro** (none of these were visible to any single story's own build-time review, since each only saw its own diff):

1. **Duplicate `parseProvenance`/`cleanReason` implementations, same host runtime.** `src/cli/resources/tasks.ts` and `src/modules/provenance-digest.ts` each carried their own copy — real drift risk (a fix to one's malformed-shape handling never propagates), and no cross-runtime justification the way `container/agent-runner/src/mcp-tools/documents.ts`'s own copy has (different package/runtime, no shared import possible). Extracted to a new shared `src/modules/provenance.ts`, imported by all three host-side call sites (`tasks.ts`, `provenance-digest.ts`, and `self-mod-log.ts`, which had its own narrower `\r?\n`-only cleaner).
2. **`self-mod-log.ts` reason-cleaning was narrower and inconsistent** with the shared `cleanReason` (documents/tasks): no whitespace-run collapse, no trim, no reject-if-whitespace-only. Fixed by switching to the shared helper — same fix as #1.
3. **`ProvenanceDigest.self_mod` broke AD-7's shared shape at the one place meant to federate all three domains.** `tasks`/`documents` both used `ProvenanceDigestSection<T>` (`{summary, items: T[]}`); `self_mod` was `{summary, entries: string[]}` — raw unparsed log lines. Independently flagged by both the adversarial lens *and* the edge-case-hunter lens. Fixed with a new `parseSelfModLogLine`/`SelfModLogEntry` pair in `self-mod-log.ts` — the exact inverse of `appendSelfModLog`'s own write format — giving `self_mod` a real `ProvenanceDigestSection<SelfModDigestItem>` shape without reversing AD-9's deliberate plain-text file-format choice.
4. **Digest section ordering was inconsistent.** `readSelfModLog`'s own documented contract is "newest last" (matching the file's append order); `tasks`/`documents` are both newest-first. `buildProvenanceDigest` now reverses only at the federation point, so every section's index 0 means the same thing in the one object meant to unify them, without changing `readSelfModLog`'s own contract for any other caller.
5. **`provenance-digest.ts`'s document-provenance re-parse had silently reintroduced a gap `documents.ts` had already fixed in its own round-1 review**: a malformed-but-present `provenance` object (wrong `triggeredBy`, missing `at`) dropped with no trace. Now logged via `log.warn`, same posture as the sibling reader.
6. **`tasks.ts`'s reason ternary let an empty string fall through as if it were a real reason** (`content.provenance?.reason && ... ? ... : (content.provenance?.reason ?? null)` — an empty string is falsy, so it fell to the second branch and rendered `''` instead of `null`). Fixed with a clean truthy-check ternary and `cleanReason(str(args.reason))` at write time (this story's writer was the one provenance writer in the whole initiative storing `reason` completely unbounded).
7. **`provenance-digest.ts`'s `TaskDigestItem.created_at`/`created_at_local` field names were misleading** for a recurring series — they carried the latest live row's own write time, not when the series was originally created (that's what `provenance_at` already answers, per AD-8: fixed at series creation, never regenerated on a later fire). Renamed to `row_timestamp`/`row_timestamp_local` with a clarifying doc comment.

**Findings independently reconfirmed, already tracked (not re-logged as new)**: the `*-shared` write-guard's nested-path false-positive and the empty-group-name-prefix bypass (`deferred-work.md`, spec-1-1 entries) — the cross-story review's pass over specs 1.1/1.2's mount-security convention surfaced the same shapes both round-1 reviews already found; no new instance beyond what's already on record.

**Findings routed to `deferred-work.md` rather than fixed now** (real, but out of this retro's fix-now scope):

- **Self-mod approver identity is discarded, not structurally unavailable.** Unlike tasks/documents (no human-approval step exists to name), self-mod's own approval flow genuinely resolves an approver (`pickApprover`) before `apply.ts`'s handlers run — that identity just isn't threaded through to `appendSelfModLog`. Real, closeable gap; bigger than a one-story patch (needs the approval-resolution result carried through the guard-approved-replay path into the handler bodies, plus a new field on the log format). New `deferred-work.md` entry logged this retro.

## Behavior verification

No new runtime behavior was exercised end-to-end this retro beyond what each story's own build-time review already did (each story's round-1 review included either a `bun test`/`pnpm test` run against real code paths, or — for 1.2 — a real eval-harness scenario run against a live container). This retro's own verification was: full `pnpm test` (1716 passed, 1 skipped — the skip and one expected-failure log line are both pre-existing, unrelated to this initiative), `pnpm exec tsc --noEmit -p .` (clean), `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (clean), and the specific fixed-file suites re-run in isolation (`provenance-digest.test.ts`, `self-mod-log.test.ts`, `tasks.test.ts` — 75/75 passed) with new tests added for each of the seven cross-story fixes above.

## Previous-retro follow-through

No prior retrospective exists for this initiative (`sprint-status-context-sharing-and-provenance.yaml` has no `action_items` array yet) — nothing to follow through on.

## Action items

1. **[Fixed this retro, no further action]** Items 1–7 above are already applied, tested, and will be committed with this retrospective.
2. **[Open]** Thread the resolved approver's user id through `src/modules/self-mod/apply.ts`'s `applyInstallPackages`/`applyAddMcpServer`/`applyAddCalendar` into `appendSelfModLog`, and extend the log line format (or add a structured sibling field) to carry it — closing the self-mod-approver-identity gap logged to `deferred-work.md` this retro. Owner: next dev pass on self-mod provenance, if/when self-mod audit trail becomes a real ask (not urgent — household-scale self-mod events are rare).

**Process lesson**: a cross-story shared-shape promise (AD-7) needs a check at the *federation point* specifically, not just per-domain review — three of the seven findings above (#1, #3, #4) were all instances of "each story's own review was clean, but the point where all three domains meet wasn't consistent with any of them." When a future initiative federates N independently-built domains into one shared surface, that federation point's own review pass should explicitly diff its output shape/ordering against each source domain's own contract, not just check it compiles.

## Acceptance verdict

**accepted-with-open-items** (criteria profiled, not declared — neither epic's own spec stated a machine-checkable acceptance criterion; profiled from `SPEC.md`'s five-field kernel and each story's own acceptance criteria).

- Both epics' criteria (epic 1: an agent group can read a fact shared by another agent group via a read-only mount, with the RW-by-default footgun structurally guarded; epic 2: task/self-mod/document actions carry `triggeredBy`/`reason`/`at` provenance, queryable on demand via one federated digest) are demonstrably met in the evidence — all six stories `done`, all round-1 reviews closed, this retro's own cross-story review found and fixed the boundary-consistency gaps a single-story review structurally couldn't see.
- No blocking finding remains open. The one open item (self-mod approver identity) is a real, named, but non-blocking gap — self-mod provenance already answers *what* changed, *when*, and (for two of three action types) *why*; it just can't yet answer *who approved it*, which the epic's own spec never promised.
- `pending_stories` is empty for both epics.

## Open questions

None a human answer would materially change right now — the one open item (self-mod approver identity) has a clear next step already recorded, to be picked up if/when it becomes a real ask rather than speculative.

## Assumptions

Interactive run — the epic-set was named explicitly in the retro's own invocation (both epics of `sprint-status-context-sharing-and-provenance.yaml`), and the "treat all six review-status stories as done, run the retro now" call was made by the user directly (AskUserQuestion, confirmed) rather than assumed by the retro run itself. No headless assumptions to record.
