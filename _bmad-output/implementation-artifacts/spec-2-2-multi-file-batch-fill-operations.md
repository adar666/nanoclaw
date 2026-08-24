---
title: 'Multi-File / Batch Fill Operations'
type: 'feature'
created: '2026-08-24'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'b2d02b24418b38a0e8c5a736b71e0cee1c279dfa'
---

<!-- Target: 900–1300 tokens. Above 1600 = high risk of context rot.
     Never over-specify "how" — use boundaries + examples instead.
     Cohesive cross-layer stories (DB+BE+UI) stay in ONE file.
     IMPORTANT: Remove all HTML comments when filling this template. -->

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `fill_document_field` is one-document-per-call — filling the same value into N saved documents (e.g. the same signature date across three contracts) needs N manual calls today, with no combined success/failure picture.

**Approach:** Add a new `fill_document_field_batch` MCP tool, reusing `fill_document_field`'s existing per-document targeting logic unchanged (table/row/column, lineNumber, fieldName, pixelX/pixelY — same auto-detection by file type, same value for every target). It accepts either an explicit list of document names/slugs or a single substring query matching every saved document — the two input shapes the story stub itself names ("naming multiple saved documents (or 'all documents matching X')"). One value, one set of targeting args, applied uniformly; each document's fill succeeds or fails independently and every outcome is reported — never a silent partial batch.

## Boundaries & Constraints

**Always:**
- New tool, not a change to `fill_document_field`'s existing schema/behavior — its `required: ['document']` single-call contract and tests are frozen and untouched.
- Internally, the batch tool calls the exact same per-document fill logic `fill_document_field` already uses (same file-type auto-detection, same `DOCX_ONLY_ARGS`/`PDF_ONLY_ARGS` validation, same output-file-per-document convention `${slug}-filled-...`) — no parallel targeting implementation.
- Exactly one of two mutually exclusive inputs selects the target set:
  - `documents: string[]` — each entry independently resolved via the existing `matchDocuments` substring search: 1 match → included; 0 or 2+ matches → that entry is a per-item failure (not a batch-wide halt), with the same "no match" / "ambiguous, be more specific" wording `fill_document_field` already uses for a single call.
  - `matchQuery: string` — one substring query; every document `matchDocuments` returns for it becomes a batch target. Zero matches for `matchQuery` is a whole-call `err()` (nothing to iterate), matching `list_documents`'s existing no-match behavior.
- One `value` and one set of targeting args (`table`/`row`/`column`/`fieldName`/`lineNumber`/`pixelX`/`pixelY`) apply identically to every resolved document — never a per-document value or per-document targeting override.
- The stored canonical raw file and stored extracted text are never touched for any document in the batch — same invariant as the existing single-document fill.
- Response is a single `ok()` text report: an N/M-succeeded summary line, then one line per document naming its outcome (output path on success, exact reason on failure) — never omit a document from the report.
- Errors use the existing MCP shape (`{ content: [...], isError: true }`) only for the whole-call failure case (0 documents to act on); a batch with at least one per-item failure is still `ok()` with that failure named in the report, per "never a silent partial batch."
- No new delivery mechanism — the tool never calls `send_file`; the agent relays each successful output path exactly as it already does for a single fill.

**Ask First:**
- None — the input shape, per-item ambiguity handling, and response shape are all fully specified above from the story stub's own two named input forms.

