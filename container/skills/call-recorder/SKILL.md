---
name: call-recorder
description: >-
  Start/stop the local call recorder (start_recorder / stop_recorder
  tools) — mic + system-audio loopback capture of a real call, regardless
  of which app it's in (Zoom, Meet, WhatsApp, phone on speaker). Use this
  when starting or ending a call recording. Covers extracting `them`/
  `context` from what was actually said, the fire-and-forget confirmation
  pattern, the 3-hour auto-stop safety cap, and transcript ingestion
  timing.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Call recorder — start_recorder / stop_recorder

You can start and stop a real recording on the user's actual machine — mic
+ system-audio loopback, so it doesn't matter what app the call is in
(Zoom, Meet, WhatsApp, phone on speaker — all the same to it).

- **Start** when told a call is starting or being joined, or asked
  directly to record. Extract `them` (the other party's name) and
  `context` (one line on what the call is about) from what was actually
  said — "call with Denis about HoursReportWebApp" → `them: "Denis"`,
  `context: "HoursReportWebApp"`. Don't ask for it to be restated in a
  particular format; pull it from the sentence already given.
- **Stop** when told the call ended ("סיימתי", "done with the call",
  etc.) — don't wait to be asked twice.
- Both tools are fire-and-forget: they return "requested" immediately,
  not "done." Don't say it's recording or stopped until the actual
  confirmation message comes back (arrives within a few seconds) — say
  "requested, confirming..." in between if anything needs saying at all.
- If it auto-stops on its own (3-hour safety cap, for a forgotten
  "סיימתי") a system notification arrives about it unprompted — relay
  that plainly. That's not an error to apologize for, it's exactly the
  safety net doing its job; the user should just know a recording ended
  without asking.
- Once stopped, the transcript is ingested into `uriel.db` (source:
  `recorder`) within the same stop cycle — "what did we agree on" can be
  asked right after and it'll already be there, no waiting for a daily
  sync.
