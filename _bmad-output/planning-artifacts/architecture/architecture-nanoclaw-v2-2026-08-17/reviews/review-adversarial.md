---
name: 'Adversarial Review — Google Calendar Read/Write Spine'
type: architecture-review
reviewed: ../ARCHITECTURE-SPINE.md
reviewed-memlog: ../.memlog.md
method: 'Construct two units one level below the spine that each obey every AD to the letter yet build incompatibly. Each hole closes with a new/tightened AD.'
created: '2026-08-17'
---

# Adversarial Review — Google Calendar Read/Write Spine

## Verdict

The spine is solid on the calendar-selection axis (AD-1/AD-2 pin ownership hard, with SDK-verified evidence) but leaves the **relay conversation itself** — the thing three of the five capabilities actually depend on — almost entirely unspecified: no message-composition contract, no reply-vs-request discrimination, no compound-request handling, no sender-identity resolution mechanism, no ambiguity-matching algorithm, and no idempotency guard. Six concrete holes found below; all are real (grounded in the current codebase, not hypothetical), five are launch-blocking.

## Method note

Each hole below is demonstrated as a pair of units — "Story A" / "Story B" (or three-way) — each of which is a plausible, literal reading of the spine's ADs and Consistency Conventions, built by a different engineer with no coordination beyond the spine text. Where a claim in the spine ("already present in every chat turn's metadata", "same disambiguation precedent") was checked against actual code, the grounding file:line is cited.

---

## Hole 1 — SEVERITY: CRITICAL — Reply-vs-request discrimination is undefined → real infinite-relay-loop risk

**Hunt target:** #1 (double-relay loop) and #3-adjacent (AD-3's letter, read literally, causes the loop).

### The clash

Grounding: `send_message`'s outbound payload is `content: JSON.stringify({ text })` only — no `replyTo`, no `kind` marker distinguishing a reply from a fresh ask (`container/agent-runner/src/mcp-tools/core.ts:96-104`). On the receiving side, an agent-to-agent message always wakes the target container and lands as an ordinary `kind: 'chat'` row (`src/modules/agent-to-agent/agent-route.ts` — routes through `wakeContainer`, no LLM bypass), and is rendered to the receiving agent as a bare `<message sender="...">text</message>` block indistinguishable in shape from a human chat message (`formatter.ts:174-186`). There is no field, anywhere in what the agent sees, that says "this is a confirmation reply to a relay I sent, not a new actionable request."

- **Story A** (household side): implements AD-3 literally — "household ... asking for Devorah's calendar does not call a calendar tool at all, it calls send_message." Its calendar skill instructs: *whenever an inbound message concerns Devorah's calendar and this isn't dm-with-partner, relay it via send_message.* When dm-with-partner's confirmation ("Done — I've added the dentist appointment to Devorah's calendar for Tuesday 3pm") arrives back in household as a plain chat message mentioning "Devorah's calendar," Story A's skill instructions match on content, not on message provenance, and re-relay it back to dm-with-partner as if it were a fresh request. dm-with-partner's own analogous skill logic (built by Story B, independently, with the same literal reading) does the same in reverse the next time household relays anything containing "Uriel's calendar." Two independently-AD-compliant skills produce an oscillating bounce.
- **Story B** (dm-with-partner side, built to avoid the above): threads relay replies using `send_message`'s existing `in_reply_to`/`getCurrentInReplyTo()` book-keeping and instructs its persona "a message from a destination I just relayed to, within N minutes, is terminal — forward to the human, do not act on it." This works, but it is **Story B's own invented convention**, not something the spine specifies, so it only prevents the loop on the leg Story B controls. Story A (household), on the other side, never adopted an equivalent rule, so the loop still fires whenever household is the one *receiving* a reply.

Both stories are fully AD-3/AD-4-compliant. The spine simply never says how a persona tells "confirmation to relay to the human" apart from "new request to relay onward" — and the codebase provides no structural signal to lean on (checked: no reply marker on agent-to-agent `send_message`).

