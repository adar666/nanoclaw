# Architecture Spine Review — Document Memory + Fill-In Editing

Reviewed: `_bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-16/ARCHITECTURE-SPINE.md`
Against: SPEC.md (CAP-1/2/3), row-targeting-matrix.md, brownfield.md, and the live repo.

## Verdict

Solid, well-grounded spine — its brownfield claims check out exactly against the live code, its 8 ADs cover the real hard divergence points (tool registration, sync-vs-async, dependency placement, PDF hybrid read/write, OOXML edit technique, storage layout, disambiguation ownership, failure semantics), and it correctly declines to reinvent anything NanoClaw already has. It has one real gap that was already surfaced (but not resolved) upstream in brownfield.md, one concrete contradiction of the project's own documented memory convention, and a few under-specified interface/versioning points worth tightening before build.

## Findings

### HIGH — Attachment-extension gap (brownfield.md's own flagged risk) is dropped, not resolved or deferred

`brownfield.md` explicitly flags: `MIME_TO_EXT` in `src/attachment-naming.ts` has `application/pdf` but **no `.docx`/`.doc` MIME entries** — confirmed live in the file (checked `/Users/uriel/Projects/nanoclaw-v2/src/attachment-naming.ts:20-37`): the map has `application/pdf: 'pdf'` and nothing for `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. brownfield.md calls this "worth checking/fixing as part of implementation" — a fast-path flag for architecture to resolve.

The spine does not resolve it. No AD addresses it, it's not in the Structural Seed, and it's not in Deferred (where it would at least get an explicit default-safe fallback per the spine's own pattern for other open questions). This is exactly the kind of thing this checklist calls "a real divergence point for the level below": AD-4 and AD-5's file-type routing rules ("if the file is `.docx`... if `.pdf`...") and AD-6's `<slug>.<ext>` naming both implicitly assume the inbound file already carries the right extension. For any channel bridge that sends a Word MIME type without an explicit `att.name` (the exact case the brownfield note describes), the file lands extension-less, and `save_document`/`fill_document_field` have no documented way to recover the type. Two independently-built units could diverge here in a way that matters: one might add the missing MIME entries to `attachment-naming.ts` as a prerequisite fix, another might sniff magic bytes inside the new tool, another might silently mis-handle it.

**Fix:** Add an AD (or a Deferred entry with an explicit default, e.g. "assume `.docx`/`.pdf` extension is already present on the inbox path; if missing, `save_document` returns a structured error asking the user to confirm the file type" — mirroring AD-8's failure philosphy) so this isn't left to chance.

### MEDIUM-HIGH — Structural Seed contradicts the project's own "new folder gets an index.md" memory convention

`docs/memory.md` states the convention explicitly: *"Before writing into a new folder, the agent creates it and its `index.md`."* (line 39-40). AD-6 and the Structural Seed introduce a brand-new `memory/documents/` subfolder but the Structural Seed lists only:

```
documents/
  <slug>.md
  files/
    <slug>.docx|.pdf
