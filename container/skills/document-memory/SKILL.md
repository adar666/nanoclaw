---
name: document-memory
description: Save a Word (.docx) or PDF file the user sends into this agent group's persistent memory, so its content can be recalled in a later, unrelated conversation without resending the file. Also fill a value into a table row, form field, or line of a document already saved this way and send back a new file. Use when the user sends a Word/PDF attachment and asks to save/remember/keep it, or asks to fill in / complete a blank on a document already saved.
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

## Filling a `.docx` table row

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
