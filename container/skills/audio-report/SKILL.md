---
name: audio-report
description: Turn an uploaded audio file into a transcript and an organized Hebrew RTL HTML report, sent back as a file. Use when the user sends an audio file (not a short voice note) and asks you to transcribe/summarize/report on it.
---

# Audio file → Hebrew RTL report

## When to use this

The user sends an audio file — a call recording, a meeting, a forwarded
voice memo saved as a document — and asks something like "תפענח את זה",
"תמלל", "תסכם", or attaches it with any instruction to process it. This is
**not** for short voice notes sent directly as Telegram voice messages —
those already transcribe automatically and arrive in your context tagged
`[VOICE-TRANSCRIPT]`; you don't need this skill or the tool for those, the
text is already there. This skill is for the `[audio: name — saved to
/workspace/inbox/...]` case — an uploaded file, not auto-transcribed.

## Workflow

1. **Start transcription.** Call `mcp__nanoclaw__transcribe_audio({ path })`
   with the exact relative path from the `[audio: ...]` line. It returns
   immediately — you are not blocked. Reply to the user that you've started
   ("מתמלל את הקובץ, אעדכן כשמוכן") or just continue with whatever else is
   in the conversation; either is fine.
2. **Wait for the result.** Minutes later, a message tagged
   `[AUDIO-TRANSCRIPT-COMPLETE]` (with the full transcript text) or
   `[AUDIO-TRANSCRIPT-FAILED: <reason>]` arrives as a normal new message —
   see `transcribe-audio.instructions.md` for the exact contract. If it
   failed, explain the failure to the user in Hebrew (`not-installed` =
   התמלול לא זמין כרגע במערכת; `timeout` = ההקלטה ארוכה מדי / לקח יותר מדי
   זמן; `error` = תקלה כללית) rather than silently dropping it.
3. **Author the report.** Once you have the transcript, write a single
   self-contained HTML file — see the design guidance below. This is your
   own summarization/organization work (headings, key points, structure) —
   the tool only gave you raw text.
4. **Send it back.** `send_file({ to: <the destination this conversation is
   in>, path: <your html file>, text: 'הנה הסיכום' })`.

The transcript itself is already saved for you (see the
`transcribe-audio.instructions.md` note) — no need to save it again.

## Hebrew RTL HTML — design guidance

A condensed, portable version of the full `rtl-hebrew-docs` /
`ui-ux-pro-max` guidance (not loadable directly inside this container) —
enough to produce something that reads as considered, not a raw text dump.

**Structure (non-negotiable for correct Hebrew rendering):**

```html
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>סיכום הקלטה</title>
  <style>
    body {
      font-family: "Segoe UI", "Arial Hebrew", "Noto Sans Hebrew", sans-serif;
      line-height: 1.8;             /* Hebrew glyphs need more vertical room than Latin */
      direction: rtl;
      text-align: right;
    }
    /* Numbers, dates, and any embedded Latin text should stay LTR inside
       an RTL page — wrap them: <span dir="ltr">14:30</span> — otherwise
       the browser can visually reorder digits within a number. */
  </style>
</head>
<body>
  ...
</body>
</html>
```

**Content shape:**
- A clear title and a one-line summary at the top — the reader should
  understand the gist in 5 seconds without scrolling.
- Sectioned body (`<h2>`/`<h3>`), not one long paragraph — group by topic
  or by chronological phase of the conversation, whichever the transcript
  actually supports.
- A short bullet list of key points / action items near the top if the
  content has any (a call almost always does) — don't bury decisions in
  prose.
- Restrained color use — one accent color for headings/highlights, neutral
  grays for body text and structure (borders, section backgrounds). Avoid
  a wall of identical black paragraphs; also avoid decorating for its own
  sake.
- Wrap any number, date, or Latin-script term in `<span dir="ltr">...</span>`
  so it doesn't visually scramble inside the RTL flow.

Keep the file self-contained (inline `<style>`, no external requests) —
it's delivered as a single file over Telegram, not hosted anywhere.
