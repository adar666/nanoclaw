# Local Hebrew voice-note transcription — design

Status: approved, pending implementation plan.

## Purpose

Telegram voice notes sent to NanoClaw agents are received today (downloaded,
saved to the session inbox as `.ogg`) but never transcribed — the agent only
sees `[audio: name — saved to path]`. This adds free, on-device, no-API
transcription for Hebrew voice notes, using the same "run it locally, no
cloud dependency" principle as the existing Ollama integration.

First use case: a Telegram voice note sent to Yulanda (or any of the three
agent groups). Out of scope for this pass: WhatsApp voice messages, email
audio attachments — Telegram voice notes only.

## Model and engine

- **Model**: [`ivrit-ai/whisper-large-v3-turbo-ggml`](https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml)
  — a Hebrew finetune of Whisper large-v3-turbo, single `ggml-model.bin`
  (~1.62 GB, confirmed via HEAD request: `content-length: 1624555275`).
  whisper.cpp-compatible. The model's own README notes language detection is
  degraded by the finetune — the language token **must** be forced to Hebrew
  (`-l he`), it will not reliably auto-detect.
- **Engine**: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) via
  `brew install whisper-cpp` — Metal-accelerated on this arm64 Mac, low
  memory footprint. Not faster-whisper/Python: this machine is 16GB with
  swap pressure already noted elsewhere in ops history, and whisper.cpp's
  C++ binary is the better tradeoff here.
