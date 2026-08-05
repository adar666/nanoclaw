# Router test snippet — apply into `src/host-core.test.ts`

Add these two mocks near the file's existing top-level `vi.mock` calls
(after `vi.mock('./container-runner.js', ...)`):

```ts
const mockDeliver = vi.fn();
vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: vi.fn(() => ({ deliver: mockDeliver })),
}));

vi.mock('./voice-transcription.js', async () => {
  const actual = await vi.importActual<typeof import('./voice-transcription.js')>('./voice-transcription.js');
  return { ...actual, applyVoiceTranscription: vi.fn().mockResolvedValue(undefined) };
});
```

Then append the full `describe('router — voice-note transcription', ...)`
block from this skill's own history (see the implementation plan commit
that added it, or `git log -p --follow src/host-core.test.ts` for the
exact text) at the end of the file. Skip this step entirely if the block
is already present (`grep -q "voice-note transcription" src/host-core.test.ts`).
