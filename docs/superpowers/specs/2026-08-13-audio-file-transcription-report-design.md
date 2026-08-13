# On-demand audio-file transcription + Hebrew RTL report — design

Status: draft, pending user review.

## Purpose

Today `src/voice-transcription.ts` auto-transcribes only true Telegram
**voice notes** (`raw.voice`, no filename, `audio/ogg`) — silently, host-side,
before the agent ever sees the message. Uploaded **audio files** (`raw.audio`,
carries a `file_name` — e.g. a forwarded call recording, a `.m4a`/`.mp3`)
are explicitly out of scope for that pipeline: saved to the session inbox,
never transcribed.

This adds an **agent-invoked, on-demand** capability: a user sends an audio
file plus an instruction ("תפענח את זה ותחזיר לי סיכום"), the agent calls a
new tool, the host transcribes it in the background (can take minutes for a
long recording), the agent is notified when done, writes a Hebrew RTL HTML
summary, and sends it back via the existing `send_file` tool. The raw
transcript is also persisted into the agent group's own durable workspace so
it's available for future reference, independent of whether a report was
ever requested.

Available to every agent group automatically (Yolanda / Tina / household) —
no per-group opt-in, same distribution model as the other container skills.

## Explicitly out of scope (this pass)

- **second-brain integration.** `src/media-ingestion.ts` already auto-ingests
  photos/PDFs into a per-sender second-brain tenant db, and its own header
  comment anticipates "later phases add audio... not a restructure." But
  second-brain's own `TelegramMediaKind` (sibling repo,
  `~/Projects/second-brain/src/sources/telegram-media.ts:15`) doesn't have an
  `'audio'` kind yet either — wiring this up properly is a cross-repo change
  (nanoclaw-v2 *and* second-brain) and belongs in its own spec. This pass
  persists transcripts as plain files inside nanoclaw-v2's own domain
  (`groups/<folder>/transcripts/`), not into second-brain. A future spec can
  point second-brain's ingest tool at that same folder, or extend
  `media-ingestion.ts` to call it directly.
