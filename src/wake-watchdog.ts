/**
 * System sleep/wake watchdog.
 *
 * Node's timers pause along with the whole process during macOS/Windows
 * system sleep and resume exactly where they left off on wake — but any
 * in-flight TCP connection (e.g. a channel adapter's long-poll HTTP
 * request) can come back dead with no local error: nothing tells Node the
 * socket died, so the adapter looks "connected" forever without receiving
 * updates. There's no direct sleep/wake event available in plain Node, so
 * we infer it: a ticking timer that arrives much later than its nominal
 * interval can only mean the process itself was suspended, not GC jitter
 * or event-loop backpressure (those top out well under a second).
 */
import { log } from './log.js';
import { restartChannelAdapters } from './channels/channel-registry.js';

const TICK_MS = 15_000;
/** Extra delay beyond TICK_MS that can only be explained by a suspend/resume. */
const WAKE_GAP_THRESHOLD_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
let lastTick = 0;

export function startWakeWatchdog(): void {
  if (timer) return;
  lastTick = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const previousTick = lastTick;
    const actualMs = now - previousTick;
    const gap = actualMs - TICK_MS;
    lastTick = now;
    if (gap < WAKE_GAP_THRESHOLD_MS) return;

    log.warn('Wake watchdog: large timer gap detected, forcing channel adapter reconnect', {
      expectedMs: TICK_MS,
      actualMs,
      gapMs: gap,
    });
    restartChannelAdapters('wake-watchdog').catch((err) => {
      log.error('Wake watchdog: adapter reconnect failed', { err });
    });
  }, TICK_MS);
  timer.unref();
}

export function stopWakeWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
