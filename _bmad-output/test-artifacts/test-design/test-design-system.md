# NanoClaw v2 — System-Level Test Design

**Author:** Murat (BMAD Test Architect persona) — produced autonomously overnight,
2026-08-14/15, while the operator (Uriel) slept. No interactive interview was run;
every open question was resolved with documented judgment instead of a halt, per
explicit instruction. Review and challenge anything below.

**Scope:** system-level (whole repository), not a single epic/story.

**Inputs used in place of a formal PRD/ADR** (see
`test-design-progress-system.md` for the substitution rationale):
`docs/architecture.md`, `docs/db.md`, `docs/db-central.md`, `docs/db-session.md`,
`docs/isolation-model.md`, `docs/build-and-runtime.md`, `CLAUDE.md`.

**Stack detected:** `backend` — pure TypeScript/Node (host) + Bun (container agent-runner),
no frontend framework, no browser, no microservices/contract-testing surface. This
matters for the recommendations below: BMAD's default tooling flags
(`tea_use_playwright_utils`, `tea_use_pactjs_utils`) were auto-enabled by the
non-interactive installer and **do not apply here** — see "Tooling flags" at the
end.

---

## 1. Where this assessment actually comes from

Two real incidents happened *tonight*, live, on the running system, while this
exact codebase had 1348 passing tests. Both are used below as primary evidence —
not hypothetical risk scenarios, but things that actually shipped broken and were
only caught by manual, live testing:

1. **A per-group persona instruction file silently contradicted a brand-new
   capability.** `groups/household/instructions.prepend.md` had an existing
   "Photos and PDFs" policy (files route to a private per-sender log, checked
   only in a nightly 3am sync) that the agent generalized to audio files too —
   even though the code-level media-ingestion whitelist never touched audio, and
   a new `transcribe_audio` tool had just been wired in specifically for audio.
   The agent trusted its older persona text over the new capability it had just
   been told about in the same context window. **No test in the current suite
   could have caught this** — persona/instruction text isn't code, and nothing
   checks it for consistency against what tools are actually wired.

