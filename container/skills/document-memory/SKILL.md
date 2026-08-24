---
name: document-memory
description: Save a Word (.docx or legacy .doc), PDF, or image (.jpg/.jpeg/.png) file the user sends into this agent group's persistent memory, so its content can be recalled in a later, unrelated conversation without resending the file. Also fill a value into a table row, form field, or line of a document already saved this way and send back a new file, or recall/answer questions about what a previously saved document says. Also save a PNG image of a handwritten signature as a reusable, background-removed asset, and stamp a saved signature into a saved PDF, .docx, or .doc. Use when the user sends a Word/PDF/image attachment and asks to save/remember/keep it, asks to fill in / complete a blank on a document already saved, asks what a saved document says/contains, asks to summarize/recall a document already saved, sends a signature image and asks to save/remember it for reuse, or asks to sign/stamp a saved document with a saved signature.
---

# Saving a document to memory

## When to use this

The user sends a `.docx`, legacy `.doc`, `.pdf`, or image (`.jpg`/`.jpeg`/
`.png`) file — shown to you as an inbox attachment tag like `[document:
report.pdf — saved to /workspace/inbox/<msgId>/report.pdf]` (the exact type
word before the colon varies by channel) — and asks something like
"remember this", "save this", "תשמרי את זה", or otherwise wants it kept for
later. This is **not** for a short voice note or an audio file (see the
`audio-report` skill for those), and it only handles Word (.docx/.doc)/PDF/
image files — any other file type, say so plainly instead of trying to save
it.

## Workflow

1. **Call the tool.** `mcp__nanoclaw__save_document({ path })` with the part
   of the inbox tag after `/workspace/` (e.g. `inbox/<msgId>/report.pdf`).
   This runs synchronously — you get a real result back in the same turn,
   no waiting, no follow-up message to expect later.

2. **Three possible outcomes:**
   - **Saved.** The tool copied the file into memory, extracted its text
     (for a scanned PDF, page 1 was rendered and OCR'd automatically —
     English and Hebrew — in this same call — you don't need to read
     anything yourself), and recorded it — you're done. Tell the user it's
     saved and can be asked about later without resending it. **For a
     scanned PDF, only page 1 is ever rendered/OCR'd** — for a multi-page
     scanned PDF, later pages are not captured; if the document is more
     than one page, say so rather than implying you saved the whole thing.
   - **Scanned PDF, OCR found little to no readable text.** Rare — a
     genuinely blank/unreadable page 1, or a page in a language other than
     English/Hebrew. The tool renders page 1 to a PNG, tries OCR, and when
     that comes back empty or near-empty tells you so instead of saving
     anything yet — no memory entry exists at this point. Ask the user how
     to proceed:
     either **read the rendered image yourself** with your own Read tool
     (you're multimodal — this is a fallback for this one case, not the
     normal path) and call `save_document` again with the *same* `path`
     argument plus an `extractedText` argument containing what you read, or
     call `save_document` again with the same `path` and
     `extractedText: ""` to save it with a placeholder note instead. Either
     follow-up call completes the save.
   - **Plain image, needs your own reading.** For a `.jpg`/`.jpeg`/`.png`
     upload, the tool always tells you it needs you to read it yourself
     instead of saving anything yet — no memory entry exists at this point.
     The uploaded file itself is already what to look at, no rendering
     needed. **Read it yourself** with your own Read tool (you're
     multimodal — this is not a separate OCR step, it's you looking at the
     image), then call `save_document` again with the *same* `path`
     argument plus an `extractedText` argument containing what you read (a
     description, any readable text, numbers, a barcode, etc.). That second
     call completes the save.

3. **Unsupported file type.** The tool declines cleanly with an error — no
   partial memory entry is ever created for a type it doesn't handle. Relay
   that to the user rather than retrying or guessing a workaround.

4. **Word documents (`.docx` and legacy `.doc`) always save in one call** —
   no rendering step, since Word documents have a real text layer to read
   directly. If text extraction from a particular `.docx`/`.doc` happens to
   come back empty (rare — an unusual/corrupted document), the file is
   still saved with a note that automatic extraction didn't find text; say
   so plainly rather than inventing a summary of content you don't actually
   have. **Only the main body is read** — headers, footers, footnotes, and
   text boxes are not captured, so don't claim those are covered if the
   user asks.

## What NOT to do

- Don't call this for `.xlsx` or plain text — only `.docx`/`.doc`/`.pdf`/
  images (`.jpg`/`.jpeg`/`.png`) are in scope. Decline those plainly
  instead of calling the tool.
