# Telegram Bridge → call.sh Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the Telegram bridge's recorder through negotiator's `call.sh` (not `run.sh`), make it report `call.sh`'s real outcome instead of assuming success, and let it resolve a Hebrew project nickname to a real `~/Projects/<dir>` via an explicit alias map before starting.

**Architecture:** Two repos, sequenced. Tasks 1-4 change `negotiator` (`call.sh` + its gate-test fixtures) to (a) forward `--them` for parity with the old `run.sh` path, (b) echo the keyterms it resolved to its own stdout, and (c) refuse to report a successful `end` when the session produced no usable transcript. Tasks 5-7 change `nanoclaw-v2` (the bridge) to call `call.sh` instead of `run.sh`, add a `project` field the agent extracts verbatim from the user's message, resolve it through a static alias map (never fuzzy-matched), and surface `call.sh`'s real stdout/stderr to Telegram instead of a generic message.

**Tech Stack:** bash (`call.sh`, gate tests via `runProcessWithTimeout`), Node (`fake-process.js` fixture), TypeScript + Vitest (`nanoclaw-v2/src`), TypeScript + `bun:test` (`nanoclaw-v2/container`).

## Global Constraints

- `--topic` is required by `call.sh`; the bridge must never fail a start over a missing one — fall back to a derived default.
- `--skip-preflight` must never be passed automatically by the bridge — a blocked preflight is a real failure to report, not something to route around.
- The project alias map is an **explicit lookup table**, never fuzzy/substring matching. An alias that matches nothing warns and continues without project context — it must never block a recording.
- Every failure path (preflight block, G33 rollback, a session with zero utterances) must reach Telegram with the real `call.sh`/`run.js` text, not a generic "failed" message.
- A recording that produced no utterances must never be confirmed as ingested — this is the exact regression being fixed (2026-08-09: FATAL + exit 1, bridge said "2 events ingested, you can ask about them").

---

## Task 1: `call.sh start` — forward `--them`, persist the capture log path, echo keyterms

**Files:**
- Modify: `negotiator/call.sh:33-35` (usage), `negotiator/call.sh:96-113` (arg parsing), `negotiator/call.sh:138-139` (keyterms), `negotiator/call.sh:182-197` (run_args + capture_log)

**Interfaces:**
- Produces: `call.sh start` now accepts `--them <name>` (forwarded to `run.js` as `--them`, matching its existing flag — see `run.js:91`). Prints `[call] keyterms: <comma-list-or-<none>>` to stdout. Writes the active session's capture log path to `.run/call-capture.logpath` for Task 2 to read.

- [ ] **Step 1: Add `--them` to arg parsing and usage**

In `call.sh`, change the usage line:

```bash
usage() {
  echo "usage: $0 start --topic \"<text>\" [--project <name>] [--them <name>] [--lang he|en] [--skip-preflight] | end [--no-debrief] | status" >&2
}
```

In the `start)` case, add `them=""` alongside the other vars and a `--them` branch:

```bash
    shift || true
    topic=""
    project=""
    them=""
    lang="he"
    skip_preflight=false
    while [ $# -gt 0 ]; do
      case "$1" in
        --topic) topic="${2:-}"; shift 2 ;;
        --project) project="${2:-}"; shift 2 ;;
        --them) them="${2:-}"; shift 2 ;;
        --lang) lang="${2:-}"; shift 2 ;;
        --skip-preflight) skip_preflight=true; shift ;;
        *) echo "[call] unknown argument: $1" >&2; usage; exit 1 ;;
      esac
    done
```

- [ ] **Step 2: Forward `--them` into `run_args`, and echo the resolved keyterms**

Change the `run_args` block:

```bash
    run_args=(--lang "$lang")
    if [ -n "$them" ]; then
      run_args+=(--them "$them")
    fi
    if [ -n "$decoded_context" ]; then
      run_args+=(--context "$decoded_context")
    fi
    if [ -n "$keyterms_val" ]; then
      run_args+=(--keyterms "$keyterms_val")
    fi
```

Right after `keyterms_val` is computed (after line 139 in the current file), add:

```bash
    echo "[call] keyterms: ${keyterms_val:-<none>}"
```

- [ ] **Step 3: Persist the capture log path for `end` to find later**

Right after `capture_log="logs/call-capture-$ts.log"` is assigned, add:

```bash
    echo "$capture_log" > .run/call-capture.logpath
```

- [ ] **Step 4: Manually verify**

```bash
cd negotiator
NEGOTIATOR_RUN_CMD='node scripts/fixtures/fake-process.js capture' \
NEGOTIATOR_UI_CMD='node scripts/fixtures/fake-process.js ui' \
NEGOTIATOR_NOTES_CMD='node scripts/fixtures/fake-process.js notes' \
NEGOTIATOR_PREFLIGHT_CMD='node scripts/fixtures/fake-preflight.js' \
./call.sh start --topic "manual check" --them "דניס"
cat .run/call-capture.logpath
grep -- '--them' "$(cat .run/call-capture.logpath)"
```

Expected: `.run/call-capture.logpath` contains a path under `logs/`; that log's `[fake-process] argv:` line contains `"--them","דניס"`; stdout printed a `[call] keyterms: <none>` line.

- [ ] **Step 5: Clean up and commit**

```bash
NEGOTIATOR_RUN_CMD='node scripts/fixtures/fake-process.js capture' \
NEGOTIATOR_UI_CMD='node scripts/fixtures/fake-process.js ui' \
NEGOTIATOR_NOTES_CMD='node scripts/fixtures/fake-process.js notes' \
./call.sh end --no-debrief
git add call.sh
git commit -m "call.sh: forward --them, echo resolved keyterms, persist capture log path"
```

---

## Task 2: `call.sh end` — refuse to report success when the session produced no usable transcript

**Files:**
- Modify: `negotiator/call.sh:226-242` (the `end)` case, before the `no_debrief` branch)

**Interfaces:**
- Consumes: `.run/call-capture.logpath` (Task 1), the `utterances=N` line and any `FATAL`/`[FATAL]` line `run.js`'s own shutdown path writes into that log (see `run.js:211-214`, `run.js:234-236`, `run.js:334`).
- Produces: `call.sh end` exits 1 (stderr carries `RECORDING FAILED` + the verbatim FATAL text) when the capture log shows zero utterances or a FATAL abort. Exits 0 as before otherwise.

- [ ] **Step 1: Add the check, right after capture is stopped, before the `no_debrief` branch**

In the `end)` case, right after `echo "[call] stopping notes..."` / `stop_proc "$NOTES_PIDFILE"` (existing lines), change the start of the block to capture whether there was a capture pidfile and the logged path *before* stopping it, then add the check after `stop_proc "$RUN_PIDFILE"`:

