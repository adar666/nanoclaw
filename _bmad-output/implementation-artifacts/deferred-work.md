> **Superseded (epic-1 retro action item AI-5):** these items were merged into `_bmad-output/planning-artifacts/architecture/architecture-nanoclaw-v2-2026-08-16/ARCHITECTURE-SPINE.md`'s own Deferred section, which is the single source of truth going forward. Kept here only for the append-only history this file's format assumes.

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
