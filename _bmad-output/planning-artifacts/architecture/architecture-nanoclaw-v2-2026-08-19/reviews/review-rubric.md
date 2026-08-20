# Review — ARCHITECTURE-SPINE.md (Agent Evaluation Harness) vs. good-spine checklist

**Target:** `_bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-19/ARCHITECTURE-SPINE.md`
**Driving spec:** `_bmad-output/specs/spec-eval-harness/{SPEC.md, eval-harness-flow.md, scenario-format.md}`
**Reviewed against:** live codebase as of this session (files/lines cited below), `CLAUDE.md`, `project-context.md`.

## Verdict

Structurally sound as a 4-stage pipeline with a real capability map, but it misses two divergence points that are severe enough to undermine its own headline capability (CAP-1) and its own explicit calendar-isolation constraint (CAP-4) — both traced to concrete, existing code, not speculation. Not ready to build from as-is.

---

## Checklist walkthrough

### 1. Fixes the real divergence points for the level below, misses none — **FAIL**

Two structural divergence points are not addressed anywhere in Rules/Deferred/Constraints:

**Finding A (CRITICAL) — cross-process container-state divergence between host-sweep and the eval CLI's own container.**

`activeContainers` (the map backing `isContainerRunning`) is process-local, in-memory state — never persisted, never shared across processes (`src/container-runner.ts:91-99`):

```
const wakePromises = new Map<string, Promise<boolean>>();
export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}
```

AD-2 has `runner.ts` call `wakeContainer`/`createSession` **in a separate process** (the `pnpm eval run <set>` CLI invocation) against the **same** `data/v2.db` the live host service uses. AD-1's own rationale ("this repo is the live production host, its real delivery pipeline is always running") and AD-4's rationale (a destination could be added "months from now" by a live operator) both assume the host service is running concurrently with eval runs — the spine never says otherwise.

`src/host-sweep.ts`'s `sweep()` iterates `getActiveSessions()` — **all** active sessions, no agent-group filter (`src/db/sessions.ts:113-114`) — every 60s, and for each session:

```
// src/host-sweep.ts:248
if (dueCount > 0 && !isContainerRunning(session.id)) {
  await wakeContainer(session);   // host's OWN competing spawn
}
...
// src/host-sweep.ts:256, 271-272
const alive = isContainerRunning(session.id);
if (!alive && outDb) {
  resetStuckProcessingRows(inDb, outDb, session, 'container not running');
}
```

Because the eval CLI's container was spawned by a *different process*, `isContainerRunning(session.id)` **always returns `false`** from the host service's point of view, for the entire duration of every scenario run. Consequence, every sweep tick (60s) while a scenario is genuinely in progress:

- host-sweep will call its own `wakeContainer(session)` for the eval session whenever a due message exists — racing a second real container spawn against the eval CLI's own, with no cross-process guard (`wakePromises`/`activeContainers` dedup is per-process only — the in-code comment on `wakePromises` even explains this guard exists specifically to prevent "a duplicate container against the same session directory, producing racy double-replies," but only covers the single-process case);
- host-sweep will call `resetStuckProcessingRows`, resetting the very `processing_ack` claim the eval runner's own poll loop is waiting on, back to pending with backoff + `tries++` — corrupting exactly the state CAP-1's "capture the resulting transcript/outbound behavior" depends on.

