---
review: reconcile-spec
target: ARCHITECTURE-SPINE.md (Cross-Group Context Sharing + Provenance/Receipts)
source: spec-context-sharing-and-provenance/SPEC.md
date: 2026-08-31
verdict: gaps found
---

# Reconciliation Review — Spec vs. Spine

Claim-by-claim trace of SPEC.md against ARCHITECTURE-SPINE.md.

## Why

Rationale-only; not a testable claim. The "industry-standard, not household-minimal" bar is referenced once in the spine's Constraints-carryover (rigor bar) but not structurally reinforced — see Finding 3.

## CAP-1 — intent + success

- Intent (query, read-only, no full merge, no isolation break): fully covered — AD-2 (mount-allowlist reuse), AD-3 (fixed file), AD-4 (tool), AD-6 (no error/guess), Consistency Conventions row ("read-only and one-directional per grant... never writes into another group's memory").
- Success (eval-harness verification matching existing bar): covered — AD-12, `eval/scenarios/shared-context.scenarios.ts` mirroring `guest-resolution.scenarios.ts`, one deterministic + one llmJudge case.

**Landed cleanly.**

## CAP-2 — intent + success

- Intent (task creation/firing, self-mod change, document write each record trigger+requester): covered per-domain — AD-8 (tasks, `content.provenance` on `messages_in`), AD-9 (self-mod, new `self-mod-log.md`), AD-10 (documents, `FillHistoryEntry.provenance`). One shared shape via AD-7.
- Success ("captured at creation time, never reconstructed after the fact"): matches — all three ADs write provenance at write time, not derived later.
- Success signal's "demonstrated live against the running system" half is not addressed anywhere in the spine (see Finding 4) — the spine only guarantees the eval-harness/queryable-surface half.

**Mostly landed; one thread (live demonstration) has no architectural hook, and see Finding 1 below on the digest.**

## Constraints

1. CAP-1 reuses mount-allowlist, no new trust boundary, opt-in per source group, consistent with 3-level isolation model — covered (AD-2, companion reference).
2. CAP-1 read-only, one-directional, no write-back — covered (AD-1, Consistency Conventions).
3. CAP-2 reuses existing structures ("task metadata, **self-mod approval log**, memory provenance conventions"), no new storage subsystem, no event bus — **partially diverges**. AD-9 explicitly does *not* reuse the self-mod approval log (`pending_approvals`); it deliberately avoids it (blast-radius reasoning) and introduces a brand-new file, `self-mod-log.md`, that did not exist before this spec (verified: no `self-mod-log`/`run-log`-for-self-mod precedent in the codebase prior to this spine). The AD's reasoning is sound and it does mirror an existing *pattern* (`src/modules/scheduling/run-log.ts`, confirmed to exist), but the SPEC's literal constraint text named the self-mod approval log as the thing to reuse — the spine silently swaps that for a new artifact instead. Worth a reviewer's explicit sign-off, not necessarily a defect. See Finding 2.
4. Both capabilities route only through two-DB split + MCP-tool/CLI boundaries, no new IPC — covered explicitly (AD-1, Design Paradigm: "No new runtime, no new IPC channel, no new database table").
5. "Real test coverage on both host (`pnpm test`) and container (`bun test`) trees... not scoped down to 'good enough for one household'" — **not represented anywhere in the spine.** AD-12 covers the eval-harness half of this constraint but the spine has no invariant, convention, or Deferred-note addressing host/container unit-test coverage at all. See Finding 3.

## Non-goals

