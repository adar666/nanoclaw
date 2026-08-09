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

No ack is sent — transcription is fast enough (warm: ~2.4s) that
announcing receipt isn't worth an extra message. Transcription runs
host-side only; the container gets no new tooling.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/voice-transcription.ts` exists, exports `isVoiceReplyToBot`,
**and** `src/db/migrations/023-voice-always-engage.ts` exists. If all
three, skip to Phase 3 (Verify).

If `voice-transcription.ts` exists but does NOT export `isVoiceReplyToBot`,
this is a stale install from before the reply-to-bot fix (a group with a
text-prefix trigger silently drops every voice note — transcription never
runs, no error, no log line). Skip the binary/model install (already done);
re-run "Copy the skill's source and tests", "Wire the reply-to-bot signal",
and the `engages` override in "Wire the router reach-in" below. The
`hasVoiceNote`/`applyVoiceTranscription` call-site wiring already in place
doesn't need to change.

If `voice-transcription.ts` exports `isVoiceReplyToBot` but
`023-voice-always-engage.ts` is missing, this is a stale install from before
the always-engage override (a wiring can only get voice notes via the
reply-to-bot gesture — there's no way to make a group "just always answer
voice notes" without it). Skip everything above; run "Wire the
voice_always_engage override" below.

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

### Wire the reply-to-bot signal (Telegram)

Voice notes carry no text, so a group's normal text-prefix trigger (`.`,
mention, etc.) can never fire on one — without this step, every voice note
in a triggered group is silently dropped and never transcribed. The
substitute gesture: a Telegram reply to one of the agent's own messages.
This needs two small edits to already-installed Telegram wiring (skip both
if `src/channels/telegram.ts` doesn't exist — the gesture is Telegram-
specific, same as transcription itself), then a router change below.

Edit `src/channels/chat-sdk-bridge.ts`. Find the `ReplyContext` interface:

```ts
export interface ReplyContext {
  text: string;
  sender: string;
}
```

Add an `isBot` field:

```ts
export interface ReplyContext {
  text: string;
  sender: string;
  /**
   * True when the replied-to message was authored by a bot account (the
   * platform's own signal — Telegram's `User.is_bot`, for instance — not a
   * name/username comparison). Extractors that can't determine this leave it
   * undefined; router.ts treats undefined as "not a reply to the bot."
   */
  isBot?: boolean;
}
```

Edit `src/channels/telegram.ts`. Find `extractReplyContext`:

```ts
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}
```

Add `isBot`, sourced from Telegram's own signal rather than comparing
`sender` names — a name comparison would be fragile (a group member could
share a first name with the bot's display name) and this field is already
on the raw payload for free:

```ts
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
    // Telegram's own signal for "this message's author is a bot account" —
    // reliable even without knowing our own bot's user id/username. One
    // caveat: if multiple agent groups share this one Telegram bot identity,
    // is_bot can't distinguish which agent's message was replied to — every
    // wired agent in the chat sees isBot:true alike. Fine while a chat has
    // one wired agent; revisit if that changes.
    isBot: reply.from?.is_bot === true,
  };
}
```

### Wire the router reach-in

Edit `src/router.ts`. Add to the import block (after the existing
`session-manager.js` import):

```ts
import { hasTranscribableVoiceAttachment, applyVoiceTranscription, isVoiceReplyToBot } from './voice-transcription.js';
```

In `routeInbound`, right after `const messageText = parsed.text ?? '';`,
insert:

```ts
  // Voice notes carry no text to test a pattern trigger against — a reply to
  // one of the agent's own Telegram messages is the substitute gesture (see
  // isVoiceReplyToBot). Computed once per event, independent of which agent
  // is being evaluated below: it's a property of the inbound message, not
  // the wiring. A voice note that ISN'T a reply-to-bot gets no override here
  // and falls through to each wiring's normal evaluateEngage — for a
  // pattern-triggered group that means dropped, untranscribed, same as today.
  const voiceReplyToBot = isVoiceReplyToBot(event.message.content);
```

Then find, inside the fan-out loop:

```ts
    const engages = evaluateEngage(agent, messageText, isMention, mg, effectiveThreadId);
