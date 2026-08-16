---
name: document-memory
description: Save a Word (.docx) or PDF file the user sends into this agent group's persistent memory, so its content can be recalled in a later, unrelated conversation without resending the file. Also fill a value into a table row, form field, or line of a document already saved this way and send back a new file, or recall/answer questions about what a previously saved document says. Use when the user sends a Word/PDF attachment and asks to save/remember/keep it, asks to fill in / complete a blank on a document already saved, or asks what a saved document says/contains, or asks to summarize/recall a document already saved.
---

# Saving a document to memory

## When to use this

The user sends a `.docx` or `.pdf` file — shown to you as an inbox
attachment tag like `[document: report.pdf — saved to
/workspace/inbox/<msgId>/report.pdf]` (the exact type word before the colon
varies by channel) — and asks something like "remember this", "save this",
"תשמרי את זה", or otherwise wants it kept for later. This is **not** for a
short voice note or an audio file (see the `audio-report` skill for those),
and it only handles Word/PDF — any other file type, say so plainly instead
of trying to save it.

## Workflow

1. **Call the tool.** `mcp__nanoclaw__save_document({ path })` with the part
   of the inbox tag after `/workspace/` (e.g. `inbox/<msgId>/report.pdf`).
   This runs synchronously — you get a real result back in the same turn,
   no waiting, no follow-up message to expect later.

2. **Two possible outcomes:**
   - **Saved.** The tool copied the file into memory, extracted its text,
     and recorded it — you're done. Tell the user it's saved and can be
     asked about later without resending it.
   - **Scanned PDF, needs your own reading.** If the PDF has no text layer
     (a scan/photo of a document, not a real text layer), the tool renders
     page 1 to a PNG and tells you its path and pixel dimensions instead of
     saving anything yet — no memory entry exists at this point. **Read
     that image yourself** with your own Read tool (you're multimodal —
     this is not a separate OCR step, it's you looking at the page), then
     call `save_document` again with the *same* `path` argument plus an
     `extractedText` argument containing what you read. That second call
     completes the save. **Only page 1 is ever rendered/read** — for a
     multi-page scanned PDF, later pages are not captured; if the document
     is more than one page, say so rather than implying you saved the whole
     thing.

3. **Unsupported file type.** The tool declines cleanly with an error — no
   partial memory entry is ever created for a type it doesn't handle. Relay
   that to the user rather than retrying or guessing a workaround.

4. **Word documents (.docx) always save in one call** — no rendering step,
   since Word documents have a real text layer to read directly. If text
   extraction from a particular `.docx` happens to come back empty (rare —
   an unusual/corrupted document), the file is still saved with a note that
   automatic extraction didn't find text; say so plainly rather than
   inventing a summary of content you don't actually have. **Only the main
   body is read** — headers, footers, footnotes, and text boxes are not
   captured, so don't claim those are covered if the user asks.

## What NOT to do

- Don't call this for `.doc` (the old binary Word format, not `.docx`),
  `.xlsx`, images, or plain text — only `.docx`/`.pdf` are in scope. Decline
  those plainly instead of calling the tool.
- Don't try to OCR a scanned PDF yourself some other way, and don't ask the
  user to resend it as an image — the render-and-read flow above already
  handles it.
- Don't claim a document is saved before the tool actually confirms it (the
  scanned-PDF first call is *not* a save — only the follow-up call with
  `extractedText` is).

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

## Filling a `.docx`

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
