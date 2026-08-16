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
