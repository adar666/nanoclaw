# Eval Harness — Flow

How one scenario run moves through the system, end to end (CAP-1..CAP-4).

```mermaid
sequenceDiagram
    participant CLI as eval CLI (pnpm eval run <set>)
    participant Runner as Scenario Runner
    participant Container as Real per-group container<br/>(container-runner.ts, production path)
    participant InDB as inbound.db
    participant OutDB as outbound.db
    participant GCal as Google Calendar<br/>(eval-test calendar only)
    participant Judge as LLM Judge<br/>(second Claude call)

    CLI->>Runner: load scenario set (e.g. guest-resolution)
    loop each scenario
        Runner->>Container: spawn (same path as production spawn)
        Runner->>InDB: write scripted inbound message
        Container->>GCal: real tool calls (create/list/update event)<br/>scoped to eval-test calendar only
        Container->>OutDB: writes real outbound response
        Runner->>OutDB: poll for completion
        Runner->>OutDB: capture transcript + outcome
        alt deterministic scenario (CAP-2)
            Runner->>Runner: exact assertion against captured outcome
        else qualitative scenario (CAP-3)
            Runner->>Judge: transcript + rubric
            Judge-->>Runner: verdict + reasoning
        end
        Runner->>GCal: cleanup eval-test events from this scenario
        Runner->>Runner: record per-scenario verdict + evidence
    end
    Runner-->>CLI: saved report (all scenarios, pass/fail + evidence)
```

## Why the real container, not a shortcut

Every live bug epic-2 actually found in production (the MCP-subprocess `loadConfig()` gap, the per-group memory isolation gap, the mount-allowlist rejection, the persona-doc `add_calendar` discoverability gap) lived in the container/DB/composition layer — none of them would have been caught by calling the Claude Agent SDK directly with a hand-assembled prompt. The real spawn path is the point.