```

No `documents/index.md`. Since this spine claims to compose onto NanoClaw's existing memory conventions without introducing anything new ("No new frontmatter schema introduced" in Consistency Conventions), the silent omission of the one structural rule `docs/memory.md` actually states for new folders is a real contradiction, not just an omission — and a plausible divergence point (one builder follows the documented repo convention despite the spine's silence, another follows the spine's structural seed literally and skips it).

**Fix:** Either add `documents/index.md` to the Structural Seed explicitly, or add a one-line note in AD-6 saying it's intentionally out of scope for Core Memory injection and why.

### MEDIUM — Row/table indexing convention is unstated

Neither the spine, row-targeting-matrix.md, nor SPEC.md says whether "table number" / "row number" in AD-5 / CAP-3 are 1-indexed or 0-indexed, or whether a header row counts as row 1. This is a user-facing correctness question ("fill row 3" — third row overall, or third data row after a header?), not just an internal implementation detail, and the two natural conventions (spreadsheet-style 1-indexed-inclusive-of-header vs. "row 1 = first data row") produce different, silently-wrong results with no error raised (AD-8 only covers *unresolvable* targets, not off-by-one row conventions). Worth a one-line rule.

### MEDIUM — `fill_document_field`'s input schema isn't pinned down despite covering three structurally different targeting mechanisms

AD-1 fixes the tool *name* (`fill_document_field`, singular) but the spine never states its parameter shape across the three mechanisms in row-targeting-matrix.md (table+row / AcroForm field name / page+position). Since docx-path and PDF-path work could reasonably be split into separate build units per the spine's own capability map, an unstated shared contract here is a real seam where two units could diverge (e.g., one assumes `{tableNumber, rowNumber}` args, the other assumes a generic `{target: string}` the agent free-types). Not necessarily architecture-altitude, but worth at least a one-line steer (e.g., "single flexible input object; unused fields per mechanism are optional") given AD-8's insistence on structured, mechanism-aware errors.

### LOW — Stack table mixes pin styles without explanation, against the project's own dependency discipline

`pdf-lib` is pinned exact (`1.17.1`), `pdfjs-dist` uses a tilde range (`~6.2.108`), and `@hyzyla/pdfium` / `jszip` both say the literal word `current` instead of a version. CLAUDE.md's own container-runtime guidance is explicit: *"no `minimumReleaseAge` policy applies to this tree... pin deliberately, never blindly."* Three different pinning styles in one four-row table for a spine that otherwise tags assumptions carefully (`[ASSUMPTION]`, `[ADOPTED]`) reads as under-baked, not deliberate. `pdfjs-dist ~6.2.108` in particular is unverifiable from the doc alone against my own knowledge of PDF.js's release cadence (Firefox-style versioning was in the 4.x/5.x range through 2024–2025; a 6.x by mid-2026 is plausible but not confirmable here) — flag for a live npm check before implementation, not as proof of fabrication.

**Fix:** Either pin all four to exact current versions checked at implementation time, or explicitly note in the Stack table that exact pins are deferred to implementation (which the spine already does well elsewhere via `[ASSUMPTION]` tags) — the inconsistency, not the vagueness itself, is the issue.

### LOW — `@hyzyla/pdfium`'s "current" version + sharp-dependency hedge is good practice, no action needed

Called out only to note it was checked and found reasonable: AD-4/Stack's `[ASSUMPTION]` about `@hyzyla/pdfium`'s native `sharp` dependency building cleanly in the Bun/Docker base image, with a stated fallback (bitmap engine), is exactly the right way to flag a real build-time risk without blocking the spine. No fix needed — noted as a positive.

## Brownfield spot-checks (all confirmed accurate)

- `container/agent-runner/src/mcp-tools/index.ts` barrel-import convention — confirmed exact shape (`import './x.js';` side-effect imports, `registerTools([...])` at module scope, one-line append per new module). AD-1's rule is directly enforceable against this file.
- `container/agent-runner/package.json` — confirmed no docx/pdf library present today (`@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `cron-parser`, `zod` only), matching brownfield.md's "no docx or pdf read/write library anywhere" claim and motivating AD-3.
- `docs/memory.md` OKF convention — confirmed `type` + frontmatter, `index.md` Core Memory, per-group `groups/<folder>/memory/` layout all match AD-6/AD-7 and the Consistency Conventions table.
- `transcribe-audio.ts` — confirmed it matches AD-2's cited "host fire-and-forget pattern" exactly (writes a `system` `messages_out` row, returns immediately, host does the work).
- `container/skills/audio-report/SKILL.md` — confirmed it matches the "closest existing pattern to follow" cited in brownfield.md (inbox path tag → transform → `send_file`).
- `container/Dockerfile` — confirmed the `bun install --frozen-lockfile` layer (line 79-80) that AD-3's dependency-baking rule depends on.
- `src/attachment-naming.ts` `MIME_TO_EXT` — confirmed the docx-MIME gap exactly as brownfield.md describes (see HIGH finding above).
- `formatAttachments()` in `container/agent-runner/src/formatter.ts` — confirmed the `[<type>: <name> — saved to <path>]` prompt-text shape cited in brownfield.md.

## Checklist scoring

| Checklist item | Verdict |
| --- | --- |
| Fixes real divergence points, misses none | Mostly — misses the attachment-extension gap (HIGH) and row-indexing convention (MEDIUM) |
| Every AD's Rule is enforceable and prevents its divergence | Yes, all 8 verified enforceable against real files/patterns |
| Deferred items don't allow meaningful divergence | Yes — each deferred item states a default-safe fallback or explicit out-of-scope reason |
| Named tech verified-current | Mostly plausible; `pdfjs-dist` version unverifiable from doc alone (LOW), pin-style inconsistency (LOW) |
| Ratifies brownfield codebase | Yes on all spot-checked claims, with one real contradiction found (documents/index.md convention, MEDIUM-HIGH) |
| Covers CAP-1/2/3 | Yes — Capability → Architecture Map is complete and accurate |
| Every dimension at this altitude decided/deferred/open | Yes — deployment/operational envelope is explicitly addressed in Deferred ("no new topology... nothing feature-specific beyond that standard rebuild+restart") |