1. Not full bidirectional merge/real-time sync — covered (AD-1, read-only framing throughout).
2. Not retroactive (CAP-2 doesn't backfill pre-existing tasks/changes) — explicit for documents only (AD-10 cites `readFillHistory`'s tolerant-reader/backward-compat handling). For tasks (AD-8) and self-mod (AD-9) this is implied by "additive"/"new log going forward" phrasing but never stated outright the way AD-10 states it for documents. Minor asymmetry, not a real gap — implementers building AD-8/AD-9 in the spirit of "additive" would naturally not backfill, but the spine doesn't say so as explicitly as it does for AD-10.
3. Not a new generic pub/sub/event bus — covered (AD-1, Design Paradigm's "no new IPC channel").
4. Trust-via-visible-uncertainty / generalized idempotency-guard-undo / persona-tuned risk profiles out of scope — **covered near-verbatim** in the Deferred section's last bullet, correctly attributed to SPEC.md's Non-goals.

**Landed cleanly, aside from the minor asymmetry noted above.**

## Success signal

- CAP-1 half (fact surfaces cross-group without re-telling, eval-covered) — covered (AD-12).
- CAP-2 half (task/self-mod/document each show correct trigger+requester "when the user asks why," demonstrated live) — the queryability is covered (AD-11: `ncl tasks get`, `self-mod-log.md`, `list_document_versions`); the "demonstrated live" clause has no architectural counterpart (see Finding 4, same as CAP-2 success above).

## Assumptions

1. CAP-1 scoped to "durable family facts... distinct from full conversational memory or from what calendar/documents already hold" — **not encoded as an invariant.** AD-3 fixes the file name/location/frontmatter convention but says nothing about *content scope*. Nothing in the spine constrains what can go into `shared-facts.md`, so an agent (or operator) could just as easily dump full conversational memory into it without violating any AD. The Structural Seed lists a `shared-context/SKILL.md` file but doesn't specify what scope guidance it must carry. This is exactly the kind of quiet, tone-bearing requirement the review was asked to watch for. See Finding 5.
2. CAP-2's periodic digest is in scope, folded into "answerable on demand," not a separate capability — **contradicted, not just under-specified.** See Finding 1, the top finding of this review.

## Open Questions

All three explicitly resolved and named as such:
1. MCP tool vs. CLI verb → AD-4, explicitly says "resolves SPEC.md's open question... in favor of the tool."
2. Push vs. pull digest → AD-11, pull-only, push deferred.
3. `add-mount` as-is vs. purpose-built verb → AD-2, reuses `add-mount` unchanged.

**Landed cleanly** — best-covered section of the spec.

---

## Top Findings

1. **The digest/recap capability the SPEC assumed was in scope got fully dropped, not just deferred on timing — and the spine's own Deferred-section justification misattributes an Assumption to an Open Question.** SPEC's Assumptions section states plainly: "Assumed CAP-2's periodic digest... is in scope as part of 'answerable on demand,' not a separate capability." That's an affirmative in-scope claim. The spine's AD-11 defers *push* (fair — SPEC's Open Questions left push-vs-pull undecided) but its Deferred section goes further and also defers "a unified cross-domain 'why' query tool federating tasks/self-mod/documents in one call" — i.e., no recap/digest of any kind, push or pull, ships. The Deferred section's own citation ("SPEC.md's assumption noted this wasn't a hard requirement") is quoting the Open Questions section's push-vs-pull hedge, not the Assumptions section's in-scope claim — those are two different SPEC sections making two different claims, and the spine's phrasing conflates them. Net effect: CAP-2 ships three siloed per-domain answers (`ncl tasks get`, `self-mod-log.md`, `list_document_versions`) with no "recap of what's being automated and why" surface at all, which is a real scope reduction from what SPEC assumed, dressed up as if it were already sanctioned by SPEC itself. Needs an explicit reviewer decision, not a silent pass-through.

2. **AD-9 swaps the SPEC's named "self-mod approval log" for a brand-new file, `self-mod-log.md`, with no prior precedent in the codebase — a real (well-reasoned) architectural choice, but a divergence from the constraint's literal text that isn't flagged as such anywhere in the spine.** The AD's own "Prevents" clause is candid about *why* (avoiding blast-radius on the shared `pending_approvals` table), but nothing in the spine surfaces this as a deviation from SPEC's constraint 3 ("reuses existing structures... self-mod approval log") for a reviewer to explicitly bless.

3. **SPEC's constraint 5 — real test coverage on both `pnpm test` and `bun test` trees, "not scoped down to good enough for one household" — has no counterpart anywhere in the spine.** AD-12 covers the eval-harness half only. There's no AD, Consistency Convention, or Deferred note addressing host/container unit-test coverage for the new tool, provenance fields, or self-mod log. This may be a legitimate "architecture spine doesn't carry test-plan directives" scoping choice, but since SPEC explicitly ties this rigor bar to the project's own "industry-standard, not household-minimal" identity (the Why section's closing line), its total absence from the spine is worth a deliberate call, not a silent one.

4. **The success signal's "demonstrated live" clauses (both CAP-1's live household demo and CAP-2's live-system demo) have no architectural hook.** Not necessarily a spine defect — live demonstration is arguably a build/acceptance-time activity, not a structural invariant — but it's a claim from SPEC that doesn't visibly land anywhere in the spine, Deferred section included, so nothing currently obliges a later story to actually do it.

5. **CAP-1's Assumption that shared facts are scoped to "durable family facts," distinct from full conversational memory and from what calendar/documents already hold, is not encoded as an invariant anywhere.** AD-3 fixes the file's name/path/frontmatter shape but is silent on content scope; the Structural Seed's `shared-context/SKILL.md` is listed but its required content (the scope guidance) isn't specified. Without an AD or convention constraining this, an implementer or agent could populate `shared-facts.md` with arbitrary memory content and nothing in the spine would catch it — this is the "quiet, tone-bearing requirement" the review brief specifically asked to check for.

Minor/non-blocking: non-retroactivity (SPEC non-goal 2) is stated explicitly for documents (AD-10) but only implied, not stated, for tasks and self-mod (AD-8/AD-9).
