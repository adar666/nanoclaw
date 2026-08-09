---
name: gmail-sender-review
description: >-
  Gmail sender-classification workflow for second-brain — proposing and
  resolving `pending_senders` batches via gmail-rules.js (list-pending,
  propose, list-proposals, resolve-proposal, set). Use this whenever
  running a gmail sender-review round, whether kicked off by the daily
  scheduled task or continuing a round after a confirmation. The
  staged-confirmation gate itself (never call `set` off a first answer)
  lives in your standing instructions, not here — this skill is the
  mechanics: exact commands, why the propose/list-proposals pairing
  exists, how a fresh round gets kicked off, and batching discipline.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Gmail sender review — mechanics

This is the procedural half of sender review. The rule that governs when
you're allowed to write (`set`) lives in your standing instructions — read
that first if you haven't. This skill covers everything else: the exact
commands, why `propose`/`list-proposals` exist, how a round gets kicked
off, and how to batch proposals.

**Background.** second-brain's Gmail source classifies each sender ONCE —
household / private / ignore — via a per-sender rule, so every future
email from them routes automatically with no review needed. A brand-new
sender has no rule yet and sits in a review queue (`pending_senders`)
until classified. Your job: surface the queue, propose classifications,
and only write a rule once the standing-instructions confirmation gate
has actually been satisfied.

**Commands** (same absolute-path pattern as the read-only `query.js`
access — the tool's own default `--db` doesn't match where it's mounted
here, so always pass `--db` explicitly):

```
node /workspace/extra/second-brain/dist/bin/gmail-rules.js list-pending --tenant uriel --db /workspace/extra/second-brain-data/uriel.db
node /workspace/extra/second-brain/dist/bin/gmail-rules.js propose --tenant uriel --db /workspace/extra/second-brain-data/uriel.db --item "<address>|household|private|ignore[|note]" [--item "..." ...]
node /workspace/extra/second-brain/dist/bin/gmail-rules.js list-proposals --tenant uriel --db /workspace/extra/second-brain-data/uriel.db [--status pending] [--limit <n>]
node /workspace/extra/second-brain/dist/bin/gmail-rules.js resolve-proposal --tenant uriel --db /workspace/extra/second-brain-data/uriel.db --id <n>
node /workspace/extra/second-brain/dist/bin/gmail-rules.js set --tenant uriel --sender <address> --category household|private|ignore --db /workspace/extra/second-brain-data/uriel.db
```

`list-pending` and `list-proposals` are read-only — run them as often as
you like. `propose`, `resolve-proposal`, and `set` all write. **Never
pass `--download-attachments` or `--no-download-attachments` to `set` —
that flag doesn't exist for you.** Whether a sender's attachments get
downloaded is a separate trust decision made by hand, directly, never
through you.

**Why `propose`/`list-proposals`/`resolve-proposal` exist — read this
before you skip straight to `set`.** Every batch is proposed in a fresh,
disposable one-off task session (see "How a round starts" below) —
completely separate from the ongoing DM chat session, and thrown away
right after. When that session fires, proposes a batch, and ends, its
own memory of what it just proposed is gone by the time the reply arrives
later in the DM chat. There is no shared conversation history between the
two; you cannot recall your own proposal from context, because as far as
the SDK conversation is concerned, you never said it. `propose` fixes
this by writing the batch into `uriel.db` itself — `sender → category`
pairs, numbered 1..N in the exact order you're about to present them —
so that later, whichever session you're in, you can read the same
numbered list back deterministically with `list-proposals` and match the
reply against it by position ("yes to 1,2,4, no on 3, make 5 private
instead") instead of guessing from memory. `list-proposals` with no
`--status` returns the most recent batches regardless of status — that's
"what did I just propose" — pass `--limit 5` or more if the reply seems
to be about an older batch than the most recent one.

**Why the staged-confirmation flow's step 3 works even though you have
no memory of proposing:** the session that proposed a batch is always a
fresh, disposable one — see below — and shares no conversation history
with the DM chat session. By the time a reply arrives there, that
session is long gone and there's no recollection of it from context.
`propose`/`list-proposals` sidestep that entirely: the batch lives in
`uriel.db`, not in anyone's memory, so reading it back with
`list-proposals` is exact and reliable regardless of which session is
currently active — no recall, no guessing needed for this specific
purpose.

## How a round starts — always a fresh, disposable session

Proposing a batch is the expensive part of this workflow — drafting the
list, checking `list-pending`, writing the message. If that work happened
in a session that sticks around (the DM chat, or a recurring scheduled
task's own session), its context would grow every single round, forever.
The fix: **every round is proposed in a brand-new one-off task, used once
and thrown away.** Nothing about proposing a batch needs memory of any
prior round — `list-pending` and `list-proposals` are always read fresh
from `uriel.db` regardless of which session asks.

The command, always the same regardless of who's firing it or which round
number this is:

```
ncl tasks create --name "gmail-review-round" --prompt "Propose the next gmail sender-review batch. Use the gmail-sender-review skill for the full protocol." --process-after "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Two things fire this:

- **The daily scheduled task's own pre-task gate script**, once a day —
  entirely mechanical, zero tokens: the script itself checks
  `list-pending` and, if anything's waiting, runs the exact command above
  directly in bash. It never wakes the agent for this — the agent is
  never involved in the daily kickoff at all, which is the most reliable
  way to guarantee that session never drafts a proposal or grows: it's
  not a matter of remembering not to, there's nothing for it to
  remember.
- **From the DM chat**, immediately after acting on a confirmation,
  whenever senders still remain pending. This is what lets a fast
  back-and-forth (many rounds in one sitting) happen without ever
  ballooning the DM chat session's own context — each round's drafting
  work happens somewhere else, every time.

**Never fire a round on your own initiative outside these two triggers**
— not because pending senders were noticed while doing something else,
not on a self-invented timer. A round only ever starts because the daily
check found something, or because a batch was just confirmed and more
remain — always a direct response to one of those two things, never
proactive.

## Batching discipline

- **A round only ever starts from the daily check or a direct reply to a
  just-confirmed batch** (see above) — never from noticing pending
  senders in passing, never per-email.
- **Don't nag.** If there's no answer to a proposal, do not follow up, do
  not re-send. Unanswered senders simply stay in the queue and get
  proposed again (or superseded by a fresher batch — `propose`
  automatically marks the previous still-open one `superseded` the
  moment a new one is proposed) next time the daily check runs. This is
  different from chaining to the next round right after a reply DOES
  arrive — that's continuing an actively-driven conversation, not
  nagging; keep chaining only as long as confirmations keep coming.
- **Cap each proposal at 10 senders**, even if far more are pending —
  there are currently well over 200. Order by message count descending
  (highest-volume senders first — they're the ones actually worth a rule,
  and the ones most likely to have hit the inbox meaningfully).
  `list-pending`'s output includes each sender's message count.
- **State how many remain** beyond the 10 proposed — `propose` reports
  this itself (the `remaining` count in its own output), so just carry
  that number into the message (e.g. "8 more shown here, 224 still
  waiting after these").
- **Never dump the raw pending list into a chat message.** Summarize it —
  sender, a short reason if the category isn't obvious, suggested
  category. This is a proposal for a human to approve, not a data export.
