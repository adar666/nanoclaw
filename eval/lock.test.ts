import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-eval-lock-test';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-eval-lock-test/groups',
}));

import { EVAL_LOCK_PATH, withEvalLock, withLock } from './lock.js';

const LOCK_PATH = path.join(TEST_ROOT, 'lock', '.test.lock');

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('withLock', () => {
  it('acquires immediately when no lock file exists, writes its own pid, runs fn, and removes the lock file afterward', async () => {
    let ran = false;
    const result = await withLock(LOCK_PATH, () => {
      ran = true;
      expect(fs.existsSync(LOCK_PATH)).toBe(true);
      expect(fs.readFileSync(LOCK_PATH, 'utf-8')).toBe(String(process.pid));
      return 'ok';
    });

    expect(ran).toBe(true);
    expect(result).toBe('ok');
    expect(fs.existsSync(LOCK_PATH)).toBe(false);
  });

  it('awaits an async fn before releasing the lock', async () => {
    const result = await withLock(LOCK_PATH, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 42;
    });

    expect(result).toBe(42);
    expect(fs.existsSync(LOCK_PATH)).toBe(false);
  });

  it('throws, naming lockPath, after exhausting the retry budget against a live (fresh) lock', async () => {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    fs.writeFileSync(LOCK_PATH, 'other-pid', { flag: 'wx' });

    await expect(
      withLock(LOCK_PATH, () => 'should not run', { retryMs: 2, maxAttempts: 3, staleMs: 30_000 }),
    ).rejects.toThrow(new RegExp(LOCK_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // The other holder's lock file is untouched — only the second caller's
    // own failed attempt should ever be cleaned up.
    expect(fs.existsSync(LOCK_PATH)).toBe(true);
  });

  it('reclaims and acquires a stale lock without exhausting the retry budget', async () => {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    fs.writeFileSync(LOCK_PATH, 'crashed-pid', { flag: 'wx' });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(LOCK_PATH, old, old);

    let ran = false;
    // maxAttempts: 2 — if reclaim didn't happen on the very next attempt,
    // this would exhaust the budget and throw instead of running fn.
    const result = await withLock(
      LOCK_PATH,
      () => {
        ran = true;
        return 'reclaimed';
      },
      { retryMs: 2, maxAttempts: 2, staleMs: 1_000 },
    );

    expect(ran).toBe(true);
    expect(result).toBe('reclaimed');
    expect(fs.existsSync(LOCK_PATH)).toBe(false);
  });

  it('releases the lock and propagates the original error when fn throws', async () => {
    await expect(
      withLock(LOCK_PATH, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(fs.existsSync(LOCK_PATH)).toBe(false);
  });

  it('releases the lock and propagates the original error when an async fn rejects', async () => {
    await expect(
      withLock(LOCK_PATH, async () => {
        await Promise.resolve();
        throw new Error('async boom');
      }),
    ).rejects.toThrow('async boom');

    expect(fs.existsSync(LOCK_PATH)).toBe(false);
  });

  it('creates a missing parent directory defensively before acquiring', async () => {
    const nested = path.join(TEST_ROOT, 'does', 'not', 'exist', '.nested.lock');
    expect(fs.existsSync(path.dirname(nested))).toBe(false);

    await withLock(nested, () => {
      expect(fs.existsSync(nested)).toBe(true);
    });

    expect(fs.existsSync(path.dirname(nested))).toBe(true);
    expect(fs.existsSync(nested)).toBe(false);
  });

  it('rejects a non-positive-integer maxAttempts before touching the filesystem', async () => {
    await expect(withLock(LOCK_PATH, () => 'unreachable', { maxAttempts: 0 })).rejects.toThrow(/maxAttempts/);
    await expect(withLock(LOCK_PATH, () => 'unreachable', { maxAttempts: 2.5 })).rejects.toThrow(/maxAttempts/);
    expect(fs.existsSync(LOCK_PATH)).toBe(false);
  });

  it('rejects a non-positive staleMs before touching the filesystem', async () => {
    await expect(withLock(LOCK_PATH, () => 'unreachable', { staleMs: 0 })).rejects.toThrow(/staleMs/);
    await expect(withLock(LOCK_PATH, () => 'unreachable', { staleMs: -1 })).rejects.toThrow(/staleMs/);
    expect(fs.existsSync(LOCK_PATH)).toBe(false);
  });

  it('still reclaims a stale lock when the reclaim happens on the very last retry attempt (off-by-one regression)', async () => {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    fs.writeFileSync(LOCK_PATH, 'crashed-pid', { flag: 'wx' });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(LOCK_PATH, old, old);

    // maxAttempts: 1 — the stale check fires on the loop's one and only
    // iteration. The buggy version would `continue` straight out of the
    // loop here (attempt reaches maxAttempts) and run fn() completely
    // unlocked, with no lock file ever written for this call.
    let ran = false;
    const result = await withLock(
      LOCK_PATH,
      () => {
        ran = true;
        expect(fs.existsSync(LOCK_PATH)).toBe(true);
        expect(fs.readFileSync(LOCK_PATH, 'utf-8')).toBe(String(process.pid));
        return 'reclaimed-on-last-attempt';
      },
      { retryMs: 2, maxAttempts: 1, staleMs: 1_000 },
    );

    expect(ran).toBe(true);
    expect(result).toBe('reclaimed-on-last-attempt');
    expect(fs.existsSync(LOCK_PATH)).toBe(false);
  });

  it("does not delete a different holder's lock on release (fencing regression)", async () => {
    // Simulates the real failure mode: this call's fn() outlives staleMs,
    // another process (identified by a different pid/token) reclaims the
    // lock as abandoned and writes its own token in — all *while our fn()
    // is still running*, exactly what a slow scenario run risks. When our
    // fn() finally returns, the buggy version's unconditional unlink would
    // delete that other, still-live holder's lock. The fix only unlinks if
    // the file still holds the exact token this call itself wrote.
    const otherHoldersToken = 'a-different-process-reclaimed-this';

    await withLock(LOCK_PATH, () => {
      expect(fs.readFileSync(LOCK_PATH, 'utf-8')).toBe(String(process.pid));
      // Simulate another process's reclaim happening mid-hold.
      fs.writeFileSync(LOCK_PATH, otherHoldersToken);
    });

    // Our release must have been a no-op — the other holder's token survives.
    expect(fs.existsSync(LOCK_PATH)).toBe(true);
    expect(fs.readFileSync(LOCK_PATH, 'utf-8')).toBe(otherHoldersToken);
  });

  it('a second waiter succeeds once the first holder releases normally (not via staleness)', async () => {
    let secondRan = false;
    const first = withLock(LOCK_PATH, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'first';
    });
    // Give the first call a moment to actually acquire before the second starts.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = withLock(
      LOCK_PATH,
      () => {
        secondRan = true;
        return 'second';
      },
      { retryMs: 5, maxAttempts: 20, staleMs: 30_000 },
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe('first');
    expect(secondResult).toBe('second');
    expect(secondRan).toBe(true);
    expect(fs.existsSync(LOCK_PATH)).toBe(false);
  });
});

describe('withEvalLock', () => {
  it('points at EVAL_LOCK_PATH under the (mocked) eval group workspace', () => {
    expect(EVAL_LOCK_PATH).toBe(path.join('/tmp/nanoclaw-eval-lock-test/groups', 'eval', '.eval-run.lock'));
  });

  it('creates groups/eval/ when missing and still acquires normally', async () => {
    expect(fs.existsSync(path.dirname(EVAL_LOCK_PATH))).toBe(false);

    let ran = false;
    const result = await withEvalLock(() => {
      ran = true;
      expect(fs.existsSync(EVAL_LOCK_PATH)).toBe(true);
      return 'done';
    });

    expect(ran).toBe(true);
    expect(result).toBe('done');
    expect(fs.existsSync(path.dirname(EVAL_LOCK_PATH))).toBe(true);
    expect(fs.existsSync(EVAL_LOCK_PATH)).toBe(false);
  });

  it('passes opts through to the underlying withLock call', async () => {
    fs.mkdirSync(path.dirname(EVAL_LOCK_PATH), { recursive: true });
    fs.writeFileSync(EVAL_LOCK_PATH, 'other-pid', { flag: 'wx' });

    // A small maxAttempts override should make contention fail fast — if
    // opts weren't actually passed through, this would fall back to the
    // real ~2s default budget instead.
    const start = Date.now();
    await expect(withEvalLock(() => 'unreachable', { retryMs: 2, maxAttempts: 2, staleMs: 30_000 })).rejects.toThrow(
      /eval-run\.lock/,
    );
    expect(Date.now() - start).toBeLessThan(500);
  });
});
