# Adversarial Review — Agent Evaluation Harness Architecture Spine

**Target:** `ARCHITECTURE-SPINE.md` (Agent Evaluation Harness, `eval/` package), updated 2026-08-20
**Method:** For each candidate hole, construct two hypothetical builders ("Builder A", "Builder B") each implementing a different piece of `eval/` (e.g. `loader.ts`+`scenarios/*` vs `runner.ts`, or `runner.ts` vs `sweep.ts`) strictly to the letter of the spine's Rules, and show they produce incompatible or unsafe systems without either one violating a Rule as written. Grounded against the actual `src/delivery.ts`, `src/db/sessions.ts`, `src/container-runner.ts` code, not just the spine's prose.
**Reviewer verdict:** The spine is not safe to build from as written. The headline invariant it exists to protect — AD-1's "zero destinations" delivery-safety guarantee — has a real, code-confirmed bypass, and the spine's own companion spec (`scenario-format.md`) contradicts AD-1's central premise in its own worked example. These are not edge-case nitpicks; they are the exact failure mode the task brief called out as highest-stakes.

---

## Finding 1 — CRITICAL: AD-1 ("dedicated eval agent group") directly contradicts CAP-1 and the SPEC's own worked example

**The contradiction, in the primary sources themselves:**

- `ARCHITECTURE-SPINE.md` AD-1: "Every scenario run spawns its container under **one dedicated agent group created for eval use only**, with **zero** entries in `destinations`... No scenario, present or future, may add a destination to this group."
- `SPEC.md` CAP-1 success criterion: "Running a scenario spins up **the real container**... **not a simulation**."
- `scenario-format.md`'s Fields table: `agentGroupId` — "Which real agent group's container to spawn (**e.g. household, dm-with-uriel**)."
- `scenario-format.md`'s worked example, verbatim: `agentGroupId: "ag-2146c1ff-6be5-45ba-8fd8-462792283951", // household` — the real, live, production household agent group's actual UUID.

These are not reconcilable by a compliant builder. `household` is not a "dedicated agent group created for eval use only" — it is the operator's real, live agent group with real Telegram destinations (per this repo's own `CLAUDE.md`, `household` is a working example throughout: real people.md, real calendar, real chat). The guest-resolution scenario's entire point (per SPEC's "Why") is to check whether the *real* `household` container, with its *real* `people.md` memory and *real* calendar registry, resolves "דבורה" correctly — a synthetic zero-destination sandbox group has none of that state and can never exercise the claim under test. CAP-1's own text ("the real container... not a simulation") backs this reading, not AD-1's.

**Two compliant builders, two incompatible systems:**