```bash
  end)
    no_debrief=false
    for a in "${@:2}"; do
      if [ "$a" = "--no-debrief" ]; then no_debrief=true; fi
    done

    had_capture=false
    [ -f "$RUN_PIDFILE" ] && had_capture=true
    capture_log_path=""
    if [ -f .run/call-capture.logpath ]; then
      capture_log_path=$(cat .run/call-capture.logpath)
    fi
    rm -f .run/call-capture.logpath

    echo "[call] stopping notes..."
    stop_proc "$NOTES_PIDFILE"
    echo "[call] stopping ui..."
    stop_proc "$UI_PIDFILE"
    echo "[call] stopping capture..."
    stop_proc "$RUN_PIDFILE"

    # G56 — a session that produced no usable transcript (a FATAL abort, or
    # genuinely zero utterances) must never be reported as a successful
    # stop. This is the exact bug from 2026-08-09: run.js exited 1 with
    # FATAL logged, and the Telegram bridge still said "2 events ingested,
    # you can ask about them" because nothing downstream ever looked at
    # what run.js actually reported before it exited — only at whether the
    # shell commands around it returned zero.
    if $had_capture && [ -n "$capture_log_path" ] && [ -f "$capture_log_path" ]; then
      fatal_line=$(grep -m1 -E '^\[FATAL\]|^FATAL:' "$capture_log_path" || true)
      utterances=$(grep -oE 'utterances=[0-9]+' "$capture_log_path" | tail -n1 | cut -d= -f2 || true)
      if [ -n "$fatal_line" ] || [ "${utterances:-0}" = "0" ]; then
        echo "[call] RECORDING FAILED — session produced no usable transcript." >&2
        if [ -n "$fatal_line" ]; then
          echo "$fatal_line" >&2
        else
          echo "FATAL: zero utterances were transcribed (utterances=${utterances:-0})." >&2
        fi
        echo "[call] full detail: $capture_log_path" >&2
        exit 1
      fi
    fi

    if [ "$no_debrief" = true ]; then
      echo "[call] debrief skipped (--no-debrief)"
      exit 0
    fi
```

(The rest of the `end)` case — the `latest`/debrief block — is unchanged.)

- [ ] **Step 2: Commit**

```bash
git add call.sh
git commit -m "call.sh end: fail loudly when a session produced zero utterances (G56)"
```

*(Verified together with Task 3/4's gate tests — bash has no unit-test story here, the gate script IS the test.)*

---

## Task 3: `fake-process.js` capture role — emit a real `utterances=` line, and a `--fatal` mode

**Files:**
- Modify: `negotiator/scripts/fixtures/fake-process.js`

**Interfaces:**
- Produces: on SIGTERM, capture role prints a shutdown line shaped like `run.js`'s real one. Default: healthy (`utterances=3`, exit 0). With `--fatal`: `FATAL: simulated abort — audio was captured but zero utterances were transcribed.` + `utterances=0`, exit 1. This is required so Task 2's new check doesn't fail the 8 existing gates that call `end` (none of them currently print an `utterances=` line at all).

- [ ] **Step 1: Replace the SIGTERM/SIGINT handlers for the capture role only**

Current file ends with generic handlers shared by all three roles:

```js
console.log(readyLine);
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 1000); // keep the event loop alive until killed
```

Replace with:

```js
console.log(readyLine);

const fatal = process.argv.includes('--fatal');

// Only the capture role's shutdown output matters to call.sh's G56 check
// (it greps logs/call-capture-*.log for utterances=/FATAL) — ui and notes
// exit plainly, same as before.
function shutdown() {
  if (role === 'capture') {
    if (fatal) {
      console.error('FATAL: simulated abort — audio was captured but zero utterances were transcribed.');
      console.log('[session] bytesSent self=500 remote=500, droppedChunks self=0 remote=0, utterances=0');
      process.exit(1);
    }
    console.log('[session] bytesSent self=1000 remote=1000, droppedChunks self=0 remote=0, utterances=3');
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 1000); // keep the event loop alive until killed
```

- [ ] **Step 2: Update the file's header comment to mention `--fatal`**

Change the usage line comment to: `// usage: node fake-process.js <capture|ui|notes> [--fail] [--fatal (capture only)]`

- [ ] **Step 3: Commit**

```bash
git add scripts/fixtures/fake-process.js
git commit -m "fake-process.js: simulate real utterances=/FATAL shutdown output for call.sh's G56 check"
```

---

## Task 4: Gate tests — G56 (honest failure) and G57 (`--them` + keyterms echo)

**Files:**
- Create: `negotiator/scripts/gate-g56-honest-stop.js`
- Create: `negotiator/scripts/gate-g57-them-keyterms.js`

**Interfaces:**
- Consumes: `runProcessWithTimeout` from `../src/tier2.js` (same helper every other gate uses).

- [ ] **Step 1: Write `gate-g56-honest-stop.js`**

```js
import { runProcessWithTimeout } from '../src/tier2.js';

// G56 — a capture process that aborts with FATAL (zero utterances) must
// make `call.sh end` fail loudly, not report success. Fixes the real bug
// from 2026-08-09: run.js exited 1 with FATAL logged, and the Telegram
// bridge still said "2 events ingested, you can ask about them" because
// nothing downstream ever looked at what run.js actually reported.

process.env.NEGOTIATOR_RUN_CMD = 'node scripts/fixtures/fake-process.js capture --fatal';
process.env.NEGOTIATOR_UI_CMD = 'node scripts/fixtures/fake-process.js ui';
process.env.NEGOTIATOR_NOTES_CMD = 'node scripts/fixtures/fake-process.js notes';
process.env.NEGOTIATOR_PREFLIGHT_CMD = 'node scripts/fixtures/fake-preflight.js';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   - ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL - ${name}`);
    if (detail) console.log(`       ${detail}`);
  }
}

async function main() {
  const start = await runProcessWithTimeout({ command: './call.sh', args: ['start', '--topic', 'G56 fatal abort'], timeoutMs: 20000 });
  console.log('=== ./call.sh start ===');
  console.log(start.stdout);
  check('G56a. start succeeds (--fatal only fires on stop)', start.status === 'ready' && start.exitCode === 0, JSON.stringify(start));

  const end = await runProcessWithTimeout({ command: './call.sh', args: ['end', '--no-debrief'], timeoutMs: 20000 });
  console.log('\n=== ./call.sh end ===');
  console.log(end.stdout);
  console.error(end.stderr);
  check('G56b. end exits non-zero', end.status === 'ready' && end.exitCode !== 0, JSON.stringify(end));
  check('G56c. FATAL text surfaced verbatim on stderr', /FATAL: simulated abort/.test(end.stderr), end.stderr);
  check('G56d. explicitly labeled a failed recording, not a quiet stop', /RECORDING FAILED/.test(end.stderr), end.stderr);

  const status = await runProcessWithTimeout({ command: './call.sh', args: ['status'], timeoutMs: 5000 });
  check(
    'G56e. nothing left running after the failed end',
    /capture: not running/.test(status.stdout) && /ui: not running/.test(status.stdout) && /notes: not running/.test(status.stdout),
    status.stdout,
  );

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  } else {
    console.log('all gate checks passed');
    process.exit(0);
  }
}

main();
```

- [ ] **Step 2: Run it, confirm it fails before Task 1-3 land (or passes cleanly after — run after implementing Tasks 1-3)**

```bash
node scripts/gate-g56-honest-stop.js
```

Expected (after Tasks 1-3 are implemented): `all gate checks passed`, exit 0.

- [ ] **Step 3: Write `gate-g57-them-keyterms.js`**

```js
import { readFileSync, readdirSync } from 'node:fs';
import { runProcessWithTimeout } from '../src/tier2.js';

// G57 — call.sh forwards --them to run.js (parity with the old run.sh
// path the Telegram bridge used to call directly) and echoes the
// keyterms it resolved from --project to its own stdout, so a caller
// that only sees call.sh's output (the bridge) can relay both back to
// Telegram before confirming the recording is live. Uses --project
// negotiator (this repo itself) rather than a synthetic fixture dir,
// same trick gate-g43 uses — call.sh's --project always resolves under
// the real $HOME/Projects, which can't be redirected via env var.