- Don't try to OCR a scanned PDF or an image yourself some other way — a
  scanned PDF is OCR'd automatically by the tool itself, and a plain image
  is read directly by you (no separate OCR step) via the flows above.
- A saved image cannot be filled/stamped via `fill_document_field` — there's
  no target to fill on a plain photo. That tool is for `.docx`/`.doc`/`.pdf`
  only.
- Don't claim a document is saved before the tool actually confirms it. A
  scanned PDF normally saves in its one and only call (OCR ran inline), but
  when OCR comes back with little to no readable text that call is *not* a save — only the follow-up
  call (with real `extractedText`, or `extractedText: ""` for the
  placeholder) is. Same for a plain image: its first call is never a save.

# Filling a value into a saved document

## When to use this

The user asks to fill in, complete, or write a value into a document you've
already saved — a table row in a `.docx` ("put John's name in the second
row"), a form field in a `.pdf` ("fill in the Name field"), or a blank line
on a scanned or plain PDF ("write the date after the 'Date:' line"). The
target must already be in memory via `save_document` — this never reads a
raw inbox attachment directly.

## Finding the right document

Both tools below take a `document` argument: a free-text name/slug/topic
match against the saved document's slug, original filename, and
description (same matching either way).

- **You already know which document** (the user just discussed it, or there's
  only one plausible match): call `fill_document_field` directly with your
  best guess at `document`.
- **You're not sure, or the user's reference could match more than one saved
  document**: call `mcp__nanoclaw__list_documents({ query })` (or with no
  `query` to see everything) first, and ask the user to confirm.
- **Either way, `fill_document_field` itself also resolves `document`** using
  the same matching: if it matches more than one saved document, the tool
  returns a numbered candidate list *instead of* filling anything — relay
  that list to the user and re-call with the exact slug (the first column)
  once they pick. This is not an error; it's a normal turn in the
  conversation. If nothing matches, that *is* an error — say so plainly
  rather than guessing.

## Filling a `.docx` (or a saved legacy `.doc`)

A saved `.doc` is filled exactly like a `.docx` — same `document`/`row`/
`table`/`column`/`lineNumber`/`value` arguments, same targeting rules below.
Under the hood the tool converts it to `.docx` once (via LibreOffice) before
filling, and the response says so — **the file you get back and deliver
with `send_file` is always `.docx`, never a reconstructed `.doc`**; mention
that to the user rather than implying the original binary format was
edited. If LibreOffice isn't available or the conversion fails, the tool
declines clearly with no file written — don't retry with a workaround.

Two targeting modes, auto-selected by the document's shape and which
argument you give — you never pick a mode explicitly:

1. **Table row** — the document has a table and you give `row` (or `table`).
   This always wins over line targeting when `row`/`table` is given, even if
   the same document also has non-table paragraphs elsewhere.
2. **Text-line (fill-in-the-blank paragraph)** — the document has no table
   at all, or you give `lineNumber` instead of `row`. Targets a plain
   paragraph carrying an underscore blank (`שם: ___________`) or a trailing
   colon label (`תאריך:`) with nothing after it — the common shape for a
   real-world form that isn't built from a Word table.

### Table row

One call. Give `document`, `row` (1-indexed row within the table), and
`value`. `table` (1-indexed) is only needed if the document has more than
one table — with exactly one table it's inferred. `column` (1-indexed) is
only needed to target something other than the row's *last* cell, which is
the default (matches the common "label | value" row shape). **"Row 1" is
literally the table's first row** — if the table has a header row, that
counts as row 1; the first data row is row 2.

```
mcp__nanoclaw__fill_document_field({ document: "intake-form", row: 2, value: "Ada Lovelace" })
```

If the target row's cell holds a nested table, or the table/row number
doesn't exist, the tool declines with a clear error and writes no file —
don't retry with a guessed different number, ask the user instead.

### Text-line (no table, or you're targeting a non-table blank)

Two calls, mirroring the PDF text-layer flow below:

- First call: `fill_document_field({ document })` — with no `row` and no
  `lineNumber`. If the document has no table, this returns a numbered list
  of detected fill-in-the-blank paragraphs (mirrors the PDF line list's
  shape). **If it also has a table, the response names both possibilities**
  — the table-row prompt *and* the numbered blank-line list — so pick
  whichever mode actually matches what the user wants (`row` for the table,
  `lineNumber` for a blank-line paragraph).
- Second call: `fill_document_field({ document, lineNumber, value })` —
  fills that line. Each detected blank is its own numbered candidate — a
  paragraph with two blanks ("Name: ___ Date: ___") lists as two separate
  lines, each independently fillable. An underscore blank has its
  underscore run replaced with `value`; a trailing-colon label gets `value`
  appended right after it, on the same paragraph. Only that one paragraph
  changes — table content, if any, is untouched.

Don't pass `row`/`table` and `lineNumber` together, and don't pass `column`
without `row`/`table` — both are rejected with a clear error rather than
silently picking one or dropping the other.

If no table exists and no fill-in-the-blank paragraph is detected either,
the tool declines clearly — don't guess a target; ask the user instead (the
same "decline rather than guess" rule as everywhere else in this tool).

