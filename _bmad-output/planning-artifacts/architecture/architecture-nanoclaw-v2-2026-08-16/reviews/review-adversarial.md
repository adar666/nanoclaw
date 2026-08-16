---
name: 'Adversarial Review — Document Memory + Fill-In Editing'
type: architecture-review
target: ARCHITECTURE-SPINE.md (spine dated 2026-08-16)
lens: adversarial (two-builder incompatibility)
created: '2026-08-16'
---

# Adversarial Review — Document Memory + Fill-In Editing

## Method

For each pair of build units that could plausibly be implemented by two
people/agents without a live conversation between them — `save_document` vs
`list_documents`, `save_document` vs `fill_document_field`, CAP-1 vs CAP-3,
the read path vs the write path of AD-4 — I asked: can both sides obey every
AD to the letter, pass their own unit tests, and still fail to interoperate?
Every "yes" below is written up as a finding with the missing/tightened AD it
implies. Grounded against the live repo (`src/attachment-naming.ts`,
`src/modules/audio-transcription/apply.ts`, `container/agent-runner/src/mcp-tools/core.ts`,
`container/agent-runner/src/memory/templates/`, `docs/memory.md`) and the
spine's own companions (`SPEC.md`, `row-targeting-matrix.md`,
`brownfield.md`).

## Findings

### F1 — No slug-generation scheme is specified; two implementations of `save_document` diverge (Severity: High)

AD-6 says the raw file lands at `memory/documents/files/<slug>.<ext>` and the
concept file at `memory/documents/<slug>.md`, but the spine never defines how
`<slug>` is derived from the inbound filename. Nothing constrains charset,
casing, length, or whether it includes a timestamp/id for uniqueness.

Concrete scenario: Builder A slugifies just the basename ("Q3 Report.pdf" →
`q3-report`), matching the kebab-case convention stated in Consistency
Conventions ("Memory files: `<slug>.md` kebab-case"). Builder B, following
the closest existing in-repo precedent for exactly this kind of derived
filename — `src/modules/audio-transcription/apply.ts`'s `slugify()` +
timestamp-prefixed collision-avoiding path (`<timestamp>-<slug>.md`, with a
counter-suffix loop on collision) — prefixes every slug with a timestamp
(`20260816-q3-report`). Both obey AD-6 and the naming convention row
literally. Now: `list_documents` (AD-7) returns "structured data (slug,
filename, description)" to the agent, and the agent is expected to reference
documents by slug/filename across turns. If `save_document` (Builder A's
version) and any tooling built against Builder B's assumed shape (e.g. a
`fill_document_field` implementation that reconstructs a path from an
agent-supplied slug using its own slugify function to validate it) disagree
on the scheme, path resolution silently breaks the moment the slug isn't a
verbatim round-trip of what `save_document` actually wrote.

**Missing AD**: *Slug generation is pinned to one deterministic function*
— exact input (original filename only, or filename + save timestamp?),
exact transform (lowercase, ASCII-fold, non-alnum → `-`, collapse repeats,
trim), and exact collision policy (append `-2`, `-3`... on an existing file
of the same slug, mirroring `audio-transcription/apply.ts`'s counter-suffix
loop, vs. some other scheme). The AD should also state whether the function
lives in a single shared helper `save_document` and any other slug-consuming
tool call, rather than being reimplemented per call site.

### F2 — Concurrent `save_document` calls from two live sessions of the same agent group race on the shared memory tree (Severity: High)