process.env.NEGOTIATOR_RUN_CMD = 'node scripts/fixtures/fake-process.js capture';
process.env.NEGOTIATOR_UI_CMD = 'node scripts/fixtures/fake-process.js ui';
process.env.NEGOTIATOR_NOTES_CMD = 'node scripts/fixtures/fake-process.js notes';
process.env.NEGOTIATOR_PREFLIGHT_CMD = 'node scripts/fixtures/fake-preflight.js';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`ok   - ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL - ${name}`);
    if (detail) console.log(`       ${detail}`);
  }
}

async function main() {
  const start = await runProcessWithTimeout({
    command: './call.sh',
    args: ['start', '--topic', 'G57 them+keyterms', '--project', 'negotiator', '--them', 'דניס'],
    timeoutMs: 20000,
  });
  console.log('=== ./call.sh start --project negotiator --them דניס ===');
  console.log(start.stdout);
  console.error(start.stderr);
  check('G57a. start succeeds', start.status === 'ready' && start.exitCode === 0, JSON.stringify(start));
  check('G57b. keyterms line echoed to stdout', /^\[call\] keyterms: /m.test(start.stdout), start.stdout);

  const captureLogs = readdirSync('logs').filter((f) => f.startsWith('call-capture-') && f.endsWith('.log')).sort();
  const latestCaptureLog = captureLogs[captureLogs.length - 1];
  const captureLogContent = latestCaptureLog ? readFileSync(`logs/${latestCaptureLog}`, 'utf8') : '';
  check(
    "G57c. --them reached run.js's argv, not swallowed by call.sh",
    captureLogContent.includes('--them') && captureLogContent.includes('דניס'),
    captureLogContent,
  );

  const end = await runProcessWithTimeout({ command: './call.sh', args: ['end', '--no-debrief'], timeoutMs: 20000 });
  console.log('\n=== cleanup: end ===');
  console.log(end.stdout);
  check('G57d. cleanup end exits 0 (healthy capture, real utterances)', end.status === 'ready' && end.exitCode === 0, JSON.stringify(end));

  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  } else {
    console.log('all gate checks passed');
    process.exit(0);
  }
}

main();
```

- [ ] **Step 4: Run it**

```bash
node scripts/gate-g57-them-keyterms.js
```

Expected: `all gate checks passed`, exit 0.

- [ ] **Step 5: Re-run the pre-existing gates that exercise `end` to confirm no regression**

```bash
for g in g31 g32 g35 g36 g37 g43-hq-profiles g45 g48; do
  echo "=== gate-$g ==="
  node scripts/gate-$g.js || echo "REGRESSION in gate-$g"
done
```

Expected: every one prints `all gate checks passed`.

- [ ] **Step 6: Commit**

```bash
git add scripts/gate-g56-honest-stop.js scripts/gate-g57-them-keyterms.js
git commit -m "add G56 (honest end failure) and G57 (--them/keyterms echo) gate tests"
```

---

## Task 5: `start_recorder` MCP tool — add `project` (raw, unresolved)

**Files:**
- Modify: `nanoclaw-v2/container/agent-runner/src/mcp-tools/recorder.ts`
- Create: `nanoclaw-v2/container/agent-runner/src/mcp-tools/recorder.test.ts`

**Interfaces:**
- Produces: `start_recorder`'s tool schema gains optional `project: string`. The system message it writes gains an optional `project` field (omitted, not empty-string, when not given) — `apply.ts` (Task 9) reads `content.project`.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * start_recorder MCP tool: `project` is optional raw text extracted from
 * whatever the user said (e.g. "פאפי") — this tool does NOT resolve it to
 * a directory; that happens on the host in
 * src/modules/recorder/project-aliases.ts, deterministically, never here.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { startRecorder } from './recorder.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('start_recorder MCP tool', () => {
  it('accepts an optional project field and writes it through untouched', async () => {
    await startRecorder.handler({ them: 'דניס', context: 'HoursReportWebApp', project: 'פאפי' });

    const [msg] = getUndeliveredMessages();
    const content = JSON.parse(msg.content);
    expect(content).toEqual({ action: 'recorder_start', them: 'דניס', context: 'HoursReportWebApp', project: 'פאפי' });
  });

  it('omits project entirely when not given, rather than writing an empty string', async () => {
    await startRecorder.handler({ them: 'דניס', context: 'HoursReportWebApp' });

    const [msg] = getUndeliveredMessages();
    const content = JSON.parse(msg.content);
    expect(content.project).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd nanoclaw-v2/container && bun test agent-runner/src/mcp-tools/recorder.test.ts
```

Expected: FAIL — `project` isn't in the schema/handler yet.

- [ ] **Step 3: Implement**

Replace `startRecorder`'s definition in `recorder.ts`:

```ts
export const startRecorder: McpToolDefinition = {
  tool: {
    name: 'start_recorder',
    description:
      'Start recording the current call (mic + system audio loopback — works for any call app: Zoom, Meet, WhatsApp, phone-on-speaker, doesn\'t matter which). Call this when the user says they\'re starting or joining a call, or explicitly asks you to start recording. Extract `them` and `context` from what they actually said. If they mention a project by name or nickname (e.g. "לגבי פאפי", "about HoursReportWebApp"), pass it as `project` VERBATIM — do not guess or normalize it into a real directory name yourself, the host resolves that deterministically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        them: { type: 'string', description: "Who the call is with — the other party's name, from the user's message." },
        context: { type: 'string', description: "One-line topic/subject of the call, from the user's message." },
        project: {
          type: 'string',
          description: 'Project name or nickname the call is about, exactly as the user said it — leave unset if not mentioned.',
        },
      },
      required: ['them', 'context'],
    },
  },
  async handler(args) {
    const them = args.them as string;
    const context = args.context as string;
    const project = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined;
    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'recorder_start', them, context, ...(project ? { project } : {}) }),
    });
    return ok("Requested. I'll confirm once it's actually recording — don't tell the user it's live yet.");
  },
};
```

- [ ] **Step 4: Run it, confirm it passes**

```bash
cd nanoclaw-v2/container && bun test agent-runner/src/mcp-tools/recorder.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/mcp-tools/recorder.ts container/agent-runner/src/mcp-tools/recorder.test.ts
git commit -m "start_recorder MCP tool: accept optional raw project nickname"
```

---

## Task 6: Project alias resolver — explicit map, never fuzzy

**Files:**
- Create: `nanoclaw-v2/src/modules/recorder/project-aliases.json`
- Create: `nanoclaw-v2/src/modules/recorder/project-aliases.ts`
- Create: `nanoclaw-v2/src/modules/recorder/project-aliases.test.ts`

**Interfaces:**
- Produces: `resolveProjectAlias(raw: string | undefined | null): { dir: string | null; warning: string | null }` — consumed by `apply.ts` (Task 9).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { resolveProjectAlias } from './project-aliases.js';