```

and change it to:

```ts
    const engages = voiceReplyToBot || evaluateEngage(agent, messageText, isMention, mg, effectiveThreadId);
```

In `deliverToAgent`, right after `deliveryAddr` is computed and before the
`// Command gate:` comment, insert:

```ts
  // Hebrew voice-note transcription (Telegram voice notes only — see
  // src/voice-transcription.ts). No ack sent — transcription is fast enough
  // (warm: ~2.4s) that announcing receipt isn't worth the extra message.
  const hasVoiceNote = hasTranscribableVoiceAttachment(event.message.content);
```

Change `writeSessionMessage`'s call to use a named `messageId` local instead
of the inline `messageIdForAgent(...)` call, and add the transcription call
right after it:

```ts
  const messageId = messageIdForAgent(event.message.id, agent.agent_group_id);

  writeSessionMessage(session.agent_group_id, session.id, {
    id: messageId,
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: deliveryAddr.platformId,
    channelType: deliveryAddr.channelType,
    threadId: deliveryAddr.threadId,
    content: event.message.content,
    trigger: wake ? 1 : 0,
  });

  if (hasVoiceNote) {
    await applyVoiceTranscription(session.agent_group_id, session.id, messageId);
  }
```

### Wire the voice_always_engage override (optional, per-wiring)

Reply-to-bot (above) is the safe default — it changes what a group's voice
notes do only for notes explicitly addressed to the agent. Some groups want
more: every voice note answered, no gesture required (e.g. a small trusted
household chat where the reply gesture is friction, not signal, and every
voice note really is meant for the agent). That's what this section wires —
skip it entirely if the install only needs the reply-to-bot default; it's
off (NULL) for every wiring until an operator explicitly turns it on.

**This is a real behavior change worth stating plainly before turning it
on for any wiring**: every voice note sent into that chat gets run through
local Whisper transcription and stored as plaintext in that session's
`inbound.db`, indefinitely — the codebase has no retention/rotation for
`messages_in` rows or session `inbox/` attachment files (checked
`host-sweep.ts` and the session-lifecycle code — nothing purges them). For
a shared chat with more than one human in it, that means voice notes
between them, not meant for the agent, get transcribed and persisted too.
No cloud call is ever made (ffmpeg + whisper-cli are local subprocesses) —
the change is what's transcribed and stored locally, not where it goes.

Copy the migration:

```bash
S=.claude/skills/add-hebrew-transcription
cp $S/023-voice-always-engage.ts src/db/migrations/023-voice-always-engage.ts
```

Register it in `src/db/migrations/index.ts` — add the import alongside the
other numbered migrations, and the entry at the end of the `migrations`
array (matching whatever the highest existing migration number is; this
skill was authored against `022`, adjust if the install has since added
more):

```ts
import { migration023 } from './023-voice-always-engage.js';
```

```ts
  migration023,
];
```

Edit `src/types.ts`. Find `MessagingGroupAgent`'s `threads` field and add
`voice_always_engage` right after it:

```ts
  /**
   * Per-wiring override (migration 023): 1 = a transcribable voice
   * attachment engages this wiring unconditionally, same effect as a
   * reply-to-bot voice note (see isVoiceReplyToBot in voice-transcription.ts).
   * NULL/0 = off — voice notes still need a reply-to-bot gesture or the
   * wiring's own evaluateEngage to engage. Never affects text messages:
   * router.ts only consults this when the inbound message actually carries a
   * transcribable voice attachment. Optional on the TS type per the
   * `threads` convention so pre-migration fixtures don't need updating.
   */
  voice_always_engage?: number | null;
```

Edit `src/router.ts`. Right after the `voiceReplyToBot` const added above,
insert:

```ts
  // Separately: whether this event carries a transcribable voice attachment
  // at all (reply or not) — needed below for the per-wiring
  // voice_always_engage override, which unlike voiceReplyToBot depends on
  // the wiring, not just the event. Never true for a text-only message, so
  // it can never affect the text-trigger path.
  const hasVoiceAttachment = hasTranscribableVoiceAttachment(event.message.content);
```

Then find the `engages` line just patched in for reply-to-bot:

