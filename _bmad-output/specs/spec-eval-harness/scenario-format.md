# Scenario Format

The schema a scenario definition follows (CAP-5: domain-agnostic — nothing here is calendar-specific except the example content).

## Fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable slug, e.g. `guest-resolution-known-name` |
| `agentGroupId` | yes | Which real agent group's container to spawn (e.g. household, dm-with-uriel) |
| `setup` | no | Steps to run before the scenario message (e.g. ensure a specific event exists) |
| `message` | yes | The exact inbound text sent to the agent, as a real user would type it |
| `judging` | yes | One of two shapes: |
| — `deterministic` | | `{ type: "deterministic", check: <fn or declarative assertion against outbound.db / real API state> }` |
| — `llmJudge` | | `{ type: "llmJudge", rubric: <prose the judge grades the transcript against> }` |
| `cleanup` | no | Steps to run after judging, regardless of verdict (e.g. delete the event this scenario created) |

A scenario file is a list of these — one file per scenario **set** (e.g. `guest-resolution.scenarios.ts`), matching CAP-6's "run the harness against the guest-resolution scenario set" framing.

## Worked example — the real scenario that motivated this spec

Drawn directly from this session's live (manual, one-off) testing of the calendar skill's guest-resolution claim, adapted to run against the dedicated eval agent group rather than the real `household` group it was originally tested against (see the architecture spine's AD-1 — `agentGroupId` here is never a real production group, always the isolated one `eval/setup.ts` creates).

```ts
{
  id: "guest-resolution-known-name",
  agentGroupId: EVAL_AGENT_GROUP_ID, // the dedicated eval-only group (setup.ts), NEVER a real production group
  message: "פגישה מחר ב19 תוסיף את דבורה כאורחת",
  judging: {
    type: "deterministic",
    // Asserts against the real outbound.db content: the created event's
    // attendee list contains devorah's real recorded email from
    // groups/household/memory/household/people.md — not a guess, not a
    // placeholder, the actual on-file address.
    check: "createdEventAttendeesInclude('adardevora@gmail.com')",
  },
  cleanup: "deleteEventCreatedThisScenario",
}
```

A qualitative counterpart — the "ask, don't guess" half of the same claim:

```ts
{
  id: "guest-resolution-ambiguous-name",
  agentGroupId: EVAL_AGENT_GROUP_ID,
  message: "פגישה מחר ב19 תוסיף את רותי כאורחת", // "Ruthie" — not in people.md
  judging: {
    type: "llmJudge",
    rubric:
      "The agent should NOT invent or guess an email address for a name " +
      "it can't resolve from memory. It should either ask the user for " +
      "the email, or say plainly it can't find one. Fail if any email " +
      "address appears in the outbound response for this unresolved name.",
  },
  cleanup: "deleteEventCreatedThisScenario", // in case it wrongly created one anyway
}
```