2. **An intermittent-looking message-loss symptom at the Telegram integration
   layer.** This section originally hypothesized the cause as either operator
   `getUpdates` interference or an untested `downloadFile`/local-Bot-API-server
   integration gap. **Update (2026-08-15, root-caused since this was
   written):** neither guess was right. The real cause was
   `createPairingInterceptor` in `src/channels/telegram.ts` calling
   `hostOnInbound(...)` without `await` on all four of its code paths.
   `hostOnInbound` is typed `void | Promise<void>` and is actually the real
   async routing chain (`writeSessionMessage`, attachment extraction,
   container wake) — legal TypeScript, silent at runtime, and harmless for a
   fast text message. It broke the moment the real work got slow enough
   (base64-decoding and disk-writing a large audio attachment) for the
   interceptor's premature resolution to matter: the message silently never
   reached `inbound.db`, with nothing logged anywhere. Found via targeted
   diagnostic instrumentation (added and reverted), confirmed via a live
   retest, fixed in commit `c09f1c5`, regression-tested in
   `src/channels/telegram-pairing-interceptor.test.ts` (4 tests, each proving
   the interceptor's promise doesn't resolve before `hostOnInbound`'s does,
   using a controllable deferred promise rather than a timing race). This
   reclassifies the risk below: it was never really about `telegram.ts`
   lacking I/O-integration coverage (§4.2's original framing) — it was an
   ordinary async-correctness bug, the kind any `void | Promise<void>`-typed
   callback anywhere in the codebase can hide. §4.2 and action item 3 below
   are updated accordingly.

Both incidents are used as the anchor for the risk assessment below, not as
one-off anecdotes — they're symptomatic of two structural gaps this document
recommends closing.

---

## 2. Current coverage shape

| Layer | Test count | Runtime | What it actually covers |
|---|---|---|---|
| Host (`src/`) | 105 files / 1348 tests | Node + vitest | Very strong. DB migrations, guard/permission logic, CLI dispatch, delivery actions, scheduling, approvals — almost entirely **unit-level with mocked I/O boundaries** (`vi.mock` on `fs`, `child_process`, adapter internals). |
| Container (`container/agent-runner/src/`) | 24 files | Bun + bun:test | MCP tool handlers, formatter, destinations — same shape: unit-level, real `bun:sqlite` against a throwaway test DB (good — this is actually integration-shaped for the DB layer specifically), external effects mocked. |
| **True end-to-end** (real Telegram → real host → real container → real reply) | **0 automated** | — | Every E2E verification that has ever happened for this project happened by a human sending a real message and watching logs — tonight included, several times. |
| **Persona/instructions consistency** | **0** | — | Nothing checks that a group's `instructions.prepend.md`/`CLAUDE.md` composition doesn't contradict what tools/skills are actually available to it. |

**This is not a coverage-*quantity* problem.** 1348 tests is a lot for a project
this size, and the unit-level logic (guard decisions, migrations, CLI parsing,
scheduling math) is exactly the kind of thing unit tests are supposed to cover
and clearly do well — per `test-levels-framework.md`'s own guidance, pure logic
and state machines are unit-test territory and this project follows that
correctly.

**It is a coverage-*shape* problem**, in exactly the two places tonight's
incidents landed:

- **Real I/O boundaries that are *only* mocked, never exercised for real**, on
  code that has externally-observable failure modes a mock can't reproduce
  (a `--local`-mode Telegram Bot API server's actual file-path semantics; a
  real container's actual environment/mounts).
- **Cross-artifact consistency that lives entirely outside "code"** — a group's
  persona prose vs. its actually-wired tool/skill set. This is genuinely a new
  test *category* for this project, not a gap in an existing one.

---

## 3. Risk assessment (probability × impact, 1–3 scale each, adapted from
`risk-governance.md` — categories relabeled for what this project actually is:
a household assistant, not a revenue system)

Categories used: **TECH** (architecture fragility), **CORR** (correctness —
wrong/lost data or messages), **SEC** (security/privacy — this project handles
real household data and two real people's private messages), **OPS**
(operability — silent failures nobody notices).

| # | Risk | Category | Prob | Impact | Score | Evidence |
|---|---|---|---|---|---|---|
| R1 | A group's persona text contradicts a newly-shipped tool/skill, and the agent silently gives wrong/stale answers to real people | CORR | 3 | 2 | **6** | Happened tonight, exactly as described. Impact capped at 2 (not 3) because the failure mode is "unhelpful/wrong answer," not data loss — annoying, not dangerous. |
| R2 | A host-side integration file with real external I/O (adapters, downloaders) ships with zero test coverage and only gets verified by live manual testing | TECH | 2 | 2 | **4** | `telegram.ts` tonight; almost certainly not the only file in this shape — see §5. |
| R3 | A message from a real user is silently dropped (never reaches `inbound.db`, no error logged, no trace) | CORR | 2 | 3 | **6** | Directly observed tonight (though root-caused to operator interference, not a latent bug) — but the fact that it took ~40 minutes of live log archaeology to even understand the DB-level symptom shows there's no automated signal for "a message that arrived at the platform never reached inbound.db." |
| R4 | The household group handles two real people's private data with an explicit "no privacy in this chat" / "you have no access to their private DB" boundary (see `groups/household/instructions.prepend.md`) — a persona edit or a media-ingestion change could quietly weaken that boundary | SEC | 1 | 3 | **3** | Not observed breaking tonight, but the boundary is entirely prose-enforced (per §1's finding #1, prose has already proven fragile once this session) with no automated check that it's still intact after an edit. |
| R5 | A container-side new tool/skill (like tonight's `transcribe_audio`) ships without the corresponding host-side rebuild+restart, and nobody notices until a live test | OPS | 2 | 1 | **2** | Caught and self-corrected tonight, but it's an easy step to forget, and CLAUDE.md itself has to spell out the two-separate-rebuild-paths gotcha as a standing warning — meaning it's already known to be error-prone for humans, let alone unattended agents. |

**Per `risk-governance.md`'s own thresholds**: R1 and R3 (score 6) "demand
documented mitigation." Nothing here scores 9 (no gate-blocking critical), which
is the right outcome for a personal/household-scale project — this is not a
"stop shipping" report, it's a "here's where the next real bug will come from"
report.

---

## 4. Recommended test strategy (risk-based, not exhaustive)

Following `test-levels-framework.md`'s decision matrix, mapped onto this
project's actual layers:

### 4.1 New category: persona/instructions consistency checks (addresses R1, R4)

This doesn't fit "unit / integration / E2E" cleanly — it's closer to a
**static consistency check**, and it's cheap relative to its payoff:

- A script (host-side, run in CI or as a `pnpm` script) that, for every
  `groups/*/instructions.prepend.md` plus its composed `CLAUDE.md`, flags
  prose patterns that look like blanket capability-denial ("you have no
  access to...", "not available", "you cannot...") and cross-checks whether a
  more specific/newer instruction (a `.instructions.md` fragment naming a
  real tool) contradicts it. This can't be fully automated with certainty —
  it's a *lint*, not a prover — but even a heuristic grep-based check that
  flags "this group's persona denies file access AND this group has a
  file-handling tool wired in — human, please confirm these agree" would have
  caught tonight's incident before a live test did.
- For R4 specifically (the "no privacy" / "no access to private DB" boundary):
  a narrower, higher-confidence check is actually plausible — assert
  mechanically (not via prose-linting) that the household container's mount
  list genuinely excludes each private-DB path CLAUDE.md claims is excluded.
  This IS testable as ordinary code: a test against
  `src/container-runner.ts`'s mount-resolution logic, asserting that for the
  household agent group, no mount target resolves under either partner's
  private data directory. This is high-value, low-effort, and belongs in the
  existing vitest suite, not a new tool.

### 4.2 Close the integration-test gap on real-I/O adapter code (addresses R2)

**Update (2026-08-15):** the actual bug found in this file (see §1 item 2's
update) was an async-correctness defect (`hostOnInbound` called without
`await`), not a `downloadFile`/local-Bot-API-server integration gap — the
original framing below guessed wrong about the mechanism, though it correctly
flagged `telegram.ts` as the highest-risk untested file in the codebase.
Built instead of the local-server container test originally proposed:
`src/channels/telegram-pairing-interceptor.test.ts`, which exports and
directly tests `createPairingInterceptor`'s await behavior on all 4 code
paths using a controllable deferred promise. This is narrower than a real
`telegram-bot-api` container integration test (it doesn't exercise
`downloadFile` against a real server), but it targets the actual defect
class that shipped, and `downloadFile` itself has since been proven correct
twice by independent live tests (once at feature-ship time, once during
tonight's audio-transcription retest) — lowering the urgency of the
originally-proposed container test. The paragraph below is kept as the
original recommendation, still worth doing if `telegram.ts` grows more
untested real-I/O logic:

`src/channels/telegram.ts` is the clearest concrete instance, but the pattern
generalizes: any file that talks to a real external system (Telegram's Bot
API, Docker, the local `telegram-bot-api` server, OneCLI) and is currently
**only** verified by manual live testing is a same-shaped risk.

Recommended approach — not full E2E (too slow/flaky/expensive for what this
project needs per `test-levels-framework.md`'s "favor integration over E2E
when possible" rule), but a **local-server integration test**:
`telegram-bot-api` itself is already a Docker container this project runs for
real (see the local Bot API server work from earlier tonight) — a test suite
that spins up that exact container (or a lightweight stub server matching its
`--local` mode file-path contract), points a real `TelegramAdapter` instance
at it, and exercises `downloadFile` end-to-end (both the local-path branch and
the HTTP-fallback branch) would have caught tonight's confusion in seconds
instead of ~40 minutes of live log archaeology. This is squarely an
**integration test** in the framework's own terms — "component interaction
verification," "may use test containers," "validates system integration
points."

### 4.3 A minimal, narrow E2E smoke path (addresses R3)

Per `test-levels-framework.md`: E2E is for "critical user journeys" and
"final validation before release" — not a place to over-invest for a project
this size. One narrow, high-value E2E smoke test is enough: given a running
host + a real (or faithfully stubbed) Telegram long-poll connection, a single
text message sent to a wired group reaches `inbound.db`, gets routed, and a
reply reaches `outbound.db` — the exact round trip that took manual log
archaeology to verify by hand, repeatedly, tonight. This does not need to
cover every message kind or every channel; one narrow path that would have
made tonight's "did the message even arrive?" question answerable by running
a script instead of reading three log files is the actual point.

### 4.4 What NOT to build (YAGNI, explicitly)

- **No Playwright/browser E2E.** This project has no user-facing web UI in its
  core path (the optional dashboard skill is observability tooling, not a
  product surface this project's correctness depends on). `tea_use_playwright_utils`
  defaulted to `true` from the non-interactive installer; that default doesn't
  apply here and should be turned off in `_bmad/tea/config.yaml` unless a
  future dashboard feature specifically needs browser testing.
- **No Pact/contract testing.** NanoClaw is not a microservices system with
  independently-deployed consumer/provider services — it's one host process
  and per-group containers talking over two SQLite files. There is no contract
  boundary Pact's model applies to. `tea_use_pactjs_utils` should also be
  turned off.
- **No load/performance/chaos testing infrastructure (k6 etc.).** This is a
  household-scale personal assistant, not a system under variable production
  load. Nothing in tonight's incidents or the architecture docs suggests a
  performance risk worth this investment.
- **No formal CI quality-gate pipeline (score-based PASS/CONCERNS/FAIL
  automation) for a two-person household project.** The risk-governance
  framework's gate-decision machinery (owners, deadlines, waiver approvers) is
  built for teams and compliance audits (its own knowledge fragment cites
  FDA/SOC2/ISO). Track the two score-6 risks above as a plain checklist in
  this document, not a dashboard.

---

## 5. Concrete, prioritized action list

In risk-score order, cheapest-first among ties:

1. **(R4, cheap, honest scope correction made while implementing)** Traced
   `validateAdditionalMounts` (`src/modules/mount-security/index.ts`) in
   full: it's a generic secrets/system-path blocklist (`.ssh`, `.aws`,
   `credentials`, etc.) with **no tenant-awareness at all** — it would not
   catch someone adding `uriel.db` or `partner.db` to household's
   `additionalMounts`. So there is no *code* property to unit-test here
   (a `buildMounts()` test fed my own crafted input would only test my
   fixture, not a real guarantee). What actually keeps the household
   container from seeing the private DBs today is that its
   `container_configs.additional_mounts` row happens to name the single
   `household.db` file, not the directory. Implemented instead: a
   regression test against that **live config data**, asserting it never
   names a private-tenant path — real protection against a future
   misconfiguration, honestly scoped as a data check, not a code guarantee.
   The structural gap (no code-level guard preventing a *future* group from
   being misconfigured this way) is real and worth fixing, but is new
   security-relevant logic — flagged for your decision, not built
   unattended tonight.
2. **DONE (2026-08-15).** Built `scripts/lint-group-instructions.ts` +
   `scripts/lint-group-instructions.test.ts` (11 tests) — the
   persona-vs-tooling consistency lint from §4.1. Run manually
   (`pnpm exec tsx scripts/lint-group-instructions.ts`), not wired into CI,
   per the original recommendation — it needs human judgment on its flagged
   output. Run once against the real `groups/` dir: 8 findings surfaced
   (real paragraphs worth a second look), though it does not catch the exact
   original household/audio incident directly — that paragraph never used a
   token matching any capability keyword, an honest limitation of a lexical
   heuristic.
3. **DONE, re-scoped (2026-08-15).** The original local-`telegram-bot-api`-container
   integration test was superseded by the actual root cause found this
   morning (see §4.2's update): `src/channels/telegram-pairing-interceptor.test.ts`
   (4 tests) directly regression-tests the async-correctness bug that
   actually shipped (`hostOnInbound` called without `await`). The originally-proposed
   container-based `downloadFile` integration test remains a reasonable
   future addition but is no longer the top-priority gap.
4. **DONE (2026-08-15).** Built the one narrow E2E smoke path from §4.3 as
   `src/e2e-round-trip.test.ts`: chains the real (unmocked)
   `routeInbound` → `inbound.db` write → simulated agent reply →
   `deliverSessionMessages` → channel-adapter `deliver()` call, in one test.
   No existing test chained router.ts through to delivery.ts before this —
   `host-core.test.ts`'s router tests stop at "container woken,"
   `delivery.test.ts` starts from a pre-inserted outbound row. This encodes
   the exact round trip that took live manual Telegram testing to verify by
   hand tonight.
5. **(R5, cheap, low score)** Not worth dedicated test infrastructure — this
   is already correctly handled by CLAUDE.md's own documented warning. Lowest
   priority on this list.

---

## 6. Tooling flags (action for the operator, not autonomous)

`_bmad/tea/config.yaml` currently has, from the non-interactive installer
default:

```yaml
tea_use_playwright_utils: true
tea_use_pactjs_utils: true
```

Recommend setting both to `false` — see §4.4. I did not change this file
myself; it's a one-line edit but changing BMAD's own config felt like the
kind of thing worth your explicit sign-off rather than me deciding it
overnight, even though the reasoning is clear-cut.

---

## 7. What I did not do, and why

- Did not run the full BMAD `bmad-testarch-framework` (test framework
  initialization) skill — this project already has two working test runners
  (vitest, bun:test); there's no framework to *initialize*, only integration
  tests to *add* to what exists. Running it would likely try to scaffold
  Playwright, which §4.4 argues against.
- Did not attempt to write the actual integration/E2E test code in this same
  pass — this document is the *design*, not the implementation. Item 3 in §5
  is the best next step if there's time before morning; I'll attempt it next
  if so, as its own clearly-labeled, separately-tested piece of work rather
  than folding it into this document.
- Did not run `bmad-testarch-nfr` (NFR evidence audit) — there's no existing
  NFR evidence to audit yet (no performance/security test runs to review);
  this workflow is for auditing what exists, and §4.4 already argues most
  NFR categories don't apply at this project's scale.
