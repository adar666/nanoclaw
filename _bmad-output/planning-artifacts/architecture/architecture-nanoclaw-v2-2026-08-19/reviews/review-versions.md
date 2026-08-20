# Review — Version / Reality-Check Audit

**Target:** `ARCHITECTURE-SPINE.md` (Agent Evaluation Harness, `eval/`)
**Lens:** every committed version/technology claim must be either web-researched (new external tech) or reality-checked against this repo (brownfield reuse) — never asserted from training data.
**Date:** 2026-08-20

## Method

1. Read the full spine (157 lines) end to end; extracted every claim that names a version, a library, or an external technology.
2. Cross-checked the three Stack-table rows against `/Users/uriel/Projects/nanoclaw-v2/package.json` (the actual host manifest) verbatim, not against the spine's own restatement of it.
3. Checked whether "Claude Agent SDK" is named anywhere in the spine, and if so what claim is attached to it.
4. Cross-checked "OneCLI" usage in the spine (AD-3) against `CLAUDE.md`'s "Secrets / Credentials / OneCLI" and "Self-Modification" sections, and against the actual `@onecli-sh/sdk` dependency and the container's `@anthropic-ai/claude-agent-sdk` dependency.

## Findings

### Stack table — all three rows verified correct, exact match

| Spine claim | package.json reality | Verdict |
|---|---|---|
| "TypeScript / Node (host) — Same as `nanoclaw` host package, no new runtime introduced" | `"engines": { "node": ">=20" }`, `typescript: ^5.7.0`, project is a TS/Node host (`tsx src/index.ts` dev script) | **PASS.** No new runtime is introduced; claim is accurate and checkable at a glance. |
| "better-sqlite3 — 11.10.0 (pinned, matches host `package.json`)" | `"better-sqlite3": "11.10.0"` (dependencies, unprefixed — genuinely pinned, not a caret range) | **PASS — exact match**, including the "pinned" characterization (no `^`/`~`). |
| "tsx (script execution) — ^4.19.0 (matches host `package.json`, same convention as `scripts/q.ts`)" | `"tsx": "^4.19.0"` (devDependencies) | **PASS — exact match.** |

No discrepancy found on any of the three cited version numbers. This is a correctly-verified brownfield reuse — the spine did not need a web search here (nothing new is being introduced), and its self-reported "matches host package.json" justification holds up against the actual file rather than just being asserted.

### "Claude Agent SDK" reference — appropriately unversioned, not a fabricated claim

**Severity: INFO (no defect).** The spine never actually names "Claude Agent SDK" as a string. The only nearby language is in AD-3 ("not a direct SDK call from the host") and the Stack section's overall framing that `eval/` calls Claude only through a container spawn, never directly from the host process. This is consistent with reality:
- The host's own `package.json` has **no** Anthropic/Claude SDK dependency at all — confirming AD-3's own claim that the host never talks to Claude directly.
- `@anthropic-ai/claude-agent-sdk` (currently pinned `^0.3.197` in `container/agent-runner/package.json`) exists only in the **container**-side package tree, matching `CLAUDE.md`'s own gotcha ("Bumping `@anthropic-ai/claude-agent-sdk`... no `minimumReleaseAge` policy applies to this tree... pin deliberately").

Since the spine makes no version claim about this SDK, there's nothing to falsify — it correctly treats it as an already-existing, already-pinned dependency out of scope for this feature's Stack table, rather than inventing a number.

### OneCLI reference — correctly framed as reused, existing infra

**Severity: INFO (no defect).** AD-3 says judge calls go through "the same `ensureAgent`/OneCLI path every other Claude call in this codebase already uses." Checked against `CLAUDE.md`'s "Secrets / Credentials / OneCLI" section: `ensureAgent()` in `container-runner.ts` and the `onecli-gateway` container skill are real, currently-documented, live-tested mechanisms (per the operator's own memory note: "epic-2 calendar hardening status... live-tested"). The host `package.json` also has a real `@onecli-sh/sdk: 2.2.1` dependency, corroborating that OneCLI integration is an actual, current part of this codebase, not an assumed/hallucinated one.

One minor terminology note (not a defect): `CLAUDE.md`'s "Requiring approval for credential use" section separately cites `onecli@2.2.5` — that's the **OneCLI CLI binary** version (`onecli --help`), a different artifact from the host's `@onecli-sh/sdk: 2.2.1` **npm SDK dependency**. The spine doesn't conflate these (it names neither version), so this is just a note for future writers, not a finding against this spine.

### Minor process/documentation gap

**Severity: LOW.** The spine's YAML frontmatter has `sources: []` — empty — despite the Stack table making three checkable factual claims ("matches host package.json") that a reader has to go verify by hand (as this review did). All three turned out correct, but an empty `sources` list on a spine that does make external-reality claims is a traceability gap: a future editor re-reading this file has no signal that these numbers were ever checked against anything, and no pointer to *what* to re-check if `package.json` changes later. Recommend citing `package.json` itself (path + line range, or just the dependency name) in `sources` for any spine row that asserts "matches X."

### No out-of-date or unresearched claims found

Nothing in the Stack table, AD-1–AD-5, or the Deferred section names an external library, framework, or service version that wasn't either (a) directly checked against this repo's own `package.json`/`CLAUDE.md` in this review and found accurate, or (b) left deliberately unversioned because it's out-of-scope reused infra. There is no case here of a plausible-sounding but unverified version number (the classic "trained-from-memory" failure mode this review lens is designed to catch) — every number present was checkable and checked out.

## Summary Table

| # | Finding | Severity |
|---|---|---|
| 1 | `better-sqlite3 11.10.0` — exact match to package.json | PASS |
| 2 | `tsx ^4.19.0` — exact match to package.json | PASS |
| 3 | "no new runtime" claim — accurate | PASS |
| 4 | Claude Agent SDK — correctly left unversioned, real container-side dep confirmed | INFO |
| 5 | OneCLI — correctly framed as existing/reused, real deps confirmed (`@onecli-sh/sdk`, `onecli-gateway`) | INFO |
| 6 | Spine `sources: []` despite making checkable "matches package.json" claims | LOW |
