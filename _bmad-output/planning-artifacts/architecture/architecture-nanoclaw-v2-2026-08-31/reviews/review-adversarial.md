# Adversarial Review — Cross-Group Context Sharing + Provenance/Receipts

**Target:** `ARCHITECTURE-SPINE.md` (2026-08-31), binds CAP-1, CAP-2
**Method:** construct two independent story-builders, each obeying every AD to the letter, and show they still ship something incompatible. Every finding below is grounded in the actual current codebase, not speculation — file:line citations included.

---

## Method note on the two-builder frame

For each finding I name Builder A and Builder B, show the AD text each is reading, show that both readings are legitimate ("letter-compliant"), and show the concrete incompatible artifact that results when both ship.

---

## CRITICAL-1 — `self-mod-log.md` has two writers with no ownership rule, and the container-side one can tamper with its own audit trail

**AD touched:** AD-9 (binds CAP-2)

**The gap:** AD-9's Rule says "Every self-mod apply handler (`applyAddCalendar` and siblings) appends one line to `groups/<folder>/self-mod-log.md`." That names the *host-side* writer (`src/modules/self-mod/apply.ts` — confirmed: imports `container-runner.js`, `db/*`, all host modules). But `groups/<folder>/` — the entire group folder, `self-mod-log.md` included — is bind-mounted **read-write** into the group's own container at `/workspace/agent` (`src/container-runner.ts:502`: `mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false })`). Compare this to the two mounts immediately below it in the same function that *are* explicitly marked `readonly: true` for exactly this reason — `container.json` (line 508) and the composed `CLAUDE.md` (line 520). No such carve-out exists, or is even discussed, for `self-mod-log.md`.

That means the agent itself, from inside its own container, can `Write`/`Edit` `/workspace/agent/self-mod-log.md` — the identical inode the host process is appending to — using its completely ordinary, always-available filesystem tools. Nothing in AD-9 says this file must be read-only from the container side, and nothing prevents the agent from editing, reordering, or deleting entries in a file whose entire purpose (CAP-2, "provenance/receipts") is to be a trustworthy record of what was done to the agent's own configuration.

**Two builders, both AD-9-compliant:**
- **Builder A** implements only the host-side `appendSelfModLog()` call in `apply.ts`, per AD-9's literal text, and never touches the mount config. Ships exactly what AD-9 describes.
- **Builder B**, reviewing CAP-2's goal ("provenance/receipts" — an audit trail), independently notices the file sits in a RW mount and adds a read-only sub-mount override for it (mirroring the `container.json`/`CLAUDE.md` pattern two lines above in the same file) so the agent can read but not edit its own receipts.

Both are literal AD-9 compliance. Only Builder B's system produces a log an operator can actually trust. Nothing in the spine tells either builder which is required — this is a correctness-relevant fork the spine is silent on, not a style choice.

