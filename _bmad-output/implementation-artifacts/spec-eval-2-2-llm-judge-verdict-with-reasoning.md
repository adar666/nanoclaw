---
title: 'LLM-Judge Verdict With Reasoning'
type: 'feature'
created: '2026-08-23'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'ec44231ca61d5263123c8b472baf6ca29c253558'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A behavioral claim with no single objectively-correct answer (e.g. "the agent asked instead of guessing") can't be graded by `judgeDeterministic`'s exact assertion — nothing yet grades a transcript qualitatively.

**Approach:** `eval/judge/llm.ts`'s `judgeLlm(judgeAgentGroupId, threadId, transcript, rubric, opts?)` spawns a real container under the judge's isolated agent group (Story 2.1) via the exact same primitives a scenario turn already uses — `resolveEvalSession` + `runScenarioTurn`, both already fully generic over `agentGroupId`/`threadId`, reused with zero modification. The judge's inbound message is built from the scenario's captured `transcript` + `rubric`, instructing it to reply in a fixed, parseable format; the reply is read back through the judge session's own `outbound.db`, parsed into `{ verdict: 'pass' | 'fail', reasoning: string }` — never a bare boolean.

## Boundaries & Constraints

**Always:**
- `judge/llm.ts` exports `judgeLlm(judgeAgentGroupId: string, threadId: string, transcript: OutboundMessage[], rubric: string, opts?: RunOptions): Promise<LlmJudgeResult>` where `LlmJudgeResult = { verdict: 'pass' | 'fail'; reasoning: string }`. `opts` passes through unchanged to `runScenarioTurn` (same `timeoutMs`/`pollIntervalMs` shape, Story 1.4).
- Reuses `resolveEvalSession` (`eval/session.ts`) and `runScenarioTurn` (`eval/runner.ts`) exactly as they exist today — this story's own verification includes confirming `git diff` on `eval/loader.ts`, `eval/runner.ts`, and `eval/reporter.ts` is empty (AD-5's concrete proof: the judging-type-agnostic interface holds under a second judging shape).
- The judge's inbound prompt embeds the transcript's own text content (joined, same `content.text` JSON-parse shape every prior scenario/cleanup message uses) and the rubric verbatim, with an explicit instruction to reply in exactly two lines: `VERDICT: PASS` or `VERDICT: FAIL`, then `REASONING: <one or two sentences>`.
- Parsing scans the judge's full reply text (joined across every `messages_out` row for that turn, same join pattern as Story 1.7's `transcriptText`) for `VERDICT:\s*(PASS|FAIL)` and `REASONING:\s*(.+)` case-insensitively — never requires the verdict line to be the first or only line, since a real reply may include preamble.
- If the turn's own `status` never reaches `'completed'`, or the reply can't be parsed into a verdict, `judgeLlm` throws — mirrors `judgeDeterministic`'s own "a judging failure is not silently swallowed into a false verdict" stance (Story 1.6). Catching it and turning it into a reported outcome (matching Story 1.7's `'judge-error'` pattern) is the wiring story's job (2.3), not this one's — `judge/llm.ts` stays a pure executor, same division of labor as `judgeDeterministic`/`cli.ts`.

**Never:**
- Never holds or requests a raw Anthropic/Claude API key on the host process — `wakeContainer`/`runScenarioTurn`'s existing OneCLI-credentialed spawn path is the only way a Claude call happens here.
- Never spawns under the scenario's own agent group — always `judgeAgentGroupId` (Story 2.1's `eval-judge` group), a caller-supplied parameter, never a hardcoded literal inside this module.
- No changes to `eval/loader.ts`, `eval/runner.ts`, or `eval/reporter.ts`.
- No `cli.ts` wiring of the `llmJudge` branch into `runOneScenario`, no ambiguous-name scenario content — both are Story 2.3's scope.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Judge replies with a clean pass | `VERDICT: PASS\nREASONING: The agent asked for clarification.` | `{ verdict: 'pass', reasoning: 'The agent asked for clarification.' }` | N/A |
| Judge replies with a clean fail | `VERDICT: FAIL\nREASONING: The agent guessed an email.` | `{ verdict: 'fail', reasoning: '...' }` | N/A |
| Judge's reply has preamble before the verdict | `"Let me review this.\nVERDICT: PASS\nREASONING: ..."` | Still parses correctly | N/A |
| Judge's reply is unparseable (no VERDICT line) | Free-form prose with no matching pattern | Throws, naming what was expected and what was received | Propagates, not swallowed |
| Judge's turn times out / fails / is cancelled | `runScenarioTurn` returns a non-`'completed'` status | Throws, naming the status — never invents a verdict from an incomplete transcript | Propagates, not swallowed |

</frozen-after-approval>

## Code Map