### Proposed fix — new AD-9

> **AD-9 — Relay confirmations are terminal, never re-relayed.**
> A message a calendar skill receives from a destination it does not own, when that inbound message reports an outcome of an action the receiving agent itself asked for (a completion, an error, or a request for missing detail on a request this agent originated) — see AD-9a for a positive test, not a heuristic left to inference — is delivered to the human and never treated as a fresh calendar request needing further relay. Concretely: `send_message`'s payload gains an optional structured marker (e.g. `{ text, relayOf?: <the id/seq of the original relay request this replies to> }`) that the calendar-relay skill instructions require calendar-tool call sites to set on confirmations and check on receipt, so "is this a reply to my own relay" is a field lookup, not content-sniffing. This is the one place this spine should tolerate a small, explicit protocol extension over free-text `send_message`, specifically to close this loop — everything else stays natural language per the existing Consistency Convention.

---

## Hole 2 — SEVERITY: HIGH — Relay message composition is unconstrained: verbatim forward vs. paraphrase vs. structured-in-prose all pass the letter of the spine

**Hunt target:** #2.

### The clash

The Consistency Conventions table says only: *"Cross-agent relay text | Natural language via `send_message`, not a structured/JSON payload."* It says nothing about **who composes** the text or **what it must contain**. `send_message`'s own schema is `{ to, text }` — free string (`core.ts:74-84`) — so the spine's convention is trivially satisfiable by wildly different content.

- **Story A**: relaying agent forwards the user's raw message text verbatim ("book me and Devorah for dentist Tuesday at 3, tell her"). Compliant — it's natural language, not JSON. But "tell her" is second-person framing addressed to the *original* human, not to Devorah's agent; the receiving agent has to re-derive who "her" refers to, what "book me" means (title? attendee?), and what timezone "Tuesday" resolves against (its own turn's `<context timezone>` header, generated fresh per-container — usually fine, but silently assumes both containers process same-day).
- **Story B**: relaying agent paraphrases into a compressed summary ("Devorah — dentist Tues 3, plz add") — also compliant, but drops the attendee list / duration / location the original user actually specified, because the paraphrase step has no contract requiring field-completeness.
- **Story C**: relaying agent composes a field-labeled prose message ("Please create: title 'Dentist', start 2026-08-19T15:00 Asia/Jerusalem, 30 min, attendee Uriel; requested by Uriel via household") — also compliant, and the only one of the three that reliably survives the round trip without detail loss.

All three satisfy "natural language, not JSON." Only one is actually safe. Nothing in the spine picks a winner, so two independently-built stories can each ship a "compliant" relay path with materially different reliability — and CAP-1/CAP-3 (writes) are exactly the capabilities where a dropped attendee or wrong date is a real-world consequence (a missed appointment), not a cosmetic bug.

### Proposed fix — new AD-10

> **AD-10 — Relay text is a composed, field-complete restatement, never a verbatim forward.**
> The relaying agent (not the receiving agent) is responsible for resolving every ambiguous element of the user's request against its own turn context (relative dates → absolute ISO date via the container's own `<context timezone>`, "me"/"my" → the resolved sender identity per AD-5, implicit attendees) *before* calling `send_message`, and must restate the resolved event fields explicitly in the relay text: title, start, end (or duration), timezone, attendees, location if given, and who is asking. Plain prose, not JSON — restating structured facts in natural language is not the same as sending a structured payload, and satisfies the existing Consistency Convention. A relay message that is just the user's original wording forwarded unchanged does not satisfy this AD.

---

## Hole 3 — SEVERITY: HIGH — AD-5's "sender identity... already present in metadata" cites a mechanism weaker than the claim, and doesn't name it

**Hunt target:** #3.

### The clash

AD-5's rule: *"The requesting user's own sender identity (already present in every chat turn's metadata, per this codebase's existing message-authoring shape) determines whose calendar an unqualified 'my calendar' refers to."*

