# Adversarial verification — Stack table & version claims

Reviewing: `ARCHITECTURE-SPINE.md` (Stack table, AD-3, AD-5) and `.memlog.md` version/decision entries, for `document-memory` feature.
Method: direct npm registry JSON fetch (`registry.npmjs.org/<pkg>` and `/<pkg>/latest`, `/<pkg>/<version>`) plus web search for maintenance/repo status. Reviewed 2026-08-16, same day as the spine's `updated:` stamp.

## Package-by-package

### pdf-lib (claimed: 1.17.1)

- **Version claim: TRUE.** `dist-tags.latest` on the npm registry is indeed `1.17.1`. Confirmed via direct registry fetch and independently via web search (Snyk package page agrees).
- **"Actively maintained" implication: FALSE — package is effectively abandoned/frozen.**
  - `1.17.1`'s registry publish timestamp is **2021-11-07** — no release in ~5 years as of this review (2026-08-16).
  - The `repository` field points to `github.com/Hopding/pdf-lib`, which **is archived**. Web search confirms: "development and maintenance moved to https://github.com/pdfme/pdfme/tree/main/packages/pdf-lib."
  - The successor is published under a **different npm package name**, `@pdfme/pdf-lib` (latest `6.1.12` at review time, active — published ~11 days before this review), and there's also a second actively-maintained fork `@cantoo/pdf-lib` (latest `2.8.1`, also ~11 days old, adds SVG support). Neither is a drop-in for the plain `pdf-lib` name the spine specifies.
  - No npm deprecation notice is set on `pdf-lib` itself, so it isn't flagged as deprecated in tooling — but it is a dead upstream with a known, better-maintained fork available.
  - **Gap:** the memlog entry (`(researched, web) pdf-lib: current npm version 1.17.1`) verified the version number but did not surface (or the write-up omits) that the originating repo is archived and the package has had zero releases in 5 years. This is exactly the kind of thing "web-researched" should have caught — checking the GitHub repo, not just the npm version number.
  - **Correction / recommendation:** either (a) explicitly accept the risk in the spine — `pdf-lib@1.17.1` is a stable, widely-used, feature-frozen library and overlay-text-drawing is a mature/unchanging part of its API, so pinning to the frozen version is a defensible choice for this narrow use case — or (b) switch to `@cantoo/pdf-lib` (actively maintained, API-compatible fork). Either is fine; what's not fine is the current phrasing implying "current npm version" without noting the package is dead upstream.

### pdfjs-dist (claimed: ~6.2.108)

- **Version claim: TRUE and current.** Registry `dist-tags.latest` is `6.2.108`. Web search corroborates: published "18 days ago" relative to a 2026-08-16 query — i.e., late July 2026, about three weeks before this review.
- **Actively maintained: TRUE.** This is Mozilla's own PDF.js build, 3,492+ dependents, positive release cadence (per libraries.io/npm signal: "at least one new version released in the past 3 months"). No concerns.

### @hyzyla/pdfium (claimed: "current", version unpinned)

- **Package exists: TRUE.** Confirmed on the npm registry. It's a TypeScript wrapper around Google's PDFium (WASM), used for page-to-image rendering.
- **Actively maintained: TRUE.** Latest version at review time is `2.1.13`, published **2026-05-12** — about 3 months before this review, healthy cadence.
- **The memlog's flagged `[ASSUMPTION]`("verify its `sharp` native dependency builds cleanly... pdfium.js.org documents a no-extra-dependency bitmap engine as a fallback if not") is already resolved upstream and should not still be an open assumption.** Registry inspection shows `sharp` was moved out of hard `dependencies` starting at version `1.0.3+` and is now listed under `peerDependenciesMeta` with `"optional": true` — the package's own README claims "zero dependencies" via a bundled WASM bitmap path. This is exactly the fallback the memlog speculated "if not" — it isn't a hypothetical fallback, it's the actual current default. A few more minutes of research (reading the current `package.json` on npm instead of general docs) would have let this ship as `[ADOPTED]` rather than a deferred build-time risk.

### jszip (claimed: "current", version unpinned)