**Known limitation:** if a paragraph's label and its blank happen to sit in
the *same* underlying Word run (no formatting break between them — rare,
but possible for a short line typed all at once with no script/formatting
change), filling it replaces the whole run, and the label is lost along
with the blank. This mirrors the existing table-cell multi-run limitation
— if it happens, the delivered file will show just the value with no label
in front of it; mention that to the user rather than assuming something
went wrong.

## Filling a `.pdf`

Three mechanisms, auto-detected — you never pick a mode explicitly:

1. **AcroForm field** (the PDF has a real fillable field matching your
   target): one call, give `document`, `fieldName`, and `value`. If the name
   doesn't match, the error lists the PDF's actual field names — pick from
   those rather than guessing again.
2. **Text-layer line** (no matching field, but the PDF has real text): two
   calls, exactly like the scanned-PDF flow below.
   - First call: `fill_document_field({ document })` — returns a numbered
     list of detected lines.
   - Second call: `fill_document_field({ document, lineNumber, value })` —
     draws the value right after that line's existing content, on the same
     baseline. This never edits or reflows existing text, only adds new
     content in blank space.
3. **Scanned/image-only PDF** (no text layer at all): two calls, mirroring
   `save_document`'s scanned-PDF pattern.
   - First call: `fill_document_field({ document })` — renders page 1 (page
     1 only) and returns its path + pixel dimensions.
   - **Read that image yourself** and estimate the pixel position (x,y from
     the top-left) where the value belongs.
   - Second call: `fill_document_field({ document, pixelX, pixelY, value })`
     — draws the value there.

## Stamping a saved signature into a saved document

Works for `.pdf`, `.docx`, and legacy `.doc`. See "Saving a reusable
signature" below for how a signature gets saved in the first place — that
has to happen before this can work.

Add `signatureName` (the exact name it was saved under — no fuzzy matching,
unlike `document`) to a `fill_document_field` call, in place of or alongside
`value`.

**For a `.pdf`** — add it to any of the three PDF calls:

- **AcroForm field**: `fill_document_field({ document, fieldName, signatureName })`
  — draws the signature image scaled to fit and centered within the
  field's own widget rectangle, aspect ratio preserved (never
  stretched/distorted). **The field's text is left unset** — stamping an
  image into a field and filling its text value are mutually exclusive in
  one call.
- **Text-layer line**: `fill_document_field({ document, lineNumber, signatureName })`
  — draws the image at the same spot a text value would have gone.
- **Scanned/pixel position**: `fill_document_field({ document, pixelX, pixelY, signatureName })`
  — same idea, at the pixel position you already picked.

**For a `.docx` (or a saved legacy `.doc`, converted first exactly like a
plain fill)** — add it to either of the two docx targeting calls:

- **Table cell**: `fill_document_field({ document, row, table, signatureName })`
  — inserts the signature image into the target cell **as an additional
  run**. Any existing text already in that cell (or elsewhere in the
  document) is left completely untouched — this never replaces text, unlike
  a plain `value` fill of the same cell.
- **Fill-in-the-blank line**: `fill_document_field({ document, lineNumber, signatureName })`
  — inserts the image right after the target paragraph (the underscore
  blank or trailing-colon label itself is left as-is, not overwritten).

A `.docx`/`.doc` signature stamp is **flow-layout, not a fixed position** —
there's no pixel/point coordinate to give it the way a PDF has; it always
lands at whichever table-cell or fill-in-the-blank-line target `row`/`table`
or `lineNumber` already resolves to, sized to a fixed max height with its
aspect ratio preserved (never stretched/distorted).

**Give `value` alongside `signatureName`** (any of the calls above, PDF or
docx/doc) to draw/insert both the signature image and a text value — e.g. a
date — right next to/after each other in the same call, same call's single
new file.

If `signatureName` doesn't match any saved signature exactly, the tool
declines and lists the signature names actually saved (or says none are
saved yet) — relay that rather than guessing a different name.

