# Remove Hebrew Voice-Note Transcription

Reverses everything `SKILL.md` applied.

## Revert the router reach-in

Edit `src/router.ts`:
- Delete the `voice-transcription.js` import (`hasTranscribableVoiceAttachment`,
  `applyVoiceTranscription`, `isVoiceReplyToBot`).
- Delete the `voiceReplyToBot` local (the comment block + assignment right
  after `const messageText = parsed.text ?? '';`), and revert
  `const engages = voiceReplyToBot || evaluateEngage(...)` back to
  `const engages = evaluateEngage(...)`.
- Delete the `hasVoiceNote`/ack block inserted after `deliveryAddr`.
- Delete the `if (hasVoiceNote) { await applyVoiceTranscription(...); }`
  block after `writeSessionMessage`.
- Revert `writeSessionMessage`'s `id:` field back to the inline
  `messageIdForAgent(event.message.id, agent.agent_group_id)` call and
  remove the now-unused `messageId` local, OR leave the local in place if
  nothing else in the function depends on removing it — either is fine,
  just make sure the transcription call site is gone.

## Revert the reply-to-bot signal (Telegram)

Only if `src/channels/telegram.ts` and `src/channels/chat-sdk-bridge.ts`
were patched by this skill (i.e. no other feature added `ReplyContext.isBot`
in the meantime — check before removing):

- `src/channels/chat-sdk-bridge.ts`: remove the `isBot?: boolean` field
  (and its doc comment) from the `ReplyContext` interface.
- `src/channels/telegram.ts`: remove the `isBot: reply.from?.is_bot === true`
  line (and its comment) from `extractReplyContext`.

## Revert the voice_always_engage override

Only if "Wire the voice_always_engage override" in `SKILL.md` was applied
(check: `src/db/migrations/023-voice-always-engage.ts` exists):

- `src/router.ts`: remove the `hasVoiceAttachment` const, and revert
  `const engages = voiceReplyToBot || voiceAlwaysEngage || evaluateEngage(...)`
  back to `const engages = voiceReplyToBot || evaluateEngage(...)` (remove
  the `voiceAlwaysEngage` const along with it).
- `src/cli/resources/wirings.ts`: remove the `voice_always_engage` column
  definition, the `normalizeVoiceAlwaysEngage` function, its call in
  `preUpdate`, and both call sites in the custom `create` handler.
- `src/types.ts`: remove the `voice_always_engage` field from
  `MessagingGroupAgent`.
- First, disable it on any wiring that has it on:
  `ncl wirings update --id <id> --voice-always-engage false` for each row
  `ncl wirings list` shows with `voice_always_engage: 1`.
- The migration itself (`023-voice-always-engage.ts`,
  `src/db/migrations/index.ts`'s import + array entry) is left in place —
  this codebase treats migrations as forward-only history (no other
  migration is ever deleted after being applied); the `voice_always_engage`
  column becomes inert once the code above no longer reads it. Delete
  `src/db/migrations/023-voice-always-engage.ts` and its `index.ts`
  registration only if this is a pre-release install where the migration
  was never actually applied anywhere.

## Remove copied files

```bash
rm src/voice-transcription.ts
rm src/voice-transcription.test.ts
```

## Remove the test-append block

Delete the `describe('router — voice-note transcription', ...)`,
`describe('router — voice-note reply-to-bot override (group, drop policy)', ...)`,
and (if voice_always_engage was applied)
`describe('router — voice_always_engage override (group, drop policy)', ...)`
blocks, and the `vi.mock('./voice-transcription.js', ...)` call, from
`src/host-core.test.ts`. If voice_always_engage was applied, also delete
`describe('wirings — voice_always_engage column', ...)` from
`src/cli/resources/wirings.test.ts`.

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