describe('resolveProjectAlias', () => {
  it('resolves a known alias to its real directory name', () => {
    expect(resolveProjectAlias('פאפי')).toEqual({ dir: 'pa-ai', warning: null });
  });

  it('returns dir: null, warning: null for an empty/absent alias', () => {
    expect(resolveProjectAlias('')).toEqual({ dir: null, warning: null });
    expect(resolveProjectAlias(undefined)).toEqual({ dir: null, warning: null });
    expect(resolveProjectAlias(null)).toEqual({ dir: null, warning: null });
  });

  it('warns and returns dir: null for an alias with no mapping, never blocks', () => {
    const result = resolveProjectAlias('some unknown nickname');
    expect(result.dir).toBeNull();
    expect(result.warning).toContain('Unknown project alias "some unknown nickname"');
  });

  it('trims whitespace before matching', () => {
    expect(resolveProjectAlias('  פאפי  ')).toEqual({ dir: 'pa-ai', warning: null });
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd nanoclaw-v2 && pnpm vitest run src/modules/recorder/project-aliases.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create the config file**

```json
{
  "פאפי": "pa-ai",
  "papi": "pa-ai"
}
```

- [ ] **Step 4: Implement the resolver**

```ts
/**
 * Explicit alias map from Hebrew/free-text project nicknames (as heard in
 * a Telegram message, e.g. "פאפי") to the real directory name under
 * ~/Projects that call.sh's --project expects. Deliberately NOT fuzzy —
 * every entry is an exact, human-reviewed mapping. An unmatched alias
 * warns and continues without project context (see apply.ts) — it never
 * blocks the recording, and it never guesses.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '../../log.js';

const ALIASES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'project-aliases.json');

function loadAliases(): Record<string, string> {
  try {
    const raw = readFileSync(ALIASES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    log.error('project-aliases.json is not a flat object — ignoring, no project aliases available', { path: ALIASES_PATH });
    return {};
  } catch (err) {
    log.error('failed to load project-aliases.json — continuing with no project aliases', { path: ALIASES_PATH, err });
    return {};
  }
}

// Loaded once at module init; edits to project-aliases.json take effect on
// next process restart, same tradeoff as any other static config file here.
const ALIASES = loadAliases();

export interface ProjectAliasResolution {
  /** Real directory name under ~/Projects, or null if unresolved. */
  dir: string | null;
  /** Set only when `raw` was non-empty but matched nothing. */
  warning: string | null;
}

export function resolveProjectAlias(raw: string | undefined | null): ProjectAliasResolution {
  const alias = typeof raw === 'string' ? raw.trim() : '';
  if (!alias) return { dir: null, warning: null };

  const dir = ALIASES[alias];
  if (dir) return { dir, warning: null };

  return {
    dir: null,
    warning: `Unknown project alias "${alias}" — no mapping in project-aliases.json. Continuing without project context.`,
  };
}
```

- [ ] **Step 5: Run it, confirm it passes**

```bash
cd nanoclaw-v2 && pnpm vitest run src/modules/recorder/project-aliases.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/recorder/project-aliases.json src/modules/recorder/project-aliases.ts src/modules/recorder/project-aliases.test.ts
git commit -m "recorder: explicit project-alias resolver (never fuzzy)"
```

---

## Task 8: `project-context.js` — status doc + non-boilerplate identity doc, weighted and logged

**Files:**
- Modify: `negotiator/src/project-context.js`
- Modify: `negotiator/scripts/test-project-context.js`

**Interfaces:**
- Produces: `loadProjectContext`'s scraping fallback (used whenever a project has no hq profile — the pa-ai case) now combines up to two sources instead of one: `NEXT_STEPS.md` (status, capped at 800 chars) + an identity doc (`README.md`, unless it's an untouched scaffold template, else `CLAUDE.md`'s intro section only — up to, not including, its second `## ` heading). Total still hard-capped at the existing `MAX_CONTEXT_CHARS` (2000) — unchanged constant, unchanged downstream contract. Logs source selection + char counts to stderr (flows through `call.sh` into the Telegram bridge's captured stderr — see Task 9's `extractProjectWarnings`, though this line isn't a warning and isn't parsed by it).
- Consumes: nothing new — same `projectDir` input as before.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-project-context.js`, before the final `fs.rmSync(tmpDir, ...)` line:

```js
// 12. A boilerplate README (create-next-app's default) is skipped in
//     favor of CLAUDE.md, not read verbatim as project background.
{
  const dir = path.join(tmpDir, 'boilerplate-readme');
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    "This is a [Next.js](https://nextjs.org) project bootstrapped with `create-next-app`.\n\n## Getting Started\n\nnpm run dev\n",
  );
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Widgetsoft\n\n## What is Widgetsoft\nA thing that makes widgets.\n\n## Testing\nnpx tsc --noEmit\n');

  const originalError = console.error;
  const stderrLines = [];
  console.error = (msg) => stderrLines.push(String(msg));
  const result = loadProjectContext(dir);
  console.error = originalError;

  check('12a. boilerplate README skipped, CLAUDE.md used instead', result.context.includes('Widgetsoft') && !result.context.includes('create-next-app'), JSON.stringify(result));
  check('12b. CLAUDE.md sliced to its intro, dev-policy section excluded', !result.context.includes('tsc --noEmit'), JSON.stringify(result));
  check('12c. log line records the boilerplate skip', stderrLines.some((l) => l.includes('README skipped')), JSON.stringify(stderrLines));
}

// 13. NEXT_STEPS.md (status) and README.md (identity) both present ->
//     both contribute, status first.
{
  const dir = path.join(tmpDir, 'status-plus-identity');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'Widgetsoft: a thing that makes widgets.');
  fs.writeFileSync(path.join(dir, 'NEXT_STEPS.md'), 'Ship the blue widget by Friday.');

  const result = loadProjectContext(dir);
  check('13a. status contributes', result.context.includes('Ship the blue widget'), JSON.stringify(result));
  check('13b. identity contributes', result.context.includes('Widgetsoft: a thing'), JSON.stringify(result));
  check('13c. status comes first', result.context.indexOf('Ship the blue widget') < result.context.indexOf('Widgetsoft:'), result.context);
}

// 14. Identity doc with zero `##` headings -> whole doc used (capped),
//     never empty just because there's no second heading to cut at.
{
  const dir = path.join(tmpDir, 'no-headings');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'A plain README with no markdown headings at all, just prose.');
  const result = loadProjectContext(dir);
  check('14. no-heading doc used whole (capped), not empty', result.context === 'A plain README with no markdown headings at all, just prose.', JSON.stringify(result));
}

// 15. Identity doc whose first section alone exceeds the budget -> capped
//     to the budget, not empty, not the whole (much longer) file.
{
  const dir = path.join(tmpDir, 'huge-first-section');
  fs.mkdirSync(dir);
  const hugeFirstSection = 'x'.repeat(3000);
  fs.writeFileSync(path.join(dir, 'README.md'), `# Title\n\n${hugeFirstSection}\n\n## Second Section\n\nshould never appear`);
  const result = loadProjectContext(dir);
  check('15a. capped, not empty', result.context.length > 0 && result.context.length <= 2000, `got ${result.context.length}`);
  check('15b. never reaches the second section', !result.context.includes('should never appear'), result.context);
}

// 16. Log line reports char counts for both sources, so a project that
//     silently contributes almost nothing is visible at session start.
{
  const dir = path.join(tmpDir, 'log-check');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'short identity');
  fs.writeFileSync(path.join(dir, 'NEXT_STEPS.md'), 'short status');

  const originalError = console.error;
  const stderrLines = [];
  console.error = (msg) => stderrLines.push(String(msg));
  loadProjectContext(dir);
  console.error = originalError;

  check(
    '16. log line names both sources with char counts',
    stderrLines.some((l) => /status=NEXT_STEPS\.md \(\d+ chars\)/.test(l) && /identity=README\.md \(\d+ chars\)/.test(l)),
    JSON.stringify(stderrLines),
  );
}
```

- [ ] **Step 2: Run it, confirm the new checks fail**

```bash
cd negotiator && node scripts/test-project-context.js
```

Expected: checks 1-11 still pass (behavior for their fixtures is unchanged — verified by hand above), checks 12-16 FAIL.

- [ ] **Step 3: Implement**

Replace `src/project-context.js` in full:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// call.sh's --project support: read a project's status (NEXT_STEPS.md) and
// identity (README.md, or CLAUDE.md's intro if README is untouched
// scaffold boilerplate) into --context/--keyterms for run.js's EXISTING
// plumbing. Falls back to this scraping ONLY when hq has not generated a
// profile for the project (see loadProjectContext below).

const MAX_CONTEXT_CHARS = 2000;
// NEXT_STEPS.md is meant to be a short status list — capped separately so
// one unusually long one can't crowd the identity doc out of the budget
// entirely (see loadProjectContext).
const STATUS_MAX_CHARS = 800;
const MAX_KEYTERMS = 25;

export function findProjectDoc(projectDir) {
  for (const name of ['README.md', 'CLAUDE.md']) {
    const p = path.join(projectDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// create-next-app's default template opens with this exact sentence —
// reading it verbatim would feed npm-install instructions into the call
// context as if they were project background. Extend this list as other
// scaffolds are hit in practice; a false negative here just means a
// boilerplate README slips through once, not a broken pipeline.
const README_BOILERPLATE_SIGNATURES = ['bootstrapped with', 'create-next-app', 'create-react-app'];

function isBoilerplateReadme(raw) {
  const head = raw.slice(0, 400).toLowerCase();
  return README_BOILERPLATE_SIGNATURES.some((sig) => head.includes(sig));
}

// Content up to (not including) the second `## ` heading — keeps a doc's
// intro/first section, drops whatever comes after (dev conventions, design
// tokens, commit policy...) without needing to know their names. A doc
// with 0 or 1 such headings degrades to the whole doc, not an empty
// string; always capped so a single huge section still degrades to a
// bounded slice, never the entire file (checks 14/15 in
// scripts/test-project-context.js).
function firstSectionSlice(raw, cap) {
  const headingRe = /^##\s+.*$/gm;
  let match;
  let count = 0;
  let cutAt = raw.length;
  while ((match = headingRe.exec(raw)) !== null) {
    count += 1;
    if (count === 2) {
      cutAt = match.index;
      break;
    }
  }
  return raw.slice(0, Math.min(cutAt, cap)).trim();
}

