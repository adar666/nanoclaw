# Wirings CLI test snippet — apply into `src/cli/resources/wirings.test.ts`

Only relevant if "Wire the voice_always_engage override" in `SKILL.md` was
applied. Skip if already present (`grep -q "voice_always_engage column"
src/cli/resources/wirings.test.ts`).

Append this `describe` block right after the existing
`describe('wirings — threads and priority columns', ...)` block — no new
imports or fixtures needed, it reuses `create`/`update`/`getMessagingGroupAgent`
already set up earlier in the file:

```ts
describe('wirings — voice_always_engage column', () => {
  it('omitted --voice-always-engage stores NULL (off)', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' });
    expect(getMessagingGroupAgent(row.id as string)!.voice_always_engage).toBeNull();
  });

  it('--voice-always-engage true/false stores 1/0 on create', async () => {
    const on = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', voice_always_engage: 'true' });
    expect(getMessagingGroupAgent(on.id as string)!.voice_always_engage).toBe(1);
    const off = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1', voice_always_engage: 'false' });
    expect(getMessagingGroupAgent(off.id as string)!.voice_always_engage).toBe(0);
  });

  it('rejects a non-boolean --voice-always-engage value on create', async () => {
    await expect(
      create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1', voice_always_engage: 'bogus' }),
    ).rejects.toThrow(/--voice-always-engage must be true or false/);
  });

  it('--voice-always-engage is updatable, and does not touch engage_mode/engage_pattern', async () => {
    const row = await create({ messaging_group_id: 'mg-group', agent_group_id: 'ag-1' }); // mention-sticky
    const updated = (await update({ id: row.id, voice_always_engage: 'true' })) as {
      voice_always_engage: number;
      engage_mode: string;
    };
    expect(updated.voice_always_engage).toBe(1);
    expect(updated.engage_mode).toBe('mention-sticky');
  });

  it('rejects a non-boolean --voice-always-engage value on update', async () => {
    const row = await create({ messaging_group_id: 'mg-dm', agent_group_id: 'ag-1' });
    await expect(update({ id: row.id, voice_always_engage: 'bogus' })).rejects.toThrow(
      /--voice-always-engage must be true or false/,
    );
  });
});
```
