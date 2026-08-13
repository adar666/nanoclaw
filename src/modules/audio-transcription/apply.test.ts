import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-audio-transcription-test';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-audio-transcription-test/groups',
  DATA_DIR: '/tmp/nanoclaw-audio-transcription-test/data',
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import Database from 'better-sqlite3';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../../db/index.js';
import {
  audioTranscriptFailedTag,
  AUDIO_TRANSCRIPT_COMPLETE_TAG,
  handleTranscribeAudioImpl,
  runTranscriptionJob,
  saveTranscript,
} from './apply.js';
import { sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';

vi.mock('../../voice-transcription.js', () => ({
  transcribeAudioFile: vi.fn(),
}));
vi.mock('../../container-runner.js', () => ({
  isContainerRunning: vi.fn(() => false),
  wakeContainer: vi.fn(() => Promise.resolve(true)),
}));

function makeGroup(id: string, folder: string): AgentGroup {
  const ag = { id, name: id, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
  createAgentGroup(ag);
  return ag;
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
  // Task 3's tests mock voice-transcription.js and container-runner.js and
  // set per-test return values on those mocks — without this, a call count
  // asserted in one test (e.g. "wakeContainer not called") can see stale
  // calls left over from an earlier test in the same file.
  vi.clearAllMocks();
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

  it('refuses a symlink inside the session dir that resolves outside it (symlink escape)', async () => {
    const ag = makeGroup('ag-symlink', 'symlink-escape');
    const session = makeSession(ag.id, 'sess-symlink');
    const inboxDir = path.join(sessionDir(ag.id, session.id), 'inbox', 'msg1');
    fs.mkdirSync(inboxDir, { recursive: true });

    // A compromised/prompt-injected agent pre-places a symlink inside its
    // own inbox pointing at an arbitrary host path, then declares that path.
    // The declared path is textually inside the session dir (isPathInside
    // on the raw string passes) but resolves outside it.
    const outsideTarget = path.join(TEST_ROOT, 'outside-secret.m4a');
    fs.writeFileSync(outsideTarget, 'attacker-controlled bytes');
    fs.symlinkSync(outsideTarget, path.join(inboxDir, 'evil.m4a'));

    const neverResolvingJob = vi.fn(() => new Promise<void>(() => {}));

    await handleTranscribeAudioImpl({ path: 'inbox/msg1/evil.m4a' }, session, neverResolvingJob);

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
    // runTranscriptionJob's post-write getSession(sessionId) needs a real row
    // to find (it's a fresh re-read of the session, not the local `session`
    // object above — see the doc comment on the implementation).
    createSession(session);
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

  it('on unexpected error in the persistence step: still delivers a failure message', async () => {
    // No makeGroup() call — saveTranscript throws for an agent group id that
    // doesn't exist in the DB, a real (not mocked) stand-in for "the
    // persistence step throws" (disk full, DB lock, etc. in production).
    const session: Session = {
      id: 'sess-job-throws',
      agent_group_id: 'ag-does-not-exist',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
    };
    fs.mkdirSync(sessionDir(session.agent_group_id, session.id), { recursive: true });

    const { transcribeAudioFile } = await import('../../voice-transcription.js');
    vi.mocked(transcribeAudioFile).mockResolvedValue({ ok: true, text: 'ok text' });

    await runTranscriptionJob(session.agent_group_id, session.id, '/tmp/does-not-matter.m4a');

    const rows = new Database(path.join(sessionDir(session.agent_group_id, session.id), 'inbound.db'))
      .prepare('SELECT content FROM messages_in ORDER BY seq DESC LIMIT 1')
      .all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content);
    expect(content.text).toBe('[AUDIO-TRANSCRIPT-FAILED: error]');
  });
});
