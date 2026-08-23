/**
 * Writes `cli.ts`'s finished run out to `eval/reports/<run-id>/report.json`
 * (AD-2: no raw DB handle here — this module only ever touches the
 * filesystem, never `data/v2.db`).
 *
 * `REPORTS_DIR` is resolved from this module's own file location
 * (`import.meta.url`), not `process.cwd()` — `pnpm eval run ...` is expected
 * to run from the repo root (matching the `"eval"` package.json script), but
 * anchoring to the source file itself means a report always lands at the
 * real `eval/reports/` regardless of the invoking shell's cwd.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { ScenarioTurnStatus } from './runner.js';

/**
 * `'unsupported'` is this module's own outcome (an `llmJudge` scenario `cli.ts`
 * didn't execute) — distinct from every real turn status. `'judge-error'` is a
 * second synthetic outcome: the turn itself completed, but the scenario's own
 * `check` function threw (review finding — a throwing check is a
 * scenario-authoring bug, `judge/deterministic.ts` never catches it, and
 * `cli.ts` must not let that propagate and abort the whole run).
 */
export type ReportEntryStatus = ScenarioTurnStatus | 'unsupported' | 'judge-error';

export interface ScenarioReportEntry {
  id: string;
  status: ReportEntryStatus;
  judging: 'deterministic' | 'llmJudge';
  passed: boolean;
  /**
   * A resolved email on a pass, the actual reply text on a fail, a status/error
   * string when the turn didn't complete or judging threw. Optional not because
   * it's "sometimes missing today" — every current producer always sets it —
   * but for forward-compat with a future judge type (Epic 2's `judge/llm.ts`)
   * that might not always have evidence to report.
   */
  evidence?: unknown;
  /** Set only when this scenario's cleanup follow-up failed or didn't confirm — never thrown, always recorded here instead. */
  cleanupError?: string;
}

export interface Report {
  runId: string;
  scenarioSetName: string;
  startedAt: string;
  finishedAt: string;
  entries: ScenarioReportEntry[];
}

export const REPORTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports');

/** ISO-8601 with every `:` stripped (`report.json`'s `runId` / the directory name it's written under). */
export function makeRunId(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, '');
}

/** Creates `eval/reports/<run-id>/` and writes `report.json` there. Returns the written file's path. */
export function writeReport(report: Report): string {
  const dir = path.join(REPORTS_DIR, report.runId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'report.json');
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2) + '\n');
  return filePath;
}
