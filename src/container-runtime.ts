/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';
import { notifyStartupFailure } from './startup-notify.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // Explicit even on macOS/Windows: Docker Desktop normally resolves
  // host.docker.internal via its embedded DNS server, but a custom `dns`
  // override in daemon.json (e.g. corporate/VPN resolvers) bypasses that
  // resolver entirely. `host-gateway` is a documented sentinel supported
  // on all platforms since Docker 20.10 and is a no-op when the magic
  // name already resolves.
  return ['--add-host=host.docker.internal:host-gateway'];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Default: keep polling for ~2 minutes — Docker Desktop typically needs
 *  30-60s to come up after login, and launchd's job wins that race on every
 *  boot. A normal reboot should self-heal instead of tripping the circuit
 *  breaker. */
const DEFAULT_RUNTIME_POLL_TIMEOUT_MS = 120_000;
const DEFAULT_RUNTIME_POLL_INTERVAL_MS = 5_000;

/**
 * Ensure the container runtime is reachable, polling for up to `timeoutMs`
 * before giving up. On genuine failure (runtime never came up), sends a
 * best-effort Telegram notification — this is the only signal outside the
 * log file, since channel adapters haven't started yet.
 */
export async function ensureContainerRuntimeRunning(
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUNTIME_POLL_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_RUNTIME_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  let attempt = 0;
  let lastErr: unknown;
  while (true) {
    attempt++;
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} info`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      if (attempt > 1) {
        log.info('Container runtime became available', { attempt });
      } else {
        log.debug('Container runtime already running');
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === 1) {
        log.warn('Container runtime not reachable yet — waiting for it to start (e.g. Docker Desktop after login)', {
          timeoutMs,
        });
      }
      if (Date.now() + pollIntervalMs > deadline) break; // no time for another attempt
      await sleep(pollIntervalMs);
    }
  }

  log.error('Failed to reach container runtime after waiting', { attempts: attempt, timeoutMs, err: lastErr });
  console.error('\n╔════════════════════════════════════════════════════════════════╗');
  console.error('║  FATAL: Container runtime failed to start                      ║');
  console.error('║                                                                ║');
  console.error('║  Agents cannot run without a container runtime. To fix:        ║');
  console.error('║  1. Ensure Docker is installed and running                     ║');
  console.error('║  2. Run: docker info                                           ║');
  console.error('║  3. Restart NanoClaw                                           ║');
  console.error('╚════════════════════════════════════════════════════════════════╝\n');

  await notifyStartupFailure(
    `⚠️ NanoClaw failed to start: container runtime (${CONTAINER_RUNTIME_BIN}) still unreachable after waiting ${Math.round(timeoutMs / 1000)}s. All agents are down until this is fixed. Check Docker Desktop, then restart NanoClaw.`,
  );

  throw new Error('Container runtime is required but failed to start', {
    cause: lastErr,
  });
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
