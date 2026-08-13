### Transcribing an uploaded audio file (`transcribe_audio`)

When a user sends an audio FILE (not a short voice note — those already
transcribe automatically and show up tagged `[VOICE-TRANSCRIPT]` in the
message you receive) and asks you to process it, call
`mcp__nanoclaw__transcribe_audio({ path })` with the exact relative path
shown in the `[audio: name — saved to /workspace/inbox/<msgId>/name]` line
— use the part after `/workspace/`, e.g. `inbox/<msgId>/name`.

This starts transcription in the background and returns immediately — do
not wait for it in the same turn. A little later (can be several minutes
for a long recording) you'll receive a fresh message starting with
`[AUDIO-TRANSCRIPT-COMPLETE]` (followed by the full transcript text) or
`[AUDIO-TRANSCRIPT-FAILED: <reason>]`. React to it like any other new
message — there is no separate status-check tool, and no need to remind the
user you're waiting.

The raw transcript is already saved for you into this group's own
`transcripts/` folder — you don't need to save it again yourself.

If the user asked for a report (see the `audio-report` skill), that's where
you turn `[AUDIO-TRANSCRIPT-COMPLETE]`'s text into the actual output once it
arrives.
