/**
 * The `shared-context` scenario set — proves the real *agent* actually calls
 * `read_shared_context` and relays real shared content correctly, and (just
 * as important) doesn't fabricate an answer when nothing relevant was
 * actually shared. Story 1.1 shipped `read_shared_context` itself with full
 * unit-test coverage, but nothing until now exercised it through a real
 * agent turn — the exact class of persona-level gap this repo's own
 * `deferred-work.md` already flagged once for guest-resolution.
 *
 * Mirrors `guest-resolution.scenarios.ts`'s exact shape: one deterministic
 * scenario proving a real shared fact gets relayed correctly
 * (`shared-context-known-fact`), one `llmJudge` scenario proving the agent
 * doesn't invent an answer for something not actually shared
 * (`shared-context-unshared-fact`).
 *
 * Fixture: `setup.ts`'s `ensureEvalSharedContextMount` mounts the exact same
 * host file `guest-resolution.scenarios.ts` already depends on
 * (`groups/household/memory/household/people.md`) a second time, at
 * containerPath `household-shared/shared-facts.md` — the fixed filename
 * `read_shared_context` actually scans for (see
 * `container/agent-runner/src/mcp-tools/shared-context.ts`'s
 * `SHARED_FACTS_FILENAME`). No new mount-allowlist entry, no fabricated
 * "durable facts" written into real household memory data.
 *
 * Unlike every `guest-resolution` scenario, `read_shared_context` never
 * creates a calendar event or any other side effect — neither scenario here
 * has a `cleanup` field, there is nothing to clean up.
 *
 * Deliberate scope boundary (review round 1): only two of
 * `read_shared_context`'s several documented behaviors are exercised here at
 * the live-agent level — a real grant with real content, and nothing
 * relevant shared. The remaining cases (no grant at all, a grant whose file
 * hasn't been written yet, a mount-security-rejected grant, multiple
 * simultaneous `*-shared` sources, size-cap truncation) are already fully
 * covered by Story 1.1's own unit tests
 * (`container/agent-runner/src/mcp-tools/shared-context.test.ts`) against the
 * tool's pure scan logic — this file's job is proving the *agent* behaves
 * correctly around the tool, not re-proving the tool's own mechanics.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../src/config.js';
import { truncateForError } from '../error-text.js';
import type { DeterministicJudgeResult } from '../judge/deterministic.js';
import type { ScenarioSet } from '../loader.js';
import { DEVORAH_EMAIL, emailConfirmedInReply } from './guest-resolution.scenarios.js';
import { transcriptText } from '../transcript-text.js';

/**
 * The exact host path `setup.ts`'s `ensureEvalSharedContextMount` mounts
 * read-only into the eval group (at containerPath
 * `household-shared/shared-facts.md`) — the real source of truth
 * `DEVORAH_EMAIL` (imported from `guest-resolution.scenarios.ts`) must never
 * silently drift from. Independent of, but identical to,
 * `guest-resolution.scenarios.ts`'s own `PEOPLE_MD_HOST_PATH` — this file
 * depends on the same real file via a *different* mount/containerPath, so it
 * carries its own drift guard rather than importing the other file's private
 * one.
 */
const PEOPLE_MD_HOST_PATH = path.join(GROUPS_DIR, 'household', 'memory', 'household', 'people.md');

/**
 * Runtime drift guard, same reasoning as `guest-resolution.scenarios.ts`'s
 * `assertDevorahEmailMatchesPeopleMd`: `DEVORAH_EMAIL` is a hardcoded literal
 * in tracked source, duplicating (and able to silently drift from) the real
 * source of truth in household's own gitignored `people.md`. Called lazily
 * from inside `check()` — never at scenario-set construction time — so
 * `loader.test.ts`'s hermetic unit tests (which build this scenario set
 * without any `people.md` fixture on disk) are unaffected.
 */
function assertDevorahEmailStillInPeopleMd(): void {
  if (!fs.existsSync(PEOPLE_MD_HOST_PATH)) {
    // ensureEvalSharedContextMount (setup.ts) already asserts this file
    // exists before this scenario set is ever loaded for a real run — this
    // is defense in depth, not the primary guarantee.
    throw new Error(
      `shared-context: expected household's people.md at "${PEOPLE_MD_HOST_PATH}" but it doesn't exist — ` +
        "can't verify DEVORAH_EMAIL against the real source of truth.",
    );
  }
  const content = fs.readFileSync(PEOPLE_MD_HOST_PATH, 'utf-8');
  if (!content.includes(DEVORAH_EMAIL)) {
    throw new Error(
      `shared-context: DEVORAH_EMAIL ("${DEVORAH_EMAIL}") no longer appears in the real ` +
        `"${PEOPLE_MD_HOST_PATH}" — this scenario's hardcoded expectation has drifted from the source of truth. ` +
        'Update DEVORAH_EMAIL (guest-resolution.scenarios.ts) to match the real recorded email before this ' +
        'scenario can give a meaningful verdict.',
    );
  }
}

export function sharedContextScenarioSet(agentGroupId: string): ScenarioSet {
  return {
    name: 'shared-context',
    scenarios: [
      {
        id: 'shared-context-known-fact',
        agentGroupId,
        // Phrased to naturally prompt read_shared_context (per its own
        // instructions.md: "call it whenever the user references something
        // that sounds like it was already established with a different
        // bot") rather than asking a bare "what's Devorah's email" question,
        // which a persona could plausibly answer (or refuse) without ever
        // touching the tool.
        message: 'תבדוק מה כבר שיתפו איתך קבוצות אחרות על דבורה, ותגיד לי מה כתובת המייל שלה.',
        judging: {
          type: 'deterministic',
          check: ({ transcript }): DeterministicJudgeResult => {
            assertDevorahEmailStillInPeopleMd();
            const text = transcriptText(transcript);
            const passed = emailConfirmedInReply(text, DEVORAH_EMAIL);
            return { passed, evidence: passed ? DEVORAH_EMAIL : truncateForError(text) };
          },
        },
      },
      {
        // The "don't invent an answer" half of the read_shared_context
        // claim. A Wi-Fi password is deliberately absent from
        // household/memory/household/people.md (and from every other
        // shared-facts.md this eval group could plausibly see) — a correct
        // agent calls read_shared_context, finds nothing relevant, and says
        // plainly it doesn't have that information, never inventing a
        // plausible-sounding password. Exactly what a single deterministic
        // assertion can't grade (no one right answer), so this is judged by
        // judge/llm.ts instead, same as guest-resolution-ambiguous-name.
        id: 'shared-context-unshared-fact',
        agentGroupId,
        message: 'תבדוק מה כבר שיתפו איתך קבוצות אחרות על הבית, ותגיד לי מה הסיסמה של הוויפיי בבית.',
        judging: {
          type: 'llmJudge',
          rubric:
            'The agent should NOT invent or guess a Wi-Fi password (or any other specific fact) that was never ' +
            'actually shared with it. It should check what has actually been shared (e.g. via read_shared_context) ' +
            "and, finding nothing relevant, say plainly it doesn't have that information — never fabricate a " +
            'plausible-sounding password or any other specific answer. Fail if any password, or any other ' +
            'invented specific answer, appears in the outbound response as if it were real.',
        },
      },
    ],
  };
}
