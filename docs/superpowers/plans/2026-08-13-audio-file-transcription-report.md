# On-demand audio-file transcription + Hebrew RTL report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent transcribe an uploaded audio file (not a short voice note — those already auto-transcribe) on request, asynchronously, and turn the transcript into a Hebrew RTL HTML report sent back via Telegram — available to every agent group automatically.

**Architecture:** A new MCP tool (`transcribe_audio`) writes a fire-and-forget outbound system row; a new host-side delivery action resolves the file, kicks off transcription as a detached background job (never awaited inline — the handler must return in milliseconds), and on completion persists the transcript to the agent group's own durable workspace and delivers a tagged message into the same session, waking the container if it's idle. A new container skill teaches the agent to call the tool and author the RTL Hebrew HTML report.

**Tech Stack:** TypeScript (host: Node/vitest, `better-sqlite3`; container: Bun/bun:test), existing `whisper.cpp` + `ffmpeg` local transcription engine (no new binaries).

**Spec:** `docs/superpowers/specs/2026-08-13-audio-file-transcription-report-design.md`

## Global Constraints

- No second-brain integration — persistence stays inside nanoclaw-v2's own `groups/<folder>/transcripts/` (spec: "Explicitly out of scope").
- The new delivery-action handler MUST return within milliseconds — never `await` the transcription subprocess inline (spec § component 3, "Hard requirement").
- No new DB table, no job-status/polling tool — fire-and-forget only (spec § Accepted limitations).
- Reuse the existing `not-installed | timeout | error` failure taxonomy from `src/voice-transcription.ts` — don't invent a new one.
- Available to every agent group with zero per-group wiring (container skill + MCP tool ship in the shared `container/skills/` and `container/agent-runner/src/mcp-tools/` trees, same distribution as existing tools).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/voice-transcription.ts` (modify) | Add `transcribeAudioFile` + `AUDIO_FILE_TIMEOUT_MS` — same engine, generic name, long timeout. |
| `src/modules/audio-transcription/apply.ts` (create) | `saveTranscript`, tag helpers, `handleTranscribeAudio` (delivery handler), `runTranscriptionJob` (the background job). |
| `src/modules/audio-transcription/apply.test.ts` (create) | Unit tests for all four exports above. |
| `src/modules/audio-transcription/index.ts` (create) | Registers `transcribe_audio` as an unguarded delivery action. |
| `src/modules/index.ts` (modify) | One import line for the new module barrel. |
| `container/agent-runner/src/mcp-tools/transcribe-audio.ts` (create) | The `transcribe_audio` MCP tool — fire-and-forget outbound write, no polling. |
| `container/agent-runner/src/mcp-tools/transcribe-audio.test.ts` (create) | Asserts the outbound row shape and that the handler returns immediately. |
| `container/agent-runner/src/mcp-tools/transcribe-audio.instructions.md` (create) | Auto-discovered (no wiring needed — `claude-md-compose.ts` globs `*.instructions.md`), mechanical usage docs for every session. |
| `container/agent-runner/src/mcp-tools/index.ts` (modify) | One import line for the new tool file's registration side effect. |
| `container/skills/audio-report/SKILL.md` (create) | Prose skill: when/how to use the tool + condensed RTL Hebrew HTML authoring guidance + `send_file` handoff. |

---

### Task 1: Generalize the transcription timeout for full-file audio

**Files:**
- Modify: `src/voice-transcription.ts`
- Test: `src/voice-transcription.test.ts`

**Interfaces:**
- Consumes: existing `transcribeVoiceNote(oggPath: string, opts?: { whisperCli?, ffmpeg?, modelPath?, timeoutMs? }): Promise<TranscribeResult>` — already fully generic internally (no OGG-specific gating in the function body; `ffmpeg -i <input> ...` already handles any container/codec `ffmpeg` decodes).
- Produces: `AUDIO_FILE_TIMEOUT_MS: number` and `transcribeAudioFile(audioPath: string, opts?: TranscribeOpts): Promise<TranscribeResult>` — later tasks (Task 3) import both from `src/voice-transcription.js`.

Why a wrapper and not just calling `transcribeVoiceNote` directly from Task 3: `transcribeVoiceNote`'s existing 30s default timeout is sized for short voice notes; a full call recording can legitimately take several minutes to transcribe even with Metal acceleration. `transcribeAudioFile` is the same engine with a name that doesn't lie about what it's transcribing and a timeout sized for the job.

- [ ] **Step 1: Write the failing tests**

Add to `src/voice-transcription.test.ts`, inside a new `describe` block (place it after the existing `describe('transcribeVoiceNote', ...)` block, reusing that block's `FAKE_WHISPER`/`FAKE_FFMPEG`/`FAKE_MODEL`/`mockedExecFile` — either hoist those into an outer scope shared by both `describe` blocks, or duplicate the same `beforeEach`/`afterEach` setup verbatim inside the new block; duplicate it verbatim to keep the two blocks independently readable and match this file's existing style of self-contained `describe` blocks):

```typescript
describe('transcribeAudioFile', () => {
  const FAKE_DIR = '/tmp/nanoclaw-test-voice-bins-audiofile';
  const FAKE_WHISPER = path.join(FAKE_DIR, 'whisper-cli');
  const FAKE_FFMPEG = path.join(FAKE_DIR, 'ffmpeg');
  const FAKE_MODEL = path.join(FAKE_DIR, 'model.bin');

  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdirSync(FAKE_DIR, { recursive: true });
    fs.writeFileSync(FAKE_WHISPER, '');
    fs.writeFileSync(FAKE_FFMPEG, '');
    fs.writeFileSync(FAKE_MODEL, '');
  });

  afterEach(() => {
    fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  });

  function mockedExecFile() {
    return execFile as unknown as ReturnType<typeof vi.fn>;
  }

  it('transcribes a non-.ogg file (e.g. .m4a) using the same engine', async () => {
    let call = 0;
    mockedExecFile().mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
        call++;
        if (call === 1) return cb(null, { stdout: '', stderr: '' });
        cb(null, { stdout: '  שיחה עם לקוח  \n', stderr: '' });
      },
    );

    const result = await transcribeAudioFile('/tmp/call-recording.m4a', {
      whisperCli: FAKE_WHISPER,
      ffmpeg: FAKE_FFMPEG,
      modelPath: FAKE_MODEL,
    });

    expect(result).toEqual({ ok: true, text: 'שיחה עם לקוח' });
    const [ffmpegCall] = mockedExecFile().mock.calls.filter((c) => c[0] === FAKE_FFMPEG);
    expect(ffmpegCall[1]).toEqual(expect.arrayContaining(['-i', '/tmp/call-recording.m4a']));
  });

  it('defaults to a timeout far larger than the voice-note default (30s)', async () => {
    mockedExecFile().mockImplementation(
      (_cmd: string, _args: string[], opts: { timeout: number }, cb: (...a: unknown[]) => void) => {
        // Capture the timeout ffmpeg is called with and fail fast — we only
        // care about the budget passed in, not a real transcription.
        expect(opts.timeout).toBeGreaterThan(30_000);
        cb(new Error('stop here, budget already asserted'), { stdout: '', stderr: '' });
      },
    );

    await transcribeAudioFile('/tmp/call-recording.m4a', {
      whisperCli: FAKE_WHISPER,
      ffmpeg: FAKE_FFMPEG,
      modelPath: FAKE_MODEL,
    });

    expect.assertions(1); // the assertion inside mockImplementation must have run
  });

  it('an explicit timeoutMs still overrides the default', async () => {
    mockedExecFile().mockImplementation(
      (_cmd: string, _args: string[], opts: { timeout: number }, cb: (...a: unknown[]) => void) => {
        expect(opts.timeout).toBeLessThanOrEqual(5_000);
        cb(new Error('stop here'), { stdout: '', stderr: '' });
      },
    );

    await transcribeAudioFile('/tmp/x.m4a', {
      whisperCli: FAKE_WHISPER,
      ffmpeg: FAKE_FFMPEG,
      modelPath: FAKE_MODEL,
      timeoutMs: 5_000,
    });

    expect.assertions(1);
  });
});
```

Add `transcribeAudioFile` to the existing import block near the top of the test file (the one that already imports `transcribeVoiceNote`, `VOICE_TRANSCRIPT_TAG`, etc.).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/voice-transcription.test.ts`
Expected: FAIL — `transcribeAudioFile is not a function` / import error, since it doesn't exist yet.

