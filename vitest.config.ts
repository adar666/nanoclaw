import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    //
    // eval/runner.live.test.ts (a real end-to-end test: real container, real
    // Claude call, real tokens spent) is intentionally matched by this same
    // include glob — NOT excluded here. An earlier version added it to
    // `exclude`, which broke `pnpm run test:eval-live` itself: vitest's
    // `exclude` blocks a file even when passed as an explicit CLI path
    // argument, verified empirically (`vitest run eval/runner.live.test.ts`
    // reported "No test files found" with `exclude` in place). The live
    // test gates itself internally instead (`describe.skipIf`, keyed off
    // `EVAL_LIVE_TEST`) — see its own file for the mechanism. That means it
    // IS collected by the default `pnpm test`/CI run, but its one test shows
    // as skipped (zero cost, no container, no API call) unless
    // `EVAL_LIVE_TEST` is set, which only `test:eval-live` does.
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'scripts/**/*.test.ts',
      'container/*.test.ts',
      'eval/**/*.test.ts',
    ],
  },
});