**Compounding race:** even setting tamper aside, once the file is RW from both host and container, a host `apply.ts` append and an agent-initiated in-container edit can land at genuinely the same wall-clock moment (self-mod approval + an unrelated agent turn in the same group), racing on the same underlying file with two completely different write mechanisms (host: presumably `fs.appendFileSync`; container: whatever the agent's edit tool does, typically read-then-write for `Edit`). AD-9 gives no ownership rule ("this file is host-written, container-read-only") to rule this out.

**Fix direction:** AD-9 needs an explicit read-only sub-mount for `self-mod-log.md` from the container side (same mechanism already used for `container.json`/`CLAUDE.md`, `container-runner.ts:508/520`), and a stated invariant that the host process is the file's sole writer.

---

## CRITICAL-2 — Recurring-task provenance goes stale after the first fire, silently, because of already-shipped code

**AD touched:** AD-8 (binds CAP-2), contradicts AD-11's claim

**The gap, verified in code, not inferred:** `src/modules/scheduling/db.ts:182-197`, `insertRecurrence`:

```ts
export function insertRecurrence(db, msg, newId, nextRun, status = 'pending'): void {
  insertTaskRow(db, {
    id: newId,
    seriesId: msg.series_id,
    processAfter: nextRun,
    recurrence: msg.recurrence,
    content: msg.content,   // <-- copied verbatim from the completed row
    status,
  });
}
```

`src/modules/scheduling/recurrence.ts`'s `handleRecurrence` (the host-sweep hook that auto-arms the next occurrence of a cron series) calls this every time a recurring task completes, copying the prior row's `content` JSON string byte-for-byte into the new pending row.

AD-8's Rule is scoped to `ncl tasks create`: "`ncl tasks create` captures AD-7's shape into `content.provenance`." It says nothing about recurrence-driven re-insertion — and the existing, already-shipped `insertRecurrence` mechanically carries the *entire* `content` blob forward untouched. Once AD-8 ships, `content.provenance` (with its `at: ISO-8601` creation timestamp and `triggeredBy: 'user'|'agent'`) gets carried forward through this exact same path, frozen at the value it had when the series was first created — forever, for every subsequent fire, even fires 50 cycles later that the scheduler itself triggered with zero human involvement in the moment.

This directly contradicts AD-11's claim: "a task's provenance is visible via the existing `ncl tasks get` output" — implying that's a trustworthy answer to "why did this happen." For any fire after the first, it isn't: it reports the *original* human's request time and identity, not the fact that this particular occurrence was auto-fired by the cron engine.

**Two builders, both AD-8-compliant:**
- **Builder A** implements AD-8 literally — touches only the `ncl tasks create` code path (`src/modules/scheduling/create.ts`), never touches `insertRecurrence`. Ships the staleness bug above, invisibly, because AD-8's text gave no reason to look at `recurrence.ts` at all.
- **Builder B**, reasoning from CAP-2's actual goal, decides each *fire* is its own provenance event and has `insertRecurrence` stamp a fresh `{ triggeredBy: 'system', at: <this fire's time>, reason: 'scheduled recurrence' }`, replacing (not preserving) the original.

Both are defensible readings of AD-8's silence on this. They produce genuinely different, incompatible semantics for the same series — and if one builder does A for the initial-create path and a different builder (or the same one, at a different time) does B for the recurrence path without the two agreeing, `ncl tasks get`'s provenance for a mid-series row becomes internally inconsistent (sometimes stale-original, sometimes correctly-system, depending which commit touched it last).

**Fix direction:** AD-8 needs to explicitly decide series-level vs. per-fire provenance semantics, and if per-fire, name `insertRecurrence` as a second capture site.

---

## HIGH-1 — `content.provenance.requesterSessionId` duplicates the pre-existing `content.originSessionId`, with no reconciliation rule

**AD touched:** AD-7, AD-8

`src/modules/scheduling/create.ts:155-159` already writes:
```ts
content: JSON.stringify({
  prompt: task.prompt,
  script: task.script,
  originSessionId: options?.originSessionId ?? null,
}),
```
`originSessionId` already answers "which session caused this task to exist." AD-8 adds `content.provenance.requesterSessionId` (part of AD-7's shape) onto the *same* `content` object, to answer the *same* question, under a different key. AD-8's Rule ("captures AD-7's shape into `content.provenance`, alongside the pre-existing `prompt`/`script`/`originSessionId` fields") acknowledges the coexistence but never says which one is authoritative, whether they must always agree, or whether one supersedes the other.

**Two builders, both AD-8-compliant:**
- **Builder A** touches only `create.ts`'s existing `originSessionId` write path when adding provenance capture, and forgets (or doesn't realize it needs) to also populate `provenance.requesterSessionId` on a second code path that constructs tasks a different way (e.g. a future agent-initiated task-creation helper, or the follow-up/edit path) — `originSessionId` gets set, `provenance.requesterSessionId` stays undefined.
- **Builder B** implements a downstream consumer (a `ncl tasks get` provenance renderer) that reads only `content.provenance.requesterSessionId` and ignores `originSessionId` entirely, because AD-7's shape is "the one provenance shape CAP-2 ever writes" per AD-7's own Rule text.

Result: a real task exists where the human-readable answer to "which session created this" (`originSessionId`, populated) diverges from the provenance answer (`requesterSessionId`, empty) — and the AD-11 promise ("a task's provenance is visible via the existing `ncl tasks get` output") silently shows nothing for a task that, by the pre-existing field, plainly has an answer.

**Fix direction:** AD-8 should either retire `originSessionId` in favor of `provenance.requesterSessionId`, or explicitly declare `originSessionId` the source of truth and have provenance-population derive from it rather than being independently set.

---

## HIGH-2 — `shared-facts.md` has no locking discipline, unlike the sibling spine's proven precedent for the identical class of file — and no AD even names a write path

**AD touched:** AD-3, and the complete absence of any concurrency AD analogous to the sibling document-memory spine's AD-11

**The precedent, confirmed in code:** `container/agent-runner/src/mcp-tools/documents.ts:3025-3039`, `recordFillHistory`, takes an explicit per-slug file lock (`withLock`, exported at `documents.ts:294`) and writes via temp-file-then-`fs.renameSync` specifically so "any reader … only ever observes the fully-old or fully-new file content, never a partial write." That machinery exists *because* the sibling architecture spine's own AD-11 (`architecture-nanoclaw-v2-2026-08-16/ARCHITECTURE-SPINE.md:97-101`) mandated it: "two concurrent `save_document` calls … racing on the same `memory/index.md` … Every write to a shared memory index file goes through read-modify-write guarded by a file lock … never an unguarded read-then-overwrite."

This spine's AD-3 fixes only *where* shareable facts live (`memory/shared-facts.md`) and *what frontmatter convention* it uses. It never says how the file gets written, and there is no locking AD anywhere in this spine analogous to the sibling's AD-11 — despite the same structural precondition existing: `docs/architecture.md:437` confirms "multiple sessions per agent group," and `groupDir` (the whole `groups/<folder>/` tree, `memory/` included) is mounted RW into every one of that group's live containers (`container-runner.ts:502`). Two live sessions of the *same* group (an interactive DM session and a scheduled-task session both currently running) can each have their agent edit `memory/shared-facts.md` with the ordinary `Edit`/`Write` tool at the same time — no MCP tool, no lock, no atomic-rename, exactly the class of bug AD-11 (sibling) was written to prevent, on a file the sibling spine's precedent didn't cover because it's brand new here.

The stakes are higher than a same-group memory-index collision: a torn or lost write here doesn't just corrupt the source group's own memory — it's the exact content another group's agent (via `read_shared_context`) quotes to a *different* user as fact.

**Two builders, both AD-3-compliant (AD-3 says nothing about the writer):**
- **Builder A** treats `shared-facts.md` like any other memory file — the agent edits it directly with its normal `Edit`/`Write` tool, per this repo's own `container/CLAUDE.md` memory guidance ("durable facts belong in memory... split any file... into a folder"). No lock, because nothing asked for one.
- **Builder B**, aware of the sibling precedent, builds a small `save_shared_fact` MCP tool that reuses `withLock` + temp-rename, the same discipline `recordFillHistory` already uses.

Both are AD-3-compliant; only B is race-safe. A live corruption/lost-update in shared-facts.md under B is impossible by construction; under A it's a real, reachable failure mode the moment two of the group's sessions are both live (already an ordinary, documented occurrence in this system — task sessions run alongside interactive ones routinely).

**Fix direction:** add an AD mirroring the sibling's AD-11 verbatim, scoped to `shared-facts.md`, and decide explicitly whether writes go through a new locked MCP tool or the agent's raw filesystem tools (if the latter, the locking guarantee has to move somewhere reachable from a plain `Edit` call, which is a much harder problem than it sounds — worth surfacing to the SPEC, not deciding by silent omission).

---

## HIGH-3 — AD-6 collapses "no grant" and "grant exists, file not yet written" into one message, and compounds a documented, previously-live mount-allowlist failure mode

**AD touched:** AD-6, AD-5

**The gap:** AD-6's Rule: "`read_shared_context` returns an explicit, non-error 'not shared with you' result when the expected mount path doesn't exist." There are at least three distinguishable real states that all present identically as "path doesn't exist" under a naive full-path `existsSync` check:

1. No grant was ever configured (`add-mount` never run for this group pair).
2. A grant *was* configured and the container restarted, mounting `/workspace/extra/shared/<folder>/` — but the source group's agent hasn't written `shared-facts.md` into its own memory yet.
3. A grant *was* requested via `add-mount`, but `src/modules/mount-security/index.ts`'s `validateMount` **rejected** it (wrong host path, blocked pattern, allowlist not yet containing the root) — logged only as `"Additional mount REJECTED"` in `nanoclaw.error.log` (`validateAdditionalMounts`, same file). This project's own CLAUDE.md documents this exact failure mode as previously live and painful: an operator diagnosing "backwards," `docker exec`-ing in before checking the error log.

AD-6 as written gives no way for `read_shared_context` to distinguish (1) from (2) or (3) — and from *inside* the container there is no way to consult `nanoclaw.error.log` at all, so case 3 is now not just an operator-diagnosis problem (the documented pitfall) but also an *agent-facing* one: the agent will confidently tell the user "that isn't shared with you," when actually a grant exists and is silently broken.

**Two builders, both AD-6-compliant, producing different behavior for the identical situation (case 2):**
- **Builder A** reads AD-5's "expected mount path" as the full file path (`/workspace/extra/shared/<folder>/shared-facts.md`) and checks only that with `existsSync`. Case 1 and case 2 both return "not shared with you."
- **Builder B** reads "expected mount path" as the mount *directory* (`/workspace/extra/shared/<folder>/`) — equally consistent with AD-5's wording, which talks about the mount, not the file within it — and checks the directory first. Case 2 gets a different message ("shared, but nothing recorded yet") than case 1 ("not shared with you").

Neither reading is ruled out by AD-6's text. They ship different user-facing behavior for the same underlying state, and case 3 (silently-rejected grant) is mishandled identically by both, indistinguishable from "never shared" — the opposite of AD-6's "never fabricates content and never surfaces a raw filesystem error" as a *positive* claim: it also never surfaces the *true* reason (rejected mount) as anything but a false negative on the grant's existence.

**Fix direction:** AD-6 should explicitly enumerate the three states and require checking the mount directory separately from the file, and — since the agent has no access to `nanoclaw.error.log` — consider whether `read_shared_context`'s "not shared" message should suggest the operator check `nanoclaw.error.log`/re-run `add-mount` when the directory itself is absent (state 1/3, indistinguishable to the tool) vs. present-but-empty (state 2, distinguishable, and a different, better message).

---

## HIGH-4 — AD-5's `containerPath` convention is pure prose; nothing in the actual `add-mount` code path enforces it, and a violation is unobservable end-to-end

**AD touched:** AD-5

**Verified:** `src/cli/resources/groups.ts:554-582` (`config add-mount`) accepts any string for `--container-path`/`--container` with the sole validation `if (!hostPath || !containerPath) throw ...` — no check against AD-5's `shared/<source-group-folder>` shape at all. Downstream, `src/modules/mount-security/index.ts`'s `isValidContainerPath` (the only structural validator in the actual mount path) checks solely for `..`, a leading `/`, `:` and emptiness — again nothing about a `shared/` prefix or the folder name matching.

**Two builders, both fully AD-2/AD-5-compliant:**
- **Builder A** implements CAP-1's `read_shared_context` exactly per AD-5: deterministically constructs `/workspace/extra/shared/<source-group-folder>/shared-facts.md` and never scans.
- **Builder B**, working the CLI side, correctly reads AD-2 ("`ncl groups config add-mount`, unchanged") as license to touch nothing in `groups.ts`'s existing `add-mount` verb — no new validation is "unchanged," and AD-2 explicitly forbids inventing a "second, parallel" mechanism, which a bespoke validator could be read as.

Neither builder violates their AD. The result: an operator who runs `add-mount --container-path household-facts` (forgetting the `shared/` prefix, or typing `shared/household` instead of `shared/household-folder-name`) gets a fully successful CLI call, a successful restart, a real mount landing inside the container at the wrong path — and, per HIGH-3 above, `read_shared_context` reports the *identical* "not shared with you" a true no-grant case would produce. No error surfaces to the operator (the CLI succeeded), no error surfaces to the agent (AD-6's clean "not shared" result), no error surfaces in `nanoclaw.error.log` (mount-security accepted the path — it's a legal relative path, just not the convention). This is a silent, structurally invisible misconfiguration with no diagnostic path at all.

**Fix direction:** either (a) have `add-mount` warn (not block, to avoid breaking legitimate non-shared-context uses of the same verb) when `--container-path` doesn't match `^shared/[a-z0-9-]+$/` and a companion flag signals "this is a shared-context grant," or (b) give CAP-1 its own dedicated grant verb instead of reusing the fully general `add-mount`, so the convention can actually be enforced in code rather than remembered by the operator.

---

## Summary table

| # | Severity | AD(s) | One-line finding |
|---|----------|-------|-------------------|
| CRITICAL-1 | Critical | AD-9 | `self-mod-log.md` is RW-mounted into its own group's container with no read-only carve-out (unlike `container.json`/`CLAUDE.md` two lines away) — the agent can edit/tamper with its own audit trail, and a host/container write race is unaddressed. |
| CRITICAL-2 | Critical | AD-8, AD-11 | `insertRecurrence` (already-shipped code, `db.ts:182-197`) copies `content` verbatim, so recurring-task provenance freezes at first-fire values forever; AD-8 never names recurrence as a second capture site, contradicting AD-11's "trustworthy why" claim. |
| HIGH-1 | High | AD-7, AD-8 | New `provenance.requesterSessionId` duplicates the pre-existing `content.originSessionId` with no reconciliation rule — the two can diverge per code path. |
| HIGH-2 | High | AD-3 | No locking AD for `shared-facts.md`, unlike the sibling document-memory spine's AD-11 precedent (`withLock` + atomic rename, already implemented for the analogous `FillHistoryEntry` index) — concurrent same-group sessions can race on it, and the write path itself isn't even specified. |
| HIGH-3 | High | AD-6 | Collapses "no grant," "grant exists but file not yet written," and "grant silently rejected by mount-security" into one identical "not shared" result; two AD-6-compliant readings ("check the file" vs. "check the directory") produce different behavior for the same state. |
| HIGH-4 | High | AD-5 | The `shared/<source-group-folder>` `containerPath` convention is unenforced anywhere in code (`add-mount` CLI, `mount-security`'s validator) — a violation is invisible end-to-end, compounding HIGH-3. |

## Deferred / lower-severity observations (not written up in full)

- AD-10's document provenance inherits `recordFillHistory`'s existing lock/atomic-rename discipline "for free" since it's additive to an object already passed through that function — this is the one CAP-2 domain that is *not* at risk from the concurrency class above, worth confirming explicitly in the spine so a future reader doesn't assume otherwise.
- If HIGH-2 is fixed by adding a dedicated locked write tool for `shared-facts.md`, that tool's registration should be added to AD-4's scope (currently AD-4 only registers the *read* tool `read_shared_context`) rather than left implicit.