Grounding check: the field that actually reaches the agent's context is `content.sender` rendered as the `<message sender="...">` attribute (`formatter.ts:176,186`) — a **free-text display-name string** sourced from whatever the channel adapter put in `content.sender` (e.g., a Telegram first name or username), not a stable identity. The stable, namespaced `senderId` (`content.senderId` / `content.author.userId`, extracted at `formatter.ts:82-89`) is used *only* for admin-command gating in `categorizeMessage` — `formatMessages` never emits it into the agent-visible prompt (`formatter.ts:132`: "the agent never sees platform_id, channel_type, thread_id" — and senderId isn't passed through either). So the "metadata" AD-5 leans on is a display-name string with no guaranteed relationship to "Uriel" or "Devorah" as literal values, and no canonical person↔calendar mapping table exists anywhere in the spine, the Structural Seed, or the Stack.

- **Story A**: hardcodes `sender === "Devorah"` (or a known Telegram username) as the household-chat disambiguation check, falling back to Uriel otherwise. Breaks the moment Devorah's Telegram display name isn't literally "Devorah" (nickname, emoji, a shared family device's generic name), silently misattributing every ambiguous request to Uriel — the exact failure AD-5 exists to prevent.
- **Story B**: instructs the persona to ask a clarifying question whenever the sender string isn't an exact, case-sensitive match against a hardcoded allowlist it invented independently (`{"Uriel", "uriel_adar"}` etc., picked without reference to Story A's list) — over-asks for exactly the cases Story A silently mis-resolves, and the two households/skills now behave inconsistently on the identical input depending on which was actually shipped.

Both stories are "AD-5-compliant" — the spine names no concrete field, no canonical mapping source, and no fallback behavior when the sender string doesn't cleanly match either name.

### Proposed fix — tighten AD-5

> **AD-5 (tightened) — Sender identity resolves via a named, versioned mapping, with a mandatory ask-don't-guess fallback.**
> `household`'s calendar skill ships (in its `SKILL.md` or a small config file under `groups/household/`) an explicit, operator-maintained mapping from the `sender` display-name string(s) that actually appear in that chat's `<message sender="...">` attribute to the two calendar owners ("Uriel" → household's own calendar; "Devorah"/known aliases → relay to `dm-with-partner`). Add: the mapping is a build-stage artifact, not something two stories may each independently invent inline in prose — it lives in one place, referenced by name in AD-5's rule text once written into the skill. When the observed `sender` string doesn't match any entry, the agent asks who is asking rather than guessing or defaulting — no silent fallback to Uriel or to "whichever calendar happens to be locally connected" (the existing Prevents clause), and no silent fallback to Devorah either.

---

## Hole 4 — SEVERITY: MEDIUM — Compound single-message, dual-calendar requests are entirely unaddressed

**Hunt target:** #4.

### The clash

Nothing in the spine — not the diagram, not any AD, not the Structural Seed — describes what happens when one inbound message needs both calendars ("check what's on my calendar and also Devorah's"). AD-2 scopes every *tool call* to one calendar; AD-3 scopes every *relay* to the surface that doesn't own the target. Both are individually satisfiable by decomposing the compound ask into two operations, but nothing requires that decomposition to happen, or to be complete.

- **Story A**: household's skill instructions frame every request as "identify the target calendar, act" (singular) — on a compound ask it resolves the first-named calendar only ("my calendar" → Uriel's, direct `list_calendar_events` call), answers that, and never notices or relays the second clause. Silent partial fulfillment; the user has to notice and re-ask.
- **Story B**: household's skill explicitly loops over every distinct calendar reference found in one message, issuing a direct `list_calendar_events` call for the owned one and a `send_message` relay for the other in the same turn. Fully compliant with every AD, and actually does what the user asked.

Both are AD-1 through AD-8 compliant. Only one delivers the capability the user will obviously expect the first time they combine two names in one sentence in the one chat surface (household) that has access to both people.

### Proposed fix — new AD-11

