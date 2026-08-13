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
