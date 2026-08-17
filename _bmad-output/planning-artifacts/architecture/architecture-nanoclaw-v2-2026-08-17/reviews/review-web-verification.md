---
name: 'Web/Reality Verification Review — Google Calendar Read/Write Architecture Spine'
type: review
purpose: verification-audit
reviews: ../ARCHITECTURE-SPINE.md
created: '2026-08-17'
---

# Review: Web/Reality Verification of ARCHITECTURE-SPINE.md

**Reviewer mandate:** verify every committed decision that names a library/framework version or a technology's continued existence/fit was actually web-researched or reality-checked, rather than asserted from training data. Findings below are independently re-derived, not taken on the spine's or memlog's word.

## Verdict

**PASS with one moderate finding.** Every load-bearing technical claim I could independently check turned out accurate — Calendar API v3 endpoint shapes, the OneCLI SDK's `applyContainerConfig`/`agent` typing, the `onecli-gateway` skill's Google Calendar listing, and the pinned SDK version all check out against live sources or files, not just the spine's own say-so. The one real gap: AD-2's secondary clause about `onecli apps configure/connect` being "scoped per-agent" is not actually supported by the CLI's own `--help` output (`apps configure` takes no `--agent` flag) — a claim tagged "SDK-verified" that overreaches past what was actually checked.

---

## 1. Google Calendar API v3 (Stack table, AD-6)

**Memlog evidence (line 18):** `(version) Google Calendar API v3 confirmed current/stable via web search (developers.google.com docs updated 2026-07-07) -- REST endpoints POST/GET/PATCH https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events[/eventId].`

This is a real, dated, sourced claim (not a bare assertion) — but the memlog itself carries no query text or URLs, just a conclusion. I independently re-ran the check rather than trusting the line:

- **WebSearch** for the insert endpoint turned up `developers.google.com/workspace/calendar/api/v3/reference/events/insert`, with a synthesized note that "the official documentation was last updated on July 7, 2026" — matching the memlog's date exactly. A second search for deprecation confirmed v3 has not been superseded; only the old JSON-RPC/batch-endpoint sub-features (2019) were retired, not the API version itself.
- **WebFetch** on the three real reference pages returned the exact request lines:
  - `POST https://www.googleapis.com/calendar/v3/calendars/calendarId/events` (insert)
  - `GET https://www.googleapis.com/calendar/v3/calendars/calendarId/events` (list)
  - `PATCH https://www.googleapis.com/calendar/v3/calendars/calendarId/events/eventId` (patch)

All three match AD-6's `POST`/`GET`/`PATCH .../calendars/{calendarId}/events[/eventId]` claim exactly, `eventId` included on patch only.

**Verdict: accurate, independently reconfirmed.** [LOW] The one process gap: the memlog line has no query string or citation URL, so this claim's own audit trail is thin — it happens to hold up, but a reader couldn't verify it without redoing the search themselves (which is what this review did).

## 2. OneCLI SDK claims (AD-2)

Read directly: `node_modules/.pnpm/@onecli-sh+sdk@2.2.1/node_modules/@onecli-sh/sdk/lib/index.d.ts` (the exact path the spine cites).

Confirmed from the type file:
- `applyContainerConfig: (args: string[], options?: ApplyContainerConfigOptions) => Promise<boolean>` where `ApplyContainerConfigOptions extends GetContainerConfigOptions extends RequestOptions { agent?: string }` — so `applyContainerConfig(args, { agent })` is a real, accurately-typed call shape.
- The `OneCLI` class's full public surface (`getGatewaySkill`, `getContainerConfig`, `applyContainerConfig`, `createAgent`, `ensureAgent`, `provisionProject`, `configureManualApproval`) contains nothing resembling a per-request agent-switch on an already-running container — the "no per-request agent-switching mechanism exists" claim holds by exhaustive absence in this file.
- Cross-checked against actual usage in `src/container-runner.ts:626-629`: `onecli.ensureAgent(...)` then a single `onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier })` call, made once per container spawn, mutating the `docker run` args array (adds `HTTPS_PROXY`/cert mounts) before the process is exec'd. This corroborates the "binds the container's entire outbound network to one identity for its whole process lifetime" framing — that phrase is a runtime-behavior inference beyond what the `.d.ts` alone states (types don't describe lifetime semantics), but it's independently confirmed by reading the real call site, not asserted from training data.

**Verdict on the core claim: accurate, and actually verified against real code** — both the type file and the call site were read, not just cited.

**[MODERATE] Overreach on a secondary sub-claim:** AD-2's rule text also asserts "`onecli apps configure`/`connect` is scoped per-agent (one OAuth grant per app per identity)" as part of what's "SDK-verified." I ran `onecli apps configure --help` directly:

```
apps configure — Save OAuth credentials (BYOC) for a provider.
  --provider (required), --client-id (required), --client-secret (required), --json, --dry-run
```

