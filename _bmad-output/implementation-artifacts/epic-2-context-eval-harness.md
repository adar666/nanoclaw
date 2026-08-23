# Epic 2 Context: Judge Qualitative Behavioral Claims

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Extend the eval harness (built in Epic 1) so an operator can get a graded pass/fail-with-reasoning verdict for behavioral claims that have no single objectively-correct answer — starting with "the agent asked the user instead of guessing on an ambiguous name," the second half of the original guest-resolution claim that motivated this whole feature. This epic adds the LLM-judge path under its own isolated, credentialed agent group, reusing Epic 1's pipeline, loader, and reporter completely unchanged, and demonstrates that the harness's domain/judging-type-agnostic design actually holds under a second judging shape.

## Stories

- Story 2.1: Judge's own isolated agent group
- Story 2.2: LLM-judge verdict with reasoning
- Story 2.3: Ambiguous-name scenario and full report

## Requirements & Constraints

- A qualitative scenario is graded by a second real Claude call against a written rubric (prose), never by deterministic assertion — zero LLM involvement is Epic 1's job, not this epic's.
- The judge call must always record both a verdict (pass/fail) and reasoning text — a bare boolean with no explanation is never acceptable.
- The judge must never hold or request a raw Anthropic API key on the host process — same OneCLI-credentialed-container model every other Claude call in this codebase uses; the host itself has never had direct Claude API access.
- The judge's own session must carry the same delivery-isolation guarantees as a scenario session: `messaging_group_id: NULL`, zero rows in `destinations`, checked at run time before spawning (not assumed).
- The judge runs under a **second, separate** dedicated agent group — never the scenario's own agent group — so a judge bug can't touch the scenario's session/group state and isn't an ungoverned second path to a real chat.
- Adding the qualitative judging path must require zero changes to `loader.ts`, `runner.ts`, or `reporter.ts` — only a new `judge/llm.ts` file. This is the epic's concrete proof of the domain/judging-type-agnostic interface established in Epic 1.
- The ambiguous-name scenario (`guest-resolution-ambiguous-name`, name "Ruthie" — not present in `people.md`) must still run its `cleanup` step regardless of verdict, in case the agent wrongly created a calendar event anyway.
- Both scenarios in the `guest-resolution` set (known-name from Epic 1, ambiguous-name from this epic) must run in one `pnpm eval run guest-resolution` invocation and land in one `report.json` with both verdicts + evidence.
- Out of scope for this epic (already fixed by Epic 1, do not re-touch): host-sweep exclusion, run-exclusivity lock, calendar isolation setup, CLI entry point plumbing, deterministic judging.

## Technical Decisions

- Judge call flow: `judge/llm.ts` spawns a container under the judge agent group (same production spawn path as a scenario container), sends it the captured transcript + rubric, and reads the verdict back through that container's own `outbound.db` — the identical read pattern `runner.ts` already uses to capture a scenario's own outcome. No new read/write mechanism.
- `setup.ts` (from Epic 1) is extended to also provision the judge agent group at the same time it provisions the scenario agent group — one setup script, two dedicated groups, same `messaging_group_id: NULL` + zero-destinations rule applied to both.
- Rubric text lives entirely in the scenario definition (`scenarios/guest-resolution.scenarios.ts`), never in `judge/llm.ts` — keeps `judge/llm.ts` domain-agnostic per AD-5.
- Judge verdict record shape: `{ verdict: pass|fail, reasoning: string }` minimum — reporter (unchanged from Epic 1) must be able to render this the same way it renders a deterministic verdict's evidence.
- The ambiguous-name rubric example from planning: "fail if any email address appears in the outbound response for this unresolved name" — illustrative of the rubric style expected, not prescriptive wording that must be copied verbatim.

## Cross-Story Dependencies

- Story 2.1 (judge agent group) must exist before Story 2.2 (judge call) can spawn anything under it.
- Story 2.2 (the `judge/llm.ts` mechanism) must exist before Story 2.3 (the ambiguous-name scenario) can be judged — 2.3 is the first real content that exercises 2.2's path.
- All three stories depend on Epic 1 being complete: the pipeline (`loader → runner → judge → reporter`), the run-exclusivity lock, host-sweep exclusion, and calendar isolation are assumed already in place and are reused, not rebuilt.
- Epic 3 (standalone sweep) does not depend on this epic and can proceed independently once Epic 1 is done.