```ts
    const engages = voiceReplyToBot || evaluateEngage(agent, messageText, isMention, mg, effectiveThreadId);
```

and change it to:

```ts
    // voice_always_engage is per-wiring (unlike voiceReplyToBot, which is a
    // property of the event) — an operator can opt one wiring into "any
    // voice note engages" (e.g. a shared household chat where the reply
    // gesture is more friction than the false-positive risk is worth)
    // without touching any other wiring's behavior, in this group or any
    // other. Gated on hasVoiceAttachment so it can never fire for text.
    const voiceAlwaysEngage = hasVoiceAttachment && agent.voice_always_engage === 1;
    const engages =
      voiceReplyToBot || voiceAlwaysEngage || evaluateEngage(agent, messageText, isMention, mg, effectiveThreadId);
```

Edit `src/cli/resources/wirings.ts` so the flag is manageable via `ncl`
rather than raw SQL. Add the normalize helper right after `normalizeThreads`:

```ts
/** --voice-always-engage accepts true/false (or 1/0); stored as INTEGER 1/0.
 *  Omitted = column NULL = off (voice notes still need a reply-to-bot
 *  gesture or the wiring's own engage check). */
function normalizeVoiceAlwaysEngage(v: unknown): number {
  if (v === true || v === 'true' || v === '1' || v === 1) return 1;
  if (v === false || v === 'false' || v === '0' || v === 0) return 0;
  throw new Error(`--voice-always-engage must be true or false, got "${v}"`);
}
```

Add the column definition right after `threads` in the `columns` array:

```ts
    {
      name: 'voice_always_engage',
      type: 'boolean',
      description:
        'True = a transcribable voice attachment (Telegram voice note) engages this wiring unconditionally, bypassing engage_mode/engage_pattern entirely — the same effect as a reply-to-bot voice note, without requiring the reply gesture. Never affects text messages. NULL/false (default) = voice notes still need a reply-to-bot gesture or the normal engage check.',
      updatable: true,
    },
```

In `preUpdate`, right after the `threads` normalize line, add:

```ts
    if (updates.voice_always_engage !== undefined) {
      updates.voice_always_engage = normalizeVoiceAlwaysEngage(updates.voice_always_engage);
    }
```

In the custom `create` handler, right after `if (args.threads !== undefined) values.threads = args.threads;`, add:

```ts
        if (args.voice_always_engage !== undefined) values.voice_always_engage = args.voice_always_engage;
```

and right after the `values.threads = normalizeThreads(values.threads)` line a bit further down, add:

```ts
        if (values.voice_always_engage !== undefined) {
          values.voice_always_engage = normalizeVoiceAlwaysEngage(values.voice_always_engage);
        }
```

(Optional but recommended: append `, --voice-always-engage` to the flag list in `customOperations.create.description` so `ncl wirings help` documents it.)

Turn it on for a specific wiring once the host has restarted and the
migration has run (`ncl wirings list` to find the id):

```bash
ncl wirings update --id <wiring-id> --voice-always-engage true
```

### Apply the router test snippet

Follow `$S/router.host-core.test.snippet.md` to add the mock and all three
`describe` blocks (transcription call-site wiring, reply-to-bot override,
and the voice_always_engage override) into `src/host-core.test.ts`. Skip
whatever's already present — the snippet file says exactly what to check.

If "Wire the voice_always_engage override" above was applied, also follow
`$S/wirings.voice-always-engage.test.snippet.md` to add its tests into
`src/cli/resources/wirings.test.ts`.

### Add the smoke-test fixture

```bash
mkdir -p $S/fixtures  # already present if copying the skill folder verbatim
```

The fixture (`fixtures/hebrew-sample.ogg`) ships with this skill — no
generation needed on a fresh install.

## Phase 3: Verify

```bash
pnpm exec vitest run src/voice-transcription.test.ts src/host-core.test.ts src/cli/resources/wirings.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
.claude/skills/add-hebrew-transcription/smoke-test.sh
```

All three must pass: unit + router integration tests green, no type
errors, and the real-audio smoke test prints `SMOKE TEST PASSED: <hebrew
text>`. The smoke test is the one that actually exercises the installed
`whisper-cli` binary and downloaded model — the vitest suite mocks the
subprocess boundary, so it can't catch a bad install by itself.

