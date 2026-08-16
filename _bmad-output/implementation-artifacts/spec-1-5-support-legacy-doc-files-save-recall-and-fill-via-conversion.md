---
title: 'Support Legacy .doc Files (Save, Recall, and Fill via Conversion)'
type: 'feature'
created: '2026-08-16'
status: 'done'
review_loop_iteration: 0
context: []
baseline_commit: 'da8795a3050c358274d657466904e276dc297bca'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `save_document` declines `.doc` (legacy binary Word 97-2003) with "only .docx/.pdf supported" — confirmed live in production when a real household form arrived as `.doc`. There's no practical way to edit the binary format directly, but reading it and converting it for editing are both solvable.

**Approach:** Add `.doc` as a third supported extension. Reading (save/recall) uses `word-extractor` (pure JS, no system dependency) — no conversion needed. Filling converts `.doc` → `.docx` once via headless LibreOffice (a new system dependency, user-approved despite the image-size cost), then reuses the entire existing `.docx` fill pipeline (table-row, fill-in-the-blank line) unchanged against the converted file. Output is always `.docx`.

## Boundaries & Constraints

**Always:**
- `SUPPORTED_EXTENSIONS` gains `'doc'` — `save_document` no longer declines it.
- `.doc` text extraction (save/recall) uses `word-extractor` — no LibreOffice call anywhere in the read path.
- Raw `.doc` files are stored as `memory/documents/files/<slug>.doc`, same storage shape as `.docx`/`.pdf` (AD-6, unchanged).
- `fill_document_field` against a saved `.doc`: converts to `.docx` once via `soffee --headless --convert-to docx` (or equivalent headless invocation) into a scratch location, then calls the *existing* `fillDocx` function (Story 1.2/1.4, completely unmodified) against the converted file — no parallel fill logic for `.doc`.
- The fill response explicitly states the returned file is `.docx`, not a reconstructed `.doc` — never implies the original binary format was edited.
- `libreoffice-writer` is added to `container/Dockerfile`'s existing `apt-get install` block (system dependency, not a `bun`/`npm` package) — same install pattern already used for `chromium`/`unzip`.
- Any test exercising the actual `soffice` subprocess must detect its absence (the host `bun test` sandbox has no LibreOffice installed) and skip cleanly rather than fail the suite.

**Ask First:**
- If `word-extractor`'s current npm version, once installed, doesn't handle a representative real-world `.doc` fixture cleanly (garbled text, thrown error on a well-formed file) — HALT before reaching for a different extraction approach.
- If the exact headless conversion invocation (`soffice --headless --convert-to docx ...`) needs flags/behavior beyond straightforward research (e.g. profile-directory issues common to headless LibreOffice in containers, `--convert-to` output-path quirks) — research and note the resolution in the Spec Change Log; only HALT if no working invocation can be found at all.

**Never:**
- Never attempts to edit `.doc`'s binary structure directly — no such approach exists in scope.
- Never returns a `.doc` file from a fill request — always `.docx`.
- Never calls LibreOffice from the save/recall (read) path — that's `word-extractor`'s job alone.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Save a `.doc` | `.doc` attachment, "remember this" | Raw file stored as `<slug>.doc`; text extracted via `word-extractor`; concept file + index line written, same shape as a `.docx` save | N/A |
| Recall a saved `.doc` | Content question about a previously saved `.doc` | Agent answers from stored extracted text — no different from a `.docx` recall | N/A |
| Fill a saved `.doc`, table row | `.doc` with a Word table, `table`/`row`/`value` given | Converts to `.docx` once, existing table-row path (AD-5) fills it, returns `.docx` with a note that the format changed | N/A |
| Fill a saved `.doc`, fill-in-the-blank line | `.doc` with underscore/colon blanks, no table match | Converts to `.docx` once, existing text-line path (AD-12) fills it, returns `.docx` | N/A |
| Conversion fails | Corrupted or unusual `.doc` content that LibreOffice can't convert | Declines clearly, no partial/broken file returned | MCP error text |
| `soffice` unavailable in the test sandbox | `bun test` run on a machine without LibreOffice installed | The specific test(s) exercising real conversion skip cleanly; everything else in the suite still runs and passes | N/A (test infra, not runtime) |

