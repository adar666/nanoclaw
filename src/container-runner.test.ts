import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  getActiveContainerCount,
  hardeningArgs,
  isRetryableMountRace,
  killAllActiveContainers,
  resolveProviderName,
} from './container-runner.js';

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
  // Every genuinely-populated case (a real spawnContainer call, which sets
  // activeContainers) needs a real `spawn()`/Docker call this file's own
  // existing tests don't mock — out of scope here, matching this file's
  // established convention of only testing this module's pure/structural
  // functions directly. What's cheaply and safely testable without that:
  // the no-op case, which is also the ONLY case this module's own real
  // callers (eval/cli.ts, eval/sweep.ts) exercise in their own mocked unit
  // tests — see cli.test.ts's/sweep.test.ts's own coverage of "is called
  // exactly once" for the call-site contract; this only proves the function
  // itself doesn't throw or misbehave against an empty map, which is this
  // test file's own process-global state in every other test here too.
  it('does nothing and does not throw when no container is currently tracked', () => {
    expect(getActiveContainerCount()).toBe(0);
    expect(() => killAllActiveContainers('test')).not.toThrow();
    expect(getActiveContainerCount()).toBe(0);
  });
});
