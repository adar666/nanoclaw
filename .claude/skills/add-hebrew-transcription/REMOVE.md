# Remove Hebrew Voice-Note Transcription

Reverses everything `SKILL.md` applied.

## Revert the router reach-in

Edit `src/router.ts`:
- Delete the two import lines added for this skill (`getDeliveryAdapter`
  from `./delivery.js` and the `voice-transcription.js` import).
- Delete the `hasVoiceNote`/ack block inserted after `deliveryAddr`.
- Delete the `if (hasVoiceNote) { await applyVoiceTranscription(...); }`
  block after `writeSessionMessage`.
- Revert `writeSessionMessage`'s `id:` field back to the inline
  `messageIdForAgent(event.message.id, agent.agent_group_id)` call and
  remove the now-unused `messageId` local, OR leave the local in place if
  nothing else in the function depends on removing it — either is fine,
  just make sure the transcription call site is gone.

## Remove copied files

```bash
rm src/voice-transcription.ts
rm src/voice-transcription.test.ts
```

## Remove the test-append block

Delete the `describe('router — voice-note transcription', ...)` block and
its two `vi.mock` calls (`./delivery.js`, `./voice-transcription.js`) from
`src/host-core.test.ts`.

## Remove the downloaded model (optional — ask first)

```bash
rm -f ~/.config/nanoclaw/models/ivrit-whisper-large-v3-turbo-ggml.bin
```

## Uninstall host packages (optional — ask first)

`whisper-cpp` and `ffmpeg` may be used by other tools on this machine.
Confirm with the operator before uninstalling:

```bash
brew uninstall whisper-cpp ffmpeg
```

## Remove agent-instruction blocks

If the "Next steps" guidance was added to any `groups/<name>/instructions.prepend.md`
files (marked with `<!-- add-hebrew-transcription:start -->` /
`<!-- add-hebrew-transcription:end -->` comments), delete each marked
block.

## Verify

```bash
pnpm exec vitest run
pnpm exec tsc --noEmit -p tsconfig.json
```

Both green, no leftover references to `voice-transcription` anywhere in
`src/`.