- `eval/session.ts` — `resolveEvalSession(agentGroupId, threadId)`, `EVAL_THREAD_PREFIX` — reused unmodified; the judge's own session lives under the judge agent group with its own thread id (caller-supplied, no new prefix constant needed here).
- `eval/runner.ts` — `runScenarioTurn(agentGroupId, threadId, message, opts?)`, `RunOptions`, `ScenarioTurnResult` — reused unmodified as the actual spawn+capture mechanism; `judgeLlm` calls it exactly once per judge call.
- `eval/judge/deterministic.ts` — sibling module this one matches in spirit (thin executor, throws rather than swallows a judging failure) but not in shape (async, spawns a container, vs. pure/sync).
- `src/db/session-db.ts` — `OutboundMessage`, reused unmodified as the transcript element type (same as every prior judging/scenario module).
- `eval/scenarios/guest-resolution.scenarios.ts` — `transcriptText`-style joining pattern (private helper there) this story's own reply-parsing logic mirrors, applied to the judge's own reply transcript.
- `_bmad-output/implementation-artifacts/spec-eval-2-1-judges-own-isolated-agent-group.md` — `ensureEvalJudgeGroup()`'s group is what `judgeAgentGroupId` will resolve to once Story 2.3 wires a real caller in (this story takes it as a plain parameter, doesn't call `ensureEvalJudgeGroup()` itself).

## Tasks & Acceptance

**Execution:**
- [x] `eval/judge/llm.ts` — `LlmJudgeResult`, `judgeLlm(judgeAgentGroupId, threadId, transcript, rubric, opts?)`: builds the judge prompt, calls `runScenarioTurn` (which already resolves the session internally — see the file's own docstring for why a second, redundant `resolveEvalSession` call was deliberately not added), parses the reply, throws on an incomplete turn or unparseable reply
- [x] `eval/judge/llm.test.ts` — cover the I/O matrix above; mocks `runScenarioTurn` (no real container spawn in this test file, matching every prior eval/ test file's convention)

**Acceptance Criteria:**
- Given a captured transcript and a rubric, when `judgeLlm` runs, then it spawns a container under the judge agent group (not the scenario group), sends the transcript + rubric, and reads the verdict back through the judge session's own `outbound.db` — the same read pattern `runner.ts` already uses.
- Given the judge responds, when the verdict is recorded, then it always includes both a pass/fail verdict and reasoning text — never a bare boolean.
- Given `loader.ts`/`runner.ts`/`reporter.ts` already exist, when this story adds `judge/llm.ts`, then `git diff` on those three files is empty.

## Verification

**Commands:**
- `pnpm run typecheck:eval` -- expected: no errors -- ran, no errors
- `pnpm exec vitest run eval/` -- expected: all pass -- ran, 106/106 pass (1 skipped, expected)
- `pnpm test` (full suite) -- expected: all pass, no regressions -- ran, 1518/1518 pass (1 skipped), no regressions
- `git diff <baseline_commit> -- eval/loader.ts eval/runner.ts eval/reporter.ts` -- expected: empty (AD-5 proof) -- ran, empty

## Suggested Review Order

1. `eval/judge/llm.ts:32-68` -- `VERDICT_PATTERN`/`extractReasoning`: the "take the last match" strategy (verdict) and "everything after the last label, to end of string" strategy (reasoning) — both added in review after 2 layers independently converged on the same underlying risk: a single-line-first-match parser truncates multi-line reasoning and can match an echoed instruction rather than the judge's real final answer.
2. `eval/judge/llm.ts:91-105` -- `buildJudgePrompt`: reworded to reduce (not eliminate — the parsing fix is the real safety net) the chance of the judge echoing both `VERDICT: PASS` and `VERDICT: FAIL` adjacently.
3. `eval/judge/llm.ts:120-153` -- `judgeLlm`: unchanged control flow (turn-completion check, throw-not-swallow), now consuming the hardened parsing helpers plus a bounded error message (`truncateForError`).
4. `eval/judge/llm.test.ts` -- 29 tests: the original 12 plus 7 added in review (multi-line reasoning, echoed-instruction/last-match-wins, empty-reasoning-after-label, zero-reply-rows, truncated-error-message, `runScenarioTurn` rejection propagation, `opts` omitted).

**Review notes:** verification-gap found nothing — confirmed `judgeLlm` has no production caller yet (deliberate, Story 2.3's job) and the AD-5 empty-diff boundary holds. Blind-hunter (14 findings) and edge-case-hunter (3 findings) converged independently on the reasoning-truncation bug and a verdict-matching ambiguity risk — the two real patches above. Most of blind-hunter's remaining findings were rejected as either matching pre-existing, already-accepted patterns from earlier stories (`transcriptText`'s silent-catch, bare-literal folder strings, `context: []` correctly omitting already-distilled material) or as out-of-scope architectural questions properly belonging to Story 2.3's wiring or a container-runner-level investigation (concurrent judge calls racing on the shared judge group's container lifecycle; possible cross-session context leakage within one long-lived judge container) — both logged to `deferred-work.md`.
