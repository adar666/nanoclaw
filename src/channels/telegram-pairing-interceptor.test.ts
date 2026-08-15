/**
 * Regression coverage for `createPairingInterceptor`'s await correctness.
 *
 * Found live in production (2026-08-15): every early-return branch called
 * `hostOnInbound(...)` without `await`, so the interceptor's own returned
 * promise resolved before the real routing work (writeSessionMessage,
 * attachment extraction, the container wake) had actually finished. This
 * was invisible for ordinary text messages (fast enough that the race
 * never mattered in practice) but a large audio-file attachment (base64
 * decode + a real multi-MB disk write) took long enough that the message
 * silently never reached inbound.db, with no error logged anywhere — the
 * interceptor had already told its caller it was done.
 *
 * Each test below proves the interceptor's promise does not resolve until
 * `hostOnInbound`'s own promise resolves, using a controllable deferred
 * promise rather than a timing race — if the `await` regresses, these
 * tests hang (and fail on vitest's timeout) instead of flaking.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import { createPairingInterceptor } from './telegram.js';
import type { InboundMessage } from './adapter.js';

const PAIRINGS_FILE = path.join(process.cwd(), 'data', 'telegram-pairings.json');

vi.mock('./telegram-markdown-sanitize.js', () => ({ sanitizeTelegramLegacyMarkdown: (t: string) => t }));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMessage(kind: 'chat' | 'chat-sdk', text: string): InboundMessage {
  return {
    id: 'test-msg-1',
    kind,
    content: { text },
    timestamp: new Date().toISOString(),
  };
}

describe('createPairingInterceptor — await correctness', () => {
  let pairingsBackup: string | null = null;

  beforeEach(() => {
    pairingsBackup = fs.existsSync(PAIRINGS_FILE) ? fs.readFileSync(PAIRINGS_FILE, 'utf-8') : null;
  });

  afterEach(() => {
    if (pairingsBackup !== null) {
      fs.writeFileSync(PAIRINGS_FILE, pairingsBackup);
    } else if (fs.existsSync(PAIRINGS_FILE)) {
      fs.rmSync(PAIRINGS_FILE);
    }
  });

  it('waits for hostOnInbound when botUsername resolves to null', async () => {
    const { promise: hostPromise, resolve: resolveHost } = deferred<void>();
    const hostOnInbound = vi.fn(() => hostPromise);
    const interceptor = createPairingInterceptor(Promise.resolve(null), hostOnInbound, 'fake-token', 'http://fake');

    let interceptorResolved = false;
    const interceptorPromise = Promise.resolve(
      interceptor('platform:1', null, makeMessage('chat-sdk', 'anything')),
    ).then(() => {
      interceptorResolved = true;
    });

    // Let microtasks settle without resolving hostPromise — the interceptor
    // must still be pending. A real race window, not a fixed sleep: this
    // checks state at the next microtask boundary, no timers involved.
    await Promise.resolve();
    await Promise.resolve();
    expect(interceptorResolved).toBe(false);
    expect(hostOnInbound).toHaveBeenCalledTimes(1);

    resolveHost();
    await interceptorPromise;
    expect(interceptorResolved).toBe(true);
  });

  it('waits for hostOnInbound on a non-chat-sdk message (empty text — this was the exact audio-attachment case)', async () => {
    const { promise: hostPromise, resolve: resolveHost } = deferred<void>();
    const hostOnInbound = vi.fn(() => hostPromise);
    const interceptor = createPairingInterceptor(
      Promise.resolve('somebot'),
      hostOnInbound,
      'fake-token',
      'http://fake',
    );

    let interceptorResolved = false;
    // kind: 'chat' (not 'chat-sdk') makes readInboundFields return text: ''
    // unconditionally — the same shape an attachment-only message with no
    // caption produces on the real chat-sdk path.
    const interceptorPromise = Promise.resolve(interceptor('platform:1', null, makeMessage('chat', ''))).then(() => {
      interceptorResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve(); // one extra tick for the awaited botUsernamePromise to settle first
    expect(interceptorResolved).toBe(false);
    expect(hostOnInbound).toHaveBeenCalledTimes(1);

    resolveHost();
    await interceptorPromise;
    expect(interceptorResolved).toBe(true);
  });

  it('waits for hostOnInbound when the text has no pairing code', async () => {
    const { promise: hostPromise, resolve: resolveHost } = deferred<void>();
    const hostOnInbound = vi.fn(() => hostPromise);
    const interceptor = createPairingInterceptor(
      Promise.resolve('somebot'),
      hostOnInbound,
      'fake-token',
      'http://fake',
    );

    let interceptorResolved = false;
    const interceptorPromise = Promise.resolve(
      interceptor('platform:1', null, makeMessage('chat-sdk', 'just a normal message')),
    ).then(() => {
      interceptorResolved = true;
    });

    // tryConsume's early "no code found" path returns before ever touching
    // the pairings file — several ticks for botUsernamePromise + tryConsume.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(interceptorResolved).toBe(false);
    expect(hostOnInbound).toHaveBeenCalledTimes(1);

    resolveHost();
    await interceptorPromise;
    expect(interceptorResolved).toBe(true);
  });

  it('waits for hostOnInbound on the fail-open catch path', async () => {
    const { promise: hostPromise, resolve: resolveHost } = deferred<void>();
    const hostOnInbound = vi.fn(() => hostPromise);
    // A rejecting botUsernamePromise drives the interceptor into its catch block.
    const interceptor = createPairingInterceptor(
      Promise.reject(new Error('boom')),
      hostOnInbound,
      'fake-token',
      'http://fake',
    );

    let interceptorResolved = false;
    const interceptorPromise = Promise.resolve(
      interceptor('platform:1', null, makeMessage('chat-sdk', 'anything')),
    ).then(() => {
      interceptorResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(interceptorResolved).toBe(false);
    expect(hostOnInbound).toHaveBeenCalledTimes(1);

    resolveHost();
    await interceptorPromise;
    expect(interceptorResolved).toBe(true);
  });
});