> **AD-11 — A single request naming multiple calendars decomposes into one operation per calendar, not one operation total.**
> When a request in `household` (the only surface where this can occur — dm-with-uriel and dm-with-partner each have exactly one non-owned calendar to reach) names or clearly implies both calendars, the agent performs the local tool call for the calendar it owns and, in the same turn, issues the AD-3 relay for the calendar it doesn't — both are actioned, never just the first-named. The relay's fire-and-forget nature (AD-4) applies to the relayed leg only; the locally-owned leg still answers same-turn. `list_calendar_events` reads and `create`/`update_calendar_event` writes are both in scope for this AD — a compound read ("what's on both calendars") and a compound write ("book us both") follow the same decomposition rule.

---

## Hole 5 — SEVERITY: HIGH — AD-7's borrowed disambiguation precedent doesn't actually transfer; "ambiguous" is undefined for calendar events

**Hunt target:** #5.

### The clash

AD-7: *"Same disambiguation precedent as `spec-document-memory`'s CAP-2/CAP-3 — when a reference matches more than one real event, present a numbered candidate list and wait for a pick."* Grounding check on the actual precedent (`container/agent-runner/src/mcp-tools/documents.ts:970-1035`): document-memory's "ambiguous" is a **mechanical, deterministic** match — the same filename slug existing under two different file extensions on disk (`ambiguousExtensions`, `matches.length > 1` on an exact-slug lookup). There is no fuzzy matching, no string-distance threshold, no time-window heuristic involved anywhere in that precedent. Calendar events have no equivalent deterministic key — "the meeting with Devorah" or "the dentist appointment" is a natural-language reference against a list of Google Calendar API results, and "matches more than one" is now a **matching-algorithm design decision** the precedent gives zero guidance on.

- **Story A**: implements matching as case-insensitive substring match on event `summary` only. "the dentist thing" never matches an event titled "Dentist — Dr. Cohen," falls through to "0 matches" behavior (not covered by AD-7 either — see below) instead of surfacing the real ambiguity risk when two candidate events both loosely fit.
- **Story B**: implements matching as "any event within ±3 days of a mentioned date, regardless of title," which for a busy calendar routinely returns 4-5 "candidates" for a request that the user considered unambiguous ("move my 2pm tomorrow") — over-triggering the numbered-list flow AD-7 exists to gate, degrading UX for the common case.
- Both are "AD-7-compliant" — each genuinely presents a numbered list when *its own* definition of "matches more than one" fires — but the two skills disambiguate on completely different signals (title text vs. time proximity vs., unaddressed, attendee overlap), so behavior is inconsistent across surfaces and neither is verifiably "correct" against the spine.

Additionally: AD-7 only says what to do at 2+ matches. It says nothing about the 0-match case (event genuinely not found — surfaced as an error? silently treated as "create new"? asked to rephrase?), which is squarely in-scope for `update_calendar_event` and just as risky as the ambiguous case.

### Proposed fix — tighten AD-7

> **AD-7 (tightened) — Ambiguity match is defined, not borrowed by analogy; 0-match is specified too.**
> `update_calendar_event` and `list_calendar_events` resolve a natural-language event reference against the Calendar API's own list results using: (1) an explicit date/time window derived from the reference if one is stated or implied (default: ±the smallest window that keeps the search meaningful, e.g. same day, when the user gives no date at all reject rather than searching the whole calendar), AND (2) a text match against `summary` (case-insensitive substring, not fuzzy-distance scoring — keeps behavior predictable and auditable). "More than one match" (both filters combined) triggers the numbered candidate list per the existing rule; exactly one match proceeds directly; **zero matches is a distinct, explicit outcome** — the tool returns "no event found matching that description" and the agent asks the user to rephrase or narrow, never silently falls through to `create` or to "closest guess." This is a genuinely new algorithm (document-memory's exact-slug precedent doesn't cover natural-language matching), not a restatement of AD-7's original text — the "same precedent as document-memory" framing is dropped as inapplicable to this capability's actual matching problem.

---

