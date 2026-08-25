/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CLAUDE_TRANSCRIPT_ROTATE_BYTES,
  CONTAINER_CPU_LIMIT,
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_MEMORY_LIMIT,
  CONTAINER_PIDS_LIMIT,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { materializeContainerJson } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerProvidesAgentSurfaces,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * Docker Desktop's VirtioFS backend sometimes hasn't finished propagating a
 * just-established bind mount (the session-dir `/workspace` mount) into the
 * VM's view before runc resolves a *nested* mount destination underneath it
 * (`/workspace/extra/...` — see validateAdditionalMounts). runc's rootfs-
 * containment check then spuriously rejects the nested mount as "outside of
 * rootfs". This is a known, unresolved Docker Desktop/VirtioFS race (see
 * docker/for-mac#7853, docker/desktop-feedback#279) — not a bad mount config.
 * It self-resolves once VirtioFS catches up, so a short retry dodges it
 * without masking a genuinely broken mount (bad path, permissions, missing
 * file) — those fail with a different code/message and are NOT retried here.
 */
const MOUNT_RACE_MAX_ATTEMPTS = 3;
const MOUNT_RACE_RETRY_DELAYS_MS = [1000, 2000]; // gap before attempt 2, then before attempt 3

export function isRetryableMountRace(code: number | null, stderrLines: string[]): boolean {
  if (code !== 125) return false;
  const joined = stderrLines.join('\n');
  return joined.includes('OCI runtime create failed') && joined.includes('is outside of rootfs');
}

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and current-thread routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Runs before the provider
  // contribution so a surfaces-providing provider finds the group dir ready.
  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, provider, contribution);
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;

  await spawnAttempt(session, agentGroup, mounts, containerConfig, provider, contribution, agentIdentifier, 1);
}

/**
 * One spawn attempt. On the narrow VirtioFS mount-race signature (see
 * isRetryableMountRace), retries with a short backoff up to
 * MOUNT_RACE_MAX_ATTEMPTS before falling through to today's behavior (leave
 * it pending — host-sweep's next tick picks it up). Any other failure —
 * a genuinely bad mount, missing binary, wrong provider — is NOT retried
 * here; it surfaces exactly as before via the existing warn log.
 */
async function spawnAttempt(
  session: Session,
  agentGroup: AgentGroup,
  mounts: VolumeMount[],
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  contribution: ProviderContainerContribution,
  agentIdentifier: string,
  attempt: number,
): Promise<void> {
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
  );

  log.info('Spawning container', {
    sessionId: session.id,
    agentGroup: agentGroup.name,
    containerName,
    attempt,
  });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr. A container that dies at boot (unknown provider, missing
  // binary, bad config) explains itself only here — and debug is below the
  // default log level — so keep a tail to surface on a non-zero exit.
  const stderrTail: string[] = [];
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      log.debug(line, { container: agentGroup.folder });
      stderrTail.push(line);
      if (stderrTail.length > 10) stderrTail.shift();
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);

    if (isRetryableMountRace(code, stderrTail) && attempt < MOUNT_RACE_MAX_ATTEMPTS) {
      const delayMs = MOUNT_RACE_RETRY_DELAYS_MS[attempt - 1];
      log.warn('Container hit the VirtioFS mount race — retrying', {
        sessionId: session.id,
        containerName,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: MOUNT_RACE_MAX_ATTEMPTS,
        delayMs,
      });
      setTimeout(() => {
        spawnAttempt(
          session,
          agentGroup,
          mounts,
          containerConfig,
          provider,
          contribution,
          agentIdentifier,
          attempt + 1,
        ).catch((err) =>
          log.error('Mount-race retry spawn failed', { sessionId: session.id, attempt: attempt + 1, err }),
        );
      }, delayMs);
      return;
    }

    if (isRetryableMountRace(code, stderrTail)) {
      log.warn('Container exhausted mount-race retries — falling through to host-sweep', {
        sessionId: session.id,
        containerName,
        attempt,
        maxAttempts: MOUNT_RACE_MAX_ATTEMPTS,
        stderrTail,
      });
      return;
    }

    // code null = killed by signal (normal shutdown path), not a boot failure.
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      log.warn('Container exited non-zero', { sessionId: session.id, code, containerName, stderrTail });
    } else {
      log.info('Container exited', { sessionId: session.id, code, containerName });
    }
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Structural guard for `killAllActiveContainers`, supplementing (not
 * replacing) its own doc comment below. A comment alone is exactly the
 * pattern this codebase's own pitfalls file already documents as having
 * caused a real incident elsewhere (`delete_calendar_event`'s confirm-trust
 * bug: an agent-visible instruction saying "always confirm first" turned out
 * not to hold once something depended on it actually being followed) — the
 * fix there was to fold the guarantee into the callee itself rather than
 * trust every caller to remember a rule written in prose. This function's
 * only two real callers (`eval/cli.ts`, `eval/sweep.ts`) are both short-lived
 * one-shot CLI processes; a future caller has to import and pass this exact
 * literal deliberately, rather than accidentally inheriting host-process
 * access via a plain `import { killAllActiveContainers } from
 * './container-runner.js'`.
 */