// The project's "identity" doc: README.md, unless it's an unmodified
// scaffold template, in which case CLAUDE.md (dev-instructions, but its
// intro section still names the project) is used instead. Returns null
// when neither exists; returns { path: null, raw: '', readmeSkipped: true }
// when README is boilerplate and there's no CLAUDE.md to fall back to.
function findIdentityDoc(projectDir) {
  const readmePath = path.join(projectDir, 'README.md');
  let readmeSkipped = false;
  if (fs.existsSync(readmePath)) {
    const raw = fs.readFileSync(readmePath, 'utf8');
    if (!isBoilerplateReadme(raw)) return { path: readmePath, raw, readmeSkipped: false };
    readmeSkipped = true;
  }
  const claudePath = path.join(projectDir, 'CLAUDE.md');
  if (fs.existsSync(claudePath)) {
    return { path: claudePath, raw: fs.readFileSync(claudePath, 'utf8'), readmeSkipped };
  }
  return readmeSkipped ? { path: null, raw: '', readmeSkipped: true } : null;
}

// Capitalised tokens (likely proper nouns / product names) plus words
// repeated 3+ times (likely this project's own technical vocabulary,
// regardless of casing). Deepgram's keyterm param rejects ':' — see
// src/keyterms.js — so that character is filtered out here too rather
// than surfacing as a downstream validation error for a term the user
// never typed themselves.
export function extractKeyterms(text) {
  const capWords = text.match(/\b[A-Z][A-Za-z0-9]{2,}\b/g) || [];
  const allWords = text.match(/\b[A-Za-z][\w.-]{2,}\b/g) || [];
  const counts = new Map();
  for (const w of allWords) counts.set(w, (counts.get(w) || 0) + 1);
  const repeated = [...counts.entries()].filter(([, c]) => c >= 3).map(([w]) => w);

  const seen = new Set();
  const out = [];
  for (const term of [...capWords, ...repeated]) {
    if (term.includes(':')) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

// hq/projects/<name>.profile.md — generated by hq's profiles.sh. Override
// exists ONLY so scripts/test-project-context.js can isolate itself from
// the real directory; production always uses the default.
export function hqProfilesDir() {
  return process.env.NEGOTIATOR_HQ_PROFILES_DIR || path.join(os.homedir(), 'Projects', 'hq', 'projects');
}

function parseHqProfile(raw) {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
  const keytermsMatch = body.match(/## keyterms\n([\s\S]*?)(?:\n## context\n|$)/);
  const contextMatch = body.match(/## context\n([\s\S]*)$/);
  const keyterms = keytermsMatch
    ? keytermsMatch[1].split('\n').map((s) => s.trim()).filter((s) => s && !s.includes(':'))
    : [];
  const context = contextMatch ? contextMatch[1].trim() : '';
  return { generatedFrom: fm.generated_from, keyterms, context: context.length ? context : null };
}

// Reads hq's generated profile for this project, if one exists, and
// returns { context, keyterms, docPath }, or null if there is no profile.
// Staleness is checked live (git rev-parse HEAD) and printed as a warning
// but NEVER blocks — a stale profile is used exactly like a fresh one.
function loadHqProfile(projectDir) {
  const name = path.basename(projectDir);
  const profilePath = path.join(hqProfilesDir(), `${name}.profile.md`);
  if (!fs.existsSync(profilePath)) return null;

  const parsed = parseHqProfile(fs.readFileSync(profilePath, 'utf8'));

  let head = null;
  try {
    head = execFileSync('git', ['-C', projectDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    head = null;
  }

  const fresh = parsed.generatedFrom && parsed.generatedFrom !== 'none' && head !== null && head === parsed.generatedFrom;
  if (!fresh) {
    const storedShort = parsed.generatedFrom && parsed.generatedFrom !== 'none' ? parsed.generatedFrom.slice(0, 7) : parsed.generatedFrom;
    const headShort = head ? head.slice(0, 7) : 'unknown';
    console.error(`[profile] ${name} is stale (generated at ${storedShort}, HEAD is ${headShort}) — using it; run ./profiles.sh build ${name} to refresh`);
  }

  return { context: parsed.context, keyterms: parsed.keyterms, docPath: profilePath };
}

// Scrapes NEXT_STEPS.md (status) + an identity doc (README.md, or
// CLAUDE.md's intro if README is boilerplate) when hq has no profile for
// this project. Logs exactly what was selected and how many chars each
// source contributed — same reason the byte-rate watchdog exists: a
// project that silently contributes almost nothing should be visible in
// the run log, not discovered mid-call.
function scrapeProjectDocs(projectDir) {
  const statusPath = path.join(projectDir, 'NEXT_STEPS.md');
  const hasStatus = fs.existsSync(statusPath);
  const statusRaw = hasStatus ? fs.readFileSync(statusPath, 'utf8') : '';
  const statusSlice = hasStatus ? statusRaw.slice(0, STATUS_MAX_CHARS).trim() : '';

  const identity = findIdentityDoc(projectDir);
  const identityBudget = Math.max(0, MAX_CONTEXT_CHARS - statusSlice.length - (statusSlice.length ? 2 : 0));
  const identityRaw = identity ? identity.raw : '';
  const identitySlice = identity && identityRaw ? firstSectionSlice(identityRaw, identityBudget) : '';

  const combinedContext = [statusSlice, identitySlice].filter(Boolean).join('\n\n');
  const context = combinedContext.length ? combinedContext : null;

  const keytermsSource = [statusRaw, identityRaw].filter(Boolean).join('\n\n');
  const keyterms = keytermsSource ? extractKeyterms(keytermsSource) : [];

  const contributingPaths = [hasStatus ? statusPath : null, identity && identity.path ? identity.path : null].filter(Boolean);
  const docPath = contributingPaths.length ? contributingPaths.join(', ') : null;

  console.error(
    `[context] ${path.basename(projectDir)}: status=${hasStatus ? `NEXT_STEPS.md (${statusSlice.length} chars)` : 'none'}, ` +
      `identity=${identity && identity.path ? `${path.basename(identity.path)} (${identitySlice.length} chars)` : 'none'}` +
      (identity && identity.readmeSkipped ? ', README skipped (boilerplate template)' : ''),
  );

  return { context, keyterms, docPath };
}

// Returns { context, keyterms, docPath } for a project directory. Prefers
// hq's generated profile when one exists (staleness never blocks); falls
// back to scrapeProjectDocs (status + identity docs) when no profile
// exists. Never throws, since neither a missing profile nor missing docs
// may ever block a recording (see call.sh).
export function loadProjectContext(projectDir) {
  const profileResult = loadHqProfile(projectDir);
  if (profileResult) return profileResult;

  console.error(`[profile] no profile for ${path.basename(projectDir)} — falling back to README/CLAUDE.md/NEXT_STEPS.md scraping`);
  return scrapeProjectDocs(projectDir);
}
```

- [ ] **Step 4: Run it, confirm all checks (1-16) pass**

```bash
cd negotiator && node scripts/test-project-context.js
```

Expected: `all checks passed`, exit 0.

- [ ] **Step 5: Re-run gate-g43 (the other consumer of `loadProjectContext`) to confirm no regression**

```bash
node scripts/gate-g43-hq-profiles.js
```

Expected: `all gate checks passed`.

- [ ] **Step 6: Commit**

```bash
git add src/project-context.js scripts/test-project-context.js
git commit -m "project-context: weight NEXT_STEPS.md + non-boilerplate identity doc, log source selection"
```

---

## Task 9: `apply.ts` — route through call.sh, resolve project, report honestly

**Files:**
- Modify: `nanoclaw-v2/src/modules/recorder/apply.ts`
- Modify: `nanoclaw-v2/src/modules/recorder/recorder.test.ts`

**Interfaces:**
- Consumes: `resolveProjectAlias` (Task 6). `call.sh`'s stdout `[call] keyterms: ...` line and stderr `[call] warning: ...` lines (Task 1).
- Produces: unchanged public API (`applyRecorderStart`, `applyRecorderStop`, `stopAndIngest`, `RECORDER_MAX_DURATION_MS`) — only the implementation and the wording of `notifyAgent` calls change.

- [ ] **Step 1: Update the failing/changed tests first**

Replace the `applyRecorderStart` and `applyRecorderStop / stopAndIngest` describe blocks in `recorder.test.ts` (the `recorder guard` and `recorder_sessions db` blocks above them are unchanged — leave them exactly as they are in the current file). Also change the shared `beforeEach`'s default mock and the hoisted `mockExecFile` default to return a `call.sh`-shaped stdout instead of `'ok\n'`:

```ts
const { mockExecFile, mockNotifyAgent } = vi.hoisted(() => ({
  mockExecFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
    ) => {
      cb(null, { stdout: '[call] keyterms: <none>\nUI: http://localhost:8140\n', stderr: '' });
    },
  ),
  mockNotifyAgent: vi.fn(),
}));
```

```ts
beforeEach(() => {
  vi.clearAllMocks();
  mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
    cb(null, { stdout: '[call] keyterms: <none>\nUI: http://localhost:8140\n', stderr: '' }),
  );
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});
```

Replace the `describe('applyRecorderStart', ...)` block:

```ts
describe('applyRecorderStart', () => {
  it('invokes call.sh start with a fixed binary and them/context/topic as argv values, never a shell string', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'HoursReportWebApp' }, session);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = mockExecFile.mock.calls[0]!;
    expect(bin).toMatch(/call\.sh$/);
    expect(args).toEqual(['start', '--topic', 'HoursReportWebApp', '--lang', 'he', '--them', 'דניס']);
    // /opt/homebrew/bin isn't on NanoClaw's launchd job's PATH — negotiator's
    // call.sh backgrounds a bare `node run.js`, which in turn bare-spawns
    // ffmpeg — see apply.ts's SPAWN_ENV.
    expect((opts as { env?: Record<string, string> }).env?.PATH).toContain('/opt/homebrew/bin');
  });

  it('falls back to a derived topic when context is empty, rather than failing', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: '' }, session);

    const [, args] = mockExecFile.mock.calls[0]!;
    expect(args[args.indexOf('--topic') + 1]).toBe('Call with דניס');
  });

  it('resolves a known project alias to its real directory and passes --project', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x', project: 'פאפי' }, session);

    const [, args] = mockExecFile.mock.calls[0]!;
    expect(args).toContain('--project');
    expect(args[args.indexOf('--project') + 1]).toBe('pa-ai');
  });

  it('an unrecognized project alias warns and still starts, without --project', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x', project: 'שטויות' }, session);

    const [, args] = mockExecFile.mock.calls[0]!;
    expect(args).not.toContain('--project');
    expect(getRunningRecorderSession()).toBeDefined();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('Unknown project alias "שטויות"'));
  });

  it('relays the resolved project and keyterms to Telegram before confirming live', async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(null, { stdout: '[call] keyterms: negotiator,BlackHole\nUI: http://localhost:8140\n', stderr: '' }),
    );
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x', project: 'פאפי' }, session);

    expect(mockNotifyAgent).toHaveBeenCalledWith(
      session,
      expect.stringMatching(/Project: "פאפי" → pa-ai.*Keyterms: negotiator,BlackHole.*Recording started/s),
    );
  });

  it('records a running recorder_sessions row and notifies success', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'HoursReportWebApp' }, session);

    const running = getRunningRecorderSession();
    expect(running?.them).toBe('דניס');
    expect(running?.context).toBe('HoursReportWebApp');
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('started'));
  });

  it('refuses a second start without calling execFile again, and notifies instead', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockExecFile.mockClear();
    mockNotifyAgent.mockClear();

    await applyRecorderStart({ them: 'מישהו אחר', context: 'y' }, session);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('already running'));
  });

  it("surfaces call.sh's own stderr verbatim on failure — not a generic message — and creates no row", async () => {
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(new Error('Command failed with exit code 1'), {
        stdout: '',
        stderr: '[check] FAILED: system audio is not reaching BlackHole.\nThe other party will NOT be recorded.',
      }),
    );
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);

    expect(getRunningRecorderSession()).toBeUndefined();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('system audio is not reaching BlackHole'));
  });
});
```

Replace the `describe('applyRecorderStop / stopAndIngest', ...)` block:

```ts
describe('applyRecorderStop / stopAndIngest', () => {
  it('with nothing running: notifies "nothing to stop" and never calls execFile', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStop({}, session);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('nothing to stop'));
  });

  it('stops, marks the row stopped, chains into the second-brain ingest, and notifies "stopped"', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockExecFile.mockClear();
    mockNotifyAgent.mockClear();

    await applyRecorderStop({}, session);

    expect(mockExecFile).toHaveBeenCalledTimes(2); // call.sh end, then the ingest
    const [stopBin, stopArgs, stopOpts] = mockExecFile.mock.calls[0]!;
    expect(stopBin).toMatch(/call\.sh$/);
    expect(stopArgs).toEqual(['end']);
    expect((stopOpts as { env?: Record<string, string> }).env?.PATH).toContain('/opt/homebrew/bin');
    const [ingestBin, ingestArgs] = mockExecFile.mock.calls[1]!;
    expect(ingestArgs).toContain('--dir');
    expect(ingestArgs.some((a: string) => a.includes('ingest-recorder'))).toBe(true);
    void ingestBin;

    const running = getRunningRecorderSession();
    expect(running).toBeUndefined();
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('stopped'));
  });

  it('a call.sh end failure (no usable transcript) marks the row stopped, never runs ingest, and never says "ask about it"', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockNotifyAgent.mockClear();
    mockExecFile.mockImplementation((_file, _args, _opts, cb) =>
      cb(new Error('exit 1'), {
        stdout: '',
        stderr:
          '[call] RECORDING FAILED — session produced no usable transcript.\nFATAL: audio was captured but zero utterances were transcribed.',
      }),
    );

    await applyRecorderStop({}, session);

    expect(mockExecFile).toHaveBeenCalledTimes(1); // call.sh end only — ingest never runs
    expect(getRunningRecorderSession()).toBeUndefined(); // still marked stopped — processes ARE dead
    expect(mockNotifyAgent).toHaveBeenCalledWith(
      session,
      expect.stringContaining('FATAL: audio was captured but zero utterances were transcribed'),
    );
    expect(mockNotifyAgent).not.toHaveBeenCalledWith(session, expect.stringContaining('ready to ask about'));
  });

  it('a cap-triggered stop notifies with the auto-stop wording, distinct from a user stop', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockNotifyAgent.mockClear();

    await stopAndIngest(session, 'cap');

    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('auto-stopped'));
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('unprompted'));
  });

  it('reports an ingest failure without hiding that the stop itself succeeded', async () => {
    const session = fakeSession('ag-uriel');
    await applyRecorderStart({ them: 'דניס', context: 'x' }, session);
    mockNotifyAgent.mockClear();
    let call = 0;
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      call++;
      if (call === 1) return cb(null, { stdout: 'stopped\n', stderr: '' }); // call.sh end
      return cb(new Error('ingest crashed'), { stdout: '', stderr: '' }); // ingest
    });

    await applyRecorderStop({}, session);

    expect(getRunningRecorderSession()).toBeUndefined(); // stop side still recorded
    expect(mockNotifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('ingest into uriel.db FAILED'));
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd nanoclaw-v2 && pnpm vitest run src/modules/recorder/recorder.test.ts
```

Expected: FAIL — `apply.ts` still calls `run.sh` and has no project/topic logic.

- [ ] **Step 3: Rewrite `apply.ts`**

```ts
/**
 * Guarded handler bodies for recorder start/stop.
 *
 * Both bodies run negotiator's own call.sh — a fixed binary path, invoked
 * with an argv array (never a shell string), so the free-text values the
 * agent supplies (them/context/project) can only ever land as flag VALUES.
 * call.sh (not run.sh) is the entry point: it starts capture, the notes UI,
 * and notes.js as one orchestrated session, rolls all three back if any
 * fails to become ready (G33), runs a mandatory audio preflight before
 * starting (G45/G46 — BLOCKS on failure; see applyRecorderStart's error
 * path, never pass --skip-preflight automatically), and on `end` refuses
 * to report success for a session that produced no usable transcript
 * (G56 — see stopAndIngest's error path). See ./guard.ts for why this
 * never holds for approval.
 *
 * `stopAndIngest` is shared by the agent-triggered stop (recorder.stop) and
 * host-sweep's cap enforcement (./index.ts's sweepRecorderCap) — same
 * shutdown + ingest chain either way, only the notification wording and
 * the stored `stop_reason` differ.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import {
  createRecorderSession,
  getRunningRecorderSession,
  markRecorderSessionStopped,
  type RecorderSessionRow,
} from './db.js';
import { resolveProjectAlias } from './project-aliases.js';

const execFileAsync = promisify(execFile);

// Overridable for tests; real deployments are both repos checked out as
// siblings under ~/Projects (see hq's and second-brain's own defaults).
const NEGOTIATOR_ROOT = process.env.NEGOTIATOR_ROOT || join(homedir(), 'Projects', 'negotiator');
const SECOND_BRAIN_ROOT = process.env.SECOND_BRAIN_ROOT || join(homedir(), 'Projects', 'second-brain');
const NEGOTIATOR_LOGS_DIR = join(NEGOTIATOR_ROOT, 'logs');

// Homebrew on Apple Silicon lives at /opt/homebrew, which is NOT on
// NanoClaw's launchd job's PATH (/usr/local/bin:/usr/bin:/bin:/Users/uriel/.local/bin
// — confirmed via ~/Library/LaunchAgents/com.nanoclaw-v2-*.plist). call.sh
// backgrounds `node run.js` bare (resolves fine, /usr/local/bin/node is on
// that PATH) which in turn bare-spawns `ffmpeg` three levels down — NOT on
// that PATH. Every execFileAsync call below passes this widened PATH so
// the whole downstream chain inherits it, without touching the sibling
// negotiator repo.
const SPAWN_ENV = {
  ...process.env,
  PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin`,
};

// call.sh orchestrates three processes plus a mandatory preflight — a
// cold start (preflight + capture + ui + notes, each with up to
// NEGOTIATOR_CALL_READY_TIMEOUT_SEC=15s to become ready) can legitimately
// take longer than the old single-process run.sh path's 15s budget.
const CALL_START_TIMEOUT_MS = 60_000;
const CALL_END_TIMEOUT_MS = 60_000;

// 3 hours — a real meeting doesn't run longer than this; anything past it
// is almost certainly a forgotten "סיימתי". Enforced by host-sweep's
// sweepRecorderCap (./index.ts), not a setTimeout — survives a host
// restart mid-recording since it's derived from the DB row's started_at,
// not an in-memory timer.
export const RECORDER_MAX_DURATION_MS = 3 * 60 * 60 * 1000;

function newRecorderSessionId(): string {
  return `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function describe(row: Pick<RecorderSessionRow, 'them' | 'context'>): string {
  return row.context ? `${row.them}, re: ${row.context}` : row.them;
}

/** call.sh start echoes `[call] keyterms: <comma-list-or-<none>>` to
 *  stdout — this is the only way the bridge learns what keyterms a
 *  --project resolution actually produced, since that computation happens
 *  entirely inside call.sh/session-context.js. */