Memory is per-*agent-group*, not per-session (`docs/memory.md`: "Every agent
group has persistent, file-based memory"), while sessions are keyed by
`agent_group_id + messaging_group_id + thread_id` (CLAUDE.md's Entity Model)
— so one agent group with, say, a DM wiring and a separate group-chat wiring
(or two active threads) can have two containers running concurrently, both
with `groups/<folder>/memory/` mounted read-write. AD-2 mandates all of
`save_document`'s work happen synchronously in-container — but says nothing
about cross-container mutual exclusion on the files it touches.

Concrete scenario: two users in two different chats send a PDF to the same
agent group at nearly the same moment and both say "remember this." Two
containers each run `save_document` concurrently. AD-6 requires "one line is
appended to `memory/index.md` per saved document" — a read-modify-write on a
single shared file from two independent Bun processes with no coordination
described anywhere in the spine. One append can silently clobber the other
(last-writer-wins on the whole file if both read-then-write without a lock),
or — if F1's slug scheme isn't timestamp/id-qualified — both documents could
even resolve to the same slug and one's raw file/concept file silently
overwrites the other's.

**Missing AD**: *Concurrent-writer safety for shared per-group memory
files.* Needs to state either (a) a locking/append-only-write discipline for
`memory/index.md` (e.g. O_APPEND single `write()` syscall semantics, which
are atomic for small writes on POSIX but *not* atomic across two separate
`read-file → concat → write-file` round trips — the natural way to implement
"append a line" in Bun/Node), or (b) an explicit acceptance that this feature
does not attempt cross-container coordination and documents the resulting
risk as a known limitation (matching the SPEC's own non-goal of "concurrent
multi-user editing" — but that non-goal is scoped to edits of the *same
document*, not concurrent saves of *different* documents landing in the same
index file, which is a distinct failure mode the spine doesn't cover).

### F3 — AD-6's concept-file frontmatter and the existing OKF field vocabulary clash, and the Consistency Conventions row contradicts AD-6 itself (Severity: High)

AD-6's Rule specifies frontmatter: `type: saved-document`, `description`,
`source-filename`, `saved-date`. But the Consistency Conventions table, one
section later in the same document, says: "OKF: `type` (free vocabulary...) +
`description`, per `docs/memory.md`. **No new frontmatter schema
introduced.**" `docs/memory.md`'s own template
(`container/agent-runner/src/memory/templates/system/definition.md`)
enumerates the *actual* recognized optional OKF fields: `title`,
`description`, `tags`, `resource` — where `resource` is defined as exactly
"path or URL of the raw source this was distilled from," i.e. precisely what
AD-6 needs to point at the raw stored file. `source-filename` and
`saved-date` appear in neither the existing template nor the Consistency
Conventions row that claims to govern this feature's frontmatter.

Concrete scenario: Builder A (implements `save_document`, CAP-1) reads AD-6's
Rule literally and writes `source-filename` + `saved-date` as new custom
keys. Builder B (implements `list_documents`, CAP-2) reads the Consistency
Conventions row ("no new frontmatter schema introduced") and `docs/memory.md`
instead, and writes a parser expecting `resource` for the raw-file pointer
and no `saved-date` field at all (assuming file mtime or a `# Citations`
line covers "when saved," per `docs/memory.md`'s own citation guidance). Both
built to spec text elsewhere in the same spine. Result: `list_documents`
either can't find the raw-file pointer it expects, or silently drops
fields it doesn't recognize when it later resaves/edits the concept file —
directly risking CAP-2's success criterion (accurate recall of a
previously-saved document).

**Missing/tightened AD**: Resolve the self-contradiction explicitly — pick
one frontmatter shape and state it once, not twice with different content.
Recommend reusing the existing `resource` field for the raw-file pointer
(consistent with "no new schema introduced") and deciding explicitly whether
a save timestamp is a new field or derived from filesystem metadata / a
`# Citations`-style line, per the existing convention.

### F4 — AD-8's "structured error" is not shaped, and the codebase's own existing convention contradicts the word "structured" (Severity: Medium)

AD-8 says `fill_document_field` "returns a structured error for the agent to
relay" when it can't resolve the target. But every existing MCP tool in this
codebase (`core.ts`'s `err()` helper, reused by `transcribe-audio.ts`) wraps
errors as a single free-text string: `{ content: [{ type: 'text', text:
'Error: ...' }], isError: true }` — not a structured/typed payload. AD-1
explicitly requires new tools follow "the same shape as `core.ts`."

Concrete scenario: Builder A, reading AD-8's word "structured" at face
value, invents an actual structured error object (e.g. `{ error: { code:
'TABLE_NOT_FOUND', table: 2, availableTables: 1 } }`) serialized as the text
content. Builder B, reading AD-1's mandate to match `core.ts`'s shape, reuses
`err()` verbatim and emits a plain prose string ("Error: this document only
has 1 table, but you asked for table 2"). Both are defensible readings of
AD-8 "to the letter." The agent-facing skill prose (`document-memory/SKILL.md`,
not yet written) would need to be written against one shape or the other —
whichever builder writes the skill last effectively decides, and if the tool
implementation and the skill's error-handling guidance disagree, the agent
either mis-parses a JSON blob it was told to "relay" verbatim (leaking raw
JSON to the user) or fails to extract detail from a prose string it expected
to parse.

**Missing/tightened AD**: State explicitly that "structured" in AD-8 means
"specific and unambiguous prose naming what was searched for and what exists
instead" (matching `core.ts`'s existing plain-text `err()` convention), not a
machine-parseable object — or, if a real structured payload is wanted,
specify its exact field names now so both the tool and the skill prose are
built against the same contract.

### F5 — AD-4's image-pixel ↔ PDF-point conversion has no pinned render scale, DPI, or coordinate-origin contract (Severity: High)

AD-4 says the tool "converts the agent's image-pixel estimate back into PDF
point-space using the known page size and render scale" — but the *render
scale* and *coordinate origin* are never pinned to a concrete value or
convention anywhere in the spine or `row-targeting-matrix.md`.
`row-targeting-matrix.md` separately notes that the text-layer positioning
path returns coordinates in "PDF points, y-axis bottom-up" — image raster
coordinates are natively top-down, origin top-left — so a correct conversion
needs an explicit y-flip using the *actual* page height, not just a naive
scale multiply.

Concrete scenario: Builder A implements the CAP-1 "render scanned page for
the agent to read content from" path (`@hyzyla/pdfium`) at a scale chosen for
legibility of small text — say `scale: 2.0` (roughly 144 DPI for a 72-DPI-native
PDF page). Builder B independently implements the CAP-3 overlay-positioning
path in `fill_document_field` and, needing to render the *same kind* of page
image to let the agent estimate a stamp position, either (a) reuses a
different default scale believing it's a fresh, unrelated call site, or (b)
correctly reuses 2.0 but forgets the y-flip (treats the agent's
"pixel_y" as already bottom-up), or (c) a vision-model-side image resize
(many multimodal APIs downscale large images internally before the model
sees them) silently changes the *effective* scale between "the raster pixels
the tool rendered" and "the raster pixels the agent actually looked at,"
which neither builder's code can detect without an explicit contract pinning
image dimensions sent vs. dimensions the tool assumes on the way back. Any
of these lands the stamped text at the wrong location — a defect AD-8
doesn't catch, because the *target* (which row/line) was resolved
correctly; only its *position* is wrong, and nothing in AD-8's "can't
resolve" failure mode covers "resolved, but the coordinate math was silently
off."

**Missing AD**: *Pin the full page-render/coordinate contract in one place*
shared by every code path that renders a PDF page image or converts a
pixel estimate back to points: exact render scale/DPI (a fixed constant, or
a formula from page size with a stated max-dimension cap), explicit statement
that the tool must report the exact rendered pixel dimensions back alongside
the image (so a client-side resize by the model API becomes detectable/
correctable — e.g. ask the agent to report the estimate as a *fraction* of
image width/height instead of raw pixels, which is scale-invariant), and the
explicit y-flip formula (`pdf_y = page_height_pt - (pixel_y / scale)`).

### F6 — Whether a fill-in edit refreshes the concept file's *extracted text* is undecided, risking silently stale CAP-2 answers (Severity: High)

The Deferred section explicitly punts "whether a fill-in edit also updates
the canonical stored copy (`memory/documents/files/<slug>.<ext>`)," defaulting
to "untouched." That default is reasonable for the *raw file* — SPEC.md's
CAP-3 success criteria only describe the delivered file. But nothing in the
spine (AD-6, AD-8, or Deferred) says anything about the *concept file's
extracted text* (`memory/documents/<slug>.md`, written once by `save_document`
per AD-6) after a later `fill_document_field` call changes the document's
actual content. CAP-2's success criterion is "a later, unrelated conversation
... answers correctly from memory" — if the concept file's text isn't
refreshed, a user who fills in row 3 with a new value and later asks "what
does row 3 say" gets a stale answer straight from memory, with no file
resend involved to reveal the discrepancy.

Concrete scenario: Builder A implements `fill_document_field` narrowly per
the Deferred note — "stored copy untouched" — and reads that as "touch
nothing under `memory/documents/`, only write to the outbox via
`send_file`." Builder B, building `list_documents`/CAP-2's recall path
against the *intent* stated in SPEC.md ("later ... asks a question about
that document's content and the agent answers correctly"), assumes any
fill-in is expected to keep the concept file's extracted text in sync,
since otherwise CAP-2 has a standing correctness bug for any document that's
ever been edited. Both are defensible readings of a spine that never says
this explicitly for the *memory text*, only for the *raw file*.

**Missing/tightened AD**: State explicitly whether `fill_document_field`
also patches the concept file's extracted text (and/or appends an edit-log
line) after a successful fill, independent of the already-deferred
raw-file-copy question — these are two different pieces of state
(canonical file vs. derived memory text) that the current Deferred note
conflates by only naming one of them.

## Additional gap worth flagging (not written up as a full finding)

**Table/row indexing base is unpinned.** AD-5 / `row-targeting-matrix.md`
address Word cells by "(table number, row number)" without stating whether
either axis is 0-indexed (matching array access in the OOXML-manipulation
code) or 1-indexed (matching how a human names "table 1, row 3" in chat, and
how the agent would naturally echo it back). Two independently-built pieces
— the tool's resolution logic and the skill prose that tells the agent how
to phrase disambiguation/confirmation to the user — could disagree by one,
silently landing edits in the wrong row for every document with a header
row. Worth folding into whichever AD ends up governing `fill_document_field`'s
public tool-call contract (extend AD-5 or AD-1's tool-definition rule to
state the indexing base explicitly, e.g. "1-indexed, matching how a human
would say 'table 1, row 3'; header rows count if visually present").

## Summary of missing/tightened ADs

| # | Gap | Proposed AD |
|---|---|---|
| F1 | No pinned slug scheme | AD-9: Slug generation is one shared, deterministic function (input, transform, collision policy) reused by every slug-producing/consuming call site |
| F2 | No cross-container write safety for shared memory files | AD-10: Concurrent-writer discipline for per-group memory files touched by multiple live sessions (atomic append or explicit accepted-risk statement) |
| F3 | AD-6 vs. Consistency Conventions frontmatter contradiction | Tighten AD-6: one frontmatter shape, reusing existing OKF fields (`resource` for raw-file pointer) instead of introducing `source-filename`/`saved-date` unreconciled with "no new schema" |
| F4 | AD-8 "structured error" unshaped | Tighten AD-8: pin error shape to the existing `core.ts` `err()` plain-text convention, or specify a real structured payload's fields |
| F5 | AD-4 coordinate conversion unpinned | Tighten AD-4: fix render scale/DPI, require the tool to report actual rendered pixel dimensions, state the explicit y-flip formula, shared by every page-render call site |
| F6 | Concept-file text staleness after edit undecided | Tighten Deferred/AD-8: state explicitly whether `fill_document_field` refreshes the concept file's extracted text, independent of the already-deferred raw-file question |
