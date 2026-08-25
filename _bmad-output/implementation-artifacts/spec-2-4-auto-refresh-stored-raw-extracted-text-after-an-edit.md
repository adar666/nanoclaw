---
title: 'Auto-Refresh Stored Raw/Extracted Text After an Edit'
type: 'feature'
created: '2026-08-25'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '3e18445d8c52be91032a5e3ef7a330faaaddc2e5'
---

<!-- Target: 900–1300 tokens. Above 1600 = high risk of context rot.
     Never over-specify "how" — use boundaries + examples instead.
     Cohesive cross-layer stories (DB+BE+UI) stay in ONE file.
     IMPORTANT: Remove all HTML comments when filling this template. -->

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A fill's output is delivery-only — the stored canonical raw file and extracted text never change, by design (Stories 1.2/2.2/2.3's frozen invariant). So recall always describes the pre-edit original, and a second fill on the same document also starts from the pre-edit original, silently discarding the first edit rather than compounding.

**Approach:** Extend `save_document` with an optional `document` argument (same free-text matching every other tool here uses). When given and it resolves to exactly one existing document, the call refreshes that document in place — overwrites its raw file and re-extracts its stored text from the new content — instead of creating a new, separately-slugged document (today's only behavior, unchanged when `document` is omitted). Before overwriting, the pre-refresh raw file is snapshotted into Story 2.3's existing fill-history mechanism, so it stays recoverable via `list_document_versions`/`send_file` exactly like a fill output — nothing is silently lost. This is the explicit, opt-in "re-save" the story stub names, mirroring `save_signature`'s existing `replace` precedent — never an automatic side effect of a fill.

## Boundaries & Constraints

**Always:**
- `save_document`'s existing behavior (always create a new, uniquely-slugged document) is completely unchanged when `document` is omitted — this is purely additive.
- `document` resolves via the exact same `resolveDocument` handshake every other tool in this file already uses (0 → not-found error, 1 → refresh that document, 2+ → numbered candidates, never guess).
- A refresh reuses `save_document`'s existing extraction pipeline unchanged (text-layer/OCR/`.doc`-conversion, all of it) against the new source file — never a parallel extraction path.
- Refresh updates both the raw file (`memory/documents/files/<slug>.<ext>`, possibly changing extension if the new file is a different type — e.g. an edited `.doc` output re-saved as `.docx`) and the concept file's body/`saved-date` — never one without the other, since `fill_document_field` reads the raw file and recall reads the concept body; updating only one leaves them inconsistent.
- Before overwriting, the pre-refresh raw file is copied into `.document-fills/` and recorded via Story 2.3's existing `recordFillHistory` (same `FillHistoryEntry` shape, `target: "pre-refresh snapshot"`) — the same cap/lock/never-auto-deleted behavior 2.3 already built, no new mechanism.
- `memory/index.md`'s existing summary line for that document is left as-is (still points at the same concept file; its filename-restatement text doesn't need updating — same non-goal CAP-1 already established for that line).
- Same MCP error shape (`err()`) for any resolution failure; a refresh's own extraction failure uses the exact same error path `save_document` already has for a fresh save.