function extractKeyterms(stdout: string): string {
  const m = stdout.match(/^\[call\] keyterms: (.*)$/m);
  if (!m) return '';
  const val = m[1].trim();
  return val === '<none>' ? '' : val;
}

/** session-context.js warns to stderr (never stdout) when a --project dir
 *  doesn't exist on disk — surfaced here so an alias that resolves to a
 *  stale/renamed directory is still visible in the Telegram confirmation. */
function extractProjectWarnings(stderr: string): string[] {
  return (stderr.match(/^\[call\] warning:.*$/gm) ?? []).map((l) => l.replace(/^\[call\] warning:\s*/, ''));
}

function errorDetail(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  const detail = (e.stderr && e.stderr.trim()) || (e.stdout && e.stdout.trim());
  return detail || (err instanceof Error ? err.message : String(err));
}

export async function applyRecorderStart(content: Record<string, unknown>, session: Session): Promise<void> {
  const them = typeof content.them === 'string' && content.them.trim() ? content.them.trim() : 'Other party';
  const context = typeof content.context === 'string' ? content.context.trim() : '';
  const rawProject = typeof content.project === 'string' ? content.project.trim() : '';

  if (getRunningRecorderSession()) {
    notifyAgent(
      session,
      "Recorder is already running. Tell the user it's already recording — no need to start it again.",
    );
    return;
  }

  // call.sh's --topic is required; the tool's existing "one-line
  // topic/subject" field (context) already carries that in the vast
  // majority of cases — but never fail a start over a missing one.
  const topic = context || `Call with ${them}`;

  const { dir: projectDir, warning: projectWarning } = resolveProjectAlias(rawProject);

  const args = ['start', '--topic', topic, '--lang', 'he', '--them', them];
  if (projectDir) args.push('--project', projectDir);

  let result: { stdout: string; stderr: string };
  try {
    result = await execFileAsync(join(NEGOTIATOR_ROOT, 'call.sh'), args, {
      cwd: NEGOTIATOR_ROOT,
      timeout: CALL_START_TIMEOUT_MS,
      env: SPAWN_ENV,
    });
  } catch (err) {
    log.error('recorder.start failed', { err });
    notifyAgent(
      session,
      `Recorder failed to start: ${errorDetail(err)}. Tell the user it did NOT start — this includes a failed audio ` +
        `preflight (the other party would not have been recorded) or a component that never became ready; nothing is running.`,
    );
    return;
  }

  createRecorderSession({
    id: newRecorderSessionId(),
    agent_group_id: session.agent_group_id,
    session_id: session.id,
    them,
    context,
    started_at: new Date().toISOString(),
  });

  const keyterms = extractKeyterms(result.stdout);
  const stderrWarnings = extractProjectWarnings(result.stderr);

  const lines: string[] = [];
  if (rawProject) {
    lines.push(projectDir ? `Project: "${rawProject}" → ${projectDir}` : `Project: ${projectWarning}`);
    lines.push(`Keyterms: ${keyterms || 'none'}`);
  }
  if (stderrWarnings.length) lines.push(...stderrWarnings);
  lines.push(`Recording started (${describe({ them, context })}). UI: http://localhost:8140.`);

  log.info('Recorder started', { agentGroupId: session.agent_group_id, them, context, project: projectDir });
  notifyAgent(session, `${lines.join(' ')} Tell the user it's live and give them the UI link.`);
}

