# Reconciliation Review — SPEC-document-memory vs. ARCHITECTURE-SPINE

Reviewer walked every claim in `SPEC.md`, `row-targeting-matrix.md`, and `brownfield.md`
(capabilities, constraints, non-goals, assumptions, and named techniques) against
`ARCHITECTURE-SPINE.md` to confirm each landed somewhere (an AD, a convention, the stack,
structural seed, or Deferred), with extra scrutiny on quiet/specific techniques an
AD-level abstraction could round off or drop.

## Overall verdict: **gaps found** — one significant, load-bearing gap; two minor/moderate ones.

---

## 1. SIGNIFICANT — the PDF AcroForm form-field write path is missing from the spine

**Spec claim.** `row-targeting-matrix.md` mandates three distinct target mechanisms for
CAP-3, auto-selected by inspecting the file — never chosen by the user:

| # | Condition | Mechanism |
|---|---|---|
| 1 | `.docx` with tables | table-row edit (table number + row number) |
| 2 | `.pdf` **with AcroForm fields matching the target** | **set the field's value via the PDF's form-field API — no page content is redrawn** |
| 3 | `.pdf` with no matching form field (plain/scanned) | overlay-by-position, draw new text on top, save as new PDF |

The "Selection rule" section is explicit and ordered: table-row → form-field → overlay,
in that priority.

**What landed in the spine.** `AD-4`'s own title is *"PDF write path is overlay-only;
read path is hybrid text-layer-or-vision."* Its Rule states: *"Writing: `pdf-lib` draws
new text on top of the existing page and saves a new PDF — never reflow."* No branch,
condition, or mention of AcroForm/form-field detection or a form-field API call appears
anywhere in AD-4, the Stack table (`pdf-lib` is described only as *"Overlay-write new
text onto an existing PDF page"*), the Structural Seed, or the Capability Map (CAP-3 →
AD-1, AD-2, AD-3, AD-4, AD-5, AD-7, AD-8 — none of which cover it).

**Why it matters.** This isn't just an omission, it's a contradiction: AD-4's title
literally asserts "overlay-only" where the spec requires overlay to be the *fallback*,
not the only path. A builder following the spine as written would never implement
AcroForm field detection/writing at all — every PDF fill request, including ones
targeting an actual fillable form field, would go through the overlay/stamp path. That
produces a materially different (and spec-violating) result: stamped text drawn on top
of/near a form field instead of the field's value being set via the API, with "no page
content is redrawn" (the spec's own success condition for that branch) silently
violated. `pdf-lib` — already the pinned dependency — natively supports AcroForm
manipulation (`PDFDocument.getForm()` / field `.setText()`), so this isn't a tooling gap,
it's purely a dropped architectural branch.

**Recommendation.** Add a form-field branch to AD-4 (or split it into two ADs: one for
detection/selection logic, one for the overlay write technique), retitle away from
"overlay-only," and add the AcroForm-field API usage to `pdf-lib`'s Stack-table role and
to CAP-3's governing-AD list.

---

## 2. MODERATE — brownfield's `MIME_TO_EXT` docx gap isn't carried into the spine (Deferred or otherwise)

**Spec claim (brownfield.md).** `deriveAttachmentName()` in `src/attachment-naming.ts`
has `MIME_TO_EXT` entries for `application/pdf` but none for `.docx`/`.doc` — a Word
file arriving without an explicit `att.name` from the channel bridge could land on disk
without an extension. Brownfield.md flags this explicitly: *"Worth checking/fixing as
part of implementation."*

**What landed in the spine.** Nothing. It isn't in an AD, the Stack, the Structural Seed,
Consistency Conventions, or Deferred. AD-1/AD-3 assume the file already has a resolvable
extension (`documents.ts`, `<slug>.docx|.pdf` in the Structural Seed) but never address
how a docx arrives without one.

**Why it matters.** This is a concrete, named prerequisite for CAP-1 to work reliably for
Word attachments sent without a filename hint — exactly the kind of grounding fact
brownfield.md exists to surface so it isn't rediscovered (or missed) downstream. Its
absence from the spine means nothing forces a build step to actually fix it; it could
silently fall through.

**Recommendation.** Add a line to Deferred (or a short addendum under AD-3/AD-6) noting
the `MIME_TO_EXT` docx gap and that it must be closed (or explicitly punted with
rationale) before/alongside this feature ships.

