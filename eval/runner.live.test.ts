/**
 * Real end-to-end test: real container, real Claude call, real tokens spent.
 *
 * IS collected by the default `pnpm test`/CI run — this file matches
 * `vitest.config.ts`'s normal `eval/**\/*.test.ts` include, deliberately, not
 * excluded (see that file's own comment for why an `exclude`-based approach
 * doesn't work: it also blocks this file's own explicit-path invocation).
 * Self-gates instead: `describe.skipIf` below only actually runs the test
 * when `EVAL_LIVE_TEST` is set, which only `pnpm run test:eval-live` does —
 * everywhere else (default `pnpm test`, CI) it shows as skipped, zero cost,
 * no container, no API call. Run it only deliberately, and confirm with the
 * operator before the first run in a session — see CLAUDE.md's "Pitfalls
 * observed in practice" section.
 *
 * No mocking at all, unlike `runner.test.ts` — this test exercises the real
 * `wakeContainer` spawn path end to end.
 */
import path from 'path';
import { describe, expect, it } from 'vitest';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { runScenarioTurn } from './runner.js';
import { EVAL_THREAD_PREFIX } from './session.js';
import { ensureEvalScenarioGroup } from './setup.js';

// Mirrors eval/setup.ts's own bootstrapDb() — idempotent, safe to call
// against the real install DB.
function bootstrapDb(): void {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
}

describe.skipIf(!process.env.EVAL_LIVE_TEST)('runScenarioTurn (live)', () => {
  it('drives a real turn against a real container and gets a real transcript back', async () => {
    bootstrapDb();
    const group = ensureEvalScenarioGroup();
    const threadId = `${EVAL_THREAD_PREFIX}:live-smoke-test`;

    const result = await runScenarioTurn(group.id, threadId, 'Reply with exactly the single word: pong');

    expect(result.status).toBe('completed');
    expect(result.transcript.length).toBeGreaterThan(0);
    expect(result.sessionId).toBeTruthy();
  }, // Matches runScenarioTurn's own default timeoutMs (300_000) plus margin
  // for container spawn — a real turn is not fast.
  320_000);
});