### Deploy to the running host

Tests passing only proves the code is correct — it does not make it live.
The host runs a compiled `dist/index.js` under a service manager
(`launchctl`/`systemd`); it neither picks up a `src/` edit nor runs a new
migration until rebuilt and restarted:

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS; Linux: systemctl --user restart nanoclaw
```

Restarting kills every running agent container (each respawns fresh, with
the new code and a freshly-composed `CLAUDE.md`, on its next inbound
message) — this is disruptive to a live install, not just a formality. If
`voice_always_engage` was wired in, this is also when migration 023
actually runs — `ncl wirings update --voice-always-engage true` only works
against a schema that already has the column.

## Next steps

Update each wired agent group's standing instructions
(`groups/<folder>/instructions.prepend.md`) so it knows what the
`[VOICE-TRANSCRIPT]`/`[VOICE-TRANSCRIPT-FAILED: reason]` tags mean, and
which of the three voice-engagement blocks below actually matches that
wiring's behavior — using the wrong one leaves the agent giving an
inaccurate explanation if asked "why didn't you respond." Check
`ncl wirings get --id <id>` and pick by what you find:

| Wiring shape | Block to use |
|---|---|
| `engage_mode: pattern, engage_pattern: '.'` (or any other "always engage" wiring — the common case for DMs) | "Voice notes" (base) |
| Text-prefix/mention trigger, `voice_always_engage` NOT set | "Voice notes: only when replied to you" |
| Text-prefix/mention trigger, `voice_always_engage: 1` | "Voice notes: always transcribed, text still needs the dot" |

Wrap the added block in
`<!-- add-hebrew-transcription:start -->` / `<!-- add-hebrew-transcription:end -->`
markers (matching `REMOVE.md`'s uninstall step) so it's identifiable and
removable later. Do NOT hand-edit `groups/<folder>/.claude-fragments/persona.md`
directly — it's regenerated from `instructions.prepend.md` on every
container spawn (`src/claude-md-compose.ts` → `readGroupPersona`), silently
overwriting a direct edit the next time the container respawns (this can
happen mid-session, from unrelated background activity — it isn't only a
restart-time risk). Edit `instructions.prepend.md` and, if the container
won't restart soon and the change should be live immediately, also write
the same (trimmed) content directly to `.claude-fragments/persona.md` —
that's a safe, idempotent no-op the next time compose runs, since it will
write the identical content anyway.

For a group wired with `engage_mode: pattern, engage_pattern: '.'` (or any
other "always engage" wiring — check `ncl wirings get --id <id>`, this is
the common case for DMs), every voice note gets transcribed and answered —
the base block below is enough:

```md
<!-- add-hebrew-transcription:start -->
## Voice notes

Telegram voice notes are transcribed automatically before you see them.
Two tags mark this:

- `[VOICE-TRANSCRIPT]` — transcription succeeded. The text that follows is
  what speech recognition heard, not what was typed.
- `[VOICE-TRANSCRIPT-FAILED: reason]` — transcription failed (reason is
  `not-installed`, `timeout`, or `error`). The voice note itself is still
  attached (`[audio: ...]` line) but you have no transcript. Say so plainly
  — "I got a voice note but couldn't transcribe it" — rather than acting on
  nothing or asking a confused follow-up.