## After a successful fill

The tool never sends anything itself — it writes a new file (the saved
original is never modified) and tells you its path. **Call
`send_file({ to, path })` yourself** with that path to actually deliver it
to the user.

## What NOT to do

- Don't call `fill_document_field` with a raw inbox path — it only targets
  documents already saved via `save_document`.
- Don't guess a table/row/field/line when the tool couldn't resolve one
  clearly — it declines rather than writing an approximate value, and you
  shouldn't work around that.
- Don't forget the `send_file` call after a successful fill — the new file
  sits on disk until you do.

# Filling the same value into many saved documents at once

## When to use this

The user asks to put the **same value into the same field/target across
several saved documents in one go** — "put today's date on all three
contracts", "fill in Ada's name on the intake form and the waiver", "set the
signature date on every invoice matching Q3". This is `fill_document_field_batch`
— a single call that applies one `value` and one set of targeting args
(`table`/`row`/`column`, `fieldName`, `lineNumber`, `pixelX`/`pixelY`)
identically to every resolved document. It reuses exactly the same
per-document targeting logic as `fill_document_field` (same auto-detection
by file type, same table/text-line/AcroForm/pixel mechanics) — everything
in the sections above about targeting still applies per document. It does
**not** support a different value or different targeting per document in
the batch — for that, call `fill_document_field` separately per document
instead.

## Picking the target set

Give **exactly one** of:

- `documents: [...]` — a list of names/slugs/topics, e.g. the user naming
  several documents explicitly ("the report and the letter"). Each entry is
  matched the same way `fill_document_field`'s own `document` argument is
  matched. An entry that matches nothing, or matches more than one saved
  document, is a **per-item failure** named in the combined report — it does
  not stop the rest of the batch.
- `matchQuery: "..."` — one substring query, e.g. the user saying "all
  documents matching X" / "every invoice" / "all three contracts" when they
  mean a topic rather than a list of exact names. Every saved document that
  query matches becomes a target. If it matches zero documents, the whole
  call errors (nothing to iterate) — relay that plainly rather than
  guessing which documents were meant.

Giving both, or neither, is rejected before any fill runs.

## Reading the report

One call, one combined text report: an `N/M succeeded` summary line, then
one line naming each target's outcome — its output path on success, the
exact failure reason otherwise (no match, ambiguous, wrong-type targeting
args for that document's file type, or any other per-document fill error).
Every target is named; nothing is silently dropped, and one document's
failure never rolls back another's already-completed fill in the same call.

```
mcp__nanoclaw__fill_document_field_batch({ documents: ["report", "letter"], row: 2, value: "16/08/2026" })
mcp__nanoclaw__fill_document_field_batch({ matchQuery: "invoice", fieldName: "Date", value: "16/08/2026" })
```

## After a batch fill

The tool never sends anything itself. **Loop `send_file({ to, path })`
yourself, once per successful output path** in the report — skip any target
that failed (there's no file to send for those; relay its failure reason to
the user instead). Don't stop delivering the successes just because one
target in the batch failed.

## What NOT to do

- Don't use this for a different value or different target per document —
  that's still one `fill_document_field` call per document.
- Don't give both `documents` and `matchQuery`, or neither — pick the one
  that matches how the user described the target set.
- Don't skip relaying a per-item failure — the report names every target
  for a reason; a partial batch is not a silent success.
- Don't forget to loop `send_file` for every successful path in the
  report — a batch of three successes needs three `send_file` calls, not
  one.
- Don't batch across incompatible file types in one call — e.g. don't mix
  `.docx` table targets with `.pdf` AcroForm targets in the same
  `documents`/`matchQuery` call. Every target gets the same targeting args,
  so a batch is only fully effective when every resolved document shares
  one file type and one targeting shape; a mismatched file type in the mix
  just shows up as a per-item failure for that document instead of
  succeeding.

# Recalling a saved document's content

## When to use this

The user asks about the content of a document saved earlier via
`save_document` — "what did the contract say about the deadline", "who's
listed on that intake form", "what does report.pdf say about Q3" —
without resending the file. The content is already in memory; don't ask
for the file again. Matching (whether via `memory/index.md` or
`list_documents`) works reliably against filename/slug — `description` is
currently just `Saved document: <filename>` (mechanically generated by
`save_document`, not a real content summary), so a reference by topic
alone, with no filename/slug hint, may not resolve on the first try.

## Workflow

1. **Check `memory/index.md` first.** It's already loaded into every turn
   as Core Memory. `save_document` appends one line per saved document
   ending in `- saved document, <date>` — that's the pattern to scan for.
   Each such line links to its concept file (`documents/<slug>.md`,
   relative to `memory/`). If an entry obviously matches what's being
   asked about, skip to step 3.
2. **Otherwise, call `mcp__nanoclaw__list_documents({ query })`** — same
   free-text match (slug/filename/description) used by the fill workflow
   above. Omit `query` to see everything.
   - **No match** — the tool errors clearly; relay that plainly rather
     than guessing.
   - **One match** — resolved; move to step 3.
   - **Two or more matches** — a numbered candidate list (`slug —
     filename (description)`). Relay it to the user and wait for them to
     pick before continuing. Once you have the slug, its concept file is
     at `documents/<slug>.md`, relative to `memory/` — the same
     convention `memory/index.md` uses; you don't need the tool to spell
     that path out.
3. **Read the concept file yourself.** Use your own Read tool on
   `memory/documents/<slug>.md`, relative to your workspace root (the
   production container's workspace root is `/workspace/agent`; other
   contexts, like tests, use a different base) — the same file
   `save_document` wrote when the document was saved — and answer from
   its extracted text.
   - **If the Read fails, or the file is missing/empty:** the index or
     `list_documents` pointed at a document whose concept file is gone,
     or at a scanned-PDF save that never got its follow-up
     `extractedText` call (so no concept file was ever written). Say
     plainly that you can't find the document's content — don't stall on
     it, and don't proceed as if you'd actually read something.

## What NOT to do

- Don't call `save_document` or `fill_document_field` to answer a recall
  question — this is read-only against what's already saved, no
  re-extraction and no file writes.
- Don't ask the user to resend a file that's already saved to memory.
- Don't invent content the concept file doesn't actually contain — if the
  extracted text doesn't cover what's asked, say so plainly instead of
  guessing.
- If a concept file's body is exactly `_(no text extracted)_` (the
  placeholder `save_document` writes when automatic `.docx` extraction
  found nothing), there's nothing to recall — say so; don't treat the
  placeholder itself as real content.