**Ask First:**
- None — the explicit `document` argument itself is the confirmation signal (same pattern `save_signature`'s `replace` already uses); the tool description and SKILL.md instruct the agent to only pass it when the user explicitly asked to replace/update the stored version, never as a default after every fill.

**Never:**
- Never make refresh automatic — a fill never triggers it; it's a distinct, explicitly-invoked action, matching the story's own "a re-save is a separate action" framing.
- Never lose the pre-refresh content irrecoverably — the snapshot-before-overwrite step is mandatory, not best-effort.
- Never change `fill_document_field`/`fill_document_field_batch`'s own behavior or their "stored copy never modified" invariant — refresh is a `save_document` capability, not a fill capability.
- Never touch `memory/index.md`'s existing entry shape or add a second entry for the same document.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Refresh an unambiguous existing document | `save_document({ path: <fill output>, document: "report" })` | Raw file + concept body updated in place, same slug; pre-refresh raw file snapshotted into fill-history | N/A |
| `document` omitted | `save_document({ path: <new file> })` | Unchanged today's behavior — new, separately-slugged document | N/A |
| `document` doesn't match any saved document | `document: "nonexistent"` | Whole-call error, nothing written | `err()`, same "no match" wording precedent |
| `document` matches 2+ saved documents | `document: "report"` (ambiguous) | Numbered candidate list, nothing written | Same handshake as every other tool |
| A second fill after a refresh | `fill_document_field({ document: "report", ... })` | Operates on the refreshed (edited) raw file, not the pre-refresh original — edits now compound | N/A |
| Refresh source is a different file type than the original | Original was `.doc`, refresh source is `.docx` | Raw file's extension changes to match; concept frontmatter's `raw-file` pointer updated accordingly | N/A |

</frozen-after-approval>

## Code Map

- `documents.ts:632-855` `saveDocumentImpl` -- the whole function; add the `document`-resolution branch near the top, before the always-new `uniqueSlug` path, so it can early-branch into a refresh path.
- `documents.ts:777-818` -- today's always-new write-out (`uniqueSlug`, `COPYFILE_EXCL`, `wx`-flag concept write) -- the refresh path uses the resolved existing `slug` instead and drops the exclusive-create flags (this call site legitimately overwrites).
- `documents.ts:1179` `matchDocuments`/`resolveDocument` -- reused unchanged for the new `document` argument.
- `documents.ts:1705-1798` `FillHistoryEntry`/`fillHistoryPath`/`readFillHistory`/`recordFillHistory` -- reused unchanged for the mandatory pre-refresh snapshot.
- `documents.ts:916-962` `writeSignaturePng` (`save_signature`'s `replace` handling) -- the direct precedent this story's `document`-argument opt-in pattern and symlink-defense-before-overwrite convention mirrors.
- `documents.ts:1133-1167` `readConceptMeta` -- confirms `raw-file` frontmatter is written but not read back elsewhere; still keep it accurate on refresh for a human reading the file directly.
- `documents.test.ts` -- existing `saveDocumentImpl`/fixture/`opts()` conventions to follow for the new describe block.
- `container/skills/document-memory/SKILL.md` -- new guidance: when to pass `document` (explicit user ask to replace/update, never by default), reusing "Undoing a bad edit" section's own recoverability framing.
- `_bmad-output/specs/spec-document-memory/SPEC.md` -- amend CAP-1's intent to note refresh is now possible via an explicit opt-in, and correct CAP-8's Non-goals line 76 ("never mutating stored state") and its "same as every other capability in this file" framing (L46), which go stale once this ships — do not leave the old text standing unqualified, per the Story 2.1 amendment precedent.

## Tasks & Acceptance

**Execution:**
- [x] `documents.ts` `saveDocumentImpl` -- add optional `document` arg; when given, resolve via `resolveDocument`, snapshot the pre-refresh raw file into fill-history, then overwrite the raw file + rewrite the concept file in place instead of creating a new slug
- [x] `documents.ts` -- `save_document`'s tool schema/description gains `document` with explicit "only when the user asked to replace/update" guidance, mirroring `save_signature`'s `replace` wording
- [x] `documents.test.ts` -- new describe block covering every I/O Matrix row, plus a snapshot-recoverable-via-`list_document_versions` regression test
- [x] `container/skills/document-memory/SKILL.md` -- section teaching when to pass `document` on a re-save, and that the pre-refresh version stays recoverable the same way an "undo" already works
- [x] `_bmad-output/specs/spec-document-memory/SPEC.md` -- amend CAP-1 intent; correct CAP-8's now-stale Non-goals line and "same as every other capability" framing

**Acceptance Criteria:**
- Given a saved document and its fill output, when `save_document` is called with `document` set to that document's identity, then recall (reading the concept file) reflects the edited content, not the original.
- Given the same setup, when a second `fill_document_field` call runs afterward, then it fills the refreshed (edited) document, not the pre-refresh original.
- Given a refresh just happened, when `list_document_versions` is called for that document, then the pre-refresh raw file appears as a recoverable entry.
- Given `document` is omitted, when `save_document` runs, then behavior is byte-for-byte identical to today (new, separately-slugged document).

## Spec Change Log

- 2026-08-25 (implementation, real gap found live, not anticipated by this spec's own frozen text): the frozen Intent/I-O-matrix's own primary example, `save_document({ path: <fill output>, document: "report" })`, could not actually work against the unmodified `resolveInboxPath` — a fill's output lives under `<baseDir>/.document-fills/`, never under `<workspaceRoot>/inbox/`, and that function's containment check only ever allowed the latter. Fixed by giving `resolveInboxPath` an optional second allowed root, passed only from `save_document`'s own call site (`save_signature`'s call site is unchanged, inbox-only) — pointed at `<baseDir>/.document-fills`, a directory that only ever holds files this same tool already wrote for the calling agent earlier in the session (a fill output, or this story's own pre-refresh snapshot), never arbitrary/untrusted content, so widening containment to it doesn't expose anything the agent didn't already have a path to. Confirmed via a new regression test (`save_document — refresh, a second fill afterward compounds on the refreshed content`) that exercises the exact call shape the spec's own I/O matrix names.
- 2026-08-25 (implementation, per this spec's own Code Map instruction): `SPEC.md`'s CAP-1 intent, CAP-8 intent, and CAP-8's Non-goals line are amended in place (not left standing unqualified) to record that `save_document`'s `document` argument is now the one explicit, opt-in exception to this file's previously-unconditional "the stored raw file/text is never touched" framing — CAP-8's own mechanism (`list_document_versions`, every fill path) still never mutates anything; only this one new, explicit refresh action does.
- 2026-08-25 (implementation): `documents.ts`'s always-new write-out template (frontmatter + heading + body) was factored into a shared `buildConceptBody` helper so the refresh path and the fresh-save path can never drift apart in shape — verified byte-for-byte identical output for the omitted-`document` case via the existing (unmodified) happy-path tests, which still pass unchanged.
- 2026-08-25 (step-04 review — blind-hunter/edge-case-hunter/verification-gap layers; all 12 findings classified `patch`, applied directly, no new spec/intent renegotiation): this story's first-ever mutation of previously-immutable stored content surfaced more real issues than any of the three prior stories in this epic, per the review's own framing. **Real correctness bug closed (highest priority):** the refresh's rm→copy→write sequence had no rollback — a partial failure (e.g. the concept-file write throwing after the old raw file was already removed) could leave the document with a missing or inconsistent raw file. Fixed by wrapping that sequence in try/catch; on failure, the pre-refresh raw file is restored from the bytes already captured for the snapshot (written to disk *before* the mutating sequence starts, so it's never lost regardless of how the rollback itself goes), any new-extension file that landed before the failure is best-effort cleaned up, and the error is rethrown — regression-tested by forcing the concept write to fail (read-only permissions on the concept file specifically, chosen because it blocks only the write, not the reads resolution needs) and confirming the raw file comes back with its original bytes. **Real correctness bug closed:** `buildConceptBody` was called with the new source file's own basename on a refresh too — since a refresh's `path` is typically a fill output or other machine-generated filename, this was silently overwriting `source-filename`/`description`/the H1 heading with something not user-meaningful. Fixed by passing the *existing* document's already-stored `sourceFilename` (from the resolved `DocumentMeta`) on the refresh path instead; only `saved-date`, the raw file's extension/content, and the extracted body text now actually change on a refresh. **Real scope-creep bug closed:** the `.document-fills` containment widening (added to make the spec's own `save_document({ path: <fill output>, document: "report" })` example work — see the entry above) was wired unconditionally, so even a plain new-document save with no `document` argument could source its content from a fill output, which was never intended. Fixed by gating it on `documentQuery` being present (refresh calls only); a fresh save is inbox-only again, exactly as before this story — regression-tested. **Real concurrency bug closed:** `fillOneDocument` read a document's raw file without acquiring the same `.index.lock` the refresh path now mutates that raw file under, risking a spurious "missing" error or a torn read if the two raced. Fixed by having `fillOneDocument` briefly acquire that same lock to snapshot the raw file's current bytes into a private temp copy (`os.tmpdir()`, cleaned up in a `finally`), then pass that immutable copy to `fillDocx`/`fillDoc`/`fillPdf` unchanged — none of those three care about the path's identity, only its bytes, so this needed no change to their own internals; the lock's duration covers only the one copy, not the whole (potentially slow) fill/stamp pipeline. **Hardening:** a whitespace-only `document` argument now errors (`'document must not be empty'`) instead of silently trimming to empty and falling through to a fresh save with no signal that the caller's refresh intent was dropped. **Hardening:** both Ask-First halt messages (scanned-PDF-OCR near-empty, and the plain-image two-call prompt) now tell the agent to include `document` again on the follow-up call when the current call is a refresh — otherwise a retry that only repeats `path`/`extractedText` (the normal, non-refresh instruction) would silently downgrade an intended refresh into a fresh, separately-slugged save. **Hardening:** the refresh target is now re-resolved via `resolveDocument` *inside* the lock, immediately before mutating anything — it was previously resolved once, before the lock was acquired, so a same-slug double-refresh race could act on already-stale ext/existence info; the re-check turns that race into a clear, accurate error instead of a confusing one further down. **Response-accuracy fix:** the refresh success message used to unconditionally claim "the pre-refresh version stays recoverable via list_document_versions" from inside the lock, before `recordFillHistory` (which is what actually makes that true, and is explicitly best-effort) had even run. Response composition now happens after that attempt, and the wording reflects which outcome actually happened. **Documentation only, no behavior change:** `save_document`'s `document` schema description and the SKILL.md "Refreshing" section both now note that nothing verifies the passed file actually corresponds to the named document — that correspondence is the caller's responsibility, same trust model as every other free-text-matched argument in this file; a doc comment near `FILL_HISTORY_CAP` and the matching SKILL.md bullet now note that a pre-refresh snapshot shares the same capped 20-entry history as real fill outputs, not a separate allowance; `SPEC.md`'s CAP-1 and CAP-8 success bullets (previously only their intent bullets) are now amended to match. **Explicitly declined, not applied (logged to `deferred-work.md` instead):** a structural blocking `ask_user_question` confirmation before every refresh (judged materially different from `delete_calendar_event`'s precedent — that tool's problem was true unrecoverable loss with zero built-in recovery; this story's refresh always snapshots first, so a wrong refresh is agent-recoverable, not silently lost); and a dedicated end-to-end test combining a refresh with the OCR/interactive two-call round-trip (real completeness gap, not a found bug — the fixture is nontrivial and the halt-message fix itself is still covered by a lighter-weight unit check). Re-verified after this round: `cd container/agent-runner && bun test` (full suite, 554 pass / 8 skip / 0 fail) and `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`, both clean.

## Design Notes

Reusing Story 2.3's fill-history mechanism for the pre-refresh snapshot (rather than inventing a second, parallel history system) directly resolves the exact coordination question 2.3's own Design Notes left open for this story: "needs to re-examine this story's own invariant list before assuming it can safely start mutating the stored copy." The answer here is that mutation is fine as long as it's explicit, opt-in, and the prior state is preserved through the same recovery path a fill's own history already uses — not a new concept for the user to learn. Extending `save_document` rather than building a dedicated new tool follows `save_signature`'s own `replace` precedent for "an explicit opt-in, identity-preserving overwrite of a stored asset" — the only existing convention in this codebase for exactly this shape of action.

## Verification

**Commands:**
- `cd container/agent-runner && bun test src/mcp-tools/documents.test.ts` -- expected: all refresh cases pass alongside the existing (unmodified-behavior) save suite
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

**Manual checks (if no CLI):**
- Save a real document, fill it, refresh it with the fill output, confirm recall reflects the edit and the pre-refresh version is listed and resendable via `list_document_versions`.

## Suggested Review Order

**Refresh core — the design fork this story resolves (mutating previously-immutable stored state, explicitly and recoverably)**

- Entry point: refresh resolution branches before the extraction pipeline; the critical section itself.
  [`documents.ts:733`](../../container/agent-runner/src/mcp-tools/documents.ts#L733)

- `buildConceptBody`: shared template between fresh-save and refresh, so the two paths can't drift in shape.
  [`documents.ts:698`](../../container/agent-runner/src/mcp-tools/documents.ts#L698)

- `refuseIfSymlink`: the symlink defense mirrored from `save_signature`'s existing `replace` precedent.
  [`documents.ts:670`](../../container/agent-runner/src/mcp-tools/documents.ts#L670)

**Review-round fixes — the real correctness bugs found once mutation entered the picture**

- Rollback on partial failure, and gated `.document-fills` containment widening.
  [`documents.ts:145`](../../container/agent-runner/src/mcp-tools/documents.ts#L145)

**Test verification of the review-round fixes**

- Rollback-on-failure, metadata preservation, symlink refusal at all three call sites, containment gating regression guard.
  [`documents.test.ts:1426`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L1426)

**Baseline I/O-matrix coverage**

- Unambiguous refresh, ambiguous match, second-fill compounding, cross-extension refresh.
  [`documents.test.ts:1244`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L1244)

**Peripheral — planning-doc parity and agent-facing guidance**

- `SPEC.md`'s CAP-1/CAP-8 amendments (both intent and success bullets).
  [`SPEC.md:17`](../specs/spec-document-memory/SPEC.md#L17)

- `SKILL.md`'s new "Refreshing" section, including the OCR-halt retry fix and the identity-correspondence caveat.
  [`SKILL.md:369`](../../container/skills/document-memory/SKILL.md#L369)
