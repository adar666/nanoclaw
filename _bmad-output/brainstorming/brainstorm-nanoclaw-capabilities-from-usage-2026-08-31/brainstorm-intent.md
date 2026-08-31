# Brainstorm Intent: Shared-Fact Resolution + Provenance/Receipts

Source: `.memlog.md` (11 techniques, 76 raw ideas, closing insight entry). This doc carries forward only the two directions the user confirmed from that insight, as input to a downstream spec pass.

## Problem framing

NanoClaw runs three isolated agent groups today — a personal DM assistant (Yulanda), a household coordination assistant, and a partner's personal DM assistant (Tina) — each with its own fully isolated memory (`/workspace/agent/memory/`, per the isolation-model pitfall already logged in CLAUDE.md). A fact one bot learns never reaches the others: the household bot doesn't know what Yulanda already told the user, and a fix has to be a deliberate read-only mount of one group's memory into another's, not something that happens automatically. Separately, everything the system does automatically — a scheduled task firing, a document getting filled, a self-mod change applying — happens with no visible trail of why it happened, who asked, or what triggered it, which erodes trust the moment a user is surprised by an action they don't remember requesting.

## Direction 1: Shared-fact / context resolution across agent groups

**Core capability**: a cross-group, read-only "context memory" query — the household bot (and each personal bot) can ask "what do the other groups already know about X" without a full memory merge and without breaking group isolation as the default.

**Supporting ideas that shaped it** (compressed from the memlog):
- The scenario itself, reinvented independently four separate times across four different techniques (Ghost User Interview, One Sentence Spec x2, Two Bots One Brain) — this repeat rate is the strongest single signal in the whole session.
- No Rules Roadmap's walked-back version: a cross-group read-only search tool gated by the existing mount-allowlist mechanism, not a new trust boundary.
- Two Bots One Brain and Job to Be Done both narrowed the shape further: an opt-in one-way summary push from a personal DM into household (not bidirectional), and a lightweight "family facts" layer for durable facts (birthdays, sizes, preferences) distinct from calendar/documents.

**First-cut "done" shape**: one new read-only query surface (tool or CLI-backed) that lets an agent group ask about facts recorded in another group it's explicitly permitted to see, reusing the mount-allowlist as the permission gate rather than inventing a new one; scoped to durable household facts, not a live merge of full conversational memory; each of the three real groups can answer "what does the household already know" without the user repeating themselves.

## Direction 2: Transparency / provenance ("receipts") for automated actions

**Core capability**: every automated action (task creation, a fired reminder, a document write, a self-mod change) carries a retrievable one-line record of why it happened and who/what triggered it, answerable on demand ("why did I get this").

**Supporting ideas that shaped it** (compressed):
- Surfaced independently in three techniques wearing different framing each time: Yes And Building's task-creation log of "which chat message triggered this," Infomercial's REMINDER RECEIPTS / DOCUMENT RECEIPTS bits, and One Sentence Spec's "never surprise me with a reminder I don't remember asking for."
- git-blame-style provenance for household memory facts (who-added-it/when) as the pattern to generalize from, not a new mechanism.
- The monthly/first-run digest idea (Yes And Building) as the natural surfacing layer — a periodic recap of what's being tracked and why, itself produced by the existing `ncl tasks` mechanism rather than new infra.

**First-cut "done" shape**: a `why` field recorded at creation time on tasks/reminders (triggering message + requester) and retrievable on demand; extends the same provenance shape to self-mod changes and document writes where a trigger already exists in the current flow; a lightweight digest (task-driven, not new infra) that periodically surfaces what's being automated — no new storage layer, reusing fields/mechanisms that already exist (task metadata, approval log, memory provenance pattern).

## Why these two, not the others

The closing insight named five threads; three are deliberately deferred here, not dropped:
- **Trust via visible uncertainty** ("ask, don't guess" as a cross-cutting rule, generalizing guest resolution) — real, but a persona/prompting change rather than a new capability surface; lower buildable specificity than the two above.
- **Generalizing the idempotency-guard/undo patterns** (calendar's duplicate-confirm and version-history/undo, extended to documents and tasks) — a solid pattern-reuse candidate, but scoped as a refinement of existing UX rather than a new initiative.
- **Persona-tuned risk profiles** (per-agent-group confirmation/self-mod friction, e.g. Tina vs. Yulanda) — real signal from Two Bots One Brain, but narrower in scope and lower repeat-count than the top two.

These three remain valid candidates for a later brainstorm-intent or spec pass; they are out of scope for this handoff only because the user chose to prioritize the two highest-repeat-signal, most-buildable threads first.