- **Builder A** (owns `loader.ts` + `scenarios/*.scenarios.ts`, working strictly from `scenario-format.md`'s schema and worked example): implements `agentGroupId` exactly as documented — a free-form real agent-group id, defaulting to `household` for the guest-resolution set, because that's what the shipped worked example says to write.
- **Builder B** (owns `runner.ts`, working strictly from AD-1's Rule text): hardcodes spawning under the one dedicated eval-only group, and either (a) ignores the scenario's `agentGroupId` field entirely, silently producing vacuous scenarios that can never see real household memory/calendar state — quietly violating CAP-1's "real... not a simulation" criterion while technically obeying AD-1 to the letter, or (b) honors the scenario's `agentGroupId` and spawns under the real `household` group — technically obeying CAP-1 and the schema, while directly violating AD-1's "one dedicated agent group... zero destinations" to the letter, because `household` has real destinations.

Both builders can point to a Rule they followed exactly. The system that results is either non-functional (Builder B-a: scenarios can't test what they claim to) or a live-delivery risk (Builder B-b: real destinations, real production group, in the eval path).

**Fix direction:** AD-1 needs to state explicitly which of these two directions is authoritative, and scenario-format.md needs to change to match — they cannot both stand as currently worded. If the intent is "exercise the real group's real memory/skills," AD-1 should require a **read-only mount** of the target group's memory/CLAUDE.md into a genuinely destination-free eval group (this codebase already has exactly this pattern for the cross-group memory-isolation gap — see `CLAUDE.md`'s "isolated memory" pitfall and `ncl groups config add-mount`), never a spawn under the real group's own container. If the intent is a synthetic eval-only persona, `scenario-format.md`'s worked example and field description must stop naming `household`/`dm-with-uriel` as valid values.

---

## Finding 2 — CRITICAL: "Zero destinations" does not prevent delivery — the origin-chat bypass in `delivery.ts`

Read literally, AD-1's Rule is: no destinations row ⇒ nothing for `<message to="X">` to resolve to ⇒ structurally safe. This is false against the actual delivery code.

`src/delivery.ts`'s `deliverMessage` (lines ~303–334) has **two** independent paths to a live channel send:

1. **Origin-chat path** (no destinations-table check at all): "The target is the session's own origin chat (`session.messaging_group_id` matches). An agent can always reply to the chat it was spawned from; requiring a destinations row for the obvious case is a footgun." This path is unconditional — it never consults `agent_destinations`.
2. **Non-origin path**: consults `agent_destinations`, which AD-4's check covers.

AD-1/AD-4 only defend path 2. Path 1 bypasses the destinations table entirely, by design (and reasonably so, for real chat sessions). Whether an eval-spawned session is exposed to path 1 depends entirely on whether `runner.ts` sets `session.messaging_group_id` to something non-null. Nothing in AD-1, AD-2, or AD-4 pins this down — AD-2 grants `runner.ts` free use of `createSession` "directly, in-process," with no constraint on what `Session` object it constructs.

**Two compliant builders:**

- **Builder A** implements `runner.ts` with `messaging_group_id: null` (a synthetic, non-chat session — matching how `dm-with-uriel`-style task sessions already work per this codebase's own task-session pattern). Origin-chat path never fires; only the AD-4-guarded non-origin path is reachable. Safe, and consistent with AD-1's intent.
- **Builder B**, independently, decides the eval session should carry a real `messaging_group_id` — plausibly because Finding 1's tension pushes toward "spawn under the real household group to get real behavior," and a session under a real agent group *conventionally* has a real originating messaging group in this codebase's data model (every other session does). If Builder B does this, **any outbound message the agent sends whose `channel_type`/`platform_id` matches that origin chat delivers unconditionally, with zero destinations-table involvement** — regardless of how many entries `destinations` has, regardless of AD-4's check having passed cleanly moments earlier. AD-1's Rule is not violated by any literal reading (it only talks about the `destinations` table), yet a real Telegram/WhatsApp message reaches a live chat.

This is the loophole the task brief specifically asked to hunt for, and it is real, present in the code today, not hypothetical. AD-1 as written protects against exactly one of the two delivery paths that actually exist.

**Fix direction:** AD-1's Rule must additionally require `session.messaging_group_id` to be structurally `NULL` for every eval-spawned session (not just "zero destinations"), and should name the origin-chat bypass in `delivery.ts` explicitly as the thing this closes — the same way the spine already names specific code paths elsewhere (AD-2). A destinations-only invariant is provably insufficient.

---

## Finding 3 — HIGH: Eval sessions are structurally invisible to no part of the live delivery poll

`src/delivery.ts`'s `pollActive` (1s) and `pollSweep` (60s) call `getRunningSessions()` / `getActiveSessions()` (`src/db/sessions.ts`), which are unscoped, unconditional queries:

```ts
export function getActiveSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE status = 'active'").all() as Session[];
}
export function getRunningSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE container_status IN ('running', 'idle')").all() as Session[];
}
```

Because AD-2 requires `runner.ts` to call `createSession` against the *same live* `data/v2.db` the real host process reads, every eval session — the instant its `container_status` becomes `running`/`idle` — is picked up by the live host service's own delivery loop within at most 1 second, and `drainSession`/`deliverMessage` run against it exactly as they would for a real user session. The spine's mermaid diagram acknowledges the shared DB ("eval/ is a client of it, not a separate deployment") but never states that this means **the live host process actively participates in every eval run's message delivery**, nor requires any opt-out marker.

This isn't a new bypass beyond Finding 2 — it's the mechanism that makes Finding 2 exploitable *automatically*, by the running production service, with no eval-side action required. A builder who reads AD-1/AD-4 as "the eval harness must not deliver to real chats" could reasonably (and wrongly) assume the eval harness's own process controls whether delivery happens. It does not — delivery is driven by the host service's independent poll loops, which don't know or care that a session originated from `eval/`.

**Fix direction:** the spine should state explicitly that eval sessions are visible to and processed by the live host's delivery polls (true today, not planned to change), and that Findings 1/2's fix (synthetic group, null `messaging_group_id`, verified-empty destinations) is the *entire* safety mechanism — there is no secondary containment layer. That's an important thing for implementers to know they're relying on.

---

## Finding 4 — HIGH: AD-3's judge container is a second, ungoverned path around AD-1

AD-1's Rule text scopes narrowly: "every **scenario run** spawns its container under one dedicated agent group... zero destinations." AD-3 introduces a *second* container spawn — the judge — via `ensureAgent`/OneCLI, explicitly independent of the scenario's own container ("spawns its own lightweight container"). Nothing in AD-1, AD-3, or AD-4 states that the judge container must *also* be spawned under a zero-destination group.

**Two compliant builders:**

- **Builder A** (owns `judge/llm.ts`) reuses the same dedicated eval agent group for the judge spawn, reasoning "we already proved this group is destination-free via AD-4's check, no reason to redo it" — plausible, but now the judge's container shares the eval group's disk state with whatever scenario is concurrently running (see Finding 5).
- **Builder B** (owns `judge/llm.ts`, working independently) creates a *separate* agent group for the judge — reasonably, since a judge container has a different role/config than a scenario container (different system prompt, no calendar tools needed) and reusing the scenario group's config would leak calendar MCP tools into a role that shouldn't need them. AD-1's Rule doesn't apply to this new group by its literal text ("every scenario run['s] container" — the judge is not a scenario run's container). If this judge-specific group is created via a normal `ncl groups create` (no explicit zero-destinations step, because AD-4's Rule also only names "the eval agent group" from AD-1, not a second judge group), its destinations are whatever `ncl groups create`'s defaults happen to produce — unaudited, unverified, and given a rubric + transcript + real Claude call, an unexpected `send_message`-shaped tool call from the judge model is exactly the class of thing AD-1 was written to prevent, on a path AD-1's text never actually reaches.

**Fix direction:** AD-1's Rule should be reworded to cover "every container this package spawns for any purpose" (scenario *and* judge), and AD-4's check should run before *every* container spawn `eval/` performs, not just before "a run" in the scenario sense.

---

## Finding 5 — HIGH: No run-exclusivity guarantee → real race on the shared group workspace mount

Confirmed in `src/container-runner.ts`: the agent-group folder (`groupDir`, containing `memory/`, `CLAUDE.md`, etc.) is mounted **read-write** at `/workspace/agent` — one mount per agent group, shared by every session under that group:

```ts
// Agent group folder at /workspace/agent (RW for working files + shared memory)
mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });
```

`activeContainers` in the same file is keyed by `session.id`, so two concurrent sessions under the same agent group get **separate container processes** but the **same RW filesystem** underneath. The spine never states that `eval/` runs are serialized — `cli.ts`'s own description ("parses `pnpm eval run <set>`... drives the pipeline") says nothing about refusing a second concurrent invocation, and nothing prevents a human from running `pnpm eval run guest-resolution` in two terminals, or running a scenario set while `pnpm eval sweep` (CAP-7, its own independent entry point per the spine's own mermaid) is mid-flight.

**Two compliant builders:**

- **Builder A** (`cli.ts`) assumes the operator won't do this and builds no lock — reasonable, since nothing in AD-1..AD-5 requires one.
- **Builder B**, later adding CAP-7's `sweep.ts` per its "standalone... independent entry point" description, likewise adds no coordination with `cli.ts run` — the spine explicitly frames them as unrelated entry points.

Two scenario runs (or a run + a sweep) touching the same eval group's `memory/` tree concurrently is a real, silent corruption risk: one scenario's `setup` step writing memory state that leaks into a different scenario's judged transcript, or a sweep deleting a calendar event mid-creation by another run. This is exactly the kind of shared-mutable-state race the task brief asked to find, and it's confirmed against real container-runner mount code, not speculative.

**Fix direction:** a new AD requiring a run-level lock (e.g. a lock file under `eval/`, or a DB-row-based mutex on the dedicated eval agent group) held for the duration of any container spawn `eval/` performs — covering `cli.ts run`, `judge/llm.ts`'s judge spawn, and `sweep.ts` alike.

---

## Finding 6 — MEDIUM: AD-4's check is a point-in-time TOCTOU, not a continuous guarantee

AD-4's Rule: `runner.ts` checks destinations "as its very first step, before spawning anything." That closes the gap AD-4 names (destination added *months* before a run). It does **not** close a same-run race: an admin (or a self-mod action elsewhere in the codebase — `install_packages`/`add_mcp_server` self-mod already exists and this codebase's own history includes an agent-initiated container restart mid-incident) runs `ncl destinations add` against the eval group *during* a scenario's container lifetime, after AD-4's check passed but before the container's outbound message reaches `drainSession`. AD-4's Rule is satisfied (checked "before spawning") while the guarantee it's meant to provide (no live delivery, ever, for this run) is not.

**Fix direction:** either re-check immediately before delivery (structurally awkward, since delivery is driven by the independent host poll per Finding 3, not by `eval/` itself), or — better — make Finding 2's fix (`messaging_group_id: NULL`, verified at the DB level) the actual safety mechanism, with AD-4's destinations check demoted to defense-in-depth rather than the primary guarantee. As currently worded, AD-4 reads as the primary guarantee, which a TOCTOU window undermines.

---

## Finding 7 — MEDIUM: The eval-test calendar has no single, pinned owner between `runner.ts` and `sweep.ts`

CAP-4: the eval-test calendar is "registered via `add_calendar`" (implying a per-group `calendar_registry` row, which the spine's own Deferred section calls "genuinely per-group in production"). CAP-7/`sweep.ts` is described as a "standalone" entry point with **no dependency on host modules** in the spine's own mermaid (`sweep.ts -.standalone, not part of the run pipeline.-> gcal[(eval-test calendar)]` — no arrow to `CentralDB` or any host module, unlike `runner.ts`'s explicit arrows to `hostmods`).

**Two compliant builders:**

- **Builder A** (`runner.ts`'s cleanup step) resolves "the eval-test calendar" by reading the eval group's `calendar_registry` row via the normal host calendar module — consistent with AD-2's "reuse host modules, no reimplementation."
- **Builder B** (`sweep.ts`), taking the spine's own diagram literally (standalone, no host-module arrow), resolves the calendar by a hardcoded calendar ID/env var instead — since AD-2's Rule text only binds CAP-1, not CAP-7, and the mermaid explicitly draws `sweep.ts` without a host-module dependency.

If an operator later changes which calendar is registered for the eval group (Deferred section already flags per-group separation as a live future possibility), Builder A's resolution moves with the registry; Builder B's hardcoded resolution doesn't. Sweep silently starts cleaning the *wrong* calendar (or misses the new one) with no error, because both builders were individually spec-compliant. Compounds badly with Finding 1: if the resolution to Finding 1 is "spawn under the real household group," the calendar being swept is `household`'s real production calendar registry entry — a stale/wrong `sweep.ts` resolution here is not just an eval-hygiene bug, it's a script capable of deleting real events from a real calendar it wasn't told to touch.

**Fix direction:** name one canonical resolution path for "the eval-test calendar" (almost certainly the `calendar_registry` row, per AD-2's own logic) and require `sweep.ts` to use it too, even though it's a standalone entry point — "standalone" (no run-pipeline dependency) should not mean "reimplements calendar resolution."

---

## Finding 8 — MEDIUM: `judging.deterministic.check`'s dual shape (`fn` vs declarative string) is unresolved, and its backing implementation location isn't pinned by AD-5

`scenario-format.md`: `check: <fn or declarative assertion against outbound.db / real API state>`. The worked example ships a **string**: `check: "createdEventAttendeesInclude('adardevora@gmail.com')"` — not a function reference, a string that names a predicate.

**Two compliant builders:**

- **Builder A** (`loader.ts`, validating against the documented schema) accepts `check` as either a `Function` value or a `string` — both are "valid" per the Fields table's own "fn or declarative assertion" phrasing — and does no further interpretation.
- **Builder B** (`judge/deterministic.ts`, CAP-2's owner) must actually execute `check` against a captured outcome. To handle the string form from the worked example, Builder B needs *some* dispatch table mapping predicate names (`createdEventAttendeesInclude`, and whatever future scenarios need) to real implementations. Where does that table live? AD-5's Rule says `judge/deterministic.ts` "never references calendar-specific... concepts by name" — but `createdEventAttendeesInclude` is exactly such a concept (attendees, events), and if its implementation is a registry inside `judge/deterministic.ts` (the natural place to put a generic string dispatcher), AD-5 is violated in substance while `judge/deterministic.ts`'s source text contains no literal domain keyword the AD's Rule is checking for ("never reference... by name" reads as a lexical/naming check, not a "no domain-specific logic at all" check). A different implementer could instead put the registry in `scenarios/guest-resolution.scenarios.ts` (matching AD-5's letter) and have `judge/deterministic.ts` do `new Function(...)`-style dynamic evaluation of the string against that scenario-supplied registry — a legitimate reading of AD-5, but a meaningfully different (and far more dangerous — arbitrary string→code execution) implementation shape from Builder A's plain-function assumption.

**Fix direction:** collapse `check` to one shape (a real function reference is simpler, type-safe, and avoids inventing a mini eval-string DSL) and have AD-5 state explicitly *where* per-scenario predicate implementations must live (co-located with the scenario file, imported by `loader.ts`, never defined inside `judge/*.ts`) — not just that domain names shouldn't appear in judge source.

---

## Finding 9 — MEDIUM: The dedicated eval agent group's identity, creation, and creation-time destination state are unpinned

AD-1 requires "one dedicated agent group created for eval use only" but the spine never says: what its stable id/slug is, who creates it (a one-time manual bootstrap? an idempotent create-if-missing in `runner.ts` itself?), or what guarantees its destinations are empty *at creation time* (before AD-4's steady-state check has anything to check). AD-4 explicitly only covers drift *after* the group exists ("someone... adds a real destination... months from now") — it says nothing about the first run against a group `runner.ts` just created.

**Two compliant builders:**

- **Builder A** treats the eval group as a fixed, pre-existing, manually-provisioned resource (documented once in a README/setup step, id hardcoded or read from a config file) — AD-4's check is meaningful from the first run.
- **Builder B**, reading AD-2's "in-process host module reuse" spirit more aggressively, has `runner.ts` create-the-group-if-missing on first run via the same `ncl groups create` path a human would use. If `ncl groups create`'s defaults ever wire a destination (e.g. a template default, or a future change to `resolveWiringDefaults` per `src/channels/channel-defaults.ts`), Builder B's freshly-created group could fail AD-4's very own check on its *first* run and simply refuse to run — safe by luck, not by contract — or, if the create path and the destinations-check path aren't both exercised in the same code path/transaction, there's a window between create and check where nothing has verified anything yet.

**Fix direction:** the spine should state explicitly whether the eval agent group is provisioned once, out-of-band, and treated as a fixed precondition `runner.ts` only ever reads — never creates. That removes the ambiguity entirely and is the safer choice given Finding 1's stakes.

---

## Finding 10 — LOW: Cleanup-failure ownership is ambiguous between the reporter and the sweep

CAP-4: "a cleanup failure is reported explicitly, never silently swallowed." CAP-7/`sweep.ts` exists precisely to catch what CAP-4's per-run cleanup misses. But nothing states whether a `report.json` entry that says "cleanup failed" is enough (human reads the report, remembers to run `pnpm eval sweep` themselves) or whether `cli.ts` should auto-invoke the sweep on any cleanup failure before exiting. Two builders can reasonably diverge (report-only vs. auto-sweep-on-failure); the divergence isn't a delivery-safety hole, but it does mean "cleanup failure reported" can silently mean "and then nothing else happens, ever, until a human notices and remembers the separate command" — worth resolving explicitly rather than leaving as an implicit assumption on both sides.

---

## Summary Table

| # | Finding | Severity | Primary AD(s) implicated |
|---|---|---|---|
| 1 | AD-1's "dedicated eval group" contradicts CAP-1 + scenario-format.md's own worked example (`household`) | **CRITICAL** | AD-1, CAP-1 |
| 2 | Origin-chat delivery path in `delivery.ts` bypasses the destinations-table check entirely | **CRITICAL** | AD-1, AD-4 |
| 3 | Live host delivery polls (`getRunningSessions`/`getActiveSessions`) are unscoped and pick up eval sessions automatically | HIGH | AD-1, AD-2 |
| 4 | AD-3's judge container spawn is outside AD-1's literal Rule scope — a second, ungoverned delivery-safety surface | HIGH | AD-1, AD-3 |
| 5 | No run-exclusivity AD; confirmed shared RW group-workspace mount in `container-runner.ts` → real race between concurrent runs/sweep | HIGH | AD-2 (new AD needed) |
| 6 | AD-4's check is point-in-time, not continuous — same-run TOCTOU window | MEDIUM | AD-4 |
| 7 | "The eval-test calendar" has two possible resolution paths (`runner.ts` registry vs. `sweep.ts` standalone) with no pinned single owner | MEDIUM | AD-2, CAP-4, CAP-7 |
| 8 | `check` field's fn-vs-string ambiguity + unclear home for domain-specific predicate logic under AD-5 | MEDIUM | AD-5 |
| 9 | Eval agent group's creation/identity/creation-time destination state unpinned | MEDIUM | AD-1, AD-4 |
| 10 | Cleanup-failure-report vs. auto-sweep ownership ambiguous | LOW | CAP-4, CAP-7 |

Findings 1 and 2 are the ones that matter most: together they show that AD-1's guarantee, as currently worded, is not structural — it depends on an implementation choice (`messaging_group_id`, and which agent group actually gets spawned) that the spine leaves entirely to individual builder discretion, against a real, confirmed bypass in the delivery code this repo already runs in production.