- [ ] **Step 3: Implement**

Add to `src/voice-transcription.ts`, directly after the `transcribeVoiceNote` function (after its closing brace, before `applyVoiceTranscription`):

```typescript
/**
 * Default timeout for on-demand full-audio-file transcription. Much larger
 * than transcribeVoiceNote's 30s default — a full call recording can
 * legitimately take several minutes to transcribe even with Metal
 * acceleration. 20 minutes covers the vast majority of realistic recording
 * lengths at whisper.cpp turbo's typical multiple-of-realtime throughput.
 */
export const AUDIO_FILE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Same engine as transcribeVoiceNote (ffmpeg -> 16kHz mono WAV -> whisper-cli
 * forced to Hebrew) — the conversion step is already format-agnostic, so
 * this works for any audio ffmpeg can decode, not just OGG voice notes. A
 * distinct exported name (rather than callers reaching for
 * transcribeVoiceNote directly) so call sites don't read "VoiceNote" for a
 * 40-minute uploaded call recording. Default timeout is AUDIO_FILE_TIMEOUT_MS,
 * not transcribeVoiceNote's 30s — still overridable via opts.timeoutMs.
 */
export function transcribeAudioFile(audioPath: string, opts: TranscribeOpts = {}): Promise<TranscribeResult> {
  return transcribeVoiceNote(audioPath, { timeoutMs: AUDIO_FILE_TIMEOUT_MS, ...opts });
}
```

Note: `{ timeoutMs: AUDIO_FILE_TIMEOUT_MS, ...opts }` — spreading `opts` *after* the default means an explicit `opts.timeoutMs` (Test 3 above) overrides the 20-minute default, while an absent one (Test 2) falls through to it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/voice-transcription.test.ts`
Expected: PASS (all `transcribeVoiceNote` tests unaffected, all three new `transcribeAudioFile` tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/voice-transcription.ts src/voice-transcription.test.ts
git commit -m "feat(voice-transcription): add transcribeAudioFile for full-length uploaded audio

Same engine as transcribeVoiceNote (already format-agnostic) with a
20-minute default timeout instead of 30s — long call recordings need
it. Distinct exported name so on-demand call sites don't read
'VoiceNote' for an uploaded file.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011YXpEFNA8xDVk52pJ4goG7"
```

---

### Task 2: Transcript persistence

**Files:**
- Create: `src/modules/audio-transcription/apply.ts` (this task writes only the persistence half; Task 3 adds the rest to the same file)
- Create: `src/modules/audio-transcription/apply.test.ts` (this task writes only the persistence tests; Task 3 appends to the same file)

**Interfaces:**
- Consumes: `GROUPS_DIR` from `src/config.js`; `getAgentGroup(id): AgentGroup | undefined` from `src/db/agent-groups.js` (`AgentGroup.folder: string`).
- Produces: `saveTranscript(agentGroupId: string, sourceFilename: string, transcriptText: string): string` (returns the absolute path written), `AUDIO_TRANSCRIPT_COMPLETE_TAG: string`, `audioTranscriptFailedTag(reason: 'not-installed' | 'timeout' | 'error'): string` — Task 3 imports all three from this same file.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/audio-transcription/apply.test.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-audio-transcription-test';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-audio-transcription-test/groups',
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { audioTranscriptFailedTag, AUDIO_TRANSCRIPT_COMPLETE_TAG, saveTranscript } from './apply.js';
import type { AgentGroup } from '../../types.js';