</frozen-after-approval>

## Code Map

- `container/agent-runner/src/mcp-tools/documents.ts:77` -- `SUPPORTED_EXTENSIONS` -- add `'doc'`.
- `container/agent-runner/src/mcp-tools/documents.ts:272-281` (approx) -- `extractDocxText` -- reference shape only; `.doc` extraction is a new, separate function using `word-extractor`, not a modification of this one (it's OOXML-zip-specific, `.doc` is a different binary format entirely).
- `container/agent-runner/src/mcp-tools/documents.ts:455-465` (approx) -- the `SUPPORTED_EXTENSIONS`/"Unsupported file type" check and the `ext === 'pdf'` / `else` (docx) branching in `saveDocumentImpl` -- needs a third branch for `ext === 'doc'` routing to the new `word-extractor`-based extraction.
- `container/agent-runner/src/mcp-tools/documents.ts:1650-1675` (approx) -- `fillDocumentFieldImpl`'s dispatch (`meta.ext === 'pdf' ? fillPdf(...) : fillDocx(...)`) -- needs a `meta.ext === 'doc'` branch that converts then delegates to the *unmodified* `fillDocx(convertedPath, ...)`.
- `container/Dockerfile:29-56` -- the `apt-get install` block (same one `chromium`/`unzip`/`INSTALL_CJK_FONTS`'s conditional install live in) -- add `libreoffice-writer` (the slim Writer-only package, not the full `libreoffice` suite) unconditionally (not behind a flag — this is core to the feature per the user's explicit approval, not opt-in like CJK fonts).
- `container/agent-runner/package.json` -- add `word-extractor` to `dependencies` (AD-3's base-image-dependency mechanism, same as every other library this feature added).
- word-extractor (research at implementation time): confirm current npm version, confirm its `.extract()` API shape and whether it needs a file path or accepts a Buffer (this codebase's other read paths take a resolved file path, prefer matching that).
- LibreOffice headless conversion (research at implementation time): confirm the exact `soffice --headless --convert-to docx --outdir <dir> <input.doc>` invocation works reliably non-interactively in a container context (a common headless-LibreOffice gotcha is needing an isolated `$HOME`/profile directory per invocation to avoid lock-file conflicts under concurrency — research and handle if it surfaces).
- `container/skills/document-memory/SKILL.md` -- extend the "When to use this" / "What NOT to do" sections to include `.doc`, and add a short note under the fill sections that a `.doc` fill returns `.docx`.

## Tasks & Acceptance

**Execution:**
- [x] `container/Dockerfile` -- add `libreoffice-writer` to the apt-get install block
- [x] `container/agent-runner/package.json` -- add `word-extractor` to `dependencies`
- [x] `container/agent-runner/bun.lock` -- regenerate via `bun install`
- [x] `container/agent-runner/src/mcp-tools/documents.ts` -- `.doc` extraction via `word-extractor`; `.doc`-aware save routing; `.doc`→`.docx` conversion helper (with a `soffice`-availability check) feeding the unmodified `fillDocx`; updated tool descriptions
- [x] `container/agent-runner/src/mcp-tools/documents.test.ts` -- bun:test coverage for the I/O matrix above; conversion-subprocess-dependent tests must skip gracefully when `soffice` is unavailable in the sandbox
- [x] `container/skills/document-memory/SKILL.md` -- document `.doc` support and the docx-output disclosure for fills

**Acceptance Criteria:**
- Given the story is complete, when `cd container/agent-runner && bun test` runs (on a machine without LibreOffice), then all non-conversion-dependent tests pass and conversion-dependent tests skip cleanly rather than fail.
- Given a real container build with `libreoffice-writer` installed, when a `.doc` fill is exercised end-to-end, then a valid `.docx` is returned with the value correctly placed.

## Spec Change Log

- 2026-08-16 (implementation, "Ask First" clause on the exact `soffice` invocation self-resolved via research + live verification — no genuine ambiguity to loop back on): confirmed `word-extractor@1.0.4`'s current API is promise-based, `extract(filePath)` accepting a path directly (matching this codebase's other read paths), no `@types` package exists on npm so a small local ambient `.d.ts` (`container/agent-runner/src/mcp-tools/word-extractor.d.ts`) was added for `strict` TypeScript rather than pulling in a new devDependency not called for by the Code Map. For the conversion invocation: `soffice --headless --norestore -env:UserInstallation=file://<unique-per-call-profile-dir> --convert-to docx --outdir <scratch-dir> <input.doc>`, with the profile directory unique per call (a fresh scratch dir under `.document-conversions/`) — this sidesteps the anticipated headless-LibreOffice profile-lock-under-concurrency gotcha entirely rather than needing retry/queueing logic. Verified for real: built the actual container image (`./container/build.sh`, `libreoffice-writer` installed) and ran the full `bun test` suite inside it with real `soffice` on PATH — all four soffice-gated `.doc` tests (real extraction, real fill-in-the-blank conversion+fill with disclosure note, real "no tables" dispatch through the unmodified `fillDocx`, real conversion-failure decline on unreadable content) passed against genuine LibreOffice output, not just the ENOENT/no-soffice path the host dev sandbox exercises. **KEEP:** every other frozen boundary (word-extractor for read, LibreOffice only for fill, unmodified `fillDocx`, always-`.docx`-output, explicit disclosure) is unaffected — this entry only records the specific invocation and confirms it works, per the spec's own instruction to note the resolution here rather than treat it as a HALT-worthy ambiguity.

- 2026-08-16 (code review — blind-hunter/edge-case-hunter/verification-gap, 15 patch findings, all applied): CI's "Container tests" step now installs `libreoffice-writer` (ubuntu-latest's own repo version, unpinned — deliberately not matching the Dockerfile's Debian pin, different distro/repo) before running `bun test`, so the soffice-gated `.doc` tests actually execute on every PR instead of only when someone happens to build+test inside the real container image by hand. `libreoffice-writer` in `container/Dockerfile` is now pinned to the exact apt version verified against (`4:7.4.7-1+deb12u14`, Debian bookworm), with a size-cost comment matching the block's own documentation style for `INSTALL_CJK_FONTS`. `convertDocToDocx` now: logs every failure branch (previously silent — container logs are the only trace since containers are `--rm`); surfaces a tail of the real captured LibreOffice stdout/stderr in the error text instead of only Node's generic "Command failed" wrapper; distinguishes a genuine conversion timeout from other failures (checked `e.signal`/`e.killed` empirically against Bun's actual `execFileSync` behavior — verified `e.signal === 'SIGTERM'` on timeout vs. `null` otherwise); wraps scratch-space `mkdirSync` in its own try/catch so a disk-full/permissions failure gets a purpose-built, logged error instead of bypassing every .doc-specific message. `word-extractor`'s extraction now has a matching 30s timeout wrapper (`withTimeout`) — it previously had none, unlike the conversion path. `withDocConversionNote` now only appends the disclosure when the result text contains every real fill path's own `"New file at "` success marker — a bare-discovery response or a table-count/ambiguous-slug prompt (no file written) no longer claims a nonexistent .docx conversion happened; covered by a new bare-discovery test. Conversion scratch dirs moved from `opts.baseDir` (the agent group's *persistent* memory volume — a crash mid-conversion would have orphaned the LibreOffice profile there permanently) to `os.tmpdir()`, and scratch-dir/profile naming moved from `Date.now()+Math.random()` to `crypto.randomUUID()`; a new concurrency test (two `Promise.all`'d `.doc` fills on the same document) exercises this for real, gated on `soffice` like the other real-conversion tests. The production `soffice` invocation's argv-building is now an exported `sofficeConvertArgs` function, and the test suite's own `.doc`-fixture builder (`buildDocViaSoffice`) calls the same function (with a different target format) instead of a hand-copied second flag list, closing the drift risk between the two. `docs/agent-runner-details.md` updated to describe `.doc` support, the LibreOffice conversion step, and the "not installed"/conversion-failure modes — it previously still said `.docx`/`.pdf` only. **Verified for real, not just locally**: re-ran `./container/build.sh` (pin resolved correctly — `Setting up libreoffice-writer (4:7.4.7-1+deb12u14)` in the build log) and the full `bun test` suite inside the freshly rebuilt image with real `soffice` on PATH — 90 pass, 1 correctly-skipped (the inverse-gated soffice-*unavailable* test, since soffice *is* available in-container), 0 fail, including both new tests (bare-discovery disclosure-suppression, concurrency) passing against genuine LibreOffice subprocess behavior. Three lower-priority findings (crash-mid-conversion test coverage, whether `execFileSync`'s timeout reliably kills a forked `soffice.bin` worker, and — now resolved by the `sofficeConvertArgs` sharing above — the test/production flag-duplication) were logged to `deferred-work.md` by the reviewer, not actioned here per its own instruction.

## Design Notes

Test fixtures for `.doc` are the one real friction point here: unlike `.docx`/`.pdf`, hand-rolling valid `.doc` binary bytes inline (the way `buildDocx`/`buildMinimalPdf` do for the other formats) isn't practical — the format is a full OLE2/Compound File Binary structure. Look first at whether `word-extractor`'s own package ships sample `.doc` fixtures (many parser libraries do, under a `test/` or `fixtures/` directory in `node_modules`) usable as a minimal real `.doc` for the extraction tests. For the conversion-path tests, generating a throwaway `.doc` via LibreOffice itself (`soffice --headless --convert-to doc` from a trivial `.docx`) at test setup time is a reasonable bootstrap when `soffice` is available — those tests are exactly the ones that skip when it isn't, so this doesn't create a hard new fixture-authoring problem, just a soffice-gated one.

## Verification

**Commands:**
- `cd container/agent-runner && bun test` -- expected: all pass (conversion-dependent tests skip cleanly if `soffice` is absent from the sandbox)
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` -- expected: no type errors
- `./container/build.sh build` -- expected: succeeds with `libreoffice-writer` installed (host-run verification after implementation, not part of the bun test suite)

## Suggested Review Order

- Start here -- `.doc` extraction via word-extractor, with its own timeout guard.
  [`documents.ts:335`](../../container/agent-runner/src/mcp-tools/documents.ts#L335)
- Shared timeout wrapper (extraction + conversion both use it).
  [`documents.ts:319`](../../container/agent-runner/src/mcp-tools/documents.ts#L319)
- Conversion invocation -- the exact soffice flags, shared between production and the test fixture builder.
  [`documents.ts:1726`](../../container/agent-runner/src/mcp-tools/documents.ts#L1726)
- Conversion orchestration -- profile/scratch-dir handling, timeout-vs-failure distinction, stderr surfacing.
  [`documents.ts:1747`](../../container/agent-runner/src/mcp-tools/documents.ts#L1747)
- The `.doc` fill entry point -- converts once, delegates to the unmodified `fillDocx`.
  [`documents.ts:1819`](../../container/agent-runner/src/mcp-tools/documents.ts#L1819)
- Disclosure-note gating -- only on an actual completed fill, not discovery/prompt responses.
  [`documents.ts:1810`](../../container/agent-runner/src/mcp-tools/documents.ts#L1810)
- CI now actually exercises the real conversion path.
  [`ci.yml`](../../../.github/workflows/ci.yml)
- Dockerfile -- pinned `libreoffice-writer`, size-cost rationale.
  [`Dockerfile`](../../container/Dockerfile)
- Dev-facing API reference update.
  [`agent-runner-details.md`](../../docs/agent-runner-details.md)
- Agent-facing usage guide -- `.doc` support, docx-output disclosure.
  [`SKILL.md`](../../container/skills/document-memory/SKILL.md)
- Test suite, including the real-LibreOffice-gated block.
  [`documents.test.ts`](../../container/agent-runner/src/mcp-tools/documents.test.ts)
