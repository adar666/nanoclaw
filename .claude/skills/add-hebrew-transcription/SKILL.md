---
name: add-hebrew-transcription
description: Add local, free, on-device Hebrew voice-note transcription for Telegram — ivrit-ai's Hebrew-finetuned Whisper via whisper.cpp, host-only, no cloud API.
---

# Add Hebrew Voice-Note Transcription

Telegram voice notes are received by NanoClaw today but never transcribed —
the agent only sees `[audio: name — saved to path]`. This skill adds local,
on-device transcription using [ivrit-ai/whisper-large-v3-turbo-ggml](https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml)
(a Hebrew finetune of Whisper large-v3-turbo) via [whisper.cpp](https://github.com/ggml-org/whisper.cpp) —
the same "runs locally, no API key, no per-call cost" principle as the
Ollama integration. Telegram voice notes only; uploaded audio files,
WhatsApp voice messages, and email attachments are untouched.

An immediate Hebrew acknowledgment is sent the moment a voice note is
detected — fire-and-forget, so a slow or failed ack can never delay or
block the actual message. Transcription runs host-side only; the container
gets no new tooling.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/voice-transcription.ts` exists. If it does, skip to Phase 3
(Verify).

### Check prerequisites

This skill targets Apple Silicon Macs with Homebrew at `/opt/homebrew`
(confirm: `brew --prefix` should print `/opt/homebrew`). On Intel Macs or
Linux, the hardcoded `/opt/homebrew/bin` paths in `voice-transcription.ts`
need adjusting to match `brew --prefix`'s actual output — do that first if
this isn't an Apple Silicon Mac.

## Phase 2: Apply

### Install host dependencies

```bash
brew install whisper-cpp ffmpeg
```

### Download the model

```bash
mkdir -p ~/.config/nanoclaw/models
curl -L -o ~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin \
  https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin
```

This is a ~1.6GB download. The feature is off (every voice note gets a
`[VOICE-TRANSCRIPT-FAILED: not-installed]` tag, never dropped) until both
the binaries and this file are in place — there's no separate config flag.

### Copy the skill's source and tests into the host tree

```bash
S=.claude/skills/add-hebrew-transcription
cp $S/voice-transcription.ts      src/voice-transcription.ts
cp $S/voice-transcription.test.ts src/voice-transcription.test.ts
```

### Wire the router reach-in

Edit `src/router.ts`. Add to the import block (after the existing
`session-manager.js` import):

```ts
import { getDeliveryAdapter } from './delivery.js';
import { hasTranscribableVoiceAttachment, applyVoiceTranscription, VOICE_NOTE_ACK_TEXT } from './voice-transcription.js';
```

In `deliverToAgent`, right after `deliveryAddr` is computed and before the
`// Command gate:` comment, insert:

```ts
  const hasVoiceNote = hasTranscribableVoiceAttachment(event.message.content);
  if (hasVoiceNote) {
    const adapter = getDeliveryAdapter();
    if (adapter) {
      void adapter
        .deliver(deliveryAddr.channelType, deliveryAddr.platformId, deliveryAddr.threadId, 'chat-sdk', JSON.stringify({ text: VOICE_NOTE_ACK_TEXT }))
        .catch((err) => log.warn('Voice-note ack failed to send', { err }));
    }
  }

```

Change `writeSessionMessage`'s call to use a named `messageId` local instead
of the inline `messageIdForAgent(...)` call, and add the transcription call
right after it:

```ts
  const messageId = messageIdForAgent(event.message.id, agent.agent_group_id);

  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageId,
    // ...unchanged fields
  });

  if (hasVoiceNote) {
    await applyVoiceTranscription(session.agent_group_id, session.id, messageId);
  }
```

### Apply the router test snippet

Follow `$S/router.host-core.test.snippet.md` to add the mocks and the
`describe('router — voice-note transcription', ...)` block into
`src/host-core.test.ts`. Skip if already present.

### Add the smoke-test fixture

```bash
mkdir -p $S/fixtures  # already present if copying the skill folder verbatim
```

The fixture (`fixtures/hebrew-sample.ogg`) ships with this skill — no
generation needed on a fresh install.

## Phase 3: Verify

```bash
pnpm exec vitest run src/voice-transcription.test.ts src/host-core.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
.claude/skills/add-hebrew-transcription/smoke-test.sh
```

All three must pass: unit + router integration tests green, no type
errors, and the real-audio smoke test prints `SMOKE TEST PASSED: <hebrew
text>`. The smoke test is the one that actually exercises the installed
`whisper-cli` binary and downloaded model — the vitest suite mocks the
subprocess boundary, so it can't catch a bad install by itself.

## Next steps

Update the agent groups' instructions so they know what the
`[VOICE-TRANSCRIPT]`/`[VOICE-TRANSCRIPT-FAILED: reason]` tags mean and to
confirm consequential content (names, numbers, emails) from a transcribed
message before acting on it — see
`docs/superpowers/specs/2026-08-05-hebrew-voice-transcription-design.md`'s
"Agent instructions" section for the exact guidance to add per group.

## Troubleshooting

- **Every voice note gets `[VOICE-TRANSCRIPT-FAILED: not-installed]`**:
  `ls -la /opt/homebrew/bin/whisper-cli /opt/homebrew/bin/ffmpeg
  ~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin` — one of
  the three is missing.
- **`[VOICE-TRANSCRIPT-FAILED: timeout]` routinely**: run the smoke test
  directly and time it; if a single short voice note is taking anywhere
  near 30s, something is wrong with the install (falling back to CPU
  instead of Metal is the most likely cause) — this isn't expected
  behavior to just wait out.
- **`[VOICE-TRANSCRIPT-FAILED: error]`**: check `logs/nanoclaw.error.log`
  for the underlying ffmpeg/whisper-cli error NanoClaw logged at `WARN`.