**Never:**
- Never accept a per-document value or per-document targeting-arg override in this story — same-value-same-field only, matching the story's own framing ("the same value applies to many").
- Never let one document's fill failure abort or roll back another document's already-completed fill in the same batch call.
- Never change `fill_document_field`'s own schema, required args, or return shape.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| All targets resolve and fill successfully | `documents: ["report", "letter"]`, valid shared `lineNumber` for both | `ok()` "2/2 succeeded" report, one output path line per document | N/A |
| Mixed success/failure across the batch | `documents: ["report", "missing-doc"]` | `ok()` "1/2 succeeded" report; `report` shows its output path, `missing-doc` shows "no match" — no batch abort | N/A (per-item failure, not a thrown error) |
| An entry in `documents` is itself ambiguous | `documents: ["report"]` where "report" matches 2 saved documents | That entry reported as a per-item failure ("ambiguous, be more specific") in the same combined report; other entries still processed | N/A (per-item failure) |
| `matchQuery` matches zero documents | `matchQuery: "nonexistent"` | Whole-call `err()` — nothing to iterate | `err("No saved document matches...")`, same wording as `list_documents` |
| Neither or both of `documents`/`matchQuery` given | `{}` or `{documents: [...], matchQuery: "x"}` | Whole-call `err()` rejecting the malformed request before any fill runs | `err("Provide exactly one of documents or matchQuery")` |
| Targeting args don't apply to one document's file type | `fieldName` given, but one matched document is a `.docx` needing `lineNumber` instead | That document reported as a per-item failure with the existing per-type validation error text; others in the batch unaffected | N/A (per-item failure, existing validation reused) |

</frozen-after-approval>

## Code Map

