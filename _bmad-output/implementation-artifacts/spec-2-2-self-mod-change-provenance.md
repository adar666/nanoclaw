---
title: 'Self-Mod Change Provenance'
type: 'feature'
created: '2026-09-01'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '6dd01da73152411352c3886c2e83545b5da3f96a'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A self-mod change (`install_packages`, `add_mcp_server`, `add_calendar`) leaves no durable trace today — the only "why" (an agent-supplied `reason`) lives in `pending_approvals`, a row deleted immediately on resolve, for every action type, not just self-mod.

**Approach:** Each apply handler appends one line to a new, capped, per-group log (`self-mod-log.md`) at apply time — reusing `run-log.ts`'s existing file-per-group markdown pattern, not the shared `pending_approvals` table (widening its blast radius onto every other approval-gated action was rejected at the architecture stage). Mounted read-only into the group's own container, host-only writer, so the agent can never tamper with its own audit trail.

## Boundaries & Constraints

**Always:** One line per applied change: `${at} — ${action}${reason ? ': ' + reason : ''}` (mirrors `run-log.ts`'s exact `${timestamp} — ${msg}` style). The file lives at `groups/<folder>/self-mod-log.md`, capped at `SELF_MOD_LOG_CAP` entries (oldest trimmed first). It is mounted **read-only** into its own group's container via a nested RO mount (same pattern as `container.json`/composed `CLAUDE.md` in `container-runner.ts`'s `buildMounts`) — conditional on the file existing, exactly like `container.json`'s own conditional mount. `pending_approvals` itself is left completely unchanged.

**Ask First:** None — fully specified.

**Never:** No backfill — a self-mod change applied before this ships has no log entry. No change to `pending_approvals`'s existing delete-on-resolve behavior (that table is shared by every approval-gated action in the system, not just self-mod — out of scope by design, per the architecture spine). No lock file for this write path — see Design Notes for why an explicit lock isn't needed here despite the sibling `shared-facts.md` write path (spec 1.1) needing one.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `install_packages` approved, with `reason` | Payload carries `apt`/`npm`/`reason` | One line appended: `<at> — install_packages: <reason>` | N/A |
| `add_mcp_server` approved (no `reason` field exists for this action) | Payload carries `name`/`command`/etc., no `reason` | One line appended: `<at> — add_mcp_server` (no trailing colon/reason) | N/A |
| `add_calendar` approved, with `reason` | Payload carries `name`/`calendarId`/`reason` | One line appended: `<at> — add_calendar: <reason>` | N/A |
| Log file doesn't exist yet (first self-mod change ever for this group) | No `groups/<folder>/self-mod-log.md` on disk | File is created with one line; no error | N/A |
| Log file already at `SELF_MOD_LOG_CAP` entries | A group with heavy self-mod history | Oldest entry(ies) trimmed before the new one is appended — file never exceeds the cap | N/A |
| Fresh container spawn, log file exists | `buildMounts` runs for a group with a real `self-mod-log.md` | Mounted read-only at `/workspace/agent/self-mod-log.md`, nested on top of the RW group mount | N/A |
| Fresh container spawn, log file doesn't exist yet | A group with zero self-mod history | No mount added for it — same conditional-existence pattern as `container.json` | N/A |

</frozen-after-approval>

## Code Map

- `src/modules/scheduling/run-log.ts` -- style precedent to mirror exactly: plain `fs.appendFileSync`, `${timestamp} — ${msg}\n` line format, no lock (single Node host process, synchronous handler body — matches this codebase's own already-investigated-and-closed reasoning for why a read-then-write in one synchronous function body needs no lock, `deferred-work.md`'s `config add-X` race finding).
- `src/modules/self-mod/self-mod-log.ts` -- NEW FILE. `export function appendSelfModLog(agentGroupId: string, action: string, reason?: string): void`. Resolves the group's folder via `getAgentGroup` (same as `run-log.ts`), reads the existing file (if any) into lines, trims to `SELF_MOD_LOG_CAP - 1` from the end if already at cap, appends the new `${new Date().toISOString()} — ${action}${reason ? ': ' + reason : ''}` line, writes the file back — all synchronous, one function body, no `await` between read and write (mirrors the reasoning above; no lock file).
- `src/modules/self-mod/apply.ts:25-87,89-130,132-175` -- all three apply functions (`applyInstallPackages`, `applyAddMcpServer`, `applyAddCalendar`). Add one `appendSelfModLog(agentGroup.id, '<action_name>', payload.reason as string | undefined)` call in each, right before (or alongside) the existing `log.info(...)` call — `add_mcp_server`'s payload has no `reason` field, so that call passes `undefined` (the I/O matrix's no-reason case).
- `src/container-runner.ts:504-509` -- `container.json`'s nested-RO-mount pattern is the exact shape to mirror for `self-mod-log.md`: `const selfModLogPath = path.join(groupDir, 'self-mod-log.md'); if (fs.existsSync(selfModLogPath)) { mounts.push({ hostPath: selfModLogPath, containerPath: '/workspace/agent/self-mod-log.md', readonly: true }); }` — placed alongside the `container.json` block, same conditional-existence convention.

## Tasks & Acceptance

**Execution:**
- [x] `src/modules/self-mod/self-mod-log.ts` -- new `appendSelfModLog` helper per Code Map -- the actual write path
- [x] `src/modules/self-mod/apply.ts` -- call it from all three apply functions -- captures provenance for every self-mod action type
- [x] `src/container-runner.ts` -- nested RO mount for `self-mod-log.md`, conditional on existence -- the agent can read but never tamper with its own audit trail
- [x] `src/modules/self-mod/self-mod-log.test.ts` (new) -- unit tests: appends correctly, caps at `SELF_MOD_LOG_CAP`, creates the file fresh when absent
- [x] `src/modules/self-mod/apply.test.ts` -- extend existing tests to assert each apply function calls `appendSelfModLog` with the right action name and reason (or `undefined` for `add_mcp_server`)
- [x] `src/container-runner.test.ts` -- extend existing mount tests: the RO mount appears when the file exists, is absent when it doesn't -- `pnpm test`
- [x] `src/modules/self-mod/apply.ts` -- **round 1 patch**: log only on rebuild success (install_packages); try/catch around every log call site
- [x] `src/modules/self-mod/self-mod-log.ts` -- **round 1 patch**: newline sanitization, 200-char stored-length cap, runtime type guard
- [x] `CLAUDE.md`, `self-mod.instructions.md` -- **round 1 patch**: mention the log file exists
- [x] `src/modules/self-mod/apply.test.ts`, `self-mod-log.test.ts` -- **round 1 patch**: rebuild-failure, log-write-failure, newline, and length-cap tests

**Acceptance Criteria:**
- Given `install_packages`/`add_calendar` approved with a `reason`, when `self-mod-log.md` is inspected, then the new line includes that reason
- Given `add_mcp_server` approved (no `reason` field exists for this action), when the log is inspected, then the new line has no trailing colon/empty reason text
- Given a group's log already has `SELF_MOD_LOG_CAP` entries, when one more change is applied, then the file still has exactly `SELF_MOD_LOG_CAP` entries — oldest dropped
- Given a fresh container spawn for a group with a real `self-mod-log.md`, when `buildMounts` runs, then that file is mounted read-only at `/workspace/agent/self-mod-log.md`

## Spec Change Log

- **Round 1 review (patch-only, no bad_spec loopback):** 3-layer review found no intent/spec defects. Real correctness bug caught: `applyInstallPackages` logged *before* the rebuild's try block, so a failed rebuild still produced a provenance entry claiming the change was applied — moved the log call to fire only after `buildAgentGroupImage` actually succeeds. Applied: try/catch around every `appendSelfModLog` call site (a log-write failure must never crash an apply that already mutated real config/killed the container — logs the error, never throws); newline sanitization (a literal `\n` in `reason` would otherwise fragment the file into extra "entries," corrupting the cap/trim logic); a 200-char stored-length cap on `reason`; a runtime type/emptiness guard inside `appendSelfModLog` itself (not just the caller's `as string` cast); `CLAUDE.md`'s Self-Modification section and `self-mod.instructions.md` both updated to mention the log file exists and how to read it. Deferred: `add_mcp_server`'s own schema having no `reason` field at all (pre-existing, separate scope); no `ncl` verb to read self-mod history (natural fit for Story 2.4's digest instead); no full request→approval→replay pipeline test for `reason`; the hardcoded cap with no operator override. Rejected: the "still-open race, one more shared mutable file" framing — `appendSelfModLog` is a single synchronous function body with no `await`; two calls (however concurrently their *callers* are scheduled) can never interleave inside it, by JS's own single-threaded execution model — same reasoning this codebase already established and closed for the `config add-X` race family (`deferred-work.md`).

## Design Notes

**Why no explicit lock, despite the architecture spine's AD-9 mentioning one:** the spine's own wording ("guarded by the same `withLock`/atomic-write discipline as AD-3") was carried over from `shared-facts.md`'s write path (spec 1.1), which is a genuinely different concern — that file can be edited by an agent's own file tools from inside a container, where two concurrent SESSIONS of the same group could race. `self-mod-log.md`'s only writer is this host-side apply code, in the single Node host process — the exact same "a synchronous function body can't be preempted mid-execution by another request's handler" reasoning this codebase already investigated and closed for the `config add-X` race family (`deferred-work.md`) applies identically here. `run-log.ts` itself — the pattern this file explicitly mirrors — has never needed a lock for the same reason. Implementing a lock here would be inconsistent with the precedent this AD says to mirror, for a race that doesn't exist in this architecture. Flagging this explicitly as a considered deviation from the spine's literal wording, not a silent skip.

**`requesterUserId`/`triggeredBy` not threaded through here:** unlike Story 2.1's `TaskProvenance`, this story's log line doesn't carry the full shared provenance shape as structured data — it's a plain-text line, matching `run-log.ts`'s own style (AD-9's explicit instruction). Every self-mod action is agent-initiated by construction in this codebase (there's no host-CLI equivalent path for `install_packages`/`add_mcp_server`/`add_calendar`), so `triggeredBy` would always read `'agent'` and add no information; the approving admin's identity is known only transiently in the approval flow and isn't threaded into any apply function's signature today (same scope boundary as spec 1.1/2.1's `requesterUserId`). Story 2.4's digest will read `action`/`reason`/timestamp out of this file's plain-text lines — sufficient for "what happened and why," which is what this story's success signal actually asks for.

## Verification

**Commands:**
- `pnpm test -- self-mod-log.test.ts` -- expected: new tests pass
- `pnpm test -- apply.test.ts` -- expected: all new + existing self-mod apply tests pass
- `pnpm test -- container-runner.test.ts` -- expected: all new + existing mount tests pass
- `pnpm exec tsc --noEmit -p .` -- expected: clean

## Suggested Review Order

**The write path — round 1's correctness fix lives here**

- Entry point: capped, sanitized, length-guarded append.
  [`self-mod-log.ts:26`](../../src/modules/self-mod/self-mod-log.ts#L26)

- The try/catch wrapper every call site now goes through — a log-write failure never crashes an already-applied change.
  [`apply.ts:31`](../../src/modules/self-mod/apply.ts#L31)

**Read-only mount — the tamper-proofing this story exists for**

- Nested RO mount, conditional on existence, mirroring `container.json`'s exact pattern.
  [`container-runner.ts:515`](../../src/container-runner.ts#L515)

**Peripherals — tests and docs**

- Full coverage including round-1 regression tests (rebuild-failure ordering, log-write-failure resilience, newline/length guards).
  [`self-mod-log.test.ts`](../../src/modules/self-mod/self-mod-log.test.ts)
  [`apply.test.ts`](../../src/modules/self-mod/apply.test.ts)

- Agent-facing + operator-facing doc mentions, added in round 1.
  [`self-mod.instructions.md`](../../container/agent-runner/src/mcp-tools/self-mod.instructions.md)