function makeGroup(id: string, folder: string): AgentGroup {
  const ag = { id, name: id, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
  createAgentGroup(ag);
  return ag;
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('saveTranscript', () => {
  it('writes the transcript under groups/<folder>/transcripts/, creating the dir', () => {
    const ag = makeGroup('ag-household', 'household');

    const written = saveTranscript(ag.id, 'call-recording.m4a', 'שלום, זו הקלטה של שיחה.');

    expect(fs.existsSync(written)).toBe(true);
    expect(path.dirname(written)).toBe(path.join(TEST_ROOT, 'groups', 'household', 'transcripts'));
    const body = fs.readFileSync(written, 'utf-8');
    expect(body).toContain('שלום, זו הקלטה של שיחה.');
    expect(body).toContain('call-recording.m4a');
  });

  it('preserves Hebrew characters in the filename slug, strips the extension', () => {
    const ag = makeGroup('ag-household2', 'household2');

    const written = saveTranscript(ag.id, 'Call _ תמר רוזמן דרדיק __260813.m4a', 'תוכן');

    const filename = path.basename(written);
    expect(filename).toContain('תמר');
    expect(filename).toContain('רוזמן');
    expect(filename.endsWith('.md')).toBe(true);
    expect(filename).not.toContain('.m4a');
  });

  it('two calls for the same group do not collide (distinct timestamps in the name)', () => {
    const ag = makeGroup('ag-household3', 'household3');

    const first = saveTranscript(ag.id, 'a.m4a', 'one');
    const second = saveTranscript(ag.id, 'a.m4a', 'two');

    expect(first).not.toBe(second);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
  });

  it('throws a clear error for an unknown agent group id', () => {
    expect(() => saveTranscript('ag-does-not-exist', 'a.m4a', 'text')).toThrow(/ag-does-not-exist/);
  });
});

describe('audioTranscriptFailedTag', () => {
  it('renders each known failure reason', () => {
    expect(audioTranscriptFailedTag('not-installed')).toBe('[AUDIO-TRANSCRIPT-FAILED: not-installed]');
    expect(audioTranscriptFailedTag('timeout')).toBe('[AUDIO-TRANSCRIPT-FAILED: timeout]');
    expect(audioTranscriptFailedTag('error')).toBe('[AUDIO-TRANSCRIPT-FAILED: error]');
  });
});

describe('AUDIO_TRANSCRIPT_COMPLETE_TAG', () => {
  it('is the expected literal tag', () => {
    expect(AUDIO_TRANSCRIPT_COMPLETE_TAG).toBe('[AUDIO-TRANSCRIPT-COMPLETE]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/modules/audio-transcription/apply.test.ts`
Expected: FAIL — module `./apply.js` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/modules/audio-transcription/apply.ts`:

```typescript
/**
 * On-demand audio-file transcription — the agent-invoked counterpart to
 * src/voice-transcription.ts's automatic short-voice-note pipeline. Handles
 * uploaded audio FILES (raw.audio with a file_name), which that pipeline
 * explicitly leaves untouched. See
 * docs/superpowers/specs/2026-08-13-audio-file-transcription-report-design.md.
 *
 * This file has two halves:
 *   - saveTranscript / tag helpers (this task) — pure persistence, no I/O
 *     beyond the filesystem.
 *   - handleTranscribeAudio / runTranscriptionJob (added next) — the
 *     delivery-action handler and the background job it fires without
 *     awaiting.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';

export const AUDIO_TRANSCRIPT_COMPLETE_TAG = '[AUDIO-TRANSCRIPT-COMPLETE]';

export function audioTranscriptFailedTag(reason: 'not-installed' | 'timeout' | 'error'): string {
  return `[AUDIO-TRANSCRIPT-FAILED: ${reason}]`;
}

/** Same charset policy as media-ingestion.ts's sanitizeFilenameFragment
 *  (control chars stripped, path separators stripped) but keeps Hebrew —
 *  source filenames are routinely Hebrew (e.g. a forwarded call recording's
 *  auto-generated Telegram name). Duplicated rather than imported: that
 *  helper lives in a module this one deliberately doesn't depend on (see
 *  spec § "Explicitly out of scope" — no second-brain/media-ingestion
 *  coupling). */
function slugify(sourceFilename: string): string {
  const base = sourceFilename.replace(/\.[^./]+$/, '');
  const slug = base
    .replace(/[^a-zA-Z0-9֐-׿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'audio';
}

/**
 * Persists a transcript into the agent group's own durable workspace —
 * `groups/<folder>/transcripts/<timestamp>-<slug>.md` — so it's available
 * for future reference independent of whether a report was ever requested
 * from it, and survives session/container churn (the session inbox has no
 * host-side GC but is not a *guaranteed* durable store either — see spec
 * § "Current state").  Creates the transcripts/ directory on first write.
 * Returns the absolute path written.
 */
export function saveTranscript(agentGroupId: string, sourceFilename: string, transcriptText: string): string {
  const group = getAgentGroup(agentGroupId);
  if (!group) {
    throw new Error(`saveTranscript: unknown agent group ${agentGroupId}`);
  }

  const transcriptsDir = path.join(GROUPS_DIR, group.folder, 'transcripts');
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const slug = slugify(sourceFilename);
  const filePath = path.join(transcriptsDir, `${timestamp}-${slug}.md`);

  const body = [
    `# Transcript: ${sourceFilename}`,
    '',
    `- Date: ${now.toISOString()}`,
    `- Source: ${sourceFilename}`,
    '',
    '---',
    '',
    transcriptText,
    '',
  ].join('\n');

  fs.writeFileSync(filePath, body, 'utf-8');
  return filePath;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/modules/audio-transcription/apply.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/audio-transcription/apply.ts src/modules/audio-transcription/apply.test.ts
git commit -m "feat(audio-transcription): transcript persistence to groups/<folder>/transcripts/

Pure filesystem helper — saveTranscript() + the [AUDIO-TRANSCRIPT-...]
tag vocabulary. No delivery-action wiring yet (next task).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011YXpEFNA8xDVk52pJ4goG7"
```

---

### Task 3: Delivery-action handler + background job + registration

**Files:**
- Modify: `src/modules/audio-transcription/apply.ts` (append)
- Modify: `src/modules/audio-transcription/apply.test.ts` (append)
- Create: `src/modules/audio-transcription/index.ts`
- Modify: `src/modules/index.ts`

**Interfaces:**
- Consumes: `transcribeAudioFile` from `../../voice-transcription.js` (Task 1); `saveTranscript`, `AUDIO_TRANSCRIPT_COMPLETE_TAG`, `audioTranscriptFailedTag` from this same file (Task 2); `sessionDir`, `writeSessionMessage` from `../../session-manager.js`; `isPathInside` from `../../inbox-safety.js`; `isContainerRunning`, `wakeContainer` from `../../container-runner.js`; `getSession` from `../../db/sessions.js`; `registerDeliveryAction` and `DeliveryActionHandler` type from `../../delivery.js`; `unguarded` from `../../guard/index.js`; `Session` type from `../../types.js`.
- Produces: `handleTranscribeAudio: DeliveryActionHandler` and `runTranscriptionJob(agentGroupId: string, sessionId: string, hostAudioPath: string, note?: string): Promise<void>` — registered under the action name `'transcribe_audio'`. Task 4's MCP tool must write an outbound row with `content: { action: 'transcribe_audio', path: <relative-inbox-path>, note?: <string> }` to trigger this handler.

**Path safety note**: `content.path` originates from the agent (via the MCP tool in Task 4) and must never be trusted to stay inside the session directory — resolve it and check with `isPathInside` before touching the filesystem, exactly like `ensureContainedInboxDir` does for inbound attachment writes (`src/inbox-safety.ts`).

**Fire-and-forget correctness**: the handler must return without waiting for `runTranscriptionJob` to finish. Task's test proves this by injecting a `runJob` spy that returns a promise that **never resolves** — if the handler mistakenly `await`s it, the test hangs and fails via vitest's default test timeout, which is a hard, non-flaky proof (no timing races).

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/audio-transcription/apply.test.ts` (add these imports to the existing import block at the top, and these new `describe` blocks at the end of the file):

```typescript
// Add to the existing import block:
import Database from 'better-sqlite3';
import { handleTranscribeAudioImpl, runTranscriptionJob } from './apply.js';
import { sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

vi.mock('../../voice-transcription.js', () => ({
  transcribeAudioFile: vi.fn(),
}));
vi.mock('../../container-runner.js', () => ({
  isContainerRunning: vi.fn(() => false),
  wakeContainer: vi.fn(() => Promise.resolve(true)),
}));
```

```typescript
describe('handleTranscribeAudioImpl', () => {
  function makeSession(agentGroupId: string, id: string): Session {
    return {
      id,
      agent_group_id: agentGroupId,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
    };
  }

  it('resolves without waiting for the background job to finish (fire-and-forget)', async () => {
    const ag = makeGroup('ag-faf', 'fire-and-forget');
    const session = makeSession(ag.id, 'sess-faf');
    const inboxDir = path.join(sessionDir(ag.id, session.id), 'inbox', 'msg1');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'call.m4a'), 'fake audio bytes');

    const neverResolvingJob = vi.fn(() => new Promise<void>(() => {}));

    // If handleTranscribeAudioImpl awaited runJob directly, this line would
    // hang and the test would fail on timeout — that's the proof, not a race.
    await handleTranscribeAudioImpl({ path: 'inbox/msg1/call.m4a' }, session, neverResolvingJob);

    expect(neverResolvingJob).toHaveBeenCalledWith(ag.id, session.id, path.join(inboxDir, 'call.m4a'), undefined);
  });

  it('passes note through when provided', async () => {
    const ag = makeGroup('ag-note', 'has-note');
    const session = makeSession(ag.id, 'sess-note');
    const inboxDir = path.join(sessionDir(ag.id, session.id), 'inbox', 'msg1');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'call.m4a'), 'fake audio bytes');

    const neverResolvingJob = vi.fn(() => new Promise<void>(() => {}));

    await handleTranscribeAudioImpl(
      { path: 'inbox/msg1/call.m4a', note: 'client call, urgent' },
      session,
      neverResolvingJob,
    );

    expect(neverResolvingJob).toHaveBeenCalledWith(
      ag.id,
      session.id,
      path.join(inboxDir, 'call.m4a'),
      'client call, urgent',
    );
  });

  it('refuses a path that escapes the session directory (traversal)', async () => {
    const ag = makeGroup('ag-escape', 'escape');
    const session = makeSession(ag.id, 'sess-escape');
    const neverResolvingJob = vi.fn(() => new Promise<void>(() => {}));

    await handleTranscribeAudioImpl({ path: '../../../etc/passwd' }, session, neverResolvingJob);

    expect(neverResolvingJob).not.toHaveBeenCalled();
  });

  it('no-ops when the referenced file does not exist', async () => {
    const ag = makeGroup('ag-missing', 'missing-file');
    const session = makeSession(ag.id, 'sess-missing');
    const neverResolvingJob = vi.fn(() => new Promise<void>(() => {}));

    await handleTranscribeAudioImpl({ path: 'inbox/msg1/nope.m4a' }, session, neverResolvingJob);

    expect(neverResolvingJob).not.toHaveBeenCalled();
  });

  it('no-ops when content.path is missing', async () => {
    const ag = makeGroup('ag-nopath', 'no-path');
    const session = makeSession(ag.id, 'sess-nopath');
    const neverResolvingJob = vi.fn(() => new Promise<void>(() => {}));

    await handleTranscribeAudioImpl({}, session, neverResolvingJob);

    expect(neverResolvingJob).not.toHaveBeenCalled();
  });
});

describe('runTranscriptionJob', () => {
  it('on success: saves the transcript and writes a tagged completion message', async () => {
    const ag = makeGroup('ag-job-ok', 'job-ok');
    const session: Session = {
      id: 'sess-job-ok',
      agent_group_id: ag.id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    // writeSessionMessage needs the session folder to exist first.
    fs.mkdirSync(sessionDir(ag.id, session.id), { recursive: true });

    const { transcribeAudioFile } = await import('../../voice-transcription.js');
    vi.mocked(transcribeAudioFile).mockResolvedValue({ ok: true, text: 'שלום, זו שיחה' });
    const { isContainerRunning, wakeContainer } = await import('../../container-runner.js');
    vi.mocked(isContainerRunning).mockReturnValue(false);

    await runTranscriptionJob(ag.id, session.id, '/tmp/does-not-matter.m4a');

    const transcriptsDir = path.join(TEST_ROOT, 'groups', 'job-ok', 'transcripts');
    const files = fs.readdirSync(transcriptsDir);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(transcriptsDir, files[0]), 'utf-8')).toContain('שלום, זו שיחה');

    const rows = new Database(path.join(sessionDir(ag.id, session.id), 'inbound.db'))
      .prepare('SELECT content FROM messages_in ORDER BY seq DESC LIMIT 1')
      .all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content);
    expect(content.text).toContain('[AUDIO-TRANSCRIPT-COMPLETE]');
    expect(content.text).toContain('שלום, זו שיחה');

    expect(wakeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }));
  });

  it('on failure: writes the failed tag, does not create a transcript file', async () => {
    const ag = makeGroup('ag-job-fail', 'job-fail');
    const session: Session = {
      id: 'sess-job-fail',
      agent_group_id: ag.id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    fs.mkdirSync(sessionDir(ag.id, session.id), { recursive: true });

    const { transcribeAudioFile } = await import('../../voice-transcription.js');
    vi.mocked(transcribeAudioFile).mockResolvedValue({ ok: false, reason: 'timeout' });

    await runTranscriptionJob(ag.id, session.id, '/tmp/does-not-matter.m4a');

    const transcriptsDir = path.join(TEST_ROOT, 'groups', 'job-fail', 'transcripts');
    expect(fs.existsSync(transcriptsDir)).toBe(false);

    const rows = new Database(path.join(sessionDir(ag.id, session.id), 'inbound.db'))
      .prepare('SELECT content FROM messages_in ORDER BY seq DESC LIMIT 1')
      .all() as Array<{ content: string }>;
    const content = JSON.parse(rows[0].content);
    expect(content.text).toBe('[AUDIO-TRANSCRIPT-FAILED: timeout]');
  });

  it('does not wake the container if it is already running', async () => {
    const ag = makeGroup('ag-job-live', 'job-live');
    const session: Session = {
      id: 'sess-job-live',
      agent_group_id: ag.id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    fs.mkdirSync(sessionDir(ag.id, session.id), { recursive: true });

    const { transcribeAudioFile } = await import('../../voice-transcription.js');
    vi.mocked(transcribeAudioFile).mockResolvedValue({ ok: true, text: 'x' });
    const { isContainerRunning, wakeContainer } = await import('../../container-runner.js');
    vi.mocked(isContainerRunning).mockReturnValue(true);

    await runTranscriptionJob(ag.id, session.id, '/tmp/x.m4a');

    expect(wakeContainer).not.toHaveBeenCalled();
  });
});
```

Note: `writeSessionMessage` writes into a real `inbound.db` under the mocked `DATA_DIR`/session dir — the test above doesn't mock `../../session-manager.js` at all (unlike `voice-transcription.js` and `container-runner.js`, which ARE mocked), so it needs `DATA_DIR` mocked too (session-manager.js reads it from config.js). Add `DATA_DIR` to the existing `config.js` mock at the top of the file:

```typescript
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-audio-transcription-test/groups',
  DATA_DIR: '/tmp/nanoclaw-audio-transcription-test/data',
}));
```

(This replaces the `config.js` mock block Task 2 wrote — same file, one extra key.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/modules/audio-transcription/apply.test.ts`
Expected: FAIL — `handleTranscribeAudioImpl`/`runTranscriptionJob` don't exist yet.

- [ ] **Step 3: Implement**

Append to `src/modules/audio-transcription/apply.ts` (add these imports to the top of the file, alongside the existing ones):

```typescript
import type Database from 'better-sqlite3';

import { isContainerRunning, wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import type { DeliveryActionHandler } from '../../delivery.js';
import { isPathInside } from '../../inbox-safety.js';
import { log } from '../../log.js';
import { sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { transcribeAudioFile } from '../../voice-transcription.js';
```

Then append after `saveTranscript`:

```typescript
type RunTranscriptionJob = (
  agentGroupId: string,
  sessionId: string,
  hostAudioPath: string,
  note?: string,
) => Promise<void>;

/**
 * Delivery-action handler for the `transcribe_audio` system action (written
 * by the container's `transcribe_audio` MCP tool). Resolves the
 * agent-declared relative path against the session dir, refuses anything
 * that escapes it, and — if the file exists — fires the background job
 * WITHOUT awaiting it (`void runJob(...)`). This is a hard requirement: the
 * outbound-delivery poll loop that calls this handler must never be blocked
 * by a multi-minute whisper-cli run. `runJob` is injectable for tests
 * (default: the real `runTranscriptionJob`), same pattern as
 * voice-transcription.ts's `applyVoiceTranscription`.
 */
export const handleTranscribeAudio: DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
) => handleTranscribeAudioImpl(content, session, runTranscriptionJob);

export async function handleTranscribeAudioImpl(
  content: Record<string, unknown>,
  session: Session,
  runJob: RunTranscriptionJob,
): Promise<void> {
  const relPath = typeof content.path === 'string' ? content.path : undefined;
  if (!relPath) {
    log.warn('transcribe_audio: missing path', { sessionId: session.id });
    return;
  }

  const sessDir = sessionDir(session.agent_group_id, session.id);
  const hostPath = path.resolve(sessDir, relPath);
  if (!isPathInside(sessDir, hostPath)) {
    log.warn('transcribe_audio: path escapes session dir, refusing', { sessionId: session.id, relPath });
    return;
  }
  if (!fs.existsSync(hostPath)) {
    log.warn('transcribe_audio: file not found', { sessionId: session.id, hostPath });
    return;
  }

  const note = typeof content.note === 'string' ? content.note : undefined;
  void runJob(session.agent_group_id, session.id, hostPath, note);
}

/**
 * The background job: transcribe, persist, deliver a tagged completion
 * message into the same session, wake the container if it's idle. Never
 * called awaited from the delivery-action handler (see above) — this is
 * where the actual multi-minute wait lives, fully decoupled from the
 * outbound-delivery poll loop.
 */
export async function runTranscriptionJob(
  agentGroupId: string,
  sessionId: string,
  hostAudioPath: string,
  _note?: string,
): Promise<void> {
  const result = await transcribeAudioFile(hostAudioPath);

  let text: string;
  if (result.ok) {
    const transcriptPath = saveTranscript(agentGroupId, path.basename(hostAudioPath), result.text);
    text = `${AUDIO_TRANSCRIPT_COMPLETE_TAG}\n${result.text}\n\n(נשמר גם ב-transcripts/${path.basename(transcriptPath)})`;
  } else {
    text = audioTranscriptFailedTag(result.reason);
  }

  writeSessionMessage(agentGroupId, sessionId, {
    id: `audio-transcript-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat-sdk',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({ text }),
  });

  if (!isContainerRunning(sessionId)) {
    const fresh = getSession(sessionId);
    if (fresh) {
      await wakeContainer(fresh);
    }
  }
}
```

Why two functions: `handleTranscribeAudio` (the exported, registered value) is a plain 3-arg arrow function that closes over the real `runTranscriptionJob` and satisfies `DeliveryActionHandler` exactly — this is what `index.ts` (below) registers. `handleTranscribeAudioImpl` is the separate, directly-testable function with the injectable `runJob` — Step 1's tests import and call `handleTranscribeAudioImpl` (not `handleTranscribeAudio`) for exactly this reason, so no test changes are needed here.

Create `src/modules/audio-transcription/index.ts`:

```typescript
/**
 * On-demand audio-file transcription module.
 *
 * Registers `transcribe_audio` as an unguarded delivery action — it only
 * ever reads a file the agent's own session already received (already
 * inside the container's own sandbox) and runs a local subprocess
 * (ffmpeg/whisper-cli); there is no privileged host mutation to hold for
 * admin approval, unlike self-mod's install_packages/add_mcp_server.
 *
 * Without this module: the MCP tool in the container still writes the
 * outbound system message, but delivery logs "Unknown system action" and
 * drops it — same failure mode as any other unregistered action.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { handleTranscribeAudio } from './apply.js';

registerDeliveryAction(
  'transcribe_audio',
  handleTranscribeAudio,
  unguarded(
    'reads an already-received attachment inside the caller\'s own session sandbox and runs a local ' +
      'subprocess (ffmpeg/whisper-cli) — no privileged host mutation, nothing to hold for approval',
  ),
);
```

Modify `src/modules/index.ts` — add one import line at the end of the existing import block:

```typescript
import './self-mod/index.js';
import './recorder/index.js';
import './audio-transcription/index.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/modules/audio-transcription/apply.test.ts`
Expected: PASS (all tests, Task 2's original 6 plus Task 3's 8 new ones).

Then run the full host suite to confirm the new module barrel import doesn't break anything (especially the guard conformance test, which imports `../modules/index.js` as a production barrel):

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit -p .`
Expected: no errors — this is where `handleTranscribeAudio`'s assignability to `DeliveryActionHandler` gets verified for real.

- [ ] **Step 6: Commit**

```bash
git add src/modules/audio-transcription/apply.ts src/modules/audio-transcription/apply.test.ts \
        src/modules/audio-transcription/index.ts src/modules/index.ts
git commit -m "feat(audio-transcription): transcribe_audio delivery action, fire-and-forget

Registers an unguarded delivery action that resolves the agent's
declared inbox path (refusing traversal), then fires the actual
transcription as a detached background job — never awaited inline,
proven by a test that would hang otherwise. On completion, persists
the transcript and delivers a [AUDIO-TRANSCRIPT-COMPLETE] /
[AUDIO-TRANSCRIPT-FAILED: reason] message into the same session,
waking the container if it's idle.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011YXpEFNA8xDVk52pJ4goG7"
```

---

### Task 4: `transcribe_audio` MCP tool (container)

**Files:**
- Create: `container/agent-runner/src/mcp-tools/transcribe-audio.ts`
- Create: `container/agent-runner/src/mcp-tools/transcribe-audio.test.ts`
- Create: `container/agent-runner/src/mcp-tools/transcribe-audio.instructions.md`
- Modify: `container/agent-runner/src/mcp-tools/index.ts`

**Interfaces:**
- Consumes: `writeMessageOut` from `../db/messages-out.js` (writes an outbound row — same helper `send_file` uses, not `ncl.ts`'s raw mechanism); `McpToolDefinition` type and `registerTools` from `./types.js` / `./server.js`.
- Produces: the MCP tool `transcribe_audio`, called by the agent with `{ path: string, note?: string }`. Its outbound row's `content` is `{ action: 'transcribe_audio', path, note? }`, `kind: 'system'` — this is exactly the shape Task 3's `handleTranscribeAudioImpl` reads via `content.path` / `content.note`.

- [ ] **Step 1: Write the failing test**

Create `container/agent-runner/src/mcp-tools/transcribe-audio.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getOutboundDb } from '../db/connection.js';
import { transcribeAudio } from './transcribe-audio.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('transcribe_audio MCP tool', () => {
  it('writes a system row with the transcribe_audio action and returns immediately', async () => {
    const result = await transcribeAudio.handler({ path: 'inbox/msg1/call.m4a' });

    expect(result.isError).toBeFalsy();
    const rows = getOutboundDb()
      .prepare("SELECT kind, content FROM messages_out WHERE kind = 'system' ORDER BY seq DESC LIMIT 1")
      .all() as Array<{ kind: string; content: string }>;
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content);
    expect(content.action).toBe('transcribe_audio');
    expect(content.path).toBe('inbox/msg1/call.m4a');
    expect(content.note).toBeUndefined();
  });

  it('passes note through when given', async () => {
    await transcribeAudio.handler({ path: 'inbox/msg2/call.m4a', note: 'client call' });

    const rows = getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq DESC LIMIT 1")
      .all() as Array<{ content: string }>;
    const content = JSON.parse(rows[0].content);
    expect(content.note).toBe('client call');
  });

  it('rejects a call with no path', async () => {
    const result = await transcribeAudio.handler({});

    expect(result.isError).toBe(true);
  });

  it('tool metadata declares path as required', () => {
    expect(transcribeAudio.tool.name).toBe('transcribe_audio');
    expect(transcribeAudio.tool.inputSchema).toMatchObject({
      required: ['path'],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `container/agent-runner/`): `bun test src/mcp-tools/transcribe-audio.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

Create `container/agent-runner/src/mcp-tools/transcribe-audio.ts`:

```typescript
/**
 * transcribe_audio — on-demand transcription of an uploaded audio FILE
 * (not a short voice note; those already auto-transcribe before the agent
 * ever sees them). Fire-and-forget: writes an outbound system row and
 * returns immediately. The host transcribes in the background and delivers
 * the result as a fresh inbound message tagged [AUDIO-TRANSCRIPT-COMPLETE]
 * or [AUDIO-TRANSCRIPT-FAILED: reason] — no polling, just continue and
 * react when it shows up. See transcribe-audio.instructions.md and the
 * audio-report container skill.
 */
import { writeMessageOut } from '../db/messages-out.js';
import type { McpToolDefinition } from './types.js';
import { registerTools } from './server.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function generateId(): string {
  return `audio-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const transcribeAudio: McpToolDefinition = {
  tool: {
    name: 'transcribe_audio',
    description:
      'Start transcribing an uploaded audio file in the background (NOT for short voice notes — ' +
      'those transcribe automatically already). Returns immediately; the result arrives later as a ' +
      'fresh message tagged [AUDIO-TRANSCRIPT-COMPLETE] or [AUDIO-TRANSCRIPT-FAILED: reason].',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative inbox path of the audio file, exactly as shown in the [audio: ...] line.',
        },
        note: {
          type: 'string',
          description: 'Optional context to carry through (not currently surfaced back, reserved for future use).',
        },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string | undefined;
    if (!filePath) return err('path is required');

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'system',
      content: JSON.stringify({
        action: 'transcribe_audio',
        path: filePath,
        note: args.note as string | undefined,
      }),
    });

    return ok('Transcription started — you will get a message tagged [AUDIO-TRANSCRIPT-COMPLETE] when it is ready.');
  },
};

registerTools([transcribeAudio]);
```

Note: `writeMessageOut`'s `WriteMessageOut` interface (Task 3's research) requires `id`, `kind`, `content` — `platform_id`/`channel_type`/`thread_id`/`in_reply_to` are all optional and correctly omitted here (this message isn't addressed anywhere; it's consumed by the host's system-action dispatch, not delivered to a channel).

Create `container/agent-runner/src/mcp-tools/transcribe-audio.instructions.md`:

```markdown
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
```

Modify `container/agent-runner/src/mcp-tools/index.ts` — add one import:

```typescript
import './core.js';
import './interactive.js';
import './agents.js';
import './self-mod.js';
import './recorder.js';
import './transcribe-audio.js';
import { startMcpServer } from './server.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `container/agent-runner/`): `bun test src/mcp-tools/transcribe-audio.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Container typecheck**

Run: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/src/mcp-tools/transcribe-audio.ts \
        container/agent-runner/src/mcp-tools/transcribe-audio.test.ts \
        container/agent-runner/src/mcp-tools/transcribe-audio.instructions.md \
        container/agent-runner/src/mcp-tools/index.ts
git commit -m "feat(agent-runner): transcribe_audio MCP tool

Fire-and-forget outbound write via the shared writeMessageOut helper
(same path send_file uses) — no polling, no blocking. Paired
instructions.md is auto-discovered by claude-md-compose.ts's
*.instructions.md scan, no separate wiring needed.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011YXpEFNA8xDVk52pJ4goG7"
```

---

### Task 5: `audio-report` container skill

**Files:**
- Create: `container/skills/audio-report/SKILL.md`

**Interfaces:**
- Consumes: `transcribe_audio` (Task 4), `send_file` (already exists, `container/agent-runner/src/mcp-tools/core.ts`).
- Produces: nothing other code depends on — this is a leaf, prose-only skill. No automated test (matches this repo's convention: `self-customize`/`agent-browser`/etc. are instructional-prose skills with no test file of their own — their *effects*, like MCP tool wiring, are what get tested, which Tasks 3-4 already cover).

- [ ] **Step 1: Write the skill**

Create `container/skills/audio-report/SKILL.md`:

```markdown
---
name: audio-report
description: Turn an uploaded audio file into a transcript and an organized Hebrew RTL HTML report, sent back as a file. Use when the user sends an audio file (not a short voice note) and asks you to transcribe/summarize/report on it.
---

# Audio file → Hebrew RTL report

## When to use this

The user sends an audio file — a call recording, a meeting, a forwarded
voice memo saved as a document — and asks something like "תפענח את זה",
"תמלל", "תסכם", or attaches it with any instruction to process it. This is
**not** for short voice notes sent directly as Telegram voice messages —
those already transcribe automatically and arrive in your context tagged
`[VOICE-TRANSCRIPT]`; you don't need this skill or the tool for those, the
text is already there. This skill is for the `[audio: name — saved to
/workspace/inbox/...]` case — an uploaded file, not auto-transcribed.

## Workflow

1. **Start transcription.** Call `mcp__nanoclaw__transcribe_audio({ path })`
   with the exact relative path from the `[audio: ...]` line. It returns
   immediately — you are not blocked. Reply to the user that you've started
   ("מתמלל את הקובץ, אעדכן כשמוכן") or just continue with whatever else is
   in the conversation; either is fine.
2. **Wait for the result.** Minutes later, a message tagged
   `[AUDIO-TRANSCRIPT-COMPLETE]` (with the full transcript text) or
   `[AUDIO-TRANSCRIPT-FAILED: <reason>]` arrives as a normal new message —
   see `transcribe-audio.instructions.md` for the exact contract. If it
   failed, explain the failure to the user in Hebrew (`not-installed` =
   התמלול לא זמין כרגע במערכת; `timeout` = ההקלטה ארוכה מדי / לקח יותר מדי
   זמן; `error` = תקלה כללית) rather than silently dropping it.
3. **Author the report.** Once you have the transcript, write a single
   self-contained HTML file — see the design guidance below. This is your
   own summarization/organization work (headings, key points, structure) —
   the tool only gave you raw text.
4. **Send it back.** `send_file({ to: <the destination this conversation is
   in>, path: <your html file>, text: 'הנה הסיכום' })`.

The transcript itself is already saved for you (see the
`transcribe-audio.instructions.md` note) — no need to save it again.

## Hebrew RTL HTML — design guidance

A condensed, portable version of the full `rtl-hebrew-docs` /
`ui-ux-pro-max` guidance (not loadable directly inside this container) —
enough to produce something that reads as considered, not a raw text dump.

**Structure (non-negotiable for correct Hebrew rendering):**

```html
<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>סיכום הקלטה</title>
  <style>
    body {
      font-family: "Segoe UI", "Arial Hebrew", "Noto Sans Hebrew", sans-serif;
      line-height: 1.8;             /* Hebrew glyphs need more vertical room than Latin */
      direction: rtl;
      text-align: right;
    }
    /* Numbers, dates, and any embedded Latin text should stay LTR inside
       an RTL page — wrap them: <span dir="ltr">14:30</span> — otherwise
       the browser can visually reorder digits within a number. */
  </style>
</head>
<body>
  ...
</body>
</html>
```

**Content shape:**
- A clear title and a one-line summary at the top — the reader should
  understand the gist in 5 seconds without scrolling.
- Sectioned body (`<h2>`/`<h3>`), not one long paragraph — group by topic
  or by chronological phase of the conversation, whichever the transcript
  actually supports.
- A short bullet list of key points / action items near the top if the
  content has any (a call almost always does) — don't bury decisions in
  prose.
- Restrained color use — one accent color for headings/highlights, neutral
  grays for body text and structure (borders, section backgrounds). Avoid
  a wall of identical black paragraphs; also avoid decorating for its own
  sake.
- Wrap any number, date, or Latin-script term in `<span dir="ltr">...</span>`
  so it doesn't visually scramble inside the RTL flow.

Keep the file self-contained (inline `<style>`, no external requests) —
it's delivered as a single file over Telegram, not hosted anywhere.
```

- [ ] **Step 2: Manual verification**

There is no automated test for this file (prose skill, per repo convention
— see `docs/skill-guidelines.md` §Testing: instructional skills are
verified by exercising their *effects*, already covered by Tasks 3-4's
tests). Verify manually once the full chain is wired (after Task 4):
1. Send a real audio file to a test agent group via Telegram.
2. Ask the agent to transcribe and report on it.
3. Confirm: the acknowledgement arrives promptly, the
   `[AUDIO-TRANSCRIPT-COMPLETE]` message arrives later, a transcript file
   appears under `groups/<folder>/transcripts/`, and an HTML file arrives
   back via Telegram that renders correctly RTL (open it in a browser —
   text should be right-aligned, numbers/dates should read left-to-right
   within themselves).

- [ ] **Step 3: Commit**

```bash
git add container/skills/audio-report/SKILL.md
git commit -m "feat(skills): audio-report container skill

Teaches every agent group how to use transcribe_audio and how to
author a Hebrew RTL HTML report from the result — condensed,
portable subset of rtl-hebrew-docs/ui-ux-pro-max guidance (those
marketplace skills aren't loadable inside the container's own skill
set). Available to every agent group automatically — no per-group
wiring, same distribution as agent-browser/self-customize/etc.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011YXpEFNA8xDVk52pJ4goG7"
```

---

## Final verification (after all 5 tasks)

- [ ] `pnpm test` (host) — full suite green.
- [ ] `pnpm exec tsc --noEmit -p .` (host) — clean.
- [ ] `cd container/agent-runner && bun test` — full suite green.
- [ ] `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` — clean.
- [ ] `pnpm run build` — host compiles.
- [ ] Manual end-to-end run per Task 5 Step 2, on a real agent group, with a
      real audio file over 20MB (exercises the local Bot API path already
      set up on this install) — confirms the whole chain, not just unit
      boundaries.