A transcribed message was **spoken, not typed**, and passed through
automatic speech recognition — names, numbers, and email addresses in it
may be wrong. If a transcribed message contains something that would
trigger an action with consequences (a sender address to classify, a
person's name to record, an amount), **confirm it back before acting**
rather than treating it as literal.
<!-- add-hebrew-transcription:end -->
```

For a group with any other engage mode (a text-prefix pattern like `^\.`,
`mention`, `mention-sticky`) — this is where "Wire the reply-to-bot signal"
above actually gets exercised, since a voice note has no text to match a
pattern against. Use this block instead, which explains the reply gesture
and gives the agent exact wording for the "why didn't you respond" failure
mode (adjust bot-name/people-names to the group):

```md
<!-- add-hebrew-transcription:start -->
## Voice notes: only when replied to you

This chat's text trigger is a `.` prefix — but a voice note has no text to
put a dot in front of. The substitute gesture is a **Telegram reply**: press
and hold (or long-press) one of your own messages in the chat, choose Reply,
then record the voice note as that reply. Only a voice note that replies to
one of your messages gets transcribed and gets a response from you.

Any other voice note in this chat is **never transcribed at all** and you
never see it or wake for it. That's deliberate — group chats are also where
people talk to each other, and their voice notes to one another are not run
through speech recognition just because they happen to land in the same
chat as you.

**If someone asks why you didn't respond to a voice note**, explain this
plainly: "I only pick up voice notes that reply to one of my own messages —
that's the equivalent of the `.` prefix for a message with no text to put it
in front of. Reply to something I said and record the voice note as that
reply, and I'll hear it." Don't imply you missed it or that something
broke — you structurally never saw it, by design.

One practical wrinkle: replying requires a message of yours to reply *to*.
Telegram has no time limit on what you can reply to, so an old message
works fine even after days of silence. If you've never sent anything into
this chat yet, there's nothing of yours to reply to yet — a `.`-prefixed
text message needs to land first to give people something to reply to.

When transcription DOES run, two tags mark the result:

- `[VOICE-TRANSCRIPT]` — transcription succeeded. The text that follows is
  what speech recognition heard, not what was typed.
- `[VOICE-TRANSCRIPT-FAILED: reason]` — transcription failed (reason is
  `not-installed`, `timeout`, or `error`). The voice note itself is still
  attached (`[audio: ...]` line) but you have no transcript. Say so plainly
  — "I got a voice note but couldn't transcribe it" — rather than acting on
  nothing or asking a confused follow-up.

A transcribed message was **spoken, not typed**, and passed through
automatic speech recognition — names, numbers, and email addresses in it
may be wrong. If a transcribed message contains something that would
trigger an action with consequences (a sender address to classify, a
person's name to record, an amount), **confirm it back before acting**
rather than treating it as literal.
<!-- add-hebrew-transcription:end -->
```

For a group with `voice_always_engage` turned on (see "Wire the
voice_always_engage override" above) — every voice note gets transcribed
and answered regardless of engage_mode, but text still needs its usual
trigger. Use this block, which states that plainly and — critically, for a
shared/multi-person chat — tells the agent to say so honestly if either
person asks whether voice notes between *them* (not addressed to the agent)
get transcribed too. They do; there is no way to send a voice note into
that chat that skips transcription:

```md
<!-- add-hebrew-transcription:start -->
## Voice notes: always transcribed, text still needs the dot

Text messages in this chat only reach you with a `.` prefix, same as
always. **Voice notes are different: every voice note sent into this chat
is transcribed and gets a response from you, with no dot and no reply
gesture needed.** A voice note engages you unconditionally — the moment one
lands, you hear it.

**This includes voice notes between people in this chat that aren't meant
for you.** There's no way to send a voice note in this chat that skips
transcription — every one goes through local, on-device speech recognition
the instant it arrives. If anyone asks whether their voice notes to each
other get transcribed too, the honest answer is yes, always, including what
they say only to each other.

**If someone asks why you didn't respond to a voice note**, that should not
normally happen — every voice note gets a response. If it seems like you
missed one, say so plainly and don't guess at a reason; it's worth them
checking with the operator rather than you inventing an explanation.

When transcription runs, two tags mark the result:

- `[VOICE-TRANSCRIPT]` — transcription succeeded. The text that follows is
  what speech recognition heard, not what was typed.
- `[VOICE-TRANSCRIPT-FAILED: reason]` — transcription failed (reason is
  `not-installed`, `timeout`, or `error`). The voice note itself is still
  attached (`[audio: ...]` line) but you have no transcript. Say so plainly
  — "I got a voice note but couldn't transcribe it" — rather than acting on
  nothing or asking a confused follow-up.

A transcribed message was **spoken, not typed**, and passed through
automatic speech recognition — names, numbers, and email addresses in it
may be wrong. If a transcribed message contains something that would
trigger an action with consequences (a sender address to classify, a
person's name to record, an amount), **confirm it back before acting**
rather than treating it as literal.
<!-- add-hebrew-transcription:end -->
```

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
