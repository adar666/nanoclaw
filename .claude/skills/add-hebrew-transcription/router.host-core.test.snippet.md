# Router test snippet — apply into `src/host-core.test.ts`

Skip any part already present (`grep -q "voice-note transcription" src/host-core.test.ts`,
`grep -q "voice-note reply-to-bot" src/host-core.test.ts`,
`grep -q "voice_always_engage override" src/host-core.test.ts`). Block 3
requires "Wire the voice_always_engage override" in `SKILL.md` to have been
applied — skip it if that section wasn't.

Add this mock near the file's existing top-level `vi.mock` calls (after
`vi.mock('./container-runner.js', ...)`):

```ts
vi.mock('./voice-transcription.js', async () => {
  const actual = await vi.importActual<typeof import('./voice-transcription.js')>('./voice-transcription.js');
  return { ...actual, applyVoiceTranscription: vi.fn().mockResolvedValue(undefined) };
});
```

Then append both `describe` blocks below at the end of the file — verbatim,
self-contained (no other snippet needs merging into them).

## Block 1 — transcription call-site wiring (DM, always-engage wiring)

```ts
describe('router — voice-note transcription', () => {
  beforeEach(async () => {
    mockDeliver.mockReset().mockResolvedValue(undefined);
    // wakeContainer and applyVoiceTranscription are module-level singleton
    // mocks and this suite has no global resetMocks/clearMocks config, so
    // their call history accumulates across every test in the file (and,
    // for applyVoiceTranscription, across the tests within this describe
    // block too). Clear them here so per-test assertions (`not.toHaveBeenCalled`,
    // and `wakeOrder` below) reflect only this test's own calls.
    const { wakeContainer } = await import('./container-runner.js');
    vi.mocked(wakeContainer).mockClear();
    const { applyVoiceTranscription } = await import('./voice-transcription.js');
    vi.mocked(applyVoiceTranscription).mockClear();
    createAgentGroup({
      id: 'ag-voice',
      name: 'Voice Agent',
      folder: 'voice-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-voice',
      channel_type: 'telegram',
      platform_id: 'tg-chat-1',
      name: 'Voice Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-voice',
      messaging_group_id: 'mg-voice',
      agent_group_id: 'ag-voice',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  function voiceEvent(id: string): InboundEvent {
    return {
      channelType: 'telegram',
      platformId: 'tg-chat-1',
      threadId: null,
      message: {
        id,
        kind: 'chat-sdk',
        content: JSON.stringify({
          text: '',
          attachments: [{ type: 'audio', mimeType: 'audio/ogg', size: 999 }],
        }),
        timestamp: now(),
      },
    };
  }

  it('calls applyVoiceTranscription before the container wakes, with no ack sent', async () => {
    const { routeInbound } = await import('./router.js');
    const { applyVoiceTranscription } = await import('./voice-transcription.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(voiceEvent('msg-voice-1'));

    expect(mockDeliver).not.toHaveBeenCalled();
    expect(applyVoiceTranscription).toHaveBeenCalledWith(
      'ag-voice',
      expect.any(String),
      expect.stringContaining('msg-voice-1'),
    );

    const transcribeOrder = (applyVoiceTranscription as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const wakeOrder = (wakeContainer as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(transcribeOrder).toBeLessThan(wakeOrder);
  });

  it('does not call applyVoiceTranscription for a plain text message', async () => {
    const { routeInbound } = await import('./router.js');
    const { applyVoiceTranscription } = await import('./voice-transcription.js');

    await routeInbound({
      channelType: 'telegram',
      platformId: 'tg-chat-1',
      threadId: null,
      message: { id: 'msg-plain-1', kind: 'chat-sdk', content: JSON.stringify({ text: 'hi' }), timestamp: now() },
    });

    expect(mockDeliver).not.toHaveBeenCalled();
    expect(applyVoiceTranscription).not.toHaveBeenCalled();
  });
});
```

## Block 2 — reply-to-bot override (group, text-prefix/drop-policy wiring)

Exercises the gap this signal exists to close: a voice note in a group with
a text trigger (`^\.`) and `ignored_message_policy: 'drop'` — the shape a
household/family chat wiring actually uses. Requires `isVoiceReplyToBot`
wired into `routeInbound` per "Wire the router reach-in" in `SKILL.md`.

