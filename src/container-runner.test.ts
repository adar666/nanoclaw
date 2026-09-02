import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildMounts,
  clearActiveContainersForTest,
  EVAL_CLI_ONESHOT_TOKEN,
  getActiveContainerCount,
  hardeningArgs,
  isRetryableMountRace,
  killAllActiveContainers,
  registerActiveContainerForTest,
  resolveProviderName,
} from './container-runner.js';
import { stopContainer } from './container-runtime.js';
import type { ContainerConfig } from './container-config.js';
import type { ProviderContainerContribution } from './providers/provider-container-registry.js';
import type { AgentGroup, Session } from './types.js';

vi.mock('./container-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./container-runtime.js')>();
  return { ...actual, stopContainer: vi.fn() };
});

// buildMounts (below) composes the agent's CLAUDE.md as a side effect when
// the resolved provider doesn't declare providesAgentSurfaces (the case for
// every provider registered in this trunk today) — that path needs a real
// central DB row this suite has no reason to set up, so it's stubbed out.
// Nothing else in this file touches claude-md-compose.js.
vi.mock('./claude-md-compose.js', () => ({
  composeGroupClaudeMd: vi.fn(),
}));

// GROUPS_DIR/DATA_DIR default to the real project's groups/ and data/ dirs
// (process.cwd()-relative) — only the self-mod-log mount test below needs a
// real (but disposable) group folder to check fs.existsSync against, so it's
// redirected to a scratch dir rather than writing into the real repo.
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-container-runner/groups',
    DATA_DIR: '/tmp/nanoclaw-test-container-runner/data',
  };
});

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('isRetryableMountRace', () => {
  const mountRaceStderr = [
    'docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: error mounting "/host_mnt/Users/uriel/second-brain-data/household.db" to rootfs at "/workspace/extra/second-brain-data/household.db": create mountpoint for /workspace/extra/second-brain-data/household.db mount: mountpoint "/run/host_virtiofs/..." is outside of rootfs "/var/lib/docker/rootfs/overlayfs/abc123"',
    "Run 'docker run --help' for more information",
  ];

  it('matches the exact OCI-125 VirtioFS mount-race signature', () => {
    expect(isRetryableMountRace(125, mountRaceStderr)).toBe(true);
  });

  it('does not match on a different exit code, even with matching text', () => {
    expect(isRetryableMountRace(1, mountRaceStderr)).toBe(false);
    expect(isRetryableMountRace(null, mountRaceStderr)).toBe(false);
  });

  it('does not match code 125 without the specific mount-race text', () => {
    // A genuinely bad mount, wrong provider binary, etc. — should fail loud,
    // not get silently retried and turned into a slower failure.
    expect(isRetryableMountRace(125, ['docker: Error response from daemon: no such file or directory'])).toBe(false);
    // Only one of the two required substrings present — not narrow enough on its own.
    expect(isRetryableMountRace(125, ['OCI runtime create failed: some unrelated error'])).toBe(false);
    expect(isRetryableMountRace(125, ['permission denied: is outside of rootfs but not the real signature'])).toBe(
      false,
    );
    // Both substrings present (even split across lines) is the actual signature.
    expect(isRetryableMountRace(125, ['OCI runtime create failed: ...', '... is outside of rootfs ...'])).toBe(true);
  });

  it('does not match a clean exit or empty stderr', () => {
    expect(isRetryableMountRace(0, [])).toBe(false);
    expect(isRetryableMountRace(125, [])).toBe(false);
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('per-container resource limits (structural)', () => {
  // CONTAINER_CPU_LIMIT / CONTAINER_MEMORY_LIMIT pass through to `docker run` as
  // --cpus / --memory, but only when set. The default is empty string → no flag →
  // today's unbounded behavior (don't OOM existing OSS workloads). Swap is not
  // managed here (a swapless host makes --memory a hard cap). buildContainerArgs
  // needs a live gateway to drive, so guard the wiring structurally: the flags
  // must be pushed, and each must be guarded by its env knob so empty emits nothing.
  it('reads both limit knobs from config', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('CONTAINER_CPU_LIMIT');
    expect(src).toContain('CONTAINER_MEMORY_LIMIT');
  });

  it('guards --cpus behind a truthy CONTAINER_CPU_LIMIT', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_CPU_LIMIT\)[\s\S]*?args\.push\('--cpus', CONTAINER_CPU_LIMIT\)/);
  });

  it('guards --memory behind a truthy CONTAINER_MEMORY_LIMIT (and sets no swap flag)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_MEMORY_LIMIT\) args\.push\('--memory', CONTAINER_MEMORY_LIMIT\)/);
    expect(src).not.toContain('--memory-swap');
  });

  it('defaults both knobs to empty string in config (no flag = unbounded)', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toContain(
      "CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || ''",
    );
    expect(cfg).toContain(
      "CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || ''",
    );
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

describe('syncSkillSymlinks blocked-entry warning (structural)', () => {
  // Real directories in .claude-shared/skills/ block the managed symlinks:
  // the prune loop only removes symlinks and the create loop skips any
  // existing entry. Template overlays depend on surviving that (see
  // src/group-skills.ts); stale pre-refactor skill copies (#3001) get served
  // forever with no trace. Driving syncSkillSymlinks needs a real group
  // filesystem, and importing more of the module pulls the provider side
  // effects, so guard the wiring structurally: the create loop must warn
  // when a non-symlink entry occupies a desired skill path.
  it('warns instead of silently skipping when a real entry blocks a desired skill', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const createLoop = src.indexOf('// Create symlinks for desired skills');
    expect(createLoop).toBeGreaterThan(-1);
    const tail = src.slice(createLoop);
    expect(tail).toMatch(/else if \(!entry\.isSymbolicLink\(\)\)/);
    expect(tail).toMatch(/log\.warn\(\s*'Shared skill not symlinked/);
  });
});

describe('hardeningArgs', () => {
  it('always emits the three unconditional flags', () => {
    const args = hardeningArgs('2048');
    expect(args).toContain('--cap-drop=ALL');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges');
    expect(args).toContain('--init');
  });

  it('emits the pids limit when positive', () => {
    expect(hardeningArgs('2048').join(' ')).toContain('--pids-limit 2048');
  });

  // cgroups v2 rejects `--pids-limit 0` with EINVAL, killing the spawn.
  it('omits the pids limit for 0, negatives, blank and garbage', () => {
    for (const v of ['0', '-1', '', '   ', 'lots']) {
      expect(hardeningArgs(v).join(' ')).not.toContain('--pids-limit');
    }
  });

  it('floors fractional values', () => {
    expect(hardeningArgs('2048.7').join(' ')).toContain('--pids-limit 2048');
  });
});

describe('killAllActiveContainers', () => {
  afterEach(() => {
    clearActiveContainersForTest();
    vi.mocked(stopContainer).mockReset();
  });

  it('does nothing and does not throw when no container is currently tracked', () => {
    expect(getActiveContainerCount()).toBe(0);
    expect(() => killAllActiveContainers('test', EVAL_CLI_ONESHOT_TOKEN)).not.toThrow();
    expect(getActiveContainerCount()).toBe(0);
  });

  it('rejects a caller that does not pass the exact structural token, even with real containers tracked', () => {
    registerActiveContainerForTest('sess-guarded', {
      process: { kill: vi.fn(), once: vi.fn() } as never,
      containerName: 'container-guarded',
    });

    // @ts-expect-error — deliberately calling with a wrong/missing token to prove the guard rejects it at runtime, not just at the type level.
    expect(() => killAllActiveContainers('test', 'not-the-real-token')).toThrow(/callerToken must be exactly/);
    expect(stopContainer).not.toHaveBeenCalled();
  });

  // Real multi-container kill-loop coverage (deferred-work.md, 2026-08-25):
  // the prior version of this test file only proved the function doesn't
  // throw against an EMPTY activeContainers map — the actual kill loop over
  // 2+ tracked containers was untested. registerActiveContainerForTest is a
  // test-only hook (container-runner.ts) that populates activeContainers
  // without a real spawn/Docker call, so this doesn't need a live runtime.
  it('kills every tracked container, not just the first', () => {
    const killA = vi.fn();
    const killB = vi.fn();
    registerActiveContainerForTest('sess-a', {
      process: { kill: killA, once: vi.fn() } as never,
      containerName: 'container-a',
    });
    registerActiveContainerForTest('sess-b', {
      process: { kill: killB, once: vi.fn() } as never,
      containerName: 'container-b',
    });
    expect(getActiveContainerCount()).toBe(2);

    killAllActiveContainers('multi-kill test', EVAL_CLI_ONESHOT_TOKEN);

    expect(stopContainer).toHaveBeenCalledWith('container-a');
    expect(stopContainer).toHaveBeenCalledWith('container-b');
    expect(stopContainer).toHaveBeenCalledTimes(2);
  });

  it("one container's kill failure does not stop the loop from attempting the rest", () => {
    const killFail = vi.fn(() => {
      throw new Error('SIGKILL also failed for this one');
    });
    const killOk = vi.fn();
    vi.mocked(stopContainer).mockImplementation((name: string) => {
      if (name === 'container-fail') throw new Error('docker stop failed');
    });
    // Registration order matters: the failing entry goes first, so a real
    // regression (an unguarded loop) would abort before ever reaching the
    // second, healthy entry.
    registerActiveContainerForTest('sess-fail', {
      process: { kill: killFail, once: vi.fn() } as never,
      containerName: 'container-fail',
    });
    registerActiveContainerForTest('sess-ok', {
      process: { kill: killOk, once: vi.fn() } as never,
      containerName: 'container-ok',
    });

    expect(() => killAllActiveContainers('resilience test', EVAL_CLI_ONESHOT_TOKEN)).not.toThrow();

    // container-fail: stopContainer threw, so killContainer's own fallback
    // tried entry.process.kill('SIGKILL') — which itself threw too, proving
    // even a total failure on one entry doesn't propagate out of the loop.
    expect(killFail).toHaveBeenCalledWith('SIGKILL');
    // container-ok: still reached and killed normally.
    expect(stopContainer).toHaveBeenCalledWith('container-ok');
    expect(killOk).not.toHaveBeenCalled(); // stopContainer succeeded for it — no fallback needed
  });
});

// spec-2-2: self-mod-change-provenance — self-mod-log.md's nested RO mount,
// same conditional-existence convention already covered by container.json
// two lines above it in buildMounts.
describe('buildMounts self-mod-log.md mount', () => {
  const TEST_DIR = '/tmp/nanoclaw-test-container-runner';
  const GROUP_DIR = `${TEST_DIR}/groups/ag-1`;
  const SELF_MOD_LOG_PATH = `${GROUP_DIR}/self-mod-log.md`;

  const agentGroup: AgentGroup = {
    id: 'ag-1',
    name: 'Agent',
    folder: 'ag-1',
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  const session: Session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  const containerConfig: ContainerConfig = {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: [],
    calendarRegistry: [],
  };
  const providerContribution: ProviderContainerContribution = {};

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(GROUP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('mounts self-mod-log.md read-only at /workspace/agent/self-mod-log.md when the file exists', () => {
    fs.writeFileSync(SELF_MOD_LOG_PATH, '2026-01-01T00:00:00.000Z — add_calendar: test\n');

    const mounts = buildMounts(agentGroup, session, containerConfig, 'claude', providerContribution);

    expect(mounts).toContainEqual({
      hostPath: SELF_MOD_LOG_PATH,
      containerPath: '/workspace/agent/self-mod-log.md',
      readonly: true,
    });
  });

  it('adds no self-mod-log.md mount when the file does not exist', () => {
    expect(fs.existsSync(SELF_MOD_LOG_PATH)).toBe(false);

    const mounts = buildMounts(agentGroup, session, containerConfig, 'claude', providerContribution);

    expect(mounts.some((m) => m.containerPath === '/workspace/agent/self-mod-log.md')).toBe(false);
  });
});
