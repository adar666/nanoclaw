# Epic 1 Context: Cross-Group Context Sharing

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Any agent group can ask "what does the household already know about X" and get a real answer sourced from another agent group's explicitly-shared facts, so a user never has to repeat the same durable fact to every bot they talk to. The read path is one new MCP tool reading through a mount-security-gated, operator-configured, read-only mount — no new trust boundary, no self-service grants, no full memory merge. Standalone and independently shippable: usable the moment it lands, with no dependency on the provenance/receipts epic.

## Stories

- Story 1.1: Read a Fact Shared by Another Agent Group
- Story 1.2: Verify Cross-Group Sharing Behaves Correctly, Not Just Compiles

## Requirements & Constraints

- An agent group can query a durable fact another agent group has explicitly agreed to share, via a new `read_shared_context` tool. The grant is always operator-configured (`ncl groups config add-mount --ro`) — never agent-initiated or self-service.
- Three distinct situations — no grant exists, a grant exists but the source file hasn't been written yet, or mount-security rejected the mount — must all collapse to one identical, clean "not shared with you" result. Never an error, never fabricated content.
- A source group's shareable facts live in exactly one fixed file, scoped to durable household facts only (birthdays, sizes, preferences, similarly stable data) — never a dump of conversational memory, calendar, or document content, each of which already has its own recall path.
- Cross-group access is always read-only, enforced both by convention and by a server-side guard — not operator discipline alone. A request to share without the read-only flag must be rejected outright, not merely discouraged in docs.
- Every write to the shared-facts file must be lock-guarded/atomic — no unguarded read-then-overwrite that two concurrent sessions could race on.
- No new runtime dependencies; this composes entirely on libraries/tables/conventions already in the dependency tree.
- Real test coverage required on both host (`pnpm test`) and container (`bun test`) trees. The persona-level "resolves shared facts correctly, declines rather than guesses" claim additionally needs real eval-harness scenario coverage — not just unit tests — matching this project's existing bar for behavioral claims (the guest-resolution precedent).
- SPEC.md's success signal is explicitly a **live demonstration** requirement, not eval-coverage alone: a fact told to one real agent group must be shown, live against the household's actual three agent groups, surfacing in another permitted group without the user re-telling it. This must be an explicit acceptance step in whichever story closes the epic, not assumed satisfied by the eval scenario passing.

## Technical Decisions

- **No new communication path.** CAP-1 reads only through a filesystem mount already validated by `src/modules/mount-security` — no new IPC channel, no new host↔container protocol, no new database table.
- **Grant mechanism is the existing `add-mount` verb, unchanged**, just always `--ro`: `ncl groups config add-mount --ro`, `hostOnly: true`, `access: 'approval'`, operator-run, requires `ncl groups restart` to take effect. This reuses the already-production-proven mechanism (household's `people.md` mounted read-only into other groups).
- **Shareable-facts file**: fixed path `memory/shared-facts.md` in the source group's own folder, using the existing OKF frontmatter convention (see `docs/memory.md`). This is the only file `read_shared_context` ever reads or expects mounted — the fixed shape is what makes a generic query tool possible. Writes to it go through the same `withLock`/atomic-write discipline already established for shared per-group files (document-memory precedent).
- **New MCP tool**: `read_shared_context`, a new `McpToolDefinition` in `container/agent-runner/src/mcp-tools/shared-context.ts`, registered via the existing `registerTools([...])` convention (mirrors `calendar.ts`), wired in with one `import` line in `mcp-tools/index.ts`, with a sibling `*.instructions.md`. This is an agent-runtime read (MCP tool), not an admin CLI verb.
- **containerPath convention**: `<source-group-folder>-shared/<filename>` — filename included, not a bare directory — exactly matching the existing `eval/setup.ts` precedent (`household-shared/people.md`). `read_shared_context` deterministically constructs `/workspace/extra/<source-group-folder>-shared/shared-facts.md` from the known source folder name; it does not scan an arbitrary mount tree.
- **Unified "not shared" result**: no grant, a grant with no file yet, and a mount-security-rejected mount all produce the identical clean result to the agent. The operator-facing diagnostic for a rejection stays the existing mount-security `WARN` log in `nanoclaw.error.log` — no new diagnostic mechanism.
- **Server-side `--ro` enforcement**: `config add-mount`'s handler (`src/cli/resources/groups.ts`) gains one guard clause rejecting any `--container-path` matching the `*-shared/` convention unless `--ro` is also passed. This closes the read-write-by-default footgun in code, not just documentation — mount-security otherwise defaults to read-write when `--ro` is omitted.
- **Eval coverage**: `eval/scenarios/shared-context.scenarios.ts`, following the existing `ScenarioSetFactory` convention (`guest-resolution.scenarios.ts` precedent), registered in `eval/loader.ts`'s `SCENARIO_SETS`. Needs one deterministic scenario (exact on-file fact returned when a grant exists) and one `llmJudge` scenario (agent declines/asks rather than guessing when no grant exists). Run via `pnpm eval run shared-context` — real container, real Claude call, real tokens; get operator go-ahead first.
- **Rebuild/restart implications**: the new MCP tool (`shared-context.ts`) is container-side only — a fresh container spawn on next wake is sufficient, no host rebuild needed. The `--ro` guard clause in `config add-mount`'s handler is a host-side `src/cli/resources/groups.ts` change — needs `pnpm run build` + a service restart, not a container rebuild. This epic touches both rebuild paths; don't assume one covers the other.

## Cross-Story Dependencies

- Story 1.2 depends on Story 1.1 being complete — it verifies the actual read path (tool + mount + guard) that 1.1 builds, via a real container and real agent, not unit tests alone.
- This epic has no dependency on Epic 2 (Provenance & Receipts) — different files, different domain, independently shippable in either order.