# Saving a reusable signature

## When to use this

The user sends a `.png` image of a handwritten signature — a photo of ink
on paper, or a drawn signature — shown to you as an inbox attachment tag
like `[image: sig.png — saved to /workspace/inbox/<msgId>/sig.png]`, and
asks to save/remember it for reuse (e.g. "save my signature", "remember
this signature as Uriel"). `save_signature` itself is **save-only** — it
never places the signature into any document itself. To actually stamp a
saved signature into a document, see "Stamping a saved signature into a
saved document" above — works for `.pdf`, `.docx`, and `.doc`.

## Workflow

1. **Get a name.** `save_signature` always needs a `name` for the
   signature (e.g. the person's own name, "uriel") — **never invent one**.
   If the user didn't give one in the same message, ask before calling the
   tool.
2. **Call the tool.** `mcp__nanoclaw__save_signature({ path, name })` with
   the part of the inbox tag after `/workspace/` (e.g.
   `inbox/<msgId>/sig.png`). This runs synchronously, in the same turn.
   - The tool removes a near-white background (a fixed threshold — not
     something you can tune) and crops tightly to what's left, so a photo
     with visible paper/table background around the ink comes back clean.
   - **Not a `.png`.** Declines cleanly — only `.png` is supported for a
     signature right now. Say so plainly rather than trying to convert
     another format yourself.
   - **Nothing survives background removal** (e.g. an all-white or blank
     image, or one with no dark ink at all). Declines cleanly — nothing is
     saved. Ask the user to resend a clearer image rather than saving an
     empty result.
3. **Name collision.** If a signature is already saved under that name,
   the new one is saved alongside it with a numeric suffix
   (`uriel-2.png`) by default — it does **not** overwrite the existing
   one. Only pass `replace: true` when the user's message made it clearly
   explicit they want to replace/overwrite the old one (e.g. "no, replace
   my old signature with this one") — if it's ambiguous whether they mean
   a new save or a replacement, ask before deciding either way.

## What NOT to do

- Don't call this for anything other than a `.png` image.
- Don't guess a name — always ask if the user didn't give one.
- Don't assume `replace: true` — a plain "save my signature again" with no
  explicit replace/overwrite language is a new, separate save, not a
  replacement.
- Don't imply a saved signature is shared with any other agent group — it's
  saved only for this group.
- For a `.docx`/`.doc` signature stamp, don't replace existing table-cell or
  paragraph text — it's always an additional inserted run, alongside
  whatever was already there.