```ts
describe('router — voice-note reply-to-bot override (group, drop policy)', () => {
  beforeEach(async () => {
    mockDeliver.mockReset().mockResolvedValue(undefined);
    const { wakeContainer } = await import('./container-runner.js');
    vi.mocked(wakeContainer).mockClear();
    const { applyVoiceTranscription } = await import('./voice-transcription.js');
    vi.mocked(applyVoiceTranscription).mockClear();
    createAgentGroup({
      id: 'ag-household',
      name: 'Household Agent',
      folder: 'household-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-household',
      channel_type: 'telegram',
      platform_id: 'tg-household-1',
      name: 'Household Chat',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-household',
      messaging_group_id: 'mg-household',
      agent_group_id: 'ag-household',
      engage_mode: 'pattern',
      engage_pattern: '^\\.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  function voiceEvent(id: string, replyTo?: { isBot?: boolean }): InboundEvent {
    return {
      channelType: 'telegram',
      platformId: 'tg-household-1',
      threadId: null,
      message: {
        id,
        kind: 'chat-sdk',
        content: JSON.stringify({
          text: '',
          attachments: [{ type: 'audio', mimeType: 'audio/ogg', size: 999 }],
          ...(replyTo ? { replyTo } : {}),
        }),
        timestamp: now(),
      },
    };
  }

  it('engages and transcribes a voice note that replies to the bot, despite no dot prefix', async () => {
    const { routeInbound } = await import('./router.js');
    const { applyVoiceTranscription } = await import('./voice-transcription.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(voiceEvent('msg-reply-bot', { isBot: true }));

    expect(applyVoiceTranscription).toHaveBeenCalledWith(
      'ag-household',
      expect.any(String),
      expect.stringContaining('msg-reply-bot'),
    );
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('drops a voice note with no reply, never invoking transcription', async () => {
    const { routeInbound } = await import('./router.js');
    const { applyVoiceTranscription } = await import('./voice-transcription.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(voiceEvent('msg-no-reply'));

    expect(applyVoiceTranscription).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('drops a voice note replying to a human (partner), never invoking transcription', async () => {
    const { routeInbound } = await import('./router.js');
    const { applyVoiceTranscription } = await import('./voice-transcription.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(voiceEvent('msg-reply-human', { isBot: false }));

    expect(applyVoiceTranscription).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });
});
```

## Block 3 — voice_always_engage override (group, drop policy)

Requires `getDb` imported from `./db/connection.js` (already imported in
`host-core.test.ts` — used at the `threads = 0` raw-SQL patches earlier in
the file) and "Wire the voice_always_engage override" applied in `SKILL.md`.

```ts
describe('router — voice_always_engage override (group, drop policy)', () => {
  beforeEach(async () => {
    mockDeliver.mockReset().mockResolvedValue(undefined);
    const { wakeContainer } = await import('./container-runner.js');
    vi.mocked(wakeContainer).mockClear();
    const { applyVoiceTranscription } = await import('./voice-transcription.js');
    vi.mocked(applyVoiceTranscription).mockClear();
    createAgentGroup({
      id: 'ag-household',
      name: 'Household Agent',
      folder: 'household-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-household',
      channel_type: 'telegram',
      platform_id: 'tg-household-1',
      name: 'Household Chat',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-household',
      messaging_group_id: 'mg-household',
      agent_group_id: 'ag-household',
      engage_mode: 'pattern',
      engage_pattern: '^\\.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    // createMessagingGroupAgent's fixed-column INSERT deliberately doesn't
    // cover voice_always_engage (same reason it excludes `threads` — see
    // its other use at 'threads = 0' above): binding `undefined` for an
    // omitted optional field throws in better-sqlite3. Patch it in directly,
    // mirroring the wiring the CLI's `wirings-update --voice-always-engage
    // true` would produce.
    getDb().prepare("UPDATE messaging_group_agents SET voice_always_engage = 1 WHERE id = 'mga-household'").run();
  });

  function voiceEvent(id: string): InboundEvent {
    return {
      channelType: 'telegram',
      platformId: 'tg-household-1',
      threadId: null,
      message: {
        id,
        kind: 'chat-sdk',
        content: JSON.stringify({
          text: '',
          attachments: [{ type: 'audio', mimeType: 'audio/ogg', size: 999 }],
        }),
        timestamp: now(),
      },
    };
  }

  function textEvent(id: string, text: string): InboundEvent {
    return {
      channelType: 'telegram',
      platformId: 'tg-household-1',
      threadId: null,
      message: { id, kind: 'chat-sdk', content: JSON.stringify({ text }), timestamp: now() },
    };
  }

  it('engages and transcribes any voice note, no reply and no dot prefix needed', async () => {
    const { routeInbound } = await import('./router.js');
    const { applyVoiceTranscription } = await import('./voice-transcription.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(voiceEvent('msg-voice-always'));

    expect(applyVoiceTranscription).toHaveBeenCalledWith(
      'ag-household',
      expect.any(String),
      expect.stringContaining('msg-voice-always'),
    );
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('still drops a text message with no dot prefix — voice_always_engage never touches text', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(textEvent('msg-text-no-dot', 'no prefix here'));

    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('still engages a dot-prefixed text message normally', async () => {
    const { routeInbound } = await import('./router.js');
    const { wakeContainer } = await import('./container-runner.js');

    await routeInbound(textEvent('msg-text-dot', '.hello'));

    expect(wakeContainer).toHaveBeenCalled();
  });
});
```