- Auto-transcribing already-covered voice notes via this new path (no
  overlap/dedup logic needed — the new tool only ever gets called for files
  the automatic pipeline doesn't touch).
- WhatsApp/email audio — Telegram only, matching the existing feature's
  scope.

## Current state (confirmed by investigation)

- **Voice-note pipeline** (unchanged by this work): `src/voice-transcription.ts`
  — `isTranscribableVoiceAttachment()` gates on `audio/ogg` + no `name`;
  `transcribeVoiceNote(oggPath)` runs `ffmpeg` → 16kHz mono WAV → `whisper-cli`
  (ivrit-ai Hebrew Whisper finetune, Metal-accelerated, model path fixed at
  `~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin`), 30s
  timeout, `not-installed | timeout | error` failure taxonomy. Injects
  `[VOICE-TRANSCRIPT]`/`[VOICE-TRANSCRIPT-FAILED: reason]` into the message
  text via `extractAttachmentFiles()` (`src/session-manager.ts:297-373`).
- **Uploaded audio files**: saved to
  `data/v2-sessions/<agentGroupId>/<sessionId>/inbox/<messageId>/<filename>`
  (same `extractAttachmentFiles` path-write, `localPath` set), but never
  transcribed. Agent sees `[audio: name — saved to /workspace/inbox/<msgId>/name]`.
- **`send_file` MCP tool** already exists and needs no changes
  (`container/agent-runner/src/mcp-tools/core.ts:112-160`): copies a
  workspace file into `/workspace/outbox/<id>/`, writes a plain `kind:'chat'`
  `messages_out` row with `content.files: [filename]`. The host's generic
  `deliverMessage()` (`src/delivery.ts:246-415`) reads it via
  `readOutboxFiles()` and delivers through the channel adapter — no
  attachment-specific host code needed for the *return* leg.
- **Async wake mechanism already proven in production** (tasks): a due
  message is just a `messages_in` row (`trigger=1`, `status='pending'`,
  optional `process_after`). If the session's container is alive, its own
  poll loop (`container/agent-runner/src/poll-loop.ts`, 1s interval) picks
  the row up on its own. If idle-killed, `host-sweep.ts:247-254`
  (`countDueMessages` + `!isContainerRunning`) spawns a fresh one, whose
  first poll sees the same row. `writeSessionMessage()`
  (`src/session-manager.ts:210-277`) is a plain exported function, already
  called from outside the router (approvals, agent-to-agent, voice
  transcription) — no CLI round-trip required to enqueue a message into an
  arbitrary session.
- **Fire-and-forget precedent already exists**: the guard/approval flow
  (`src/cli/dispatch.ts:125-152` for the hold → `requestApproval` → immediate
  `'approval-pending'` ack; real completion later via
  `registerApprovalHandler` → `notifyAgent()` in
  `src/modules/approvals/primitive.ts:191-205`, which calls
  `writeSessionMessage()` + an explicit `wakeContainer()` call, fully
  decoupled from the original request). This is the template for the new
  tool: ack fast, do the real work out-of-band, deliver the result as an
  independent fresh message + explicit wake (don't wait for the next 60s
  host-sweep tick).
- **`groups/<folder>/` is the right persistence target**, not the session
  inbox: the inbox/outbox tree has no host-side GC (confirmed —
  `deleteSession()` exists but is never called; `updateSession(status:'closed')`
  only flips a DB column) so it's *unmanaged*, not durable-by-guarantee. The
  agent group's own folder (`groups/<folder>/`) is the established
  persistent-workspace convention (CLAUDE.md, skills, memory) and is already
  mounted read-write at `/workspace/agent`
  (`src/container-runner.ts:405-411`) as a single directory bind-mount — a
  new `transcripts/` subdirectory needs no mount-allowlist change (that
  allowlist only gates `additionalMounts` outside the group's own folder,
  irrelevant here).

## New components

### 1. Generalized host-side transcription function

Extend `src/voice-transcription.ts` (or split the raw engine call out into
an exported `runWhisperTranscription(audioPath, opts?: {timeoutMs?})` that
`transcribeVoiceNote` becomes a thin wrapper over) so it accepts **any**
audio file `ffmpeg` can decode, not just `audio/ogg` voice notes — the
`ffmpeg -i <input> -ar 16000 -ac 1 <tempWav>` step is already
format-agnostic (it already handles Telegram's Opus/OGG; container/codec
detection is `ffmpeg`'s job either way). Same
`not-installed | timeout | error` result shape. New default timeout must be
much larger than the existing 30s — long call recordings can legitimately
take several minutes even with Metal acceleration; the on-demand path uses
its own generous default (spec leaves the exact number to the
implementation plan, but it must be an order of magnitude above 30s and
should scale roughly with expected recording length, not be a fixed small
constant).

### 2. New `transcribe_audio` MCP tool (agent-runner)

`container/agent-runner/src/mcp-tools/` — new tool, input
`{ path: string, note?: string }` where `path` is exactly the relative inbox
path the agent already sees in its own context
(`inbox/<messageId>/<filename>`, matching the existing
`[audio: name — saved to ...]` line). Modeled on `sendFile`'s outbound-write
shape, not on `ncl.ts`'s blocking `cli_request`/`pollResponse` pattern — this
tool must **not** block waiting for a response:

```
writes an outbound.db row: kind:'system',
  content: { action: 'transcribe_audio', requestId, path, note }
returns immediately: "Transcription started — you'll get a message when it's ready."
```

### 3. Host-side delivery action: `transcribe_audio`

New module `src/modules/audio-transcription/apply.ts` (same tier as
`src/modules/recorder/apply.ts`, `src/modules/self-mod/apply.ts`), registered
via `registerDeliveryAction('transcribe_audio', handler, guardSpec)`
(`src/delivery.ts:453-484`, same registration point `cli_request` uses).

**Hard requirement**: the registered handler must return within
milliseconds. It resolves the container-relative `path` to the host
filesystem path
(`path.join(sessionDir(agentGroupId, session.id), path)` — the inbox tree
already lives on host disk, no container-side path-mapping needed, unlike
the telegram-bot-api local-file-dir problem solved separately), validates
the file exists, then **starts the transcription as a detached, un-awaited
background operation** (`void runTranscriptionJob(...)` — never `await`s the
whisper-cli process inside the handler itself). This mirrors the
approval-hold pattern's separation between the synchronous ack and the
async `notifyAgent` callback (§ Current state) — required regardless of
whether the host's outbound-delivery loop processes sessions sequentially
or concurrently, since blocking it either way is unacceptable.

`runTranscriptionJob(agentGroupId, sessionId, hostAudioPath, note)`:
1. Calls the generalized transcription function (component 1).
2. On success: writes the transcript to
   `groups/<folder>/transcripts/<timestamp>-<slug>.md` (frontmatter: source
   filename, date, agent group; body: full transcript text) — persisted
   regardless of whether the agent ever turns it into a report, satisfying
   "save it for other projects later."
3. Delivers the result into the *same* session via `writeSessionMessage()`
   with `kind:'chat-sdk'`-shaped content (`{ text: '[AUDIO-TRANSCRIPT-COMPLETE]\n' + transcript, ... }`
   on success, `[AUDIO-TRANSCRIPT-FAILED: reason]` on failure) — reusing the
   exact tagged-text convention `[VOICE-TRANSCRIPT]`/`[MEDIA]` already
   establish, so **no new agent-runner formatter code is needed**; the
   existing chat-sdk rendering path shows it like any other inbound message.
   Default `trigger:1` (wakes on next poll / triggers host-sweep pickup).
4. Explicitly checks `isContainerRunning(sessionId)`; if not, calls
   `wakeContainer()` immediately rather than waiting for the next 60s
   host-sweep tick — same immediacy as the approval-notify flow.

No new DB table. No job-status/polling tool — fire-and-forget, matching
"the agent should never be stuck, always able to receive things, work
happens in the background" (user's own framing). No concurrency
limit/queue in this pass — accepted limitation, flagged below.

### 4. New container skill: `audio-report`

`container/skills/audio-report/SKILL.md` (loaded for every agent session,
same distribution as `agent-browser`/`frontend-engineer`/etc. — satisfies
"available in all agents" with zero per-group wiring). Content:

- How to call `transcribe_audio({ path, note? })` when a user sends an audio
  file and asks for it to be processed, and that the reply arrives later as
  a tagged message (`[AUDIO-TRANSCRIPT-COMPLETE]` / `...-FAILED`) — no
  polling, just continue normally and react when it shows up.
- Condensed Hebrew RTL HTML authoring guidance — a portable subset of
  `rtl-hebrew-docs` (the full marketplace skill isn't loadable inside the
  container's own restricted skill set): `dir="rtl"` on `<html>`, an
  RTL-appropriate Hebrew font stack, correct line-height/letter-spacing for
  Hebrew glyphs, avoiding LTR-leaking punctuation/number bugs. Paired with a
  condensed visual-design checklist in the spirit of `ui-ux-pro-max`
  (typography pairing, spacing rhythm, a restrained color system) — enough
  to produce a page that reads as considered rather than a raw text dump,
  without needing the full searchable skill database.
- Instructs: turn the raw transcript into an organized, easy-to-scan
  summary (sectioned, headings, key points) — this is the agent's own
  reasoning over the transcript text, not a new capability; the skill only
  supplies the *how to make it look good* guidance.
- Save the HTML to the workspace, then `send_file({ to: <original sender's
  destination>, path: <html file> })`.
- Mentions the transcript is already durably saved to the group's own
  `transcripts/` folder — no need for the agent to save it again itself.

### 5. `groups/<folder>/transcripts/` directory

Created lazily on first write by `runTranscriptionJob` (or eagerly by
`group-init.ts`'s `initGroupFilesystem()` — implementation plan decides
which is simpler). No mount or allowlist change needed (§ Current state).

## Data flow (end to end)

```
User → Telegram: audio file + ".שלחתי קובץ אודיו, תפענח אותו..."
  → existing pipeline saves it to inbox/<msgId>/<filename> (unchanged)
  → agent sees [audio: ... saved to /workspace/inbox/<msgId>/<filename>]
  → agent (audio-report skill) calls transcribe_audio({ path })
    → MCP tool writes outbound system row, returns immediately
    → host delivery-action handler resolves host path, validates,
      fires runTranscriptionJob() un-awaited, returns immediately
  → agent's turn ends / it can keep working on other things meanwhile
  ...minutes later, in the background...
  → runTranscriptionJob: ffmpeg + whisper-cli → transcript text
    → persists groups/<folder>/transcripts/<ts>-<slug>.md
    → writeSessionMessage(..., text: '[AUDIO-TRANSCRIPT-COMPLETE]\n<text>')
    → wakes container if idle (or next poll picks it up if still alive)
  → agent resumes, writes Hebrew RTL HTML summary (audio-report skill
    guidance), send_file() back to the original chat
```

## Error handling

Same three-way taxonomy as the existing voice pipeline
(`not-installed | timeout | error`), surfaced to the agent as
`[AUDIO-TRANSCRIPT-FAILED: <reason>]` — the agent (per skill instructions)
explains the failure to the user in Hebrew rather than silently dropping it.
`not-installed` reuses the exact same on/off switch as the existing feature
(presence of the `whisper-cli` binary and the model file at their fixed
paths) — if voice-note transcription is unavailable on this install, so is
this.

## Testing

- Host: unit tests for the generalized transcription function (mock
  `execFile`, same style as `voice-transcription.test.ts`), for the
  `transcribe_audio` delivery-action handler (assert it returns fast / never
  awaits the job inline — a timing-shaped test, not just a happy-path
  assertion), and for `runTranscriptionJob`'s persistence + wake behavior.
- Container: MCP tool unit test asserting the outbound row shape and that
  the handler returns without waiting for any inbound response (mirrors
  `core.test.ts`'s existing `send_file` coverage).
- Manual verification: send a real audio file > 20MB (exercises the local
  Bot API path already set up) through a live agent group, confirm the
  transcript lands in `groups/<folder>/transcripts/`, confirm the HTML
  report is RTL-correct and arrives via Telegram.

## Accepted limitations (v1)

- No concurrency limit on simultaneous transcription jobs — fine at current
  household scale, revisit if it ever becomes a real contention problem.
- No job-status/history tool (`ncl` resource) — fire-and-forget only,
  matching the requested UX. If future need arises for "what's transcribing
  right now," that's an additive follow-up, not a blocker here.
- Not wired into second-brain — see "Explicitly out of scope" above.