export const EVAL_CLI_ONESHOT_TOKEN = 'eval-cli-oneshot' as const;

/**
 * Kill every container this process is currently tracking (every session id
 * in `activeContainers`), synchronously in sequence (`killContainer` →
 * `stopContainer` is itself synchronous, `execSync` with a 1s grace). One
 * container's kill failure is caught and logged, not left to abort the loop
 * — every other tracked container still gets its own kill attempt.
 *
 * Intended for a short-lived, one-shot CLI process that must never leave a
 * container running past its own exit — the eval harness (`eval/cli.ts`,
 * `eval/sweep.ts`), whose containers otherwise have no idle-timeout or
 * decommission path at all (host-sweep deliberately excludes eval sessions,
 * AD-6/Story 1.5) and can persist indefinitely. `wakeContainer`'s own
 * `activeContainers.has()` dedup check only ever sees the CALLING process's
 * own in-memory map — a fresh `pnpm eval sweep`/`pnpm eval run` invocation
 * starts with an empty map every time, so it has no way to detect (let alone
 * reuse) a container a *previous*, already-exited invocation left running;
 * left unaddressed, two real agent-runner containers can end up polling and
 * writing the identical session DB concurrently (found live, 2026-08-24,
 * during a `pnpm eval sweep` re-verification run). Calling this once at the
 * very end of every eval CLI invocation means no eval container ever
 * outlives the invocation that spawned it, so there is nothing left over
 * for a later invocation to collide with.
 *
 * Never call this from the long-running host process (`index.ts`) — it
 * would kill every session's container the host is currently serving, not
 * just eval ones. Safe here specifically because a `pnpm eval` invocation's
 * `activeContainers` map — a fresh module instance in its own separate OS
 * process — only ever contains containers this same invocation itself
 * spawned.
 *
 * `callerToken` must be exactly `EVAL_CLI_ONESHOT_TOKEN` — see that
 * constant's own doc comment for why this exists as a structural check, not
 * just a naming convention.
 */
export function killAllActiveContainers(reason: string, callerToken: typeof EVAL_CLI_ONESHOT_TOKEN): void {
  if (callerToken !== EVAL_CLI_ONESHOT_TOKEN) {
    throw new Error(
      `killAllActiveContainers: callerToken must be exactly "${EVAL_CLI_ONESHOT_TOKEN}" — this function kills ` +
        'every container this OS process is currently tracking, which is only ever safe from a short-lived, ' +
        'one-shot CLI process (eval/cli.ts, eval/sweep.ts). Never call this from the long-running host process — ' +
        "it would kill every session's container the host is currently serving, not just eval ones.",
    );
  }
  for (const sessionId of [...activeContainers.keys()]) {
    try {
      killContainer(sessionId, reason);
    } catch (err) {
      log.error('killAllActiveContainers: failed to kill one container — continuing with the rest', {
        sessionId,
        reason,
        err,
      });
    }
  }
}

/**
 * Test-only hook: registers a container in `activeContainers` without a real
 * spawn, so `killAllActiveContainers`'s actual multi-entry kill loop can be
 * exercised in a unit test without a live Docker daemon. Not used by any
 * production code path.
 */
export function registerActiveContainerForTest(
  sessionId: string,
  entry: { process: ChildProcess; containerName: string },
): void {
  activeContainers.set(sessionId, entry);
}