No `--agent` flag exists on this command — it registers OAuth **client** credentials (BYOC) for a provider, which reads as project/org-scoped, not per-agent-identity. There is also no `onecli connect` command at all; the actual user-facing per-identity grant happens through the `connect_url` browser flow referenced in the `onecli-gateway` skill, not a CLI verb. `apps disconnect --connection-id (required if multiple connections exist)` hints that a provider *can* have multiple connections (consistent with per-identity grants existing), but this wasn't confirmed by inspecting connection records themselves. The memlog's citation ("verified via OneCLI SDK d.ts + apps list") doesn't actually establish this specific sub-claim — `apps list` output (which I also ran live) shows no per-agent/identity field either. This doesn't undermine AD-2's actual architectural **rule** (no `calendarId` argument, one calendar per container identity — that part is solidly supported by `applyContainerConfig`'s `agent` param + the container-runner.ts call site), but the "apps configure/connect is scoped per-agent" phrase inside the same bullet is asserted with more confidence than what was actually checked.

## 3. `onecli-gateway` skill's "Google Calendar is a supported app" claim (AD-1)

Read `container/skills/onecli-gateway/SKILL.md` directly. Line 25 states verbatim:

> "OAuth apps (Gmail, GitHub, Google Calendar, Google Drive, etc.) and API key services are all available through the gateway."

Confirmed — the claim is a direct, unparaphrased match to what's actually in the file, not an inference. I also independently ran `onecli apps list` live on this install (not just reading a static skill doc) and got:

```json
{ "id": "google-calendar", "name": "Google Calendar", "available": true, "connectionType": "oauth", "configurable": true, "config": null, "connection": null }
```

This is stronger evidence than the spine itself cites — live confirmation from the actual OneCLI gateway that Google Calendar is a real, currently-configurable app, not just skill-doc prose.

**Verdict: accurate, and independently corroborated beyond what the spine checked.**

## 4. Other named tech/versions — spot checks

| Claim | Check performed | Result |
| --- | --- | --- |
| `@onecli-sh/sdk@2.2.1` pinned in `package.json`, unchanged by this feature | Read root `package.json` | Exact match: `"@onecli-sh/sdk": "2.2.1"`. Note (informational, not a defect): the installed `onecli` **CLI** binary on this machine reports version `2.2.5` — CLI and SDK are separately versioned packages, and the spine correctly scopes its Stack-table entry to the SDK only, so there's no actual inconsistency, just worth knowing they diverge. |
| Bun's native `fetch()` — no new HTTP client dependency | Cross-checked against project's own `CLAUDE.md` ("The agent container runs on Bun") and Bun's well-established built-in spec-compliant `fetch` | Accurate; low-risk platform-capability claim, not version-sensitive, doesn't need a fresh web search to stand behind it. |
| `McpToolDefinition` + `registerTools()` convention "same mechanism as `documents.ts`" | Read `container/agent-runner/src/mcp-tools/types.ts` and `index.ts` | Confirmed: `McpToolDefinition { tool, handler }` interface exists; `index.ts`'s own header comment describes exactly this "create the file, call `registerTools([...])` at module scope, append the import" convention, and `documents.ts` is already wired into the barrel this way. |
| `send_message`'s schema is "plain `to`/`text`" (Consistency Conventions) | Read `container/agent-runner/src/mcp-tools/core.ts` | Confirmed verbatim: `inputSchema.properties = { to, text }`, both required. |
| `err()`/`ok()` MCP content shape used by "every other tool" | Read `core.ts`, `agents.ts` | Confirmed: both files define local `ok(text)`/`err(text)` helpers returning `{ content: [...], isError? }`. |

No inaccurate or fabricated version/technology claims found in this spot-check set.

## Summary Table

| # | Claim | Verified how | Severity if issue | Status |
| --- | --- | --- | --- | --- |
| 1 | Google Calendar API v3 still current; endpoint shapes | Independent WebSearch + WebFetch of 3 live Google docs pages | LOW (thin audit trail, but correct) | Confirmed accurate |
| 2a | `applyContainerConfig` binds container's whole outbound network to one identity, no per-request switching | Read actual `.d.ts` + `container-runner.ts` call site | — | Confirmed accurate, genuinely code-verified |
| 2b | `onecli apps configure/connect` "scoped per-agent" | Ran `onecli apps configure --help`, `apps list` live | MODERATE (overreach — not actually shown by the cited evidence) | Not supported as stated |
| 3 | `onecli-gateway` skill lists Google Calendar as supported | Read `SKILL.md` directly + live `onecli apps list` | — | Confirmed, exceeds spine's own verification |
| 4 | SDK version pin, Bun fetch, tool-registration convention, `send_message` schema, `ok`/`err` shape | Read `package.json`, `core.ts`, `types.ts`, `index.ts`, `agents.ts` | — | All confirmed accurate |

## Recommendation

Downgrade or narrow AD-2's `[ADOPTED, SDK-verified]` tag: split the bullet so the genuinely SDK/code-verified part (one identity per container, no per-request switching) keeps the tag, and the `apps configure/connect` per-agent-grant claim is either re-labeled `[ASSUMPTION]` or actually verified (e.g., by inspecting a live `connection` record for two different agent identities, or the OneCLI docs' description of the `connect_url` OAuth flow) before build. No other change needed — every other web/reality-checkable claim in the spine held up under independent re-verification.