export async function applyRecorderStop(_content: Record<string, unknown>, session: Session): Promise<void> {
  await stopAndIngest(session, 'user');
}

export async function stopAndIngest(session: Session, reason: 'user' | 'cap'): Promise<void> {
  const running = getRunningRecorderSession();
  if (!running) {
    if (reason === 'user') {
      notifyAgent(session, "Recorder is not running. Tell the user there's nothing to stop.");
    }
    return;
  }

  let stopFailed: string | null = null;
  try {
    await execFileAsync(join(NEGOTIATOR_ROOT, 'call.sh'), ['end'], {
      cwd: NEGOTIATOR_ROOT,
      timeout: CALL_END_TIMEOUT_MS,
      env: SPAWN_ENV,
    });
  } catch (err) {
    // call.sh end exits non-zero when the session produced no usable
    // transcript (FATAL abort, or genuinely zero utterances — call.sh's
    // G56 check) as well as on an unexpected shell failure. The processes
    // are stopped either way (call.sh stops them before this check runs),
    // so the DB row below is still marked stopped — but ingest never
    // runs and the confirmation must say so plainly, never "ask about it".
    stopFailed = errorDetail(err);
  }

  markRecorderSessionStopped(running.id, new Date().toISOString(), reason);

  if (stopFailed) {
    log.error('recorder.stop: call.sh end reported a failed session', { err: stopFailed });
    notifyAgent(
      session,
      `Recording stopped, but it did NOT produce a usable transcript — nothing was ingested. ` +
        `Tell the user this plainly, do not say it's ready to ask about:\n\n${stopFailed}`,
    );
    return;
  }

  let ingestSummary: string;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [join(SECOND_BRAIN_ROOT, 'dist/bin/ingest-recorder.js'), '--dir', NEGOTIATOR_LOGS_DIR],
      { cwd: SECOND_BRAIN_ROOT, timeout: 60_000, env: SPAWN_ENV },
    );
    ingestSummary = stdout.trim().split('\n').filter(Boolean).pop() || 'ingested';
  } catch (err) {
    log.error('recorder stop: ingest into second-brain failed', { err });
    ingestSummary = `ingest into uriel.db FAILED (transcript is safe on disk at ${NEGOTIATOR_LOGS_DIR}) — retry manually: ${err instanceof Error ? err.message : String(err)}`;
  }

  const label = describe(running);
  if (reason === 'cap') {
    const hours = RECORDER_MAX_DURATION_MS / 3_600_000;
    notifyAgent(
      session,
      `Recording auto-stopped after hitting the ${hours}h cap (started ${running.started_at}, ${label}) — looks like "סיימתי" never came. ${ingestSummary}. Tell the user this happened, unprompted — a recording that ended without them asking is something they should know about, not discover later.`,
    );
  } else {
    notifyAgent(
      session,
      `Recording stopped (${label}). ${ingestSummary}. Tell the user it's done and ready to ask about.`,
    );
  }
}
```

- [ ] **Step 4: Run it, confirm it passes**

```bash
cd nanoclaw-v2 && pnpm vitest run src/modules/recorder/recorder.test.ts
```

Expected: PASS, all tests including the 4 `recorder guard` and 3 `recorder_sessions db` tests unchanged from before.

- [ ] **Step 5: Full nanoclaw-v2 test suite, confirm no cross-module regression**

```bash
cd nanoclaw-v2 && pnpm vitest run
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/recorder/apply.ts src/modules/recorder/recorder.test.ts
git commit -m "recorder: route through call.sh, resolve project alias, report call.sh's real outcome"
```

---

## Manual end-to-end check (after all 7 tasks)

Requires `~/Projects/negotiator` and `~/Projects/nanoclaw-v2` both on these changes, and negotiator's real `devices.json` configured (per its `SETUP.md`).

1. From Telegram (dm-with-uriel): "אני נכנס לשיחה בנוגע לפאפי עם דניס" → expect a confirmation naming `Project: "פאפי" → pa-ai`, its keyterms, and the UI URL (`http://localhost:8140`) — *before* "recording started".
2. Open `http://localhost:8140` — confirm the live notes UI renders (this never happened via the old `run.sh` path).
3. Say "סיימתי" → expect ingest confirmation naming utterance/segment counts, not a bare "done".
4. Repeat step 1, but pull the mic cable / mute at the OS level immediately after start, wait a few seconds, then "סיימתי" → expect the FATAL text verbatim in Telegram, explicitly saying nothing was ingested — not a generic failure, not a false "you can ask about it".