## Hole 6 — SEVERITY: MEDIUM — No idempotency/duplicate-write guard; a relayed create and a locally-initiated create on the same calendar can double-book

**Hunt target:** #6.

### The clash

AD-6 specifies each tool as "a direct `fetch()`... `POST`/`GET`/`PATCH`" — no idempotency key, no pre-write existence check, no de-dup logic anywhere in the spine. Consider: Devorah, directly in `dm-with-partner`, asks her own agent to add "dentist Tuesday 3pm." At nearly the same moment, Uriel in `household` asks the household agent to do the same on Devorah's behalf ("can you also get Devorah down for the dentist Tuesday"), which per AD-3 relays to `dm-with-partner`. Because AD-4 makes the relay asynchronous — the relaying agent doesn't wait for or see the receiving agent's in-flight state — nothing prevents `dm-with-partner`'s container from processing both the human-direct request and the relayed request as two independent `create_calendar_event` calls, each a bare `POST` with no correlation to the other.

- **Story A**: `create_calendar_event`'s tool code is a pure pass-through `POST` — no pre-check. Two near-simultaneous creates (one direct, one relayed) produce two Google Calendar events for the same appointment. Fully AD-1/AD-2/AD-6-compliant; the duplicate is real.
- **Story B**: adds a pre-`POST` `list_calendar_events` existence check inside `create_calendar_event` itself ("does an event with this exact title/time already exist? skip if so") — also AD-6-compliant (still "a direct fetch... through HTTPS_PROXY," the AD never says *only one* fetch per call), but this is Story B's own invented safety net, undocumented anywhere at the spine level, so Story A's version (built by someone who didn't think to add it) ships with the race intact and nobody reviewing against the spine would catch the gap — the spine doesn't ask either way.

### Proposed fix — new AD-12

> **AD-12 — `create_calendar_event` checks for a near-duplicate before writing.**
> Before issuing the `POST`, `create_calendar_event` calls the same calendar's `list` for events overlapping the requested time window (±30 min) and compares `summary` (case-insensitive substring, matching AD-7's tightened definition for consistency) against the requested title. An overlapping match is surfaced back to the caller as "an event that looks like this already exists — did you mean to update it, or is this a genuinely separate event?" rather than silently creating a duplicate or silently skipping the create. This does not require a host-side lock or a new dependency — it's one extra `fetch()` inside the existing tool, consistent with AD-6's no-new-dependency stance — and it is the direct, minimal answer to the fire-and-forget relay (AD-4) creating exactly the kind of race a synchronous flow wouldn't have.

---

## Summary table

| # | Hole | Severity | Fix |
|---|------|----------|-----|
| 1 | No reply-vs-request discrimination on agent-to-agent messages → real bounce/loop risk | CRITICAL | New AD-9: relay confirmations carry a `relayOf` marker and are terminal, never re-relayed |
| 2 | Relay message content unconstrained (verbatim / paraphrase / structured-in-prose all "compliant") | HIGH | New AD-10: relaying agent composes a field-complete restatement (title/start/end/tz/attendees/location/requester) before relaying |
| 3 | AD-5's "sender identity in metadata" is a free-text display-name string with no named mapping to Uriel/Devorah | HIGH | Tighten AD-5: named, versioned sender→person mapping + mandatory ask-don't-guess fallback |
| 4 | Compound single-message dual-calendar requests unaddressed — one story silently drops the second calendar | MEDIUM | New AD-11: one operation per named calendar, not one operation total |
| 5 | AD-7's document-memory precedent doesn't transfer to NL calendar-event matching; 0-match case unspecified | HIGH | Tighten AD-7: define the actual match algorithm (date window + substring) and the 0-match outcome explicitly |
| 6 | No idempotency guard — relayed create + locally-initiated create on same calendar can double-book | MEDIUM | New AD-12: pre-`POST` overlap check inside `create_calendar_event`, surfaced as a confirm-or-separate question |

File: `/Users/uriel/Projects/nanoclaw-v2/_bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-17/reviews/review-adversarial.md`