- `documents.ts:1179` -- `matchDocuments`/`resolveDocument`/`DocumentResolution` (1197-1208) -- reused per-entry for `documents[]`, as-is for `matchQuery`.
- `documents.ts:2905-2967` -- `fillDocumentFieldImpl`'s per-document fill body (targeting validation, `DOCX_ONLY_ARGS`/`PDF_ONLY_ARGS`, `writeFillOutput`) -- extract into a shared internal helper, don't duplicate.
- `documents.ts:88-94` -- `ok()`/`err()` helpers, reused throughout.
- `documents.ts:1191` -- `formatDocumentCandidates` -- wording precedent only (batch's per-item ambiguity note is one line, not a full candidate list).
- `documents.test.ts:1272-1310` -- existing fill describe blocks + `opts()`/`extractOutPath` conventions to follow for the new batch describe block.
- `container/skills/document-memory/SKILL.md:102-120,274-279` -- parallel batch section, single-fill instructions untouched.
- `_bmad-output/specs/spec-document-memory/SPEC.md` -- next CAP entry after existing CAP-6, referencing CAP-3's fill intent rather than restating it.

## Tasks & Acceptance

**Execution:**
- [x] `documents.ts` -- extract `fillDocumentFieldImpl`'s single-document body into an internal `fillOneDocument()` helper, existing tool calls it unchanged -- sets up reuse, zero behavior change to the shipped tool
- [x] `documents.ts` -- add `fillDocumentFieldBatch: McpToolDefinition` (`documents?: string[]`, `matchQuery?: string`, same `value`/targeting args as today) per the Boundaries above -- the new capability
- [x] `documents.ts` `registerTools([...])` -- register alongside the existing four
- [x] `documents.test.ts` -- new describe block covering every I/O Matrix row
- [x] `container/skills/document-memory/SKILL.md` -- section teaching when/how to call the batch tool and relay its report (loop `send_file` per success)
- [x] `_bmad-output/specs/spec-document-memory/SPEC.md` -- add the new CAP entry

**Acceptance Criteria:**
- Given `documents: [a, b, c]` where all three resolve to exactly one document each and the targeting args apply to all three, when `fill_document_field_batch` runs, then all three are filled and the report shows 3/3 succeeded with each output path.
- Given a batch where one named document doesn't exist and the rest do, when the tool runs, then the existing documents are still filled, the missing one is named as a failure in the same report, and nothing is silently dropped.
- Given `matchQuery` matching zero documents, when the tool runs, then it returns a whole-call error rather than an empty/silent success report.
- Given both `documents` and `matchQuery` provided together (or neither), when the tool runs, then it rejects the call before attempting any fill.

## Spec Change Log

- 2026-08-24 (implementation): Extracted `fillOneDocument(meta, filesDir, args, opts)` out of `fillDocumentFieldImpl` in `container/agent-runner/src/mcp-tools/documents.ts` — the exact same ambiguous-extension check, image-target decline, `DOCX_ONLY_ARGS`/`PDF_ONLY_ARGS` validation, and `fillDocx`/`fillDoc`/`fillPdf` dispatch, unchanged, now shared by both tools. `fillDocumentFieldImpl` itself now just resolves `document` (via `resolveDocument`, its existing 0/1/2+ handshake, untouched) and calls the helper — zero behavior change, confirmed by the full existing `fill_document_field` test suite staying green with no edits to its assertions.
- 2026-08-24 (implementation): Added `fillDocumentFieldBatchImpl`/`fillDocumentFieldBatch`, registered alongside the existing four tools. `documents[]` resolves each entry independently via `resolveDocument` (not-found -> `No saved document matches "<query>".`; ambiguous -> `Multiple saved documents match "<query>" — ambiguous, be more specific.`, deliberately one line, not a full candidate list, per the Code Map's `formatDocumentCandidates` precedent note); `matchQuery` resolves via `matchDocuments` directly, with zero matches rejected as a whole-call `err()` before any fill runs. A resolved target's "success" is judged by the presence of `FILL_SUCCESS_MARKER` (`'New file at '`) in its `fillOneDocument` result text, not just `!isError` — an engineering call not spelled out row-by-row in the I/O Matrix: a per-document discovery/prompt response (e.g. a document whose args under-specify a target, returning the same "which row?" prompt a single `fill_document_field` call would) never wrote a file, so it is reported as a per-item failure (the prompt text as the reason) rather than miscounted as a success with no output path — consistent with the frozen "output path on success, exact reason on failure" line and "never a silent partial batch."
- 2026-08-24 (implementation): `SKILL.md` gained a new top-level section ("Filling the same value into many saved documents at once") teaching when to use the batch tool, the `documents`/`matchQuery` choice, how to read the combined report, and the "loop `send_file` once per successful path, skip the failed ones" delivery rule. `SPEC.md` gained CAP-7, referencing CAP-3's fill intent rather than restating it, per the Code Map instruction.
- 2026-08-24 (implementation, scope note not explicit in the frozen Boundaries text): the batch tool's JSON schema intentionally omits `signatureName` — the Boundaries section enumerates the shared targeting args as `table`/`row`/`column`/`fieldName`/`lineNumber`/`pixelX`/`pixelY` only, and the story stub's own framing ("the same value applies to many") reads as scoped to plain value fills, not signature stamping. `fillOneDocument` forwards the full `args` object unmodified either way (same as the pre-existing single-call path), so this is a documentation/schema-surface scope decision, not a code-level block — if a future story wants batch signature stamping, only the schema (and SKILL.md) need to grow, not the fill logic.
- 2026-08-24 (implementation): Verification run — `cd container/agent-runner && bun test` (full suite, container-wide): 507 pass / 8 skip (skips are the pre-existing LibreOffice-unavailable-in-sandbox skips, unrelated to this change) / 0 fail. `documents.test.ts` alone: 161 pass / 7 skip / 0 fail, including the new `fill_document_field_batch` describe blocks covering every I/O Matrix row plus a "never touches the stored canonical files" and an "existing single-call tool untouched" regression check. `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` and `pnpm exec tsc --noEmit -p .` both clean.
- 2026-08-24 (step-04 review — blind-hunter/edge-case-hunter/verification-gap layers, all findings classified `patch`, applied directly, no new spec/intent work): **Real Boundary violation closed**: the per-target loop in `fillDocumentFieldBatchImpl` had no per-iteration try/catch — only the outer function-level one — so an uncaught *throw* from `fillOneDocument` (e.g. `fillDocx`'s unguarded `JSZip.loadAsync` on a corrupted `.docx`, as opposed to a handled `err()` return) propagated past the loop and collapsed the whole call into one generic `fillDocumentFieldBatch failed: ...` error, discarding the report — and the already-written output file — for every target that had already succeeded earlier in the same loop. This directly violated the frozen Boundary "never let one document's fill failure abort or roll back another document's already-completed fill." Fixed by wrapping the per-target `fillOneDocument` call in its own try/catch; a caught exception now produces a `FAILED` line (the exception's message) for that one target and the loop continues, exactly like a handled `err()` already did. Regression test: a `good` document filled successfully, followed by a `corrupt` document whose *stored raw file* (not the inbox source) is overwritten with non-zip bytes after saving — asserts `good`'s success still appears in the combined report. **Scope-boundary gap closed**: nothing previously rejected `signatureName` on a batch call — it would have flowed through to `fillOneDocument` unblocked, silently working despite being undocumented/unsupported for this capability (CAP-7 reuses CAP-3's plain-value targeting only, not CAP-6's signature stamping). `fillDocumentFieldBatchImpl` now rejects the whole call up front with a clear message if `args.signatureName` is present, before any fill runs; tool description and `SPEC.md`'s Constraints updated to state this explicitly. This supersedes the earlier Spec Change Log entry's framing ("forwards the full `args` object unmodified... a documentation/schema-surface scope decision, not a code-level block") — it is now a real, enforced block, not just a schema omission. **Log distinguishability**: `fillOneDocument` gained an optional `callerLabel` parameter (default `'fill_document_field'`), used in its own log line instead of a hardcoded prefix; the batch tool passes `'fill_document_field_batch'` so a batch-triggered fill is now distinguishable from a single-call fill in `nanoclaw.log`. **Dedup added**: `resolveBatchTargets`'s `documents[]` branch now tracks resolved slugs and silently drops (does not add to `targets`, does not report) any later entry whose resolution matches a slug already included — first occurrence wins — so naming the same document twice, or two different query strings that resolve to the same document, no longer fills or reports it twice. **Batch-size cap added**: a new `MAX_BATCH_TARGETS = 25` constant; `fillDocumentFieldBatchImpl` rejects the whole call (before any fill runs) if the resolved, post-dedup target count exceeds it, naming the actual count and suggesting narrowing `matchQuery` or splitting into smaller batches — closes an unbounded-sequential-processing gap (an unbounded `matchQuery` match set, or a very long `documents[]` array, previously had no upper bound and no partial visibility until the whole call finished). 25 is a deliberately generous, documented placeholder, not a hard technical ceiling. **Report-formatting consistency**: resolution-failure lines used to render as `` - "label": FAILED — ... `` (quoted) while fill-outcome lines rendered as `` - slug: OK/FAILED — ... `` (unquoted) — both now render unquoted, matching the fill-outcome convention, since a target label is a plain identifier (a query string or a resolved slug), not free text needing delimiting. **Test coverage added** (no behavior change, existing behavior locked in): `resolveBatchTargets`'s input-shape validation branches (non-array `documents`, empty array, an array with a blank/non-string entry, a non-string/empty `matchQuery`); a `documents[]` batch where every entry fails to resolve, confirming this is a soft `0/N succeeded` report and not a whole-call error (unlike `matchQuery`'s hard zero-match error — this asymmetry is intended, per the frozen Boundaries, not a bug); a target that resolves to a legitimate discovery/prompt `ok()` response (a `.docx` with both a table and a fill-in-the-blank paragraph, called with no `row`/`table`/`lineNumber` at all) — asserts it is reported `FAILED` and excluded from `succeeded`, proving the existing `FILL_SUCCESS_MARKER`-based `isCompletedFill` check actually distinguishes a real completion from a discovery response (previously asserted only implicitly). **Doc parity**: `SPEC.md`'s Constraints gained a note that CAP-7 does not pre-validate cross-file-type targeting-arg compatibility (a mixed `.docx`+`.pdf` batch routinely partial-fails on whichever file type the given args don't match — intended per-item failure handling, not a bug), that `signatureName`/CAP-6 is out of scope for CAP-7, and the 25-document cap; `SKILL.md`'s batch "What NOT to do" section gained a line warning against batching across incompatible file types in one call. **Not actioned, per reviewer instruction**: a suggestion to express the `documents`/`matchQuery` XOR constraint via JSON Schema `oneOf`/`anyOf` (no precedent for that shape elsewhere in this codebase; logged to `deferred-work.md` as a nice-to-have) and a suggestion to assert the full registered-tool-set count in `registerTools([...])` (low value, brittle against future tool additions). Re-verified after this round: `cd container/agent-runner && bun test` (full suite): 519 pass / 8 skip / 0 fail; `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`: clean.