- **ffmpeg dependency**: whisper.cpp's `whisper-cli` takes 16kHz mono WAV
  only — it does not decode OGG/Opus itself (confirmed: "whisper-cli example
  currently runs only with 16-bit WAV files"). Telegram voice notes arrive
  as OGG/Opus. `ffmpeg` (via `brew install ffmpeg`) converts OGG → WAV before
  each transcription call.

## Current pipeline (confirmed by investigation, unaffected)

```
Telegram voice → @chat-adapter/telegram extracts raw.voice as
  {type:'audio', mimeType:'audio/ogg', fetchData}  (NO `name` field —
  raw.audio, an uploaded audio FILE, gets file_name; raw.voice does not.
  This is the reliable signal that distinguishes a true voice note from an
  uploaded audio file, both of which the package collapses to type:'audio'.)
→ chat-sdk-bridge.ts downloads bytes via fetchData(), base64 into
  content.attachments[0].data
→ router.ts passes the message through unchanged (kind: 'chat-sdk', never
  dropped)
→ session-manager.ts extractAttachmentFiles(): decodes base64, writes the
  .ogg to <session>/inbox/<messageId>/, deletes `data`, sets `localPath`
→ agent-runner formatter.ts shows the agent only:
  [audio: name — saved to /workspace/inbox/<messageId>/name]
```

Nothing above changes. This feature adds an ack send and a transcription
step; the `.ogg` file write path is untouched, so the original audio is
saved and linked (`localPath`) on both transcription success and failure —
same reasoning as `raw_ref` pointing at source files for other attachment
types.

## New pipeline

```
router.ts (right after deliveryAddr is resolved, before writeSessionMessage):
  parse event.message.content once
  if isTranscribableVoiceAttachment(any attachment):
    fire-and-forget: getDeliveryAdapter()?.deliver(
      deliveryAddr.channelType, deliveryAddr.platformId, deliveryAddr.threadId,
      'chat-sdk', JSON.stringify({ text: ACK_TEXT })
    ).catch(err => log.warn('Voice-note ack failed to send', { err }))
    — NOT awaited. See "Ack must not block delivery" below.

  writeSessionMessage(...)  [now async]
    → extractAttachmentFiles(...)  [now async]
      for each attachment matching isTranscribableVoiceAttachment:
        transcribeVoiceNote(oggPath) → { ok: true, text } | { ok: false, reason }
        on ok:    prepend `[VOICE-TRANSCRIPT]\n<text>\n\n` to parsed.text
        on !ok:   prepend `[VOICE-TRANSCRIPT-FAILED: <reason>]\n` to parsed.text
                  (the existing `[audio: ...]` line still renders from the
                  untouched attachment entry — agent sees both)
      attachment write path (the .ogg save) is unchanged either way
```

### `isTranscribableVoiceAttachment(att)`

```
att.type === 'audio' && att.mimeType === 'audio/ogg' && !att.name
```

Gates on true Telegram voice notes only. Uploaded audio files (`raw.audio`,
which carries `file_name`) are left exactly as today — untouched
`[audio: ...]` passthrough. Exported from the new module so both call sites
(the ack check in `router.ts` and the transcription step in
`session-manager.ts`) share one definition — no duplicated detection logic.

## New module: `src/voice-transcription.ts`

Plain host-side file, same tier as `container-runtime.ts` / `env.ts` (not a
registry-based module — this is core pipeline behavior, not agent-facing).

```ts
export function isTranscribableVoiceAttachment(att: Record<string, unknown>): boolean;

export interface TranscribeResult {
  ok: true;
  text: string;
} | {
  ok: false;
  reason: 'not-installed' | 'timeout' | 'error';
}

export async function transcribeVoiceNote(oggPath: string): Promise<TranscribeResult>;
```

`transcribeVoiceNote`:
1. Resolve `whisper-cli` binary and the model path
   (`~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin`, fixed
   path — presence of both is the feature's on/off switch, no DB config, no
   env toggle). Missing either → `{ ok: false, reason: 'not-installed' }`
   immediately, no subprocess spawned.
2. `ffmpeg -i <ogg> -ar 16000 -ac 1 <tempWav>` — convert to 16kHz mono WAV in
   a temp file.
3. `whisper-cli -m <model> -l he -nt -f <tempWav>` — force Hebrew language
   token (required per the model's own caveat), no timestamps, capture
   stdout.
4. Both steps share a single **30s wall-clock deadline** (same
   deadline-check pattern as `container-runtime.ts`'s Docker poll, for
   consistency: `Date.now() + timeoutMs`, checked before each step). Exceed
   it → kill the subprocess, `{ ok: false, reason: 'timeout' }`. A short
   voice note should transcribe in single-digit seconds on Metal; 30s is
   headroom, not an expected duration — if it's routinely taking that long,
   something is wrong and the failure tag should surface it, not a longer
   wait.
5. Any other subprocess failure (non-zero exit, missing stdout, etc.) →
   `{ ok: false, reason: 'error' }`. Temp WAV is always deleted (success,
   failure, or timeout).

## Ack must not block delivery

The ack (`getDeliveryAdapter()?.deliver(...)`) is **not awaited** in the
main routing path. It's fired and its promise is `.catch()`-handled with a
`log.warn` — a slow adapter call, a Telegram rate limit, or a thrown error
degrades to "no ack sent," never to a delayed or dropped message. This was
an explicit requirement: a courtesy notification must never be able to
break delivery of the thing it's announcing. `writeSessionMessage` (and
everything downstream — transcription, container wake) proceeds
immediately, independent of whether the ack succeeded, failed, or is still
in flight.

## Ack wording — must stay true across both the warm and cold container paths

Traced the full latency sequence for a voice note when the container is
cold: ack fires in under a second (fire-and-forget, no dependency on
container state) → transcription runs (single-digit seconds typically, up
to the 30s timeout) → **if the container was cold, it still needs its
~60s cold start** before the agent can process the now-transcribed message
→ reply delivered. So the realistic sequence in the cold case is: instant
ack → ~50-90s of silence → reply. Transcription itself is long since
finished by the time the reply lands.

This means wording like "transcribing…" (the literal translation of the
originally-proposed Hebrew text) is misleading in the cold-start case — by
the time the user reads it, transcription is done and the wait is actually
container startup, a different and already-known-separately-tracked latency
issue (not something this feature fixes or should claim to explain).

**Decision**: use a verb that covers the whole pipeline, not just the ASR
step, so it stays accurate regardless of which path the message takes:

```
🎙️ קיבלתי הודעה קולית, מעבדת…
```

("Got a voice note, processing…" — "מעבדת" / processing, not "מתמלל" /
transcribing specifically.) Fixed literal string, not agent-generated — the
agent hasn't run yet when this fires.

## Failure handling

| Condition | Agent sees | Host log |
|---|---|---|
| Success | `[VOICE-TRANSCRIPT]\n<transcript text>` + existing `[audio: ...]` line | — |
| whisper-cli/model not installed | `[VOICE-TRANSCRIPT-FAILED: not-installed]` + `[audio: ...]` line | `WARN` with reason |
| Transcription exceeds 30s | `[VOICE-TRANSCRIPT-FAILED: timeout]` + `[audio: ...]` line | `WARN` with reason |
| ffmpeg/whisper-cli crash, bad output, etc. | `[VOICE-TRANSCRIPT-FAILED: error]` + `[audio: ...]` line | `WARN` with reason + underlying error |

The message is never dropped — a voice note the user sent is a message they
sent, transcription failure or not. The three reasons are distinguishable
in the host log (setup problem vs. transient timeout vs. genuine error) but
collapse to one visible-in-chat signal so the agent can say "I got a voice
note but couldn't transcribe it" rather than acting on nothing or looking
confused. No separate notification channel — surfacing the failure once, in
the same conversation, is enough; this is not a persistent-outage case like
the Docker startup failure (which does get a dedicated Telegram ping because
nothing else is running to surface it in-context).

## Install / activation: skill-gated, trunk stays inert by default

- **Feature toggle**: file presence. If `whisper-cli` isn't resolvable and/or
  the model file isn't at the fixed path, the feature is off — every voice
  note gets `[VOICE-TRANSCRIPT-FAILED: not-installed]` (still delivered,
  never silently dropped). No DB config, no env var.
- **New operational skill** `/add-hebrew-transcription` (matches the
  `/add-ollama-tool` / `/add-<channel>` convention — every install-shaped
  capability in this project is a rerunnable skill, not a manual doc):
  1. `brew install whisper-cpp ffmpeg`
  2. Download `ivrit-ai/whisper-large-v3-turbo-ggml`'s `ggml-model.bin` to
     `~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin`
  3. **Smoke test with a real Hebrew audio fixture, not silence/a tone.** A
     model that loads and returns empty passes a trivial smoke test and
     fails in production — this project already hit exactly that failure
     shape once with Ollama returning valid-JSON-but-empty summaries. Ship a
     tiny Hebrew audio fixture in the skill (generated via macOS's built-in
     Hebrew TTS voice, confirmed available on this machine:
     `say -v Carmit "<short Hebrew phrase>" -o fixture.aiff`, converted to
     `.ogg` so the smoke test also exercises the real ffmpeg conversion
     path) and assert the transcription output is **non-empty and matches
     the Hebrew Unicode block** (`֐-׿`), not just "didn't throw."
  4. Report install success/failure plainly to the operator.
- Rejected: container-side/agent-installed (self-mod `install_packages`) —
  explicitly out of scope; the container has no audio tooling and shouldn't
  gain any for this.
- Rejected: manual-docs-only install (no skill wrapper) — breaks this
  project's own convention and loses the smoke-test verification step.

## Agent instructions

Append to `instructions.prepend.md` in the three real agent groups
(`dm-with-uriel`, `dm-with-partner`, `household` — not `_ping-test`, which is
a test stub):

- What `[VOICE-TRANSCRIPT]` and `[VOICE-TRANSCRIPT-FAILED: reason]` mean.
- A transcribed message was **spoken, not typed**, and passed through
  automatic speech recognition — names, numbers, and email addresses in it
  may be wrong.
- If a transcribed message contains something that would trigger an action
  with consequences (a sender address to classify, a person's name to
  record, an amount), **confirm it back before acting** rather than treating
  it as literal. (This matters concretely: Yulanda can write sender rules
  and start a recorder off spoken input, and Hebrew ASR is most likely to
  mangle exactly the tokens — emails, proper nouns — that those actions
  depend on.)

## Testing

- `src/voice-transcription.test.ts` (new, vitest, mocked `execFile`/`fs`):
  - `isTranscribableVoiceAttachment` — true voice note vs. uploaded audio
    file (has `name`) vs. non-audio attachment vs. missing fields.
  - `transcribeVoiceNote` — not-installed (binary missing / model missing,
    as two separate cases), success path (mocked ffmpeg + whisper-cli
    stdout), timeout (mocked subprocess that never resolves before the
    deadline), generic error (non-zero exit).
  - Temp WAV cleanup happens in all four outcomes.
- `router.ts` tests: ack fires (mocked `getDeliveryAdapter`) for a
  transcribable attachment and does not fire for a non-voice message; ack
  failure (mocked rejected `deliver`) does not delay or block
  `writeSessionMessage` — assert the message write still completes and is
  not gated on the ack promise settling.
- `session-manager.ts` tests: `extractAttachmentFiles` becomes async;
  existing tests updated for the new `await`; new cases for the
  success/failure tag prepending, and confirming the `.ogg` attachment entry
  (`localPath`) is unaffected by transcription outcome in both directions.
- Skill-level: the smoke test itself (real Hebrew fixture → non-empty,
  Hebrew-matching output) is the acceptance test for the install skill —
  covered in `/add-hebrew-transcription`'s own verification step, not a
  vitest unit test (it depends on the actual installed binary + model).

## Explicitly out of scope (this pass)

- WhatsApp voice messages, email audio attachments — Telegram only.
- Any change to container-side tooling — transcription is host-only.
- A DB/config toggle for enabling/disabling the feature — file presence is
  the switch.
- Fixing container cold-start latency — traced and documented above as a
  real contributor to post-ack silence in the cold case, but it's a
  pre-existing, separately-tracked latency issue, not something this
  feature is scoped to fix.
