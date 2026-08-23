import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { makeRunId, REPORTS_DIR, writeReport, type Report } from './reporter.js';

const writtenDirs: string[] = [];

/** Every test writes under a `test-`-prefixed runId — only those directories are cleaned up, real reports untouched. */
function testRunId(suffix: string): string {
  const id = `test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writtenDirs.push(path.join(REPORTS_DIR, id));
  return id;
}

afterEach(() => {
  for (const dir of writtenDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('makeRunId', () => {
  it('produces an ISO-8601 timestamp with every colon stripped', () => {
    const date = new Date('2026-08-23T12:34:56.789Z');
    expect(makeRunId(date)).toBe('2026-08-23T123456.789Z');
    expect(makeRunId(date)).not.toContain(':');
  });

  it('defaults to the current time when no date is given', () => {
    const before = Date.now();
    const runId = makeRunId();
    const after = Date.now();

    expect(runId).not.toContain(':');
    const match = runId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/);
    expect(match).not.toBeNull();
    const [, datePart, hh, mm, ss, ms] = match!;
    const parsed = new Date(`${datePart}T${hh}:${mm}:${ss}.${ms}Z`).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    expect(parsed).toBeLessThanOrEqual(after + 1000);
  });
});

describe('writeReport', () => {
  it('creates eval/reports/<run-id>/report.json with the exact report content', () => {
    const runId = testRunId('basic');
    const report: Report = {
      runId,
      scenarioSetName: 'guest-resolution',
      startedAt: '2026-08-23T10:00:00.000Z',
      finishedAt: '2026-08-23T10:05:00.000Z',
      entries: [
        {
          id: 'guest-resolution-known-name',
          status: 'completed',
          judging: 'deterministic',
          passed: true,
          evidence: 'adardevora@gmail.com',
        },
      ],
    };

    const filePath = writeReport(report);

    expect(filePath).toBe(path.join(REPORTS_DIR, runId, 'report.json'));
    expect(fs.existsSync(filePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual(report);
  });

  it('includes a cleanupError field when present, and omits it when absent', () => {
    const runId = testRunId('cleanup-error');
    const report: Report = {
      runId,
      scenarioSetName: 'guest-resolution',
      startedAt: '2026-08-23T10:00:00.000Z',
      finishedAt: '2026-08-23T10:05:00.000Z',
      entries: [
        {
          id: 'guest-resolution-known-name',
          status: 'completed',
          judging: 'deterministic',
          passed: true,
          evidence: 'adardevora@gmail.com',
          cleanupError: 'cleanup follow-up did not confirm success (turn status: completed)',
        },
      ],
    };

    const filePath = writeReport(report);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    expect(persisted.entries[0].cleanupError).toBe(
      'cleanup follow-up did not confirm success (turn status: completed)',
    );
  });

  it('reports an unsupported llmJudge scenario with status "unsupported" and passed: false', () => {
    const runId = testRunId('unsupported');
    const report: Report = {
      runId,
      scenarioSetName: 'guest-resolution',
      startedAt: '2026-08-23T10:00:00.000Z',
      finishedAt: '2026-08-23T10:05:00.000Z',
      entries: [
        {
          id: 'guest-resolution-ambiguous-name',
          status: 'unsupported',
          judging: 'llmJudge',
          passed: false,
          evidence: 'llmJudge scenarios are not executed until Epic 2 adds judge/llm.ts',
        },
      ],
    };

    const filePath = writeReport(report);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    expect(persisted.entries[0]).toEqual(report.entries[0]);
  });

  it('creates parent directories that do not yet exist', () => {
    const runId = testRunId('fresh-dir');
    expect(fs.existsSync(path.join(REPORTS_DIR, runId))).toBe(false);

    writeReport({
      runId,
      scenarioSetName: 'guest-resolution',
      startedAt: '2026-08-23T10:00:00.000Z',
      finishedAt: '2026-08-23T10:00:01.000Z',
      entries: [],
    });

    expect(fs.existsSync(path.join(REPORTS_DIR, runId, 'report.json'))).toBe(true);
  });
});
