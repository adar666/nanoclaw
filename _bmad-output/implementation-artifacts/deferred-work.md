> **Superseded (epic-1 retro action item AI-5):** these items were merged into `_bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-16/ARCHITECTURE-SPINE.md`'s own Deferred section, which is the single source of truth going forward. Kept here only for the append-only history this file's format assumes.

- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-4-guest-list-validation.md`
  summary: SKILL.md's new guest-resolution instructions (and AD-5's pre-existing sender-identity resolution, same pattern) are unfalsifiable persona-level behavioral claims — no eval harness or persona-behavior test exists anywhere in this repo to check whether the agent actually resolves proactively, asks on ambiguity, or asks when unmatched, versus e.g. guessing a plausible-looking (but wrong) email that would still pass the tool's EMAIL_RE shape check silently.
  evidence: Verification-gap review finding; an inherent limitation of persona-level instructions in this codebase, not something this story introduces or could fix alone — worth a real eval-harness investment if this class of bug ever bites in practice.

- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-3-calendars-beyond-uriel-and-devorah.md`
  summary: Concurrent `ncl groups config add-calendar`/`remove-calendar` calls on the same group can lose an update (read-then-write, not transactional) — same class of race as every other `config add-X`/`remove-X` JSON-column CLI verb on this table (mounts, MCP servers, packages), not new to this story.
  evidence: Edge-case-hunter review finding; pre-existing systemic pattern across the whole `config add-X` family, surfaced incidentally by this story rather than introduced by it.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-3-calendars-beyond-uriel-and-devorah.md`
  summary: `configFromDb()`/`presentConfig()`'s `JSON.parse(row.calendar_registry)` (and every other JSON column on that same function) has no try/catch — a hand-corrupted DB row throws uncaught instead of falling back to empty.
  evidence: Edge-case-hunter review finding; pre-existing pattern across every JSON column on `container_configs`, not unique to `calendar_registry`.
  resolved: 2026-08-19 — both functions now route every JSON column through a `safeJsonParse()` helper that logs (`log.warn`) and falls back to an empty value instead of throwing. `src/container-config.ts`'s `configFromDb()`, `src/cli/resources/groups.ts`'s `presentConfig()`.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-3-calendars-beyond-uriel-and-devorah.md`
  summary: Adding a calendar today is a bare CLI CRUD verb with no restart-reminder automation or on-wake notification — unlike `install_packages`/`add_mcp_server`'s self-mod MCP-tool flow (admin approval → auto image rebuild/restart → on-wake chat notification, `src/modules/self-mod/apply.ts`). An approved `config add-calendar` still requires a human to remember `ncl groups restart`.
  evidence: Blind-hunter review finding; a real, valuable enhancement (agent-initiated calendar registry changes with the same auto-restart+notify UX as package/MCP-server self-mod) but a separate, bigger feature — extending `self-mod.ts`'s action set — not this story's scope.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-3-calendars-beyond-uriel-and-devorah.md`
  summary: `config add-calendar --calendar-id` has no format/plausibility validation (contrast `install_packages`'s explicit apt/npm name regexes) — a typo'd calendar ID surfaces only as an opaque Google API error much later, at call time.
  evidence: Blind-hunter review finding; consistent with this story's own "no RRULE validation" precedent (spec cal-2.2) and this file's existing "let Google's API be the validator" pattern for description/location — not fixed now.
  resolved: 2026-08-19 — `config add-calendar` now rejects a `--calendar-id` that doesn't match `CALENDAR_ID_RE` ("primary" or an email-shaped id), mirroring `install_packages`' plausibility-only precedent. `src/cli/resources/groups.ts`.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-3-calendars-beyond-uriel-and-devorah.md`
  summary: A duplicate `name` in a hand-edited/corrupted `calendar_registry` JSON array silently lets the last entry win in `resolveCalendarIds()`'s merge, with no diagnostic.
  evidence: Blind-hunter review finding; low-likelihood (the CLI write path already dedupes by name), not worth defensive read-time validation now.
  resolved: 2026-08-19 — `resolveCalendarIds()` now logs (`log()`) when a registry entry's name collides with an earlier *registry* entry (a built-in override like uriel/devorah is the intended behavior, not flagged). `container/agent-runner/src/mcp-tools/calendar.ts`.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-3-calendars-beyond-uriel-and-devorah.md`
  summary: The built-in `CALENDAR_IDS` constant in `calendar.ts` still hardcodes a real personal email address (`adardevora@gmail.com`) directly in trunk source — pre-existing since Story 1.2, unchanged by this story's own migration-default design (which deliberately avoids adding *more* hardcoded personal data, but doesn't retroactively scrub what was already there).
  evidence: Blind-hunter review finding; a deliberate call for the repo owner to make (whether/how to move this to per-install config), not something to silently patch mid-story.

- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-2-recurring-events.md`
  summary: update_calendar_event silently drops a recurrence argument if one is passed to it (no schema entry, not destructured, no error) rather than rejecting it clearly — there is no way to add/change/remove recurrence on an existing event short of delete-and-recreate.
  evidence: Blind-hunter review finding; out of this story's scope (spec explicitly said don't touch update_calendar_event), but worth a real decision before someone assumes update supports it.
  resolved: 2026-08-19 — `update_calendar_event` now explicitly rejects a `recurrence` argument with a clear message (delete-and-recreate instead), rather than silently ignoring it. `container/agent-runner/src/mcp-tools/calendar.ts`.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-2-recurring-events.md`
  summary: list_calendar_events' output doesn't indicate whether a listed event is part of a recurring series, even though CalendarEventItem.recurrence/recurringEventId are already read internally.
  evidence: Blind-hunter review finding; real UX gap, out of this story's scope (list wasn't touched).
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-2-recurring-events.md`
  summary: The idempotency guard's precheck only brackets the new event's own first-occurrence [startUtc, endUtc] window — a new recurring series' later occurrences are never checked against existing events, so a later occurrence could double-book with no warning.
  evidence: Edge-case-hunter review finding; spec explicitly said don't touch the idempotency guard's existing exclusion logic for this story, and full recurrence-aware dedup is a materially bigger feature.

- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-1-idempotency-guard-on-event-creation.md`
  summary: A zero-duration existing duplicate (start === end === the new event's own start) lands exactly on the pre-check's exclusive `timeMin` bound and would be excluded from the returned page, missing the guard entirely.
  evidence: Blind-hunter review loop-1 finding; genuinely rare (a real zero-duration Google Calendar event is unusual) and a real fix (padding the window) would slightly change matching semantics, not purely mechanical — worth a deliberate look, not a blind patch.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-1-idempotency-guard-on-event-creation.md`
  summary: The idempotency-guard's title match trims leading/trailing whitespace but doesn't collapse internal whitespace ("Team  Sync" vs "Team Sync" won't match).
  evidence: Blind-hunter review finding; correctly implements the spec's stated "trimmed" rule, but a realistic copy/paste or agent-generated artifact could silently miss the guard.
  resolved: 2026-08-19 — `findDuplicateCandidate()`'s title match now also collapses internal whitespace (`.replace(/\s+/g, ' ')`) before comparing. `container/agent-runner/src/mcp-tools/calendar.ts`.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-1-idempotency-guard-on-event-creation.md`
  summary: The duplicate-confirmation card shows only the existing candidate's details, never the new event's own location/description/guests/times, so a user can't compare what they're creating against what's flagged as a likely duplicate.
  evidence: Blind-hunter review finding; real UX gap, not required by any AC.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-1-idempotency-guard-on-event-creation.md`
  summary: Every create_calendar_event call now issues two network round trips (pre-check GET + POST) instead of one, doubling latency/quota for the common no-duplicate case; not surfaced in the tool's user-facing description or flagged for a future opt-out.
  evidence: Blind-hunter review finding; acceptable at this system's scale (one household), worth revisiting if quota/latency ever becomes a real complaint.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-1-idempotency-guard-on-event-creation.md`
  summary: update_calendar_event has no analogous duplicate/collision guard — moving an existing event's start/end to collide with another event bypasses idempotency protection entirely, with no in-code comment pointing this out.
  evidence: Blind-hunter review finding; out of this story's scope (create-only), not covered by any epic-2 story yet.
- source_spec: `_bmad-output/implementation-artifacts/spec-cal-2-1-idempotency-guard-on-event-creation.md`
  summary: defaultConfirmCreation (and the pre-existing defaultConfirmDeletion it mirrors) has no try/catch around askUserQuestion.handler — a thrown rejection (vs. a returned isError) would propagate unhandled instead of surfacing as a clean MCP error.
  evidence: Edge-case-hunter review finding; pre-existing pattern inherited unchanged from defaultConfirmDeletion, not introduced by this story.
  resolved: 2026-08-19 — both `defaultConfirmCreation()` and `defaultConfirmDeletion()` now wrap `askUserQuestion.handler(...)` in try/catch, converting a thrown rejection into a clean `{ error: err(...) }` MCP result. `container/agent-runner/src/mcp-tools/calendar.ts`.

- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-save-a-word-pdf-document-to-memory.md`
  summary: No size limits / decompression-bomb protection on docx unzip or PDF read (whole-file reads, only a 64MB unzip output cap).
  evidence: Blind-hunter review finding; robustness hardening, not blocking for a trusted single-operator use case.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-save-a-word-pdf-document-to-memory.md`
  summary: No timeout around async PDF text-extraction/render calls — a pathological file could hang a tool call indefinitely.
  evidence: Blind-hunter review finding.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-save-a-word-pdf-document-to-memory.md`
  summary: Full multi-page scanned-PDF support (rendering/reading pages beyond page 1) and mixed text/image-page handling.
  evidence: Blind-hunter finding; current page-1-only behavior matches the architecture spine's singular "the page" framing and is now disclosed to the user via the tool's message and SKILL.md (see patch P9) rather than being silent — genuine multi-page support is a larger feature.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-save-a-word-pdf-document-to-memory.md`
  summary: Lock staleness detection is mtime-heuristic only, no real PID-liveness cross-check.
  evidence: Edge-case-hunter finding; the mtime-based stale-lock fix (patch P2) is reasonable but not a perfect crash-detection mechanism.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-save-a-word-pdf-document-to-memory.md`
  summary: No handling or specific user-facing messaging for password-protected/encrypted PDFs — surfaces a generic "Could not read PDF" error.
  evidence: Blind-hunter finding; not encountered in the I/O matrix's scenarios, revisit if it comes up in practice.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-save-a-word-pdf-document-to-memory.md`
  summary: Full cleanup/GC of abandoned `.document-renders/` PNGs when the agent never follows up with extractedText.
  evidence: Blind-hunter + edge-case-hunter finding; patch P7 only cleans up on the successful-completion path, not abandoned first-calls.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-fill-a-named-target-in-a-saved-document-and-return-it.md`
  summary: `.document-fills/` render/output files are never cleaned up.
  evidence: Blind-hunter finding; mirrors Story 1.1's already-deferred `.document-renders/` leak, same class, not fixed there either.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-fill-a-named-target-in-a-saved-document-and-return-it.md`
  summary: Full merged-cell-aware (`w:gridSpan`) visual-column targeting for `.docx` fills.
  evidence: Blind-hunter finding; the applied patch only detects and declines a gridSpan row rather than silently miscounting -- genuine support for filling a specific visual column across merged cells is a larger feature.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-2-fill-a-named-target-in-a-saved-document-and-return-it.md`
  summary: Non-`w:`-prefixed OOXML namespace bindings are not recognized by the table parser (reports "no tables" rather than a specific unsupported-namespace message).
  evidence: Blind-hunter finding; rare in practice since Word's own default binds `w:`, not worth solving now.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-5-support-legacy-doc-files-save-recall-and-fill-via-conversion.md`
  summary: No test simulates a crash/interruption mid-conversion (between claiming the scratch dir and the finally cleanup) -- only the happy path and synchronous-failure paths are covered.
  evidence: Blind-hunter finding; the fix moving scratch dirs to os.tmpdir() (patch round) reduces the blast radius (host OS temp cleanup vs. leaking into a persistent memory volume), but doesn't add crash-simulation coverage.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-5-support-legacy-doc-files-save-recall-and-fill-via-conversion.md`
  summary: execFileSync's timeout sends SIGTERM only to the immediate tracked child process; if headless LibreOffice forks into a separate soffice.bin worker in this base image, a timeout-triggered kill may not reliably terminate it, risking an orphaned LibreOffice process for the container's remaining lifetime.
  evidence: Blind-hunter finding; needs direct verification against the installed libreoffice-writer package's actual process model (process-group kill via a negative PID or --pgid) before a real fix is justified, not assumed and patched blind.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-5-support-legacy-doc-files-save-recall-and-fill-via-conversion.md`
  summary: The test fixture builder (buildDocViaSoffice) independently duplicates the production conversion invocation's flags rather than sharing them -- a future change to the production flags has no structural guarantee the test fixture generator stays in sync.
  evidence: Blind-hunter finding; a shared-constant refactor is a minor drift-prevention nice-to-have, not urgent.
