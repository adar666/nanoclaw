---
name: document-memory
description: Save a Word (.docx) or PDF file the user sends into this agent group's persistent memory, so its content can be recalled in a later, unrelated conversation without resending the file. Use when the user sends a Word/PDF attachment and asks to save/remember/keep it.
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