/** Test-only hook: clears every tracked container without going through a real `container.on('close', ...)` event. */
export function clearActiveContainersForTest(): void {
  activeContainers.clear();
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

/**
 * Container hardening flags. Applied to every agent container; no per-group or
 * per-install override.
 *
 * cap-drop and no-new-privileges are inert while containers run under the
 * `--user` mapping below (the capability sets are already empty and the image
 * carries no file capabilities) — they are depth against a root-in-container
 * path. `--init` is not optional: the `--entrypoint bash` override further down
 * defeats the image's tini, leaving bun as PID 1 with no signal handler, and
 * Linux discards default-action signals to PID 1. Without docker-init, SIGTERM
 * is ignored and every stop ends in SIGKILL after the full grace period.
 */
export function hardeningArgs(pidsLimit: string): string[] {
  const args = ['--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--init'];

  // Test >0, not truthiness: cgroups v2 rejects `--pids-limit 0` with EINVAL and
  // fails the spawn, and '0' is a truthy string. Blank/unparseable means no cap.
  const pids = Number(pidsLimit);
  if (Number.isFinite(pids) && pids > 0) args.push('--pids-limit', String(Math.floor(pids)));

  return args;
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

export function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider's registration declares it provides its
  // own — a capability, never a provider name. See provider-container-registry.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    // Sync skill symlinks based on container.json selection before mounting.
    syncSkillSymlinks(claudeDir, containerConfig);

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    composeGroupClaudeMd(agentGroup);
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + shared memory)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. The shared
  // memory tree and standing-instructions source remain RW via the group mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (defaultSurfaces && fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  if (defaultSurfaces) {
    mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });
  }

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedSkillNames(containerConfig);
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(linkPath);
    } catch {
      /* missing */
    }
    if (!entry) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    } else if (!entry.isSymbolicLink()) {
      // A real entry here is either a template overlay (intentional; see
      // src/group-skills.ts) or a stale pre-refactor skill copy that shadows
      // the shared skill (#3001). No marker distinguishes them yet, so
      // surface the skip instead of staying silent.
      log.warn(
        'Shared skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
        {
          skill,
          path: linkPath,
        },
      );
    }
  }
}

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added upstream skills appear automatically.
 */
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Per-container resource caps (opt-in; empty = unbounded, today's behavior).
  // Only --memory is set. Whether that's a hard cap depends on the host having no
  // swap (a deployment concern) — on a swapless host --memory is hard and a runaway
  // is OOM-killed; we don't manage swap from here.
  if (CONTAINER_CPU_LIMIT) args.push('--cpus', CONTAINER_CPU_LIMIT);
  if (CONTAINER_MEMORY_LIMIT) args.push('--memory', CONTAINER_MEMORY_LIMIT);

  // Docker defaults /dev/shm to 64m, which silently short-writes past that size.
  // agent-browser passes --disable-dev-shm-usage, but a third-party puppeteer or
  // Playwright launcher may not.
  args.push('--shm-size=1g');

  args.push(...hardeningArgs(CONTAINER_PIDS_LIMIT));

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${containerConfig.timezone ?? TIMEZONE}`);

  // Exception to the above: the Claude provider's own transcriptRotateBytes()
  // reads this directly from its own process.env (claude.ts), and it's a
  // deliberately GLOBAL operator knob, not per-group config — see
  // src/config.ts's doc comment. Forwarded only when set; empty means the
  // provider's own 12MB default, unchanged.
  if (CLAUDE_TRANSCRIPT_ROTATE_BYTES) {
    args.push('-e', `CLAUDE_TRANSCRIPT_ROTATE_BYTES=${CLAUDE_TRANSCRIPT_ROTATE_BYTES}`);
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Egress lockdown when enabled — throws if it can't be established, aborting
  // the spawn rather than running with open egress. Otherwise the host gateway.
  if (ensureEgressNetwork()) {
    args.push(...egressNetworkArgs());
    log.info('Egress lockdown active', { containerName, network: EGRESS_NETWORK });
  } else {
    args.push(...hostGatewayArgs());
  }

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection, and mounts
  // any credential stubs the gateway serves (e.g. a sentinel auth file).
  // Runs AFTER the volume mounts so a stub nested inside one of our mounts
  // (a parent dir mounted RW above it) lands later in the args and isn't
  // shadowed by it. Treated as a transient hard failure: if we can't wire
  // the gateway, we don't spawn. The caller (router or host-sweep) catches
  // the throw, leaves the inbound message pending, and the next sweep tick
  // retries.
  if (agentIdentifier) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  log.info('OneCLI gateway applied', { containerName });

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return args;
}

const execAsync = promisify(exec);

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  // Which bytes this is built on. Recorded on the derived image so an operator
  // can tell which base a group's packages were layered onto — the image id
  // rather than a RepoDigest, because a locally built base has no RepoDigest at
  // all and an id is unambiguous either way.
  let baseId = '';
  try {
    const { stdout } = await execAsync(`${CONTAINER_RUNTIME_BIN} image inspect --format '{{.Id}}' ${CONTAINER_IMAGE}`);
    baseId = stdout.trim();
  } catch {
    // Non-fatal: the build below fails on its own if the base is really absent.
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  // Overwrite the provenance label rather than letting it be inherited.
  //
  // `dev.nanoclaw.image-source` is documented as the one claim a retag cannot
  // forge, and --status treats it as the trustworthy answer. But a derived
  // build inherits the base's labels, so without this a group that has just
  // added arbitrary apt/npm packages would keep asserting `hardened` — the
  // vendor's claim, over bytes the vendor never saw. `derived` is the honest
  // answer, and `derived-from` says what it was layered onto.
  dockerfile += 'LABEL dev.nanoclaw.image-source="derived"\n';
  if (baseId) dockerfile += `LABEL dev.nanoclaw.derived-from="${baseId}"\n`;

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    // Awaited async exec so the single-threaded host stays responsive during
    // the build (can take minutes) instead of blocking on execSync. exec buffers
    // stdout/stderr (matching the old stdio: 'pipe') and rejects on a non-zero
    // exit, so error propagation is unchanged.
    await execAsync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