- **Package exists: TRUE.**
- **"Current" is misleading — the package is stale, not actively released.** Latest version is `3.10.1`, published **2022-06-02** (confirmed via direct registry fetch of the `latest` alias) — **over 4 years** before this review. No deprecation notice, and it remains the dominant/most-downloaded pure-JS zip library in the ecosystem (used transitively by `docxtemplater` via its `pizzip` fork, etc.), so this is "stalled but stable and ubiquitous," not "abandoned and risky" — closer to jQuery-style stasis than rot. But labeling it "current" in the Stack table's Version column is not accurate; it should read something like "3.10.1 (stable since 2022, no releases since)."
- Two independent web searches corroborate the staleness (Socket.dev/npm-compare style tooling both flag "not healthy version release cadence").
- This repo's own `minimumReleaseAge` supply-chain policy (CLAUDE.md) is about *too-new* packages, so it doesn't apply here — but a genuinely honest Stack table entry should still say "stale" rather than "current," since a reader would reasonably infer active maintenance from that word.

## AD-5 sanity check — direct OOXML manipulation via jszip vs. alternatives

Independently searched for an established, non-template, "edit an arbitrary existing .docx" JS/TS library to see if the memlog's conclusion ("no single well-established, template-free library... surfaced in research") holds up.

- **Confirms the memlog's conclusion.** Search turned up the same category the memlog already ruled out (`docxtemplater` — template/placeholder-oriented, correctly rejected for "edit an arbitrary existing document") plus several niche/low-adoption candidates not previously mentioned: `office-kit/docx`, `docXMLater`, `@ooxml-tools/file`, `docx-redline-js`. None of these have strong, established adoption (no evidence of significant download counts, long track records, or wide production use) — they read as small/single-maintainer projects, which is the same supply-chain risk category the memlog already used to rule out "newer/unproven single-maintainer libraries." So AD-5's choice (direct OOXML via `jszip`, over `docxtemplater` or an unproven library) is well-supported by real research, not an unverified training-data assertion.
- The memlog's flagged risk — **Word fragments visible text across multiple `<w:r>` runs, so naive string-matching on raw XML can miss the target text** — is a real, well-known OOXML gotcha (this is exactly why `docxtemplater`/its ecosystem has "run merging" utilities). Its presence in the write-up is a good sign the risk assessment reflects genuine domain understanding, not just a plausible-sounding fabrication.
- One nuance worth noting for the builder: `docxtemplater`'s own zip layer is `pizzip`, a maintained fork of `jszip` created by the same author specifically because of concerns like the one above (and, incidentally, sidesteps the "jszip is stale" finding above). Not a reason to change AD-5, but worth a pointer in case `jszip`'s staleness becomes a blocker later — `pizzip` is a closer-to-drop-in replacement than switching libraries entirely.
- **Verdict on AD-5: sound.** No overlooked better-established alternative for the "arbitrary existing docx, cell-level edit" use case.

## Summary table

| Claim | Verified? | Correction |
|---|---|---|
| `pdf-lib` npm version 1.17.1 is current/latest | Version: **true** | Not flagged as effectively abandoned — source repo archived, zero releases in 5 years, active forks exist under different package names |
| `pdf-lib` "researched, web" implies healthy dependency | **False** | Should note archived upstream; either accept explicitly or switch to `@cantoo/pdf-lib` |
| `pdfjs-dist` ~6.2.108, actively maintained | **True** | None — Mozilla-maintained, released weeks before this review |
| `@hyzyla/pdfium`, sharp-dependency risk still open | **False (over-cautious)** | Sharp is optional as of v1.0.3+ with a bundled WASM fallback — the flagged assumption is already resolved, could be `[ADOPTED]` not a deferred risk |
| `jszip` labeled "current" | **False (misleading)** | Latest release is 3.10.1 from June 2022 (4+ years stale); still the ecosystem-standard, not deprecated, but not "current" |
| AD-5 (direct OOXML via jszip) is the best-researched option, no better-established alternative overlooked | **True** | Independent search confirms; only niche/low-adoption libraries exist as alternatives to the correctly-rejected `docxtemplater` |
