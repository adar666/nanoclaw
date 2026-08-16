---
title: "Recall a Saved Document's Content"
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: '882d79647537c1aaa75d0e2d6b24c32898f196ff'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Stories 1.1/1.2 built saving and filling, but nothing yet tells the agent how to actually *answer a question* about a document's content from memory instead of asking the user to resend it — the mechanism (concept files, `list_documents`) exists but the workflow isn't taught.

**Approach:** No new MCP tool needed — `list_documents` (Story 1.2) already does disambiguation. Teach the recall workflow in `SKILL.md`: find the document (from Core Memory's `memory/index.md` or `list_documents`), read its concept file directly with the agent's own Read tool, answer from its extracted text.

## Boundaries & Constraints

**Always:**
- No new MCP tool call is required to *read* a resolved document's content — the agent uses its own Read tool on `memory/documents/<slug>.md` (or `/workspace/agent/memory/documents/<slug>.md` from a container-relative path), exactly as it would read any other memory file.
- `list_documents` remains the sole disambiguation mechanism (AD-7): 0 matches → clear error; 1 → resolved directly; 2+ → numbered candidates, unchanged from Story 1.2's behavior, error/ok shapes, and `formatDocumentCandidates`'s exact output (no code change to it — the agent already has the `slug` it needs to derive `documents/<slug>.md` itself, per SKILL.md's own documented convention; a code-level path suffix would be redundant, leak an internal path into user-relayed text, and add dead weight to `fill_document_field`'s disambiguation output where it's never used).
- `SKILL.md` documents the full recall flow: check `memory/index.md` first (already always-loaded as Core Memory, per `docs/memory.md`), fall back to `list_documents` when the reference doesn't obviously match an index entry, then Read the concept file to answer. Only the numbered slug/filename/description list is ever relayed to the user — any internal path stays agent-side.

**Never:**
- Never re-runs extraction or touches the saved document's files to answer a recall question — read-only against what Stories 1.1/1.2 already wrote.
- Never invents document content not actually present in the concept file — if the extracted text doesn't cover what's asked, say so rather than guessing.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Direct recall | User asks about a document saved in a prior session, unambiguous reference | `list_documents` (or index) resolves it; agent reads the concept file and answers from its content | N/A |
| Ambiguous recall | Reference matches 2+ saved documents | `list_documents` returns a numbered candidate list; agent relays it and waits for a pick | N/A (not an error) |
| No match | Reference matches no saved document | `list_documents` errors clearly | MCP error text, relayed plainly |
| Missing/unreadable concept file | Index/list_documents resolves a document but its concept file is gone or a save never completed | Agent reports it can't find the document rather than stalling or fabricating an answer | N/A (agent-level, not a tool error) |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/documents.ts:692-696` -- `formatDocumentCandidates` -- **revert to its pre-Story-1.3 form** (no path suffix; see Spec Change Log).
- `container/agent-runner/src/mcp-tools/documents.test.ts:757-792` -- existing `list_documents` describe block -- remove the path-assertion lines added this round; the original assertions (`.toContain('report-a')` etc.) stay as they were.
- `container/skills/document-memory/SKILL.md`'s `# Recalling a saved document's content` section (already added) -- amend per the patch findings: frontmatter `description` needs recall trigger phrases; add the `- saved document, <date>` index-line recognition pattern; add missing/unreadable-concept-file fallback guidance; soften the "summarize" example given `description` is currently filename-derived, not a real summary; call out the literal `_(no text extracted)_` placeholder; generalize the hardcoded `/workspace/agent/...` path example.

## Tasks & Acceptance

**Execution:**
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- revert the concept-file path addition to `formatDocumentCandidates`
- [x] `container/agent-runner/src/mcp-tools/documents.test.ts` -- remove the path assertions added this round
- [x] `container/skills/document-memory/SKILL.md` -- recall workflow section, amended per patch findings

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs, then all tests (new and existing) pass.
- Given `formatDocumentCandidates`'s output, when compared to its pre-Story-1.3 form, then it is unchanged (no path suffix).

## Spec Change Log

- 2026-08-16 (code review, bad_spec self-resolved under blanket automator delegation for this epic run -- no genuine ambiguity to loop back on, all 3 review lenses independently converged on the same fix): this story's own frozen Boundaries originally required `formatDocumentCandidates` to append each candidate's concept-file path. Review found this redundant (the `slug` shown is already enough to derive `documents/<slug>.md`, which SKILL.md documents), a user-facing internal-path leak (both fill and recall sections say "relay to the user"), and dead weight on `fill_document_field`'s disambiguation output where it's never used. **KEEP:** the recall workflow's overall shape (check index -> `list_documents` -> Read concept file) is unaffected and correct as originally designed -- only the path-suffix code addition is reverted. Boundaries text amended above; code and tests reverted in this round.

## Design Notes

This story is intentionally thin — Stories 1.1/1.2 already built everything CAP-2 needs mechanically (`memory/index.md`, concept files, `list_documents`). The only real gap was teaching the *workflow*, which is why the bulk of this story's diff is `SKILL.md` prose, not code.

## Verification

**Commands:**
- `cd container/agent-runner && bun test` -- expected: all pass
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors

## Suggested Review Order

- Start here -- the whole recall workflow: index-first, `list_documents` fallback, Read-and-answer, plus the fallback/caveat guidance review added.
  [`SKILL.md:159`](../../container/skills/document-memory/SKILL.md#L159)
- Skill-discovery trigger phrases -- confirms a pure recall question (no attachment) actually loads this skill.
  [`SKILL.md:3`](../../container/skills/document-memory/SKILL.md#L3)