## Design Notes

No existing precedent in this codebase for a multi-item execution-with-per-item-report MCP tool (confirmed by investigation) — this story establishes the pattern: a single `ok()` text report listing every target's outcome, reusing the existing `ok()`/`err()` envelope rather than inventing a JSON results array, since every other tool in this file communicates via prose the agent relays. Uniform targeting args (rather than per-document targeting) keeps this a genuine "same field, many files" tool rather than N independent calls disguised as one — the harder per-document-distinct-targeting shape was considered and rejected as out of scope for what the story actually asks for.

## Verification

**Commands:**
- `cd container/agent-runner && bun test src/mcp-tools/documents.test.ts` -- expected: all batch-fill cases pass alongside the existing (unmodified-behavior) single-fill suite
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

**Manual checks (if no CLI):**
- Save two real documents through a live container session, batch-fill the same field across both, confirm both output files are correct and the report names both.

## Suggested Review Order

**Batch core — the new tool's shape**

- Entry point: batch loop iterates resolved targets, reuses `fillOneDocument` unchanged per document.
  [`documents.ts:3100`](../../container/agent-runner/src/mcp-tools/documents.ts#L3100)

- `fillOneDocument`: extracted single-document fill body, shared unmodified by both tools.
  [`documents.ts:2827`](../../container/agent-runner/src/mcp-tools/documents.ts#L2827)

- `resolveBatchTargets`: turns `documents[]`/`matchQuery` into a flat target list or a whole-call error — the two-input-shape design.
  [`documents.ts:3035`](../../container/agent-runner/src/mcp-tools/documents.ts#L3035)

- Tool registration alongside the existing four.
  [`documents.ts:3185`](../../container/agent-runner/src/mcp-tools/documents.ts#L3185)

**Review-round fixes — the one real frozen-Boundary violation, and the guardrails added alongside it**

- Per-target try/catch: closes the bug where a thrown (not returned) failure used to collapse the whole batch and discard already-recorded successes.
  [`documents.ts:3154`](../../container/agent-runner/src/mcp-tools/documents.ts#L3154)

- `signatureName` rejected outright — batch reuses CAP-3 only, not CAP-6/signature stamping.
  [`documents.ts:3109`](../../container/agent-runner/src/mcp-tools/documents.ts#L3109)

- Dedup by resolved slug and the 25-document cap — both reject/skip before any fill runs.
  [`documents.ts:3025`](../../container/agent-runner/src/mcp-tools/documents.ts#L3025)

**Test verification of the review-round fixes**

- Regression test proving a thrown exception no longer discards an earlier target's already-recorded success.
  [`documents.test.ts:3887`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L3887)

- `signatureName` rejection, dedup, and batch-size-cap tests.
  [`documents.test.ts:3909`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L3909)

- Discovery/prompt response correctly excluded from the succeeded count — locks in the `FILL_SUCCESS_MARKER` check that had no prior test.
  [`documents.test.ts:4013`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L4013)

**Baseline I/O-matrix coverage**

- All-succeed, mixed success/failure, ambiguous entry, zero-match `matchQuery`, malformed input, wrong-type targeting args.
  [`documents.test.ts:3758`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L3758)

- Regression guard: the existing single-call tool's contract is unchanged by this addition.
  [`documents.test.ts:4031`](../../container/agent-runner/src/mcp-tools/documents.test.ts#L4031)

**Peripheral — planning-doc parity and agent-facing guidance**

- `SPEC.md`'s CAP-7 entry and the review-round Constraints additions (cross-file-type caveat, `signatureName` exclusion, the cap).
  [`SPEC.md:41`](../specs/spec-document-memory/SPEC.md#L41)

- `SKILL.md`'s new batch section, including the mixed-file-type warning added in the review round.
  [`SKILL.md:291`](../../container/skills/document-memory/SKILL.md#L291)