---

## 3. MINOR — the "don't confuse with the second-brain pipeline" warning doesn't carry forward as an explicit guardrail

**Spec claim.** Both `SPEC.md` ("not the separate second-brain media-ingestion pipeline,
which is a different tenant-scoped system serving only specific DM groups") and
`brownfield.md` ("**Do not confuse with** `src/media-ingestion.ts`...") call this out
explicitly as a named trap.

**What landed in the spine.** AD-6 places storage correctly (`groups/<folder>/memory/documents/...`,
the generic per-group OKF tree) — so the *outcome* is right — but no AD, Prevents-clause,
or convention states the guardrail explicitly (contrast with AD-6's own Prevents clause,
which does call out the *inbox-as-storage* and *index.md-bloat* traps by name but not
this one).

**Why it matters.** Low risk since the correct location is already the path of least
resistance in AD-6's Rule, but this is precisely the kind of adjacent-system confusion
this codebase's CLAUDE.md pitfall log already warns is easy to make live (see the
"self-mod... second brain" style entries). A one-line Prevents addition would close the
loop for a future reader who doesn't have brownfield.md open.

**Recommendation.** Optional: add "and the tenant-scoped second-brain pipeline
(`src/media-ingestion.ts`)" to AD-6's Prevents clause, alongside its existing
inbox/index.md-bloat items.

---

## Claims confirmed as landed cleanly (spot-checked, no issue)

For completeness — these are the claims most likely to be casualties of AD-level
rounding, and all were verified present and faithfully preserved:

- **"Never reflow PDF text"** — AD-4 Rule and Prevents clause, verbatim intent preserved.
- **Numbered pick-list disambiguation, "never guess (e.g. most recent)"** — AD-7's
  Prevents clause names the exact bad behavior ("one auto-selecting 'most recent'") the
  spec forbids; Capability Map applies AD-7 to both CAP-2 and CAP-3 per spec.
- **Table number + row number addressing, run-fragmentation handling** — AD-5's Rule
  explicitly calls out merging runs before matching, matching the spec's Prevents
  rationale about `<w:r>`-fragmented text (row-targeting-matrix's simpler "set text
  content directly" phrasing is the less detailed of the two — spine is *more* precise
  here, not less).
- **Hybrid vision-fallback, no new OCR engine, agent (not tool) does the reading** —
  AD-4 preserves the specific and easy-to-drop nuance that it's *"the agent's own
  multimodal turn — not a tool-embedded OCR/vision call."* Deferred section correctly
  scopes a future dedicated OCR engine as out-of-scope per this same decision.
- **Per-text-item coordinates for positioning** — AD-4 Rule, present.
- **Canonical-copy-never-overwritten ambiguity** — SPEC's CAP-3 success criteria are
  silent on whether the stored copy also gets edited; spine correctly identifies this as
  open and defers it with a stated default-safe assumption (Deferred item 1,
  Consistency Conventions row).
- **Deps require base-image rebuild, in-scope not deferred-to-later-epic** — AD-3 Rule +
  Deferred item 2 explicitly reference the standard rebuild+restart gotcha.
- **`send_file`/outbox reuse, no new outbound mechanism** — covered at the Design
  Paradigm level ("no new communication path, no new runtime") and the mermaid diagram;
  no AD needed since nothing new is being built here.
- **Memory scoped per agent group, not per-user** — implicit and correct by construction:
  AD-6 places documents in the existing per-group `memory/` tree, which is inherently
  group-shared; no per-user table was introduced anywhere in the spine.
- **`docs/document-memory/SKILL.md` mirroring `audio-report/SKILL.md`** — Structural Seed
  names this exact precedent, matching brownfield.md's "Closest existing pattern to
  follow" callout precisely.

## Not flagged (judged out of scope for an architecture spine)

- PDF coordinate system detail (points, y-axis bottom-up) from row-targeting-matrix —
  this is implementation-level precision, not an architectural decision; AD-4's "known
  page size and render scale" framing is the right altitude.
- Non-goals around no-restructuring / single-value-only edits, and no
  concurrent/collaborative editing — both are naturally enforced by the narrow write
  techniques AD-4/AD-5 already specify (overlay-only stamp, single-cell text replace);
  neither needed its own explicit restatement.