This is a near-certain bug for any scenario run whose agent turn takes longer than ~60s while the host service is live — not an edge case; it is the default expected runtime shape of a real Claude tool-calling turn. Nothing in AD-1/AD-2/AD-4/Deferred acknowledges host-sweep, or states an operating assumption (e.g. "host service must be stopped during eval runs" — which would contradict AD-4's own framing) that would resolve it.

**Finding B (CRITICAL) — no structural guarantee against the eval container writing to the real primary Google Calendar.**

CAP-4 / SPEC.md Constraints: "Scenario runs must never write to Uriel's real household/personal Google Calendars — only the dedicated eval-test calendar." AD-1 makes the *message-delivery* analog of this structurally impossible (zero destinations, checked pre-run by AD-4). There is no equivalent for calendar isolation.

`container/agent-runner/src/mcp-tools/calendar.ts:36-40,88-116`:

```
const CALENDAR_IDS: Record<string, string> = { uriel: 'primary' };
...
function resolveCalendarIds(): Record<string, string> {
  const merged = Object.create(null);
  for (const [name, calendarId] of Object.entries(CALENDAR_IDS)) merged[name] = calendarId;
  for (const entry of calendarConfigHooks.getCalendarRegistry()) { ... merged[entry.name] = entry.calendarId; }
  return merged;
}
```

`"uriel"` → `'primary'` (the one connected Google account's own real primary calendar — "there is exactly one connected Google account," per the file's own comment at lines 9-20) is **unconditionally merged in for every agent group**, including AD-1's dedicated eval agent group — it is not something the eval group's `calendarRegistry` can omit. The `create_calendar_event` tool schema (lines ~209-213) explicitly advertises `"uriel"` to the agent as a valid, resolvable calendar name alongside whatever the group's own registry adds.

The scenario-format.md worked example's own message — `"פגישה מחר ב19 תוסיף את דבורה כאורחת"` (the literal scenario that motivated this spec) — names no calendar at all. Nothing in the spine (or scenario-format.md) requires a scenario's message or setup to pin the calendar choice, and nothing prevents the agent from defaulting to `"uriel"` when a request is calendar-ambiguous — which is exactly the everyday phrasing real household requests use. If it does, a scenario run writes a real event to Uriel's real primary calendar. This is precisely the class of risk this project's own `CLAUDE.md` pitfall on `delete_calendar_event` already demonstrated is not safe to leave to agent behavior/instructions alone ("Don't trust the agent to always call a separate confirmation tool before a destructive action — fold the confirmation into the tool itself").

### 2. Every AD's Rule is enforceable and actually prevents its stated divergence — **PASS** (for the ADs that exist)

AD-1, AD-2, AD-3, AD-4, AD-5 are each individually checkable (code review / a pre-run assertion) and each actually blocks the specific divergence they name. The gap is not a broken Rule — it's the **absence** of an AD covering Findings A and B above (see #1).

### 3. Nothing under Deferred could let two units diverge — **PARTIAL**

Four of five Deferred items are inert (CI, multi-domain taxonomy, multi-turn scenarios, report retention — all correctly out-of-scope-for-v1 per SPEC.md's own Non-goals, no divergence risk).

**Finding C (MEDIUM)** — the fifth, "whether the eval-test calendar needs per-group separation later," undersells the *near-term* risk: a single shared eval-test calendar used across scenario runs (CAP-7's own premise — a sweep to remove "orphaned events left behind by a crashed or interrupted run" — implies collisions/leftovers are expected in practice) makes each scenario's own `cleanup: "deleteEventCreatedThisScenario"` (scenario-format.md) ambiguous unless cleanup identifies the event by an ID captured from the transcript rather than by content-matching (e.g. two scenarios both scheduling "tomorrow 19:00" would look identical by title/time). This isn't stated as a Rule or Consistency Convention anywhere, and two implementers of `cleanup` could diverge (one keys cleanup off the returned `htmlLink`/event id, another off a fuzzy title/time match that's fragile the moment two scenarios run back-to-back against the same shared calendar).

### 4. Named tech is verified-current — **PASS**

`better-sqlite3` 11.10.0 and `tsx` ^4.19.0 both match `package.json` exactly (`better-sqlite3: 11.10.0`, `tsx: ^4.19.0`). No new dependency claim checks out — everything used (`wakeContainer`, `writeSessionMessage`, `openOutboundDb`, `createSession`, `ensureAgent`) is real, exported code at the cited locations.

### 5. Ratifies rather than contradicts a brownfield codebase — **PASS, with the two findings above being the actual point of contact where it fails to account for existing brownfield behavior**

AD-2's "call host modules directly, in-process" is consistent with existing precedent (`scripts/q.ts`, `scripts/init-first-agent.ts` already call DB/host functions directly rather than going through the `ncl` socket layer, which is the container-to-host boundary, not a host-side-script convention) — not a new pattern. The central DB is WAL-mode (`src/db/connection.ts:17`), so a second host-side process opening its own connection is not inherently unsafe at the SQLite level. The place this "ratify" claim actually breaks down is Finding A: the spine says it reuses "the same functions... the same database... no reimplementation" but doesn't account for the fact that `wakeContainer`/`isContainerRunning` carry real in-memory state that is **not** shared just because the DB is — reusing the function signature isn't the same as reusing the host's live view of what's running, and this codebase's own history (the pitfalls list in `CLAUDE.md`) is full of exactly this shape of cross-process-assumption bug (the MCP-subprocess `loadConfig()` gap being the closest analog: "a comment claiming 'safe because X already ran' needs to name which *process* X ran in").

### 6. If a spec drove it, it covers that spec's capabilities — **PASS on paper, undermined in practice by Finding A**

The Capability → Architecture Map covers all seven CAPs. But CAP-1's actual success criterion ("captures the resulting transcript/outbound behavior for judging") is exactly what Finding A puts at risk — coverage on the map doesn't mean the capability survives contact with the live host-sweep.

### 7. Every dimension the altitude owns is decided, deferred, or an open question (esp. operational/environmental envelope) — **FAIL**

Two dimensions this feature-altitude spine owns are left completely silent, not even flagged as open questions:

**Finding D (HIGH)** — **judge container identity is undecided.** AD-3 says the judge "spawns its own lightweight container (the same `ensureAgent`/OneCLI path...)" but never says which `agentGroupId` that container runs under. Every real container spawn in this codebase is anchored to a real `agent_groups` row (workspace, persona, `container_configs`, secret mode) and every `sessions` row requires `agent_group_id` (+ `messaging_group_id`/`thread_id`, `src/db/sessions.ts` schema and `findSessionForAgent`). Options — reuse AD-1's eval agent group on a different thread, stand up a second dedicated "judge" agent group, or something ad hoc — are structurally different (different persona/instructions bleeding into judge output; different secret-mode/credential exposure) and nothing here decides between them. Left unresolved, two implementers diverge on a security-relevant axis (AD-3's own point — "judge credentials never touch the host process" — depends on which agent group's container config the judge actually runs under).

**Finding E (HIGH)** — **eval-session identity (`messaging_group_id`/`thread_id`) is undecided.** `createSession` requires these fields; `messaging_group_id` is nullable in the schema and the codebase already has a working precedent for synthetic sessions — the `system:<label>` thread-id convention used for scheduled tasks (`TASKS_SYSTEM_THREAD_ID`, `findSystemSession` in `src/db/sessions.ts`) — but the spine never says whether the eval runner should adopt that convention, create a throwaway real `messaging_groups` row, or something else. This also determines whether Finding A's host-sweep interaction is avoidable (e.g. if `isTaskThread`-style exclusion could be extended to eval sessions) — a decision point the spine should have made explicitly rather than leaving implicit.

**Finding F (MEDIUM, operational envelope)** — the spine never states its own concurrency/operations assumption: is the eval CLI meant to run **while** the host service (`com.nanoclaw`) is live, or does it require the operator to stop the service first? SPEC.md's Constraints cover token cost only. AD-1's and AD-4's own rationale text both assume the host is live concurrently (which is what makes Finding A a real, not hypothetical, bug) — but this is never stated as a decision, just implied inconsistently. This is exactly the kind of operational/environmental-envelope dimension the checklist calls out as easy to leave silent.

---

## Summary table

| # | Finding | Severity | Checklist bucket |
|---|---|---|---|
| A | Host-sweep (live process) and the eval CLI (separate process) have disjoint in-memory `activeContainers` state → host-sweep will duplicate-spawn and reset in-flight `processing_ack` claims for every long-running scenario, corrupting CAP-1's transcript capture | **Critical** | #1, #6, #5 |
| B | `"uriel"` → `'primary'` (real household calendar) is unconditionally resolvable by every agent group's calendar tool, including the eval group; no structural block (only scenario-authoring discipline) stands between a calendar-ambiguous scenario message and a real write to Uriel's real calendar | **Critical** | #1 |
| C | Shared single eval-test calendar + unspecified event-identification method for `cleanup` risks cross-scenario collision, understated by Deferred's "per-group separation" framing | Medium | #3 |
| D | Judge container's `agentGroupId`/session identity never decided — affects which persona/credential/secret-mode surface the judge actually runs under | High | #7 |
| E | Eval-scenario session identity (`messaging_group_id`/`thread_id`) never decided — no chosen convention (e.g. the existing `system:` thread pattern) | High | #7 |
| F | No stated assumption on whether eval runs happen concurrently with the live host service — the operational/environmental envelope dimension is silent | Medium | #7 |

## What would resolve this

- An AD (or extension of AD-1/AD-4) making calendar-target isolation structural, not conventional — e.g. the eval agent group's calendar tool refuses any name other than an explicitly eval-scoped one, or the built-in `"uriel"` mapping is excluded/overridden for that group specifically.
- An AD addressing host-sweep's global, unfiltered `getActiveSessions()` sweep against eval-spawned sessions — either exclude eval sessions from the sweep (a scoping predicate, mirroring `isTaskThread`), or state and justify that eval runs require the host service stopped.
- A decision (even one line) on judge-container agent-group identity and eval-session `messaging_group_id`/`thread_id` shape, so `runner.ts`/`judge/llm.ts` have an unambiguous contract to implement against.
