/**
 * save_document — persist a Word (.docx/.doc), PDF, or image (.jpg/.jpeg/
 * .png) attachment to the agent group's durable per-group memory (see
 * docs/memory.md's OKF convention), so a later, unrelated conversation can
 * be answered from it without the file being resent.
 *
 * All work runs synchronously in-container, in the same MCP tool call
 * (no host round-trip — this needs no external API/credential):
 *
 *   - `.pdf` with a text layer: `pdfjs-dist` extracts the text directly.
 *   - `.pdf` with no text layer (scanned/image-only): `@hyzyla/pdfium`
 *     renders page 1 (page 1 only — later pages are not captured) to a PNG,
 *     and `tesseract.js` OCRs that PNG in-process (English and Hebrew) — a
 *     single deterministic call, not a round trip through the agent's own
 *     multimodal turn (spec 2-1, which deliberately reverses this file's
 *     earlier "never a tool-embedded OCR call" stance — see SPEC.md's
 *     amended constraint and spec-2-1's Spec Change Log). If OCR comes back
 *     empty/near-empty (a genuinely blank or unreadable page, or a page in
 *     neither supported language), the tool halts instead of writing a
 *     blank concept file: it asks the agent to either read the
 *     still-present render itself and call back with `extractedText` (the
 *     old vision-fallback path, now only reached on this one edge case), or
 *     call back with `extractedText: ""` to accept today's placeholder.
 *   - `.docx`: text is pulled out of `word/document.xml` (body paragraphs
 *     only — headers, footers, footnotes, and text boxes are not read) by
 *     shelling out to the `unzip` CLI (already in the base image for other
 *     purposes) and stripping the OOXML markup with a small regex-based
 *     reader — no new zip dependency for this story (`jszip`/`pdf-lib` are
 *     Story 1.2's, needed only for *writing* back into a document).
 *   - `.doc` (legacy binary Word 97-2003): text is pulled out via the
 *     `word-extractor` package (pure JS, no system dependency) — no
 *     LibreOffice conversion in this read path at all. Filling a saved
 *     `.doc` (Story 1.5) is the one operation that needs LibreOffice: a
 *     one-time `.doc` -> `.docx` conversion feeding the existing, unmodified
 *     `.docx` fill pipeline; save/recall never touch it.
 *
 *   - image (`.jpg`/`.jpeg`/`.png`): no rendering step, since the uploaded
 *     file already IS the image — same two-call vision-read pattern as a
 *     scanned PDF page (agent reads it directly, calls back with
 *     `extractedText`). Cannot be targeted by `fill_document_field` — there's
 *     no field/target on a plain image.
 *
 * `.docx`, `.doc`, `.pdf`, and images (`.jpg`/`.jpeg`/`.png`) are in scope;
 * anything else is declined cleanly with no memory footprint at all.
 *
 * Storage shape (AD-6):
 *   memory/documents/files/<slug>.<ext>   — canonical raw copy
 *   memory/documents/<slug>.md            — OKF concept file (type: saved-document)
 *   memory/documents/index.md             — static folder index, created once
 *   memory/index.md                       — gains one appended line per save
 *
 * `<slug>` (AD-10) is derived once here and reused by later stories
 * (fill/recall) that need to resolve the same document by name.
 *
 * Every write to a file shared across concurrent sessions of the same
 * agent group (`memory/index.md`, and slug uniqueness under
 * `memory/documents/`) is guarded by an exclusive-create lock file with a
 * short retry/backoff and mtime-based staleness recovery (AD-11) — no
 * unguarded read-then-overwrite, and no permanent deadlock if a holder
 * crashes mid-lock.
 *
 * The source `path` argument is untrusted (model-controlled): resolution is
 * containment-checked against the session's `inbox/` root, mirroring the
 * `isPathInside`/`ensureContainedInboxDir` pattern `src/inbox-safety.ts`
 * and `src/session-manager.ts` already use on the host side for the same
 * class of risk (a path that resolves outside the sandbox).
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

import { PNG } from 'pngjs';

import type { PDFDocument as PDFDocumentType, PDFFont, PDFPage, PDFTextField as PDFTextFieldType } from 'pdf-lib';
import type JSZipType from 'jszip';

import type { McpToolDefinition } from './types.js';
import { registerTools } from './server.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function errnoCode(e: unknown): string | undefined {
  return e && typeof e === 'object' && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
}

const SUPPORTED_EXTENSIONS = new Set(['docx', 'doc', 'pdf', 'jpg', 'jpeg', 'png']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);

// ---------------------------------------------------------------------------
// Path containment — `path` is a model-supplied argument. Resolve it (either
// relative to the workspace root or as given, if absolute) and refuse
// anything whose *real* (symlink-resolved) location doesn't stay under the
// session's inbox root. Mirrors src/inbox-safety.ts's isPathInside +
// realpath-containment approach on the host side; reimplemented here rather
// than imported because container/agent-runner is a separate Bun package
// tree with no dependency on host code.
// ---------------------------------------------------------------------------

/** True if `child` is `parent` itself or nested within it (no traversal/escape). */
function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveInboxPath(filePath: string, workspaceRoot: string): { path: string } | { error: string } {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath);
  if (!fs.existsSync(resolved)) return { error: `File not found: ${filePath}` };

  let realResolved: string;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    return { error: `File not found: ${filePath}` };
  }

  const inboxRoot = path.join(workspaceRoot, 'inbox');
  let realInboxRoot: string;
  try {
    realInboxRoot = fs.realpathSync(inboxRoot);
  } catch {
    return { error: `Refusing to read a file outside the inbox: ${filePath}` };
  }

  if (!isPathInside(realInboxRoot, realResolved)) {
    return { error: `Refusing to read a file outside the inbox: ${filePath}` };
  }
  return { path: realResolved };
}

// ---------------------------------------------------------------------------
// Slug generation (AD-10) — the single shared scheme every document-memory
// tool derives a document's on-disk name from. Lowercase kebab-case of the
// original filename with the extension stripped; on collision with an
// existing concept file, append -2, -3, ... until unique.
// ---------------------------------------------------------------------------

export function slugify(filename: string): string {
  const base = path.basename(filename).replace(/\.[^./]+$/, '');
  const slug = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics after NFKD decomposition
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'document';
}

/**
 * Generalized collision-suffix loop: the first candidate name (under `dir`,
 * with extension `ext`) not already on disk — `base`, then `base-2`,
 * `base-3`, ... `uniqueSlug` below is this file's original, `.md`-in-
 * `memory/documents/`-specific caller; `save_signature` is a second,
 * `.png`-in-`memory/signatures/` caller — both go through this one loop
 * rather than each hand-rolling their own.
 */
function uniqueName(dir: string, base: string, ext: string): string {
  let candidate = base;
  let n = 2;
  while (fs.existsSync(path.join(dir, `${candidate}.${ext}`))) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

export function uniqueSlug(documentsDir: string, filename: string): string {
  return uniqueName(documentsDir, slugify(filename), 'md');
}

// ---------------------------------------------------------------------------
// Locked read-modify-write (AD-11) — exclusive-create lock file with a
// short retry/backoff, plus mtime-based staleness recovery: if the lock's
// holder crashed mid-critical-section, the lock file is never released, and
// without recovery every later save_document call for this group would fail
// permanently once the retry window elapses. A lock older than
// LOCK_STALE_MS is treated as abandoned, removed, and retried immediately.
// ---------------------------------------------------------------------------

const LOCK_RETRY_MS = 25;
const LOCK_MAX_ATTEMPTS = 80; // ~2s worst case
const LOCK_STALE_MS = 30_000;

async function withLock<T>(lockPath: string, fn: () => T): Promise<T> {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (errnoCode(e) !== 'EEXIST') throw e;

      // A crashed holder never releases its lock — recover instead of
      // failing every save for this group forever.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue; // retry the exclusive-create immediately, no need to sleep
        }
      } catch {
        // Lock vanished between our failed create and this stat — another
        // holder likely just released it; fall through to the normal retry.
      }

      if (attempt === LOCK_MAX_ATTEMPTS - 1) {
        throw new Error(`Timed out waiting for memory index lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Already gone (or never created) — nothing to clean up.
    }
  }
}

function appendIndexLine(indexPath: string, line: string): void {
  const existing = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '';
  const withTrailingNewline = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
  fs.writeFileSync(indexPath, `${withTrailingNewline}${line}\n`);
}

const DOCUMENTS_INDEX_TEMPLATE =
  '# Saved documents\n\n' +
  'Word/PDF documents saved via `save_document`. Each entry is an OKF\n' +
  'concept file (`type: saved-document`) holding the extracted text and a\n' +
  'pointer to the canonical raw copy under `files/`.\n';

function ensureDocumentsScaffold(documentsDir: string, filesDir: string): void {
  fs.mkdirSync(filesDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(documentsDir, 'index.md'), DOCUMENTS_INDEX_TEMPLATE, { flag: 'wx' });
  } catch (e) {
    if (errnoCode(e) !== 'EEXIST') throw e;
  }
}

// Strip C0 control characters (and DEL) — a filename with a raw newline or
// other control byte would otherwise corrupt the YAML frontmatter block
// (despite quoting/backslash-escaping) and, separately, break the "one
// physical line per entry" shape of the memory/index.md append.
function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, '');
}

function yamlEscape(s: string): string {
  const sanitized = stripControlChars(s);
  return `"${sanitized.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Escape Markdown link/emphasis-syntax characters before interpolating
// untrusted text (a filename) into generated Markdown — otherwise a crafted
// filename could break or hijack the `[text](url)` link written to
// memory/index.md, or the concept file's heading line.
function escapeMarkdown(s: string): string {
  return s.replace(/[[\]()]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// .docx text extraction — shell out to the base image's `unzip` CLI (no new
// dependency) to pull `word/document.xml` out of the OOXML zip, then strip
// the markup with small, targeted regexes: paragraphs (<w:p>...</w:p>)
// become lines, and the <w:t> runs inside each are concatenated in order
// (Word can fragment a single sentence across multiple runs). Good enough
// for memory/recall text; not a general OOXML parser — headers, footers,
// footnotes, and text boxes (which live in separate parts, not
// word/document.xml) are not read.
// ---------------------------------------------------------------------------

function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function docxXmlToText(xml: string): string {
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  const lines = paragraphs.map((para) => {
    const runs = para.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
    return runs
      .map((run) => {
        const m = /<w:t[^>]*>([\s\S]*?)<\/w:t>/.exec(run);
        return m ? decodeXmlEntities(m[1]) : '';
      })
      .join('');
  });
  return lines.join('\n').trim();
}

function extractDocxText(filePath: string): string {
  try {
    const buf = execFileSync('unzip', ['-p', filePath, 'word/document.xml'], {
      maxBuffer: 1024 * 1024 * 64,
    });
    return docxXmlToText(buf.toString('utf-8'));
  } catch (e) {
    log(`docx text extraction failed for ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

// ---------------------------------------------------------------------------
// .doc (legacy binary Word 97-2003) text extraction via `word-extractor` —
// a pure-JS OLE2/Compound-File-Binary reader, no system dependency and no
// LibreOffice call. This is a genuinely different binary format from
// `.docx` (OOXML-in-a-zip), so it gets its own extraction path rather than
// any modification of extractDocxText above. `.extract()` takes a file path
// directly (matching every other read path in this file) and resolves to a
// document object; `getBody()` is the main document text — headers,
// footers, footnotes, etc. are available via other accessors but are not
// read here, mirroring the .docx path's "body paragraphs only" scope.
// ---------------------------------------------------------------------------

// Shared across every .doc-related operation that can, in principle, hang on
// a pathological input: word-extractor's in-process parse below, and the
// soffice subprocess conversion further down. Same 30s budget for both —
// there's no discipline-based reason for the read path to be more patient
// than the write path.
const DOC_TIMEOUT_MS = 30_000;

/**
 * word-extractor has no built-in timeout/cancellation — a pathological .doc
 * (deeply nested OLE2 structure, adversarial input) could otherwise hang
 * save_document indefinitely. This races the extraction against a timer;
 * on timeout the *promise* settles (so the caller isn't blocked forever),
 * even though the underlying parse work may still be running in the
 * background — best achievable without an abortable extractor API.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function extractDocText(filePath: string): Promise<string> {
  try {
    const WordExtractor = (await import('word-extractor')).default;
    const extractor = new WordExtractor();
    const doc = await withTimeout(extractor.extract(filePath), DOC_TIMEOUT_MS, '.doc text extraction');
    return doc.getBody().trim();
  } catch (e) {
    log(`.doc text extraction failed for ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return '';
  }
}

// ---------------------------------------------------------------------------
// .pdf text-layer extraction via pdfjs-dist. Returns '' (not an error) when
// the PDF has no meaningful text layer — the caller treats that as "scanned,
// fall back to rendering." A genuinely malformed/corrupt PDF throws instead,
// surfaced by the caller as a clear "Could not read PDF" error.
// ---------------------------------------------------------------------------

async function extractPdfText(filePath: string): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = getDocument({ data, verbosity: 0 });
  try {
    const doc = await loadingTask.promise;
    const pageTexts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pageText = content.items.map((item: any) => ('str' in item ? item.str : '')).join(' ');
      pageTexts.push(pageText);
      page.cleanup();
    }
    return pageTexts.join('\n\n').trim();
  } finally {
    await loadingTask.destroy();
  }
}

// pdfjs-dist's getTextContent() returns a genuinely empty items list only
// when a page has no text objects at all (scanned/image-only) — any real
// text layer, however short, yields something. So "any non-whitespace
// character at all" is the correct, non-arbitrary signal here.
function hasTextLayer(text: string): boolean {
  return text.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Scanned-PDF fallback: render page 1 to a PNG via @hyzyla/pdfium (bundled
// WASM, zero runtime dependencies — its README example uses `sharp` to
// encode PNG, but that's only a devDependency of the example, not a
// dependency of the package, so a small hand-rolled encoder below avoids
// pulling it in). As of spec-2-1, `tesseract.js` OCRs the render directly
// (see `ocrPngText` below) instead of asking the agent's own multimodal
// turn to transcribe it — that vision-read path is now only reached when
// OCR itself comes back empty/near-empty (spec-2-1's Ask-First case).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** Encode a raw RGBA bitmap (as returned by @hyzyla/pdfium's render callback) as a PNG. */
function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdr = pngChunk('IHDR', ihdrData);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** 72-DPI-native PDF page rendered at 2x — legible enough for the agent to read text from. */
const RENDER_SCALE = 2;

async function renderFirstPageToPng(filePath: string, outPath: string): Promise<{ width: number; height: number }> {
  const { PDFiumLibrary } = await import('@hyzyla/pdfium');
  const buf = fs.readFileSync(filePath);
  const library = await PDFiumLibrary.init();
  try {
    const document = await library.loadDocument(buf);
    try {
      const [page] = document.pages();
      if (!page) throw new Error('PDF has no pages');
      let dims = { width: 0, height: 0 };
      const image = await page.render({
        scale: RENDER_SCALE,
        render: async (options) => {
          dims = { width: options.width, height: options.height };
          return encodePng(options.data, options.width, options.height);
        },
      });
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(image.data));
      return dims;
    } finally {
      document.destroy();
    }
  } finally {
    library.destroy();
  }
}

/**
 * Deterministic render filename for a given source file — so a follow-up
 * `save_document` call (same `path`, now with `extractedText`) can compute
 * the identical path and delete it on success, instead of leaving it behind
 * (a random/timestamped name would make that lookup impossible).
 */
function renderFileNameFor(resolvedPath: string, originalFilename: string): string {
  const hash = crc32(Buffer.from(resolvedPath, 'utf-8'))
    .toString(16)
    .padStart(8, '0');
  return `${slugify(originalFilename)}-${hash}-p1.png`;
}

// ---------------------------------------------------------------------------
// OCR (spec-2-1): tesseract.js reads the page-1 render produced above,
// server-side and deterministically — this is the one deliberate exception
// to this codebase's otherwise-standing "no dedicated OCR engine" stance
// (SPEC.md, amended; see spec-2-1's Spec Change Log). English and Hebrew
// (`createWorker('eng+heb')`, operator decision, step-04) — a scanned page
// in a language other than those two may still OCR poorly or not at all,
// which is exactly the case the empty/near-empty Ask-First halt in
// saveDocumentImpl below is for. A fresh worker per call (init + terminate)
// matches this file's existing pattern of not holding any resource open
// across separate MCP tool invocations (@hyzyla/pdfium's
// library/document lifecycle above does the same).
//
// Two Bun-specific behaviors, confirmed live (not documented by
// tesseract.js itself), drive the options passed below:
//
//   - `workerPath`: tesseract.js's Node worker computes its own default
//     workerPath from `__dirname` inside its `defaultOptions.js`. Under
//     Bun, `import('tesseract.js')` resolves that module through Bun's
//     global package cache rather than this project's on-disk
//     node_modules, so the resulting `__dirname` has no project
//     node_modules among its ancestors — the spawned worker thread's own
//     `require('regenerator-runtime/runtime')` then fails with "Cannot
//     find module". Passing `workerPath` explicitly, anchored at *this*
//     file's own real location (always two directories above
//     node_modules here, in dev and in the mounted-in-production layout
//     alike), points the worker at a copy that does have this project's
//     node_modules as an ancestor, resolving correctly. (tesseract.js's own
//     package.json declares `"main": "src/index.js"` — `src/` genuinely is
//     the package's shipped Node runtime layout, not a dev-only path.)
//   - `cachePath`: without it, tesseract.js writes `<lang>.traineddata`
//     into `process.cwd()` — which would otherwise land loose inside the
//     agent's own workspace. Pointing it at a dedicated directory under
//     `baseDir` keeps it out of the way and lets a second OCR call in the
//     same group reuse the already-downloaded language data instead of
//     fetching it again. Unlike `.document-renders` (deleted after every
//     call, success or halt), `.ocr-cache` is a *reusable* cache and is
//     never deleted by this tool — `eng.traineddata`/`heb.traineddata`
//     stay there indefinitely once fetched, by design, not an oversight.
//
// `eng.traineddata` and `heb.traineddata` (a few MB each) are fetched from a
// public CDN (`cdn.jsdelivr.net`) the first time each language is needed for
// a given cacheDir — a real, new runtime dependency on outbound network
// access the first time this path is exercised, not present in any of this
// tool's other extraction paths. Not gated behind a Dockerfile change
// (matches the spec's no-Dockerfile-change constraint, which is about the
// *code* dependency, not this data fetch), but worth knowing if OCR ever
// fails specifically on a fresh cacheDir with no network reachable.
//
// Bounds both worker init (which includes that first-time language-data
// fetch) and the recognize() call itself in one combined budget — a stuck
// fetch or a stalled OCR pass must not block save_document indefinitely.
const OCR_TIMEOUT_MS = 60_000;
// ---------------------------------------------------------------------------

async function ocrPngText(pngPath: string, ocrOpts: { cacheDir: string }): Promise<string> {
  const work = (async () => {
    const tesseractModule = await import('tesseract.js');
    const createWorker = tesseractModule.createWorker ?? tesseractModule.default?.createWorker;
    if (typeof createWorker !== 'function') {
      throw new Error('tesseract.js module shape unexpected — no createWorker export found');
    }

    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const workerPath = path.join(moduleDir, '..', '..', 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js');

    fs.mkdirSync(ocrOpts.cacheDir, { recursive: true });

    const worker = await createWorker('eng+heb', undefined, { workerPath, cachePath: ocrOpts.cacheDir });
    try {
      const { data } = await worker.recognize(pngPath);
      return (data.text ?? '').trim();
    } finally {
      // A terminate() failure must never mask/replace the real
      // result/error already being returned/thrown above — best effort
      // only, logged not propagated.
      try {
        await worker.terminate();
      } catch (e) {
        log(`OCR worker terminate() failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  })();

  return withTimeout(work, OCR_TIMEOUT_MS, 'OCR (worker init + recognition)');
}

// Anything shorter than this (after stripping all whitespace) is treated as
// "no readable text" for the Ask-First halt below — not just a literally
// empty string. A blank/noisy scanned page can OCR to a stray single
// character rather than a true empty string; a small floor catches that
// without needing tesseract's own per-word confidence score (which would
// add real plumbing for a case this floor already resolves).
const OCR_NEAR_EMPTY_THRESHOLD = 3;

function isNearEmptyOcrText(text: string): boolean {
  return text.replace(/\s+/g, '').length < OCR_NEAR_EMPTY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// save_document
// ---------------------------------------------------------------------------

interface SaveDocumentOpts {
  /** `/workspace/agent` in production; a temp dir in tests. */
  baseDir: string;
  /** `/workspace` in production; a temp dir in tests. Also the base for the inbox containment check. */
  workspaceRoot?: string;
}

export async function saveDocumentImpl(
  args: Record<string, unknown>,
  opts: SaveDocumentOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  try {
    const filePath = typeof args.path === 'string' ? args.path : undefined;
    if (!filePath) return err('path is required');

    if (args.extractedText !== undefined && typeof args.extractedText !== 'string') {
      return err('extractedText must be a string');
    }
    const extractedText = typeof args.extractedText === 'string' ? args.extractedText : undefined;

    const workspaceRoot = opts.workspaceRoot ?? '/workspace';
    const resolution = resolveInboxPath(filePath, workspaceRoot);
    if ('error' in resolution) return err(resolution.error);
    const resolvedPath = resolution.path;

    const originalFilename = path.basename(resolvedPath);
    const ext = path.extname(originalFilename).slice(1).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return err(
        `Unsupported file type "${ext ? `.${ext}` : '(none)'}" — save_document only handles Word (.docx/.doc), ` +
          'PDF (.pdf), and image (.jpg/.jpeg/.png) files.',
      );
    }

    const memoryDir = path.join(opts.baseDir, 'memory');
    const documentsDir = path.join(memoryDir, 'documents');
    const filesDir = path.join(documentsDir, 'files');

    let bodyText: string;
    let extractionNote = '';
    let renderPathToCleanup: string | undefined;

    if (ext === 'pdf') {
      let pdfText: string;
      try {
        pdfText = await extractPdfText(resolvedPath);
      } catch (e) {
        return err(`Could not read PDF: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (hasTextLayer(pdfText)) {
        bodyText = pdfText;
      } else {
        const renderDir = path.join(opts.baseDir, '.document-renders');
        const renderPath = path.join(renderDir, renderFileNameFor(resolvedPath, originalFilename));

        if (extractedText === undefined) {
          // First call for this path (or a retry after an earlier halt below
          // — renderFileNameFor is deterministic, so this re-renders the
          // same file in place rather than accumulating a new PNG per
          // retry). Render page 1, then OCR it directly: this collapses
          // what used to be a two-call agent-vision round trip into a
          // single deterministic call for the common case (spec-2-1).
          let dims: { width: number; height: number };
          try {
            dims = await renderFirstPageToPng(resolvedPath, renderPath);
          } catch (e) {
            return err(`Could not render scanned PDF page: ${e instanceof Error ? e.message : String(e)}`);
          }

          let ocrText: string;
          try {
            const ocrCacheDir = path.join(opts.baseDir, '.ocr-cache');
            ocrText = await ocrPngText(renderPath, { cacheDir: ocrCacheDir });
          } catch (e) {
            // Unlike the near-empty halt below, there's no follow-up flow
            // that needs this render — a genuine OCR engine failure (as
            // opposed to a successful-but-empty OCR) has nothing for a
            // vision-fallback follow-up to read differently, so clean up
            // now rather than leaving it orphaned in .document-renders.
            try {
              fs.unlinkSync(renderPath);
            } catch {
              // best effort
            }
            return err(`Could not OCR scanned PDF page: ${e instanceof Error ? e.message : String(e)}`);
          }

          if (isNearEmptyOcrText(ocrText)) {
            // Ask-First (spec-2-1): a genuinely blank/unreadable page, or an
            // OCR result too short to be real content (a stray character
            // from noise is not "readable text") — do NOT delete the
            // render, since the vision-fallback choice below needs it
            // still on disk to read.
            return ok(
              'This PDF has no extractable text layer (scanned/image-only), and OCR on page 1 (page 1 only — ' +
                `later pages are not captured), ${dims.width}x${dims.height}px, at ${renderPath} found little ` +
                'to no readable text — the page may be genuinely blank or unreadable. Ask the user how to ' +
                'proceed: either read that rendered image yourself and call save_document again with the same path ' +
                `("${filePath}") and an "extractedText" argument containing what you read, or call ` +
                'save_document again with the same path and extractedText: "" to save it with a placeholder ' +
                'note instead of blank/guessed text.',
            );
          }

          bodyText = ocrText;
          renderPathToCleanup = renderPath;
        } else {
          // Follow-up call after the Ask-First halt above: the agent either
          // read the still-present render itself (real text) or is
          // confirming the placeholder (extractedText === ""). Either way,
          // the render has served its purpose and is cleaned up below.
          bodyText = extractedText;
          renderPathToCleanup = renderPath;
        }
      }
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      // No rendering step — the uploaded file already IS the image to look
      // at. Always a two-call vision-read pattern (unlike a scanned PDF,
      // which is now single-call in the common case — spec-2-1): first call
      // (no extractedText) points the agent at the file and asks it to read
      // it and call back; second call (extractedText given) finishes the
      // save. resolvedPath stays valid for both calls (it's the original
      // inbox file, never moved) so there's nothing to render or clean up.
      if (extractedText === undefined) {
        return ok(
          `This is an image (${ext}) — I can't extract its content myself. Read it yourself at "${filePath}", ` +
            'then call save_document again with the same path and an "extractedText" argument containing what ' +
            'you read (a description, any readable text, numbers, etc.), to finish saving it to memory.',
        );
      }
      bodyText = extractedText;
    } else if (ext === 'doc') {
      bodyText = await extractDocText(resolvedPath);
      if (!bodyText) {
        extractionNote =
          '\n\n_(Could not extract text automatically from this Word document — the raw file is preserved ' +
          'for reference.)_';
      }
    } else {
      bodyText = extractDocxText(resolvedPath);
      if (!bodyText) {
        extractionNote =
          '\n\n_(Could not extract text automatically from this Word document — the raw file is preserved ' +
          'for reference.)_';
      }
    }

    ensureDocumentsScaffold(documentsDir, filesDir);
    const lockPath = path.join(documentsDir, '.index.lock');

    const result = await withLock(lockPath, () => {
      const slug = uniqueSlug(documentsDir, originalFilename);
      const rawDestPath = path.join(filesDir, `${slug}.${ext}`);
      const conceptPath = path.join(documentsDir, `${slug}.md`);
      let rawWritten = false;
      let conceptWritten = false;

      try {
        fs.copyFileSync(resolvedPath, rawDestPath, fs.constants.COPYFILE_EXCL);
        rawWritten = true;

        const savedDate = new Date().toISOString();
        const description = `Saved document: ${originalFilename}`;
        const conceptBody = [
          '---',
          'type: saved-document',
          `description: ${yamlEscape(description)}`,
          `source-filename: ${yamlEscape(originalFilename)}`,
          `saved-date: ${savedDate}`,
          // Relative path back to the canonical raw copy, per AD-6 — recorded explicitly
          // rather than left only derivable from <slug>.<ext> by convention.
          `raw-file: ${yamlEscape(`files/${slug}.${ext}`)}`,
          '---',
          '',
          `# ${escapeMarkdown(stripControlChars(originalFilename))}`,
          '',
          bodyText || '_(no text extracted)_',
          extractionNote,
        ].join('\n');
        fs.writeFileSync(conceptPath, conceptBody, { flag: 'wx' });
        conceptWritten = true;

        const indexPath = path.join(memoryDir, 'index.md');
        appendIndexLine(
          indexPath,
          // stripControlChars first: a raw newline in `description` would
          // otherwise turn this single appended entry into multiple
          // physical lines in memory/index.md.
          `- [${escapeMarkdown(stripControlChars(description))}](documents/${slug}.md) - saved document, ${savedDate}`,
        );

        log(`save_document: saved "${originalFilename}" as "${slug}"`);
        return ok(`Saved "${originalFilename}" to memory as "${slug}". Recorded in memory/documents/${slug}.md.`);
      } catch (e) {
        // Partial failure — a raw copy or concept file already landed with
        // no complete, consistent entry to show for it. Roll back whatever
        // succeeded so a retry doesn't hit a permanent EEXIST on the same
        // slug, and so memory never shows a half-written document.
        if (conceptWritten) {
          try {
            fs.unlinkSync(conceptPath);
          } catch {
            // best effort
          }
        }
        if (rawWritten) {
          try {
            fs.unlinkSync(rawDestPath);
          } catch {
            // best effort
          }
        }
        throw e;
      }
    });

    if (renderPathToCleanup) {
      try {
        fs.unlinkSync(renderPathToCleanup);
      } catch {
        // Best effort — an abandoned first-call render (no follow-up ever
        // arrived) is not cleaned up here; see deferred-work.md.
      }
    }

    return result;
  } catch (e) {
    return err(`save_document failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// save_signature (Story 1.6)
//
// Turns a photographed/drawn signature PNG into a clean, reusable asset:
// decode via pngjs, threshold near-white pixels to fully transparent (fixed
// luminance cutoff, not user-configurable), crop to the bounding box of what
// survives, and write via the existing encodePng/pngChunk/crc32 helpers
// (Story 1.1's scanned-PDF-render path) — no second PNG writer. Save-only:
// this never stamps a signature into any document (CAP-6, future stories).
// ---------------------------------------------------------------------------

/** Fixed per-pixel luminance cutoff for background removal — not read from args (spec Boundaries). */
const WHITE_THRESHOLD = 240;

/**
 * Thresholds near-white pixels to alpha 0 (mutates `data` in place — the
 * caller's decoded buffer is not reused afterward), then crops to the
 * bounding box of every pixel with alpha > 0. Returns undefined when that
 * set is empty (nothing survived thresholding, e.g. an all-white input) —
 * the caller declines cleanly rather than writing a zero-dimension file.
 */
function thresholdAndCropPng(
  width: number,
  height: number,
  data: Buffer,
): { data: Buffer; width: number; height: number } | undefined {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] >= WHITE_THRESHOLD && data[i + 1] >= WHITE_THRESHOLD && data[i + 2] >= WHITE_THRESHOLD) {
        data[i + 3] = 0;
      }
      if (data[i + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return undefined;

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const cropped = Buffer.alloc(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    const srcStart = ((minY + y) * width + minX) * 4;
    data.copy(cropped, y * cropWidth * 4, srcStart, srcStart + cropWidth * 4);
  }

  return { data: cropped, width: cropWidth, height: cropHeight };
}

/**
 * Writes the cropped/encoded PNG under `signaturesDir` as `<baseSlug>.png`,
 * or the next free `<baseSlug>-2.png`/`-3.png`/... on a name collision
 * (unless `replace` is true, in which case any existing file at the base
 * name is overwritten deliberately). The candidate check (uniqueName) and
 * this write are not atomic together, so two concurrent same-name saves
 * could both pick the same free candidate; on that race (EEXIST) this
 * retries with the next candidate rather than one call silently clobbering
 * the other's file — no crash and no silent overwrite either way (spec I/O
 * matrix: concurrent same-group saves).
 */
function writeSignaturePng(signaturesDir: string, baseSlug: string, encoded: Buffer, replace: boolean): string {
  if (replace) {
    const destPath = path.join(signaturesDir, `${baseSlug}.png`);

    // `replace: true` is a deliberate overwrite of a *known, existing regular
    // file* at this exact name — not license to write through a symlink an
    // attacker (or a stray prior operation) planted at that path, which
    // would silently truncate whatever it points to instead. lstat (not
    // stat) inspects the directory entry itself without following it; ENOENT
    // just means this is a fresh name, not yet a collision at all.
    let existingIsSymlink = false;
    try {
      existingIsSymlink = fs.lstatSync(destPath).isSymbolicLink();
    } catch (e) {
      if (errnoCode(e) !== 'ENOENT') throw e;
    }
    if (existingIsSymlink) {
      throw new Error(`Refusing to overwrite "${baseSlug}.png" — it is a symlink, not a regular signature file.`);
    }

    fs.writeFileSync(destPath, encoded);
    return baseSlug;
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = uniqueName(signaturesDir, baseSlug, 'png');
    try {
      fs.writeFileSync(path.join(signaturesDir, `${candidate}.png`), encoded, { flag: 'wx' });
      return candidate;
    } catch (e) {
      if (errnoCode(e) !== 'EEXIST') throw e;
      // Another concurrent save just took this candidate — loop and pick the next one.
    }
  }
  throw new Error('Could not find a free signature filename after multiple attempts.');
}

interface SaveSignatureOpts {
  /** `/workspace/agent` in production; a temp dir in tests. */
  baseDir: string;
  /** `/workspace` in production; a temp dir in tests. Also the base for the inbox containment check. */
  workspaceRoot?: string;
}

export async function saveSignatureImpl(
  args: Record<string, unknown>,
  opts: SaveSignatureOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  try {
    const filePath = typeof args.path === 'string' ? args.path : undefined;
    if (!filePath) return err('path is required');

    if (args.name !== undefined && typeof args.name !== 'string') {
      return err('name must be a string');
    }
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) {
      return err('name is required — ask the user what to call this signature (e.g. their own name) before saving it.');
    }

    // slugify() falls back to the literal "document" when nothing in `name`
    // survives its a-z/0-9 filter (e.g. a Hebrew-only name, emoji-only, pure
    // punctuation) — a real, distinct signature name in that case would
    // silently collapse onto (and collide with) a generic "document" slug,
    // which is exactly the invented/unstated name the spec's Boundaries rule
    // out ("no silent default ... a signature name is a value the user
    // chose"). Only decline when the fallback actually fired — a user who
    // literally typed "document" is not misled by this check.
    const baseSlug = slugify(name);
    if (baseSlug === 'document' && name.toLowerCase() !== 'document') {
      return err(
        'That name has no Latin letters or digits I can turn into a filename — ask the user for a name that ' +
          'includes at least one (e.g. a transliteration), rather than saving it under a generic name.',
      );
    }

    if (args.replace !== undefined && typeof args.replace !== 'boolean') {
      return err('replace must be a boolean');
    }
    const replace = args.replace === true;

    const workspaceRoot = opts.workspaceRoot ?? '/workspace';
    const resolution = resolveInboxPath(filePath, workspaceRoot);
    if ('error' in resolution) return err(resolution.error);
    const resolvedPath = resolution.path;

    const originalFilename = path.basename(resolvedPath);
    const ext = path.extname(originalFilename).slice(1).toLowerCase();
    if (ext !== 'png') {
      return err(
        `Unsupported file type "${ext ? `.${ext}` : '(none)'}" — save_signature only handles PNG (.png) images.`,
      );
    }

    let decoded: { width: number; height: number; data: Buffer };
    try {
      const buffer = fs.readFileSync(resolvedPath);
      decoded = PNG.sync.read(buffer);
    } catch (e) {
      return err(`Could not decode PNG: ${e instanceof Error ? e.message : String(e)}`);
    }

    const cropped = thresholdAndCropPng(decoded.width, decoded.height, decoded.data);
    if (!cropped) {
      return err(
        'Nothing survived background removal — every pixel was near-white, so there is no ink to crop to. ' +
          'Declining rather than saving an empty image.',
      );
    }

    const signaturesDir = path.join(opts.baseDir, 'memory', 'signatures');
    fs.mkdirSync(signaturesDir, { recursive: true });

    const encoded = encodePng(cropped.data, cropped.width, cropped.height);
    const finalSlug = writeSignaturePng(signaturesDir, baseSlug, encoded, replace);

    log(
      `save_signature: saved "${name}" as "${finalSlug}" (${cropped.width}x${cropped.height}px` +
        `${replace ? ', replace' : ''})`,
    );
    return ok(
      `Saved signature "${finalSlug}" to this agent group's memory (memory/signatures/${finalSlug}.png, ` +
        `${cropped.width}x${cropped.height}px, background removed and cropped to the ink). This signature is ` +
        'only available in this group — it is not shared with any other agent group.',
    );
  } catch (e) {
    return err(`save_signature failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const saveSignature: McpToolDefinition = {
  tool: {
    name: 'save_signature',
    description:
      "Save a PNG image of a handwritten signature to this agent group's persistent memory, so it can be " +
      'reused later without resending the image. Removes a near-white background (fixed threshold, not ' +
      'configurable) and crops tightly to the remaining ink. Save-only — this tool never places a signature ' +
      'into any document; it only saves the asset itself. Declines cleanly for a non-PNG file, or for an image ' +
      'with no ink left after background removal (e.g. a blank/all-white page).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Path to the PNG image, as shown in the [<type>: name — saved to /workspace/inbox/...] line. Give ' +
            'the part after /workspace/, e.g. "inbox/<msgId>/name.png" (an absolute path also works, but must ' +
            'resolve inside /workspace/inbox).',
        },
        name: {
          type: 'string',
          description:
            'What to call this signature (e.g. the person\'s name, "uriel"). Required — never invent one; if ' +
            'the user did not give a name, ask for it before calling this tool.',
        },
        replace: {
          type: 'boolean',
          description:
            'Only set true if the user explicitly asked to replace/overwrite an existing signature saved under ' +
            'this same name. Default false: a name collision saves alongside the existing one with a numeric ' +
            'suffix (e.g. "uriel-2") instead of overwriting it. When it is unclear whether the user wants to ' +
            'replace the old one, ask them rather than guessing.',
        },
      },
      required: ['path', 'name'],
    },
  },
  handler: (args) => saveSignatureImpl(args, { baseDir: '/workspace/agent', workspaceRoot: '/workspace' }),
};

// ---------------------------------------------------------------------------
// list_documents / fill_document_field (Story 1.2)
//
// `resolveDocument` is the single shared matcher both tools use to turn a
// free-text `document` argument into a saved document: case-insensitive
// substring match against slug, source filename, and description
// (Design Notes — no fuzzy/ranked search needed yet). 0 matches is an
// error; 1 match resolves directly; 2+ matches is *not* an error — it's a
// numbered candidate list for the agent to relay to the user and re-call
// with the exact slug (AD-7).
// ---------------------------------------------------------------------------

interface DocumentMeta {
  slug: string;
  ext: 'docx' | 'doc' | 'pdf';
  sourceFilename: string;
  description: string;
  /**
   * Set when more than one raw file matches this slug (e.g. both a .docx
   * and a .pdf under files/<slug>.*) — shouldn't normally happen, but
   * silently picking one via extension-iteration order would risk editing
   * the wrong file. `ext` above is whichever was found first; callers that
   * are about to actually target this document must check this field and
   * surface a specific error instead of proceeding.
   */
  ambiguousExtensions?: Array<'docx' | 'doc' | 'pdf'>;
}

/** Reverses yamlEscape(): strips the surrounding quotes and unescapes `\x` -> `x`. */
function parseYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed);
  if (!m) return trimmed;
  return m[1].replace(/\\(.)/g, '$1');
}

function readConceptMeta(documentsDir: string, filesDir: string, slug: string): DocumentMeta | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(documentsDir, `${slug}.md`), 'utf-8');
  } catch {
    return undefined;
  }

  // \r?\n tolerates a CRLF-saved concept file (e.g. hand-edited on Windows) —
  // a bare \n-only regex would fail to match the frontmatter block at all.
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  const fields: Record<string, string> = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const m = /^([a-zA-Z][a-zA-Z0-9-]*):\s?(.*)$/.exec(line);
      if (m) fields[m[1]] = parseYamlScalar(m[2]);
    }
  }

  const matchingExts: Array<'docx' | 'doc' | 'pdf'> = [];
  for (const candidate of SUPPORTED_EXTENSIONS) {
    if (fs.existsSync(path.join(filesDir, `${slug}.${candidate}`))) {
      matchingExts.push(candidate as 'docx' | 'doc' | 'pdf');
    }
  }
  if (matchingExts.length === 0) return undefined; // concept file with no matching raw copy — orphaned, skip it

  return {
    slug,
    ext: matchingExts[0],
    sourceFilename: fields['source-filename'] ?? slug,
    description: fields['description'] ?? '',
    ambiguousExtensions: matchingExts.length > 1 ? matchingExts : undefined,
  };
}

function listDocumentMeta(documentsDir: string, filesDir: string): DocumentMeta[] {
  if (!fs.existsSync(documentsDir)) return [];
  const files = fs.readdirSync(documentsDir).filter((f) => f.endsWith('.md') && f !== 'index.md');
  const metas: DocumentMeta[] = [];
  for (const f of files) {
    const meta = readConceptMeta(documentsDir, filesDir, f.slice(0, -3));
    if (meta) metas.push(meta);
  }
  return metas;
}

function matchDocuments(documentsDir: string, filesDir: string, query: string | undefined): DocumentMeta[] {
  const all = listDocumentMeta(documentsDir, filesDir);
  if (!query || query.trim() === '') return all;
  const q = query.toLowerCase();
  return all.filter(
    (m) =>
      m.slug.toLowerCase().includes(q) ||
      m.sourceFilename.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q),
  );
}

function formatDocumentCandidates(metas: DocumentMeta[]): string {
  return metas
    .map((m, i) => `${i + 1}. ${m.slug} — ${m.sourceFilename}${m.description ? ` (${m.description})` : ''}`)
    .join('\n');
}

type DocumentResolution =
  | { kind: 'resolved'; meta: DocumentMeta }
  | { kind: 'candidates'; metas: DocumentMeta[] }
  | { kind: 'not-found' };

/** Used by fill_document_field's own targeting — 1 match proceeds, 2+ halts with a candidate list, 0 errors. */
function resolveDocument(documentsDir: string, filesDir: string, query: string): DocumentResolution {
  const matches = matchDocuments(documentsDir, filesDir, query);
  if (matches.length === 0) return { kind: 'not-found' };
  if (matches.length === 1) return { kind: 'resolved', meta: matches[0] };
  return { kind: 'candidates', metas: matches };
}

interface ListDocumentsOpts {
  baseDir: string;
}

export async function listDocumentsImpl(
  args: Record<string, unknown>,
  opts: ListDocumentsOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  try {
    const query = typeof args.query === 'string' ? args.query : undefined;
    const documentsDir = path.join(opts.baseDir, 'memory', 'documents');
    const filesDir = path.join(documentsDir, 'files');

    const matches = matchDocuments(documentsDir, filesDir, query);
    if (query && query.trim() !== '' && matches.length === 0) {
      log(`list_documents: no match for query "${query}"`);
      return err(`No saved document matches "${query}".`);
    }
    if (matches.length === 0) {
      log('list_documents: no saved documents yet');
      return ok('No saved documents yet.');
    }
    log(`list_documents: ${matches.length} match(es) for query ${query ? `"${query}"` : '(none)'}`);
    return ok(formatDocumentCandidates(matches));
  } catch (e) {
    return err(`list_documents failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const listDocuments: McpToolDefinition = {
  tool: {
    name: 'list_documents',
    description:
      "List saved documents (from save_document) matching a free-text query against each document's slug, " +
      'original filename, and description. Omit "query" to list everything. Used to find the exact slug for ' +
      'fill_document_field when a name/topic reference could match more than one saved document.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Free-text match against slug/filename/description. Omit to list all saved documents.',
        },
      },
    },
  },
  handler: (args) => listDocumentsImpl(args, { baseDir: '/workspace/agent' }),
};

// ---------------------------------------------------------------------------
// fill_document_field — .docx table-cell path
//
// A tiny stack-based tokenizer limited to the six OOXML tag names a table
// can be built from (tbl/tr/tc/p/r/t). Any other tag (tblPr, trPr, tcPr,
// rPr, pPr, ...) is treated as opaque content that never affects nesting,
// which is safe because real OOXML is well-formed: those tags always live
// fully inside one of our six, never straddling a boundary. This gives an
// exact tree with byte offsets, letting later edits splice precise ranges
// out of the original string rather than doing any string-based rebuild.
// ---------------------------------------------------------------------------

const OOXML_TAGS = ['tbl', 'tr', 'tc', 'p', 'r', 't'] as const;
type OoxmlTag = (typeof OOXML_TAGS)[number];

interface XmlNode {
  tag: OoxmlTag;
  start: number; // index of '<' of the opening (or self-closing) tag
  openEnd: number; // index right after the opening tag's '>'
  close: number; // index of '<' of the closing tag (== openEnd if self-closing)
  end: number; // index right after the closing tag's '>' (== openEnd if self-closing)
  selfClosing: boolean;
  children: XmlNode[];
}

function parseOoxmlTree(xml: string): XmlNode[] {
  const tagAlt = OOXML_TAGS.join('|');
  const re = new RegExp(`<w:(${tagAlt})\\b([^>]*)>|<\\/w:(${tagAlt})>`, 'g');
  const stack: XmlNode[] = [];
  const roots: XmlNode[] = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(xml))) {
    const isClose = m[0].startsWith('</');
    if (!isClose) {
      const tag = m[1] as OoxmlTag;
      const selfClosing = /\/\s*$/.test(m[2] ?? '');
      const openEnd = m.index + m[0].length;
      const node: XmlNode = {
        tag,
        start: m.index,
        openEnd,
        close: selfClosing ? openEnd : -1,
        end: selfClosing ? openEnd : -1,
        selfClosing,
        children: [],
      };
      if (stack.length > 0) stack[stack.length - 1].children.push(node);
      else roots.push(node);
      if (!selfClosing) stack.push(node);
    } else {
      const tag = m[3] as OoxmlTag;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack[i].close = m.index;
          stack[i].end = m.index + m[0].length;
          stack.length = i; // pop it (and, defensively, anything left dangling above it)
          break;
        }
      }
    }
  }
  return roots;
}

function nodeContainsTag(node: XmlNode, tag: OoxmlTag): boolean {
  for (const child of node.children) {
    if (child.tag === tag || nodeContainsTag(child, tag)) return true;
  }
  return false;
}

/**
 * An unbalanced closing tag (or truncated document.xml) leaves some node's
 * close/end at -1 (never matched — see parseOoxmlTree's close-tag branch).
 * Slicing the original string using a -1 offset would silently corrupt the
 * output rather than erroring, so this is checked up front, once, over the
 * whole parsed tree, before any of it is used for an edit.
 */
function treeIsWellFormed(nodes: XmlNode[]): boolean {
  return nodes.every((n) => n.close !== -1 && n.end !== -1 && treeIsWellFormed(n.children));
}

function collectDescendants(node: XmlNode, tag: OoxmlTag): XmlNode[] {
  const found: XmlNode[] = [];
  for (const child of node.children) {
    if (child.tag === tag) found.push(child);
    found.push(...collectDescendants(child, tag));
  }
  return found;
}

// stripControlChars first: `value` is untrusted (model-controlled), same as the filenames
// stripControlChars already guards elsewhere — a raw control byte other than tab/CR/LF is not
// legal XML 1.0 character data and would otherwise corrupt the produced word/document.xml.
function xmlEscapeText(s: string): string {
  return stripControlChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Ensures a <w:t...> opening tag carries xml:space="preserve" — replacing any other value it already has. */
function ensurePreserveSpace(openTag: string): string {
  if (/xml:space\s*=\s*"[^"]*"/.test(openTag)) {
    return openTag.replace(/xml:space\s*=\s*"[^"]*"/, 'xml:space="preserve"');
  }
  return openTag.replace(/^<w:t/, '<w:t xml:space="preserve"');
}

/**
 * Sets the cell's displayed text to `value`. The first <w:t> run (in
 * document order) receives the value; any additional runs in the same cell
 * are blanked rather than left to concatenate stray leftover text after it.
 */
function replaceCellText(xml: string, tNodes: XmlNode[], value: string): string {
  const primary = tNodes[0];
  const byPositionDesc = [...tNodes].sort((a, b) => b.start - a.start);
  let result = xml;
  for (const node of byPositionDesc) {
    if (node.close === -1 || node.end === -1) {
      // Should be unreachable — fillDocx checks treeIsWellFormed() before
      // reaching here — but slicing on a -1 offset would silently corrupt
      // the output, so this is a hard stop rather than a fallback.
      throw new Error('Malformed table cell XML (unclosed run) — cannot fill.');
    }
    const isPrimary = node === primary;
    const inner = isPrimary ? xmlEscapeText(value) : '';
    if (node.selfClosing) {
      if (!isPrimary) continue; // already empty — nothing to blank
      const raw = result.slice(node.start, node.end);
      const opened = ensurePreserveSpace(raw.replace(/\/\s*>\s*$/, '>'));
      result = result.slice(0, node.start) + opened + inner + '</w:t>' + result.slice(node.end);
    } else {
      const openTagRaw = result.slice(node.start, node.openEnd);
      const openTag = isPrimary ? ensurePreserveSpace(openTagRaw) : openTagRaw;
      result = result.slice(0, node.start) + openTag + inner + result.slice(node.close);
    }
  }
  return result;
}

/** Cell has no <w:t> at all — insert a new run into its last paragraph (or a new paragraph if it has none). */
function insertRunIntoCell(xml: string, cellNode: XmlNode, value: string): string {
  const runXml = `<w:r><w:t xml:space="preserve">${xmlEscapeText(value)}</w:t></w:r>`;
  const paragraphs = cellNode.children.filter((c) => c.tag === 'p');
  if (paragraphs.length > 0) {
    const lastP = paragraphs[paragraphs.length - 1];
    if (lastP.close === -1) throw new Error('Malformed table cell XML (unclosed paragraph) — cannot fill.');
    const insertAt = lastP.close;
    return xml.slice(0, insertAt) + runXml + xml.slice(insertAt);
  }
  if (cellNode.close === -1) throw new Error('Malformed table cell XML (unclosed cell) — cannot fill.');
  const insertAt = cellNode.close;
  return xml.slice(0, insertAt) + `<w:p>${runXml}</w:p>` + xml.slice(insertAt);
}

// ---------------------------------------------------------------------------
// .docx signature stamping (Story 1.8) — embeds a saved signature PNG
// (resolveSignaturePng, Story 1.7, reused unmodified) as a new OOXML media
// part and inserts it as an *additional* <w:drawing> run at whichever
// table-cell or fill-in-the-blank-line target fillDocx already resolved —
// never a replacement for existing text (unlike a plain text `value` fill).
//
// Three zip parts always change together: `word/media/imageN.png`, a new
// relationship in `word/_rels/document.xml.rels`, and (only if none already
// exists) a PNG `<Default>` entry in `[Content_Types].xml`. The "next free
// id" computations below always read from the *original*, pre-edit zip
// contents, so they can never collide with anything already present in the
// source .docx — including a pre-existing embedded image's own media file/
// relationship/content-type entries, which are left untouched.
// ---------------------------------------------------------------------------

/** EMU per point (ECMA-376 DrawingML) — the unit wp:extent/a:ext expect. */
const EMU_PER_POINT = 12700;

const RELATIONSHIPS_XML_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const IMAGE_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

// Fallback shape used only when the source .docx's zip has no
// word/_rels/document.xml.rels or [Content_Types].xml part at all — a real
// Word-produced .docx always has both, but a hand-built/minimal test fixture
// (or a genuinely malformed input) might not. Synthesizing a minimal valid
// starting point here is strictly additive: it never removes or reinterprets
// anything the source actually had, since these fallbacks are only ever used
// when the part was entirely absent.
const DEFAULT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + `<Relationships xmlns="${RELATIONSHIPS_XML_NS}"></Relationships>`;
const DEFAULT_CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + `<Types xmlns="${CONTENT_TYPES_NS}"></Types>`;

/** Next free `rId<n>` in a relationships part — scans existing `Id="rId(\d+)"` occurrences (either quote style — XML allows single- or double-quoted attribute values), returns max+1 (1 if none found). */
function nextRelationshipId(relsXml: string): number {
  let max = 0;
  const re = /\bId=["']rId(\d+)["']/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(relsXml))) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max + 1;
}

/** Next free `word/media/imageN.<ext>` number across every existing entry in the zip (any extension — an existing image1.jpeg still claims the number 1), returns max+1 (1 if none found). */
function nextMediaImageNumber(zip: JSZipType): number {
  let max = 0;
  const re = /^word\/media\/image(\d+)\./;
  zip.forEach((relPath) => {
    const m = re.exec(relPath);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  });
  return max + 1;
}

/** Appends a new image `<Relationship>` right before `</Relationships>`. */
function addImageRelationship(relsXml: string, id: number, target: string): string {
  const entry = `<Relationship Id="rId${id}" Type="${IMAGE_RELATIONSHIP_TYPE}" Target="${target}"/>`;
  if (relsXml.includes('</Relationships>')) {
    return relsXml.replace('</Relationships>', `${entry}</Relationships>`);
  }
  // Defensive fallback for a self-closing <Relationships/> root — never
  // produced by DEFAULT_RELS_XML above, but cheap insurance against an
  // atypical real-world producer.
  return relsXml.replace(/<Relationships([^>]*)\/>/, `<Relationships$1>${entry}</Relationships>`);
}

/**
 * Adds a `<Default Extension="png" .../>` entry unless a PNG `Default` (any
 * quote style) is already present — never a duplicate. An OPC `Override` is
 * deliberately NOT treated as sufficient: per OPC content-type resolution,
 * an `Override` only applies to its own exact `PartName`, not to the `.png`
 * extension generally — a `.docx` with a scoped Override for one existing
 * image part but no extension-wide `Default` would otherwise leave the
 * *new* `word/media/imageN.png` part with no applicable content-type
 * mapping at all (an invalid OOXML package). Always adding the Default when
 * none exists is harmless even alongside an unrelated Override — a
 * redundant-but-consistent Default is spec-legal, unlike the false-negative
 * the Override check used to produce.
 */
function ensurePngContentType(contentTypesXml: string): string {
  if (/<Default\s+Extension=["']png["']/i.test(contentTypesXml)) return contentTypesXml;
  const entry = '<Default Extension="png" ContentType="image/png"/>';
  if (contentTypesXml.includes('</Types>')) {
    return contentTypesXml.replace('</Types>', `${entry}</Types>`);
  }
  return contentTypesXml.replace(/<Types([^>]*)\/>/, `<Types$1>${entry}</Types>`);
}

/** Next free `<wp:docPr id="N">` in word/document.xml — scans for the current max (either quote style), returns max+1 (1 if none found). Duplicate docPr ids can make Word/LibreOffice misbehave. */
function nextDocPrId(xml: string): number {
  let max = 0;
  const re = /<wp:docPr\b[^>]*\bid=["'](\d+)["']/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(xml))) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max + 1;
}

/** A PNG's natural pixel dimensions, via pngjs (Story 1.6's dependency) — used to derive an aspect-preserved width for a fixed max-height placement. */
function readPngDimensions(bytes: Buffer): { width: number; height: number } {
  const decoded = PNG.sync.read(bytes);
  return { width: decoded.width, height: decoded.height };
}

/**
 * The canonical minimal inline-image OOXML run (Design Notes). Namespaces
 * (`wp`/`a`/`pic`/`r`) are declared inline on the elements that introduce
 * each prefix, rather than assumed to already be declared on the source
 * .docx's root `<w:document>` element — this keeps the run self-contained
 * regardless of what the source producer happened to declare at the root.
 */
function buildDrawingRunXml(relId: number, widthEmu: number, heightEmu: number, docPrId: number): string {
  return (
    '<w:r><w:drawing>' +
    '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${docPrId}" name="Picture ${docPrId}"/>` +
    '<wp:cNvGraphicFramePr>' +
    '<a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>' +
    '</wp:cNvGraphicFramePr>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:nvPicPr>' +
    `<pic:cNvPr id="${docPrId}" name="Picture ${docPrId}"/>` +
    '<pic:cNvPicPr/>' +
    '</pic:nvPicPr>' +
    '<pic:blipFill>' +
    `<a:blip r:embed="rId${relId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>` +
    '<a:stretch><a:fillRect/></a:stretch>' +
    '</pic:blipFill>' +
    '<pic:spPr>' +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '</pic:spPr>' +
    '</pic:pic>' +
    '</a:graphicData>' +
    '</a:graphic>' +
    '</wp:inline>' +
    '</w:drawing></w:r>'
  );
}

/** Additional text run following a stamped image, same run-construction convention as insertRunAfterParagraph — a leading space keeps it from visually running into the image. */
function buildSignatureValueRunXml(value: string): string {
  return `<w:r><w:t xml:space="preserve"> ${xmlEscapeText(value)}</w:t></w:r>`;
}

/** Table-cell target, image case: appends into the cell's last paragraph (or a new paragraph if it has none) — mirrors insertRunIntoCell's insertion point, but used unconditionally for an image regardless of whether the cell already has text. */
function appendRunXmlIntoCell(xml: string, cellNode: XmlNode, runXml: string): string {
  const paragraphs = cellNode.children.filter((c) => c.tag === 'p');
  if (paragraphs.length > 0) {
    const lastP = paragraphs[paragraphs.length - 1];
    if (lastP.close === -1) throw new Error('Malformed table cell XML (unclosed paragraph) — cannot stamp.');
    const insertAt = lastP.close;
    return xml.slice(0, insertAt) + runXml + xml.slice(insertAt);
  }
  if (cellNode.close === -1) throw new Error('Malformed table cell XML (unclosed cell) — cannot stamp.');
  const insertAt = cellNode.close;
  return xml.slice(0, insertAt) + `<w:p>${runXml}</w:p>` + xml.slice(insertAt);
}

/** Fill-in-the-blank-line target, image case: appends right after the target paragraph's existing content — mirrors insertRunAfterParagraph's insertion point, but used unconditionally for an image regardless of whether the paragraph matched via an underscore blank or a trailing-colon label (the existing blank/label text is never touched). */
function appendRunXmlAfterParagraph(xml: string, pNode: XmlNode, runXml: string): string {
  const runs = pNode.children.filter((c) => c.tag === 'r');
  if (runs.length > 0) {
    const lastRun = runs[runs.length - 1];
    if (lastRun.end === -1) throw new Error('Malformed paragraph XML (unclosed run) — cannot stamp.');
    const insertAt = lastRun.end;
    return xml.slice(0, insertAt) + runXml + xml.slice(insertAt);
  }
  if (pNode.close === -1) throw new Error('Malformed paragraph XML (unclosed paragraph) — cannot stamp.');
  const insertAt = pNode.close;
  return xml.slice(0, insertAt) + runXml + xml.slice(insertAt);
}

interface SignatureStampParts {
  /** The drawing run XML, plus an additional text run right after it when `value` was also given — ready to splice into word/document.xml at the resolved target's insertion point. */
  insertXml: string;
  mediaNumber: number;
  /** word/_rels/document.xml.rels content, already updated with the new relationship. */
  relsXml: string;
  /** [Content_Types].xml content, already updated (or left as-is if a PNG Default already existed). */
  contentTypesXml: string;
}

/**
 * Reads whatever's needed from the *original*, unmodified zip (rels,
 * content-types, existing document.xml) to compute every next-free id, then
 * returns the ready-to-splice run XML and the two updated part contents —
 * the caller still has to actually splice insertXml into document.xml and
 * write all four zip.file(...) calls (document.xml, media, rels,
 * content-types) together before generateAsync (spec: "all three or none").
 *
 * Returns `{ error }` instead when the signature PNG's dimensions are
 * degenerate (width or height <= 0) — reachable if a file was hand-placed
 * under memory/signatures/ bypassing save_signature's own empty-bbox guard,
 * or corrupted after saving. Dividing by a zero height to derive the
 * aspect-preserved width would otherwise produce Infinity/NaN and emit an
 * invalid `cx="Infinity"` attribute into the drawing XML.
 */
async function prepareSignatureStamp(
  zip: JSZipType,
  documentXml: string,
  signaturePng: Buffer,
  value: string | undefined,
): Promise<SignatureStampParts | { error: string }> {
  const dims = readPngDimensions(signaturePng);
  if (dims.width <= 0 || dims.height <= 0) {
    return {
      error:
        `The saved signature image has degenerate dimensions (${dims.width}x${dims.height}px) — cannot size it ` +
        'for stamping.',
    };
  }
  const heightEmu = SIGNATURE_MAX_HEIGHT_PT * EMU_PER_POINT;
  const widthEmu = Math.round(heightEmu * (dims.width / dims.height));

  const mediaNumber = nextMediaImageNumber(zip);

  const relsFile = zip.file('word/_rels/document.xml.rels');
  const relsXmlOriginal = relsFile ? await relsFile.async('string') : DEFAULT_RELS_XML;
  const relId = nextRelationshipId(relsXmlOriginal);

  const contentTypesFile = zip.file('[Content_Types].xml');
  const contentTypesXmlOriginal = contentTypesFile ? await contentTypesFile.async('string') : DEFAULT_CONTENT_TYPES_XML;

  const docPrId = nextDocPrId(documentXml);
  const drawingRunXml = buildDrawingRunXml(relId, widthEmu, heightEmu, docPrId);
  const insertXml = value !== undefined ? drawingRunXml + buildSignatureValueRunXml(value) : drawingRunXml;

  return {
    insertXml,
    mediaNumber,
    relsXml: addImageRelationship(relsXmlOriginal, relId, `media/image${mediaNumber}.png`),
    contentTypesXml: ensurePngContentType(contentTypesXmlOriginal),
  };
}

/** Writes all three new/updated zip parts together, alongside the (already-spliced) new document.xml — never a partial subset. */
function applySignatureZipParts(zip: JSZipType, newDocumentXml: string, signaturePng: Buffer, parts: SignatureStampParts): void {
  zip.file('word/document.xml', newDocumentXml);
  zip.file(`word/media/image${parts.mediaNumber}.png`, signaturePng);
  zip.file('word/_rels/document.xml.rels', parts.relsXml);
  zip.file('[Content_Types].xml', parts.contentTypesXml);
}

function writeFillOutput(baseDir: string, slug: string, ext: string, data: Buffer): string {
  const dir = path.join(baseDir, '.document-fills');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${slug}-filled-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  fs.writeFileSync(outPath, data);
  return outPath;
}

interface FillOpts {
  baseDir: string;
}

// ---------------------------------------------------------------------------
// .docx text-line fill (Story 1.4) — targets a plain paragraph's underscore
// blank or trailing-colon label, for documents (or document regions) that
// aren't a table. Only ever considers top-level body paragraphs (roots whose
// tag is 'p') — a paragraph nested inside a <w:tbl> is never a candidate
// here; that's the table-row path's job (see fillDocx's dispatch below).
// ---------------------------------------------------------------------------

interface DocxLineCandidate {
  /** 1-indexed position within the *candidate* list itself — the same list both the discovery call and a fill call's "lineNumber" address. */
  lineNumber: number;
  pNode: XmlNode;
  /** Own text of this paragraph (concatenated t-descendants, plus a rendered space for a <w:tab/>/<w:br/>), trimmed — shown in the discovery list and echoed back on fill. */
  text: string;
  /**
   * The <w:t> node(s) that together make up *this candidate's* underscore
   * run, when one was found — undefined means this candidate qualified via
   * the trailing-colon rule instead. Almost always length 1; length > 1
   * only when that one underscore run itself is fragmented across multiple
   * <w:t> nodes (see findAllUnderscoreRunGroups). A paragraph with two
   * separate underscore runs (two blanks) produces two candidates, each
   * with its own node group here — never a merged/ambiguous one.
   */
  underscoreNodes?: XmlNode[];
}

/**
 * Concatenates a paragraph's own <w:t> descendant text, in document order,
 * decoding XML entities. A <w:tab/> or <w:br/> found in the raw XML between
 * (or around) two <w:t> nodes renders as a single space, so a label and a
 * blank separated by a real tab/line-break don't visually run together in
 * the discovery listing (e.g. "שם:" <tab> "___________" reads as
 * "שם: ___________", not "שם:___________").
 */
function collectParagraphText(xml: string, pNode: XmlNode): string {
  const tNodes = collectDescendants(pNode, 't');
  const tabOrBreakRe = /<w:(?:tab|br)\b[^>]*\/>/;
  let result = '';
  let cursor = pNode.start;
  const appendGap = (gapStart: number, gapEnd: number) => {
    if (gapEnd > gapStart && tabOrBreakRe.test(xml.slice(gapStart, gapEnd))) result += ' ';
  };
  for (const t of tNodes) {
    appendGap(cursor, t.start);
    result += decodeXmlEntities(xml.slice(t.openEnd, t.close));
    cursor = t.end;
  }
  appendGap(cursor, pNode.end);
  return result;
}

/**
 * Finds every underscore run (a `/_{3,}/` match) in a paragraph's
 * concatenated <w:t>-descendant text, returning one node-group per match —
 * a paragraph with two blanks ("Name: ___ Date: ___") yields two groups,
 * each independently addressable as its own line candidate. For a single
 * match, the group is normally one <w:t> node; if Word fragmented that one
 * blank across multiple runs, every node overlapping that specific match is
 * included (fillDocxTextLine then applies replaceCellText's existing
 * first-run-wins/blank-the-rest splice to just that group's nodes — same
 * behavior already documented for a table cell, no new precedent needed
 * here). A label run adjacent to (but not overlapping) a match is never
 * included in that match's group, so it's left untouched by the fill.
 */
function findAllUnderscoreRunGroups(xml: string, pNode: XmlNode): XmlNode[][] {
  const tNodes = collectDescendants(pNode, 't');
  if (tNodes.length === 0) return [];

  let concatenated = '';
  const ranges: Array<{ node: XmlNode; start: number; end: number }> = [];
  for (const node of tNodes) {
    const text = decodeXmlEntities(xml.slice(node.openEnd, node.close));
    const start = concatenated.length;
    concatenated += text;
    ranges.push({ node, start, end: start + text.length });
  }

  const groups: XmlNode[][] = [];
  const re = /_{3,}/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(concatenated))) {
    const matchStart = m.index;
    const matchEnd = m.index + m[0].length;
    const overlapping = ranges.filter((r) => r.start < matchEnd && r.end > matchStart).map((r) => r.node);
    if (overlapping.length > 0) groups.push(overlapping);
  }
  return groups;
}

// A trailing-colon paragraph only counts as a fill-in-the-blank label when it's short
// (e.g. "תאריך:") — a longer prose sentence or section heading that happens to end in
// ':' ("Please review the following:") is not a blank to fill.
const COLON_LABEL_MAX_LENGTH = 40;

/**
 * Scans top-level body paragraphs (document order) for fill-in-the-blank
 * markers: one candidate per underscore run (3+ literal `_`), or — only
 * when no underscore run was found at all — one candidate if the paragraph
 * is a short line ending in ':' with nothing meaningful after it. Table-
 * internal paragraphs (anything not a direct `roots` entry) are never
 * candidates. A paragraph that's purely a decorative underscore divider
 * (no other label text once every underscore run is stripped out) is never
 * a candidate either — it has no label to attach a value to. The returned
 * list's own position (1-indexed) IS the "lineNumber" addressing scheme —
 * both the discovery response and a fill call's lineNumber argument index
 * into this same filtered list, mirroring how the PDF side's lineNumber
 * indexes its own detected-lines list.
 */
function findDocxLineCandidates(xml: string, roots: XmlNode[]): DocxLineCandidate[] {
  const candidates: DocxLineCandidate[] = [];
  for (const pNode of roots) {
    if (pNode.tag !== 'p') continue;
    const text = collectParagraphText(xml, pNode).trim();
    if (text === '') continue;

    const underscoreGroups = findAllUnderscoreRunGroups(xml, pNode);
    if (underscoreGroups.length > 0) {
      const hasLabelText = text.replace(/_+/g, '').trim().length > 0;
      if (hasLabelText) {
        for (const group of underscoreGroups) {
          candidates.push({ lineNumber: candidates.length + 1, pNode, text, underscoreNodes: group });
        }
      }
      continue;
    }

    if (text.endsWith(':') && text.length <= COLON_LABEL_MAX_LENGTH) {
      candidates.push({ lineNumber: candidates.length + 1, pNode, text, underscoreNodes: undefined });
    }
  }
  return candidates;
}

function formatDocxLineCandidates(candidates: DocxLineCandidate[]): string {
  return candidates.map((c) => `${c.lineNumber}. ${c.text}`).join('\n');
}

/** Discovery response for a table-less docx (or one where the caller explicitly asked for line targeting). */
function docxListLines(candidates: DocxLineCandidate[]): ReturnType<typeof ok> | ReturnType<typeof err> {
  if (candidates.length === 0) {
    return err(
      'This document has no tables to fill, and no fill-in-the-blank line (an underscore blank or a ' +
        'trailing-colon label) was detected either.',
    );
  }
  return ok(
    `Detected fill-in-the-blank line(s):\n${formatDocxLineCandidates(candidates)}\n\nCall fill_document_field ` +
      'again with the same "document", this "lineNumber", and a "value" to fill one.',
  );
}

const TABLE_ROW_REQUIRED_MESSAGE = 'row is required for a .docx fill (1-indexed row within the target table).';

/**
 * Bare-discovery response (neither row/table nor lineNumber given). Always
 * scans for fill-in-the-blank paragraphs regardless of whether the document
 * also has tables (2026-08-16 spec amendment) — a mixed document names both
 * possibilities so the agent can pick either targeting mode, rather than
 * only ever surfacing the table prompt with the blank lines undiscoverable.
 */
function docxDiscoveryResponse(
  tables: XmlNode[],
  candidates: DocxLineCandidate[],
): ReturnType<typeof ok> | ReturnType<typeof err> {
  if (tables.length === 0) return docxListLines(candidates);
  if (candidates.length === 0) return err(TABLE_ROW_REQUIRED_MESSAGE);
  return ok(
    `${TABLE_ROW_REQUIRED_MESSAGE} Or use "lineNumber" instead to fill one of the detected fill-in-the-blank ` +
      `line(s) below:\n${formatDocxLineCandidates(candidates)}\n\nCall fill_document_field again with the same ` +
      '"document" and either "row" (table path) or "lineNumber" (text-line path) plus "value".',
  );
}

/** Paragraph has no underscore run (colon-ending case) — insert a new run right after its last existing run. A leading space keeps the value from running into the colon (e.g. "תאריך: 16/08/2026", not "תאריך:16/08/2026"). */
function insertRunAfterParagraph(xml: string, pNode: XmlNode, value: string): string {
  const runXml = `<w:r><w:t xml:space="preserve"> ${xmlEscapeText(value)}</w:t></w:r>`;
  const runs = pNode.children.filter((c) => c.tag === 'r');
  if (runs.length > 0) {
    const lastRun = runs[runs.length - 1];
    if (lastRun.end === -1) throw new Error('Malformed paragraph XML (unclosed run) — cannot fill.');
    const insertAt = lastRun.end;
    return xml.slice(0, insertAt) + runXml + xml.slice(insertAt);
  }
  if (pNode.close === -1) throw new Error('Malformed paragraph XML (unclosed paragraph) — cannot fill.');
  const insertAt = pNode.close;
  return xml.slice(0, insertAt) + runXml + xml.slice(insertAt);
}

async function fillDocxTextLine(
  zip: JSZipType,
  xml: string,
  roots: XmlNode[],
  meta: DocumentMeta,
  lineNumber: number,
  value: string | undefined,
  signaturePng: Buffer | undefined,
  opts: FillOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  const candidates = findDocxLineCandidates(xml, roots);
  const target = candidates[lineNumber - 1];
  if (!target) {
    return err(
      `No line ${lineNumber} found — this document has ${candidates.length} detected fill-in-the-blank line(s).`,
    );
  }

  // Image case: always appended right after the target paragraph's existing
  // content — never a replacement, regardless of whether the paragraph
  // matched via an underscore blank or a trailing-colon label.
  if (signaturePng !== undefined) {
    const stamp = await prepareSignatureStamp(zip, xml, signaturePng, value);
    if ('error' in stamp) return err(stamp.error);
    const newXml = appendRunXmlAfterParagraph(xml, target.pNode, stamp.insertXml);
    applySignatureZipParts(zip, newXml, signaturePng, stamp);
    const outBytes = await zip.generateAsync({ type: 'nodebuffer' });
    const outPath = writeFillOutput(opts.baseDir, meta.slug, 'docx', outBytes);
    return ok(
      `Stamped ${describeStamp(true, value)} right after line ${lineNumber} ("${target.text}") of "${meta.slug}". ` +
        `New file at ${outPath} — call send_file to deliver it.`,
    );
  }

  const newXml = target.underscoreNodes
    ? replaceCellText(xml, target.underscoreNodes, value!)
    : insertRunAfterParagraph(xml, target.pNode, value!);

  zip.file('word/document.xml', newXml);
  const outBytes = await zip.generateAsync({ type: 'nodebuffer' });
  const outPath = writeFillOutput(opts.baseDir, meta.slug, 'docx', outBytes);
  return ok(
    `Filled line ${lineNumber} ("${target.text}") of "${meta.slug}" with "${value}". New file at ${outPath} — ` +
      'call send_file to deliver it.',
  );
}

async function fillDocx(
  rawPath: string,
  meta: DocumentMeta,
  args: Record<string, unknown>,
  opts: FillOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  const row = typeof args.row === 'number' ? args.row : undefined;
  const value = typeof args.value === 'string' ? args.value : undefined;
  const tableArg = typeof args.table === 'number' ? args.table : undefined;
  const columnArg = typeof args.column === 'number' ? args.column : undefined;
  const lineNumberArg = typeof args.lineNumber === 'number' ? args.lineNumber : undefined;
  const signatureNameRaw = typeof args.signatureName === 'string' ? args.signatureName : undefined;
  const signatureName = signatureNameRaw?.trim();
  if (signatureNameRaw !== undefined && !signatureName) return err('signatureName cannot be empty.');

  // Resolved once here, regardless of which target branch below ends up
  // being picked — mirrors fillPdf's identical up-front resolution.
  let signaturePng: Buffer | undefined;
  if (signatureName !== undefined) {
    const resolved = resolveSignaturePng(opts.baseDir, signatureName);
    if ('error' in resolved) return err(resolved.error);
    signaturePng = resolved.bytes;
  }

  // Table-row targeting (Story 1.2) always wins when the caller gives row
  // and/or table — text-line mode only activates when the caller instead
  // gives lineNumber, or gives neither and the document has no tables at all.
  const usesTablePath = row !== undefined || tableArg !== undefined;

  // row/table and lineNumber together used to silently resolve to table
  // priority, dropping lineNumber with no acknowledgment — an explicit
  // error is safer than a silent resolution.
  if (usesTablePath && lineNumberArg !== undefined) {
    return err(
      'Pass either "row"/"table" for the table-fill path or "lineNumber" for the text-line path, not both.',
    );
  }
  // column only means something for table-row targeting — without row/table
  // it used to be silently ignored.
  if (columnArg !== undefined && !usesTablePath) {
    return err('"column" requires "row" (or "table") — it only applies to table-row targeting.');
  }

  const JSZipModule = await import('jszip');
  const JSZip = JSZipModule.default;
  const zip = await JSZip.loadAsync(fs.readFileSync(rawPath));
  const docFile = zip.file('word/document.xml');
  if (!docFile) return err('This .docx has no word/document.xml — cannot edit it.');
  const xml = await docFile.async('string');

  const roots = parseOoxmlTree(xml);
  if (!treeIsWellFormed(roots)) {
    return err("This document's table XML looks malformed (an unbalanced tag) — declining to edit it.");
  }
  const tables = roots.filter((n) => n.tag === 'tbl');

  if (!usesTablePath) {
    if (lineNumberArg !== undefined) {
      if (value === undefined && signaturePng === undefined) {
        return err('value or signatureName is required together with lineNumber.');
      }
      return fillDocxTextLine(zip, xml, roots, meta, lineNumberArg, value, signaturePng, opts);
    }
    // Discovery (no row/table/lineNumber given) — always scans for
    // fill-in-the-blank paragraphs regardless of whether the document also
    // has tables; a mixed document's response names both possibilities. A
    // signatureName given alongside a bare-discovery call was already
    // resolved (or errored) above but is otherwise unused here — this
    // response is identical whether or not one was passed, mirroring
    // fillPdf's own "no target given" branches.
    return docxDiscoveryResponse(tables, findDocxLineCandidates(xml, roots));
  }

  if (row === undefined) return err('row is required for a .docx fill (1-indexed row within the target table).');
  if (value === undefined && signaturePng === undefined) return err('value or signatureName is required.');
  if (tables.length === 0) return err('This document has no tables to fill.');

  let tableIndex: number;
  if (tableArg !== undefined) {
    tableIndex = tableArg;
  } else if (tables.length === 1) {
    tableIndex = 1;
  } else {
    return err(`This document has ${tables.length} tables — specify "table" (1-${tables.length}).`);
  }
  const table = tables[tableIndex - 1];
  if (!table) return err(`Table ${tableIndex} not found — this document has ${tables.length} table(s).`);

  const rows = table.children.filter((n) => n.tag === 'tr');
  const targetRow = rows[row - 1];
  if (!targetRow) return err(`Row ${row} not found in table ${tableIndex} — it has ${rows.length} row(s).`);

  // gridSpan (a merged cell) makes direct-<w:tc>-position counting unreliable
  // for the *visual* column the user means — decline rather than silently
  // filling the wrong one. Full merged-cell-aware targeting is out of scope
  // (see deferred-work.md); this is detect-and-decline only.
  if (/<w:gridSpan\b/.test(xml.slice(targetRow.start, targetRow.end))) {
    return err(
      `Row ${row} of table ${tableIndex} contains a merged cell (gridSpan) — column-by-position targeting isn't ` +
        'reliable here, declining to edit it.',
    );
  }

  const cells = targetRow.children.filter((n) => n.tag === 'tc');
  if (cells.length === 0) return err(`Row ${row} in table ${tableIndex} has no cells.`);
  const cellIndex = columnArg !== undefined ? columnArg : cells.length; // default: last cell (label|value shape)
  const targetCell = cells[cellIndex - 1];
  if (!targetCell) {
    return err(`Column ${cellIndex} not found in row ${row} of table ${tableIndex} — it has ${cells.length} cell(s).`);
  }

  if (nodeContainsTag(targetCell, 'tbl')) {
    return err(
      `Row ${row}, column ${cellIndex} of table ${tableIndex} contains a nested table — declining to edit it ` +
        'rather than risk miscounting or corrupting its content.',
    );
  }

  // Image case: always appended into the cell's last paragraph — never a
  // replacement, regardless of whether the cell already has text.
  if (signaturePng !== undefined) {
    const stamp = await prepareSignatureStamp(zip, xml, signaturePng, value);
    if ('error' in stamp) return err(stamp.error);
    const newXml = appendRunXmlIntoCell(xml, targetCell, stamp.insertXml);
    applySignatureZipParts(zip, newXml, signaturePng, stamp);
    const outBytes = await zip.generateAsync({ type: 'nodebuffer' });
    const outPath = writeFillOutput(opts.baseDir, meta.slug, 'docx', outBytes);
    return ok(
      `Stamped ${describeStamp(true, value)} into table ${tableIndex}, row ${row}, column ${cellIndex} of ` +
        `"${meta.slug}". New file at ${outPath} — call send_file to deliver it.`,
    );
  }

  const tNodes = collectDescendants(targetCell, 't');
  const newXml = tNodes.length > 0 ? replaceCellText(xml, tNodes, value!) : insertRunIntoCell(xml, targetCell, value!);

  zip.file('word/document.xml', newXml);
  const outBytes = await zip.generateAsync({ type: 'nodebuffer' });
  const outPath = writeFillOutput(opts.baseDir, meta.slug, 'docx', outBytes);
  return ok(
    `Filled table ${tableIndex}, row ${row}, column ${cellIndex} of "${meta.slug}" with "${value}". New file at ` +
      `${outPath} — call send_file to deliver it.`,
  );
}

// ---------------------------------------------------------------------------
// fill_document_field — .pdf paths (AcroForm field, text-layer line overlay,
// scanned-page pixel overlay), in the priority order row-targeting-matrix.md
// specifies.
// ---------------------------------------------------------------------------

interface PdfLine {
  pageIndex: number; // 0-based
  y: number; // PDF point-space, bottom-left origin
  endX: number; // rightmost extent of the line's existing text, in points
  text: string;
}

const LINE_Y_TOLERANCE_PT = 2;

async function pdfExtractLinesAllPages(filePath: string): Promise<PdfLine[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = getDocument({ data, verbosity: 0 });
  try {
    const doc = await loadingTask.promise;
    const lines: PdfLine[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items: Array<{ x: number; y: number; width: number; str: string }> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const raw of content.items as any[]) {
        if (!('str' in raw) || raw.str === '') continue;
        const transform = raw.transform as number[];
        items.push({ x: transform[4], y: transform[5], width: raw.width ?? 0, str: raw.str });
      }
      page.cleanup();

      items.sort((a, b) => b.y - a.y || a.x - b.x);
      let current: typeof items = [];
      const flush = () => {
        if (current.length === 0) return;
        const text = current
          .map((it) => it.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) {
          lines.push({
            pageIndex: p - 1,
            y: current[0].y,
            endX: Math.max(...current.map((it) => it.x + it.width)),
            text,
          });
        }
        current = [];
      };
      for (const item of items) {
        if (current.length > 0 && Math.abs(current[0].y - item.y) > LINE_Y_TOLERANCE_PT) flush();
        current.push(item);
      }
      flush();
    }
    return lines;
  } finally {
    await loadingTask.destroy();
  }
}

// ---------------------------------------------------------------------------
// Unicode text support for PDF drawing/appearances. StandardFonts.Helvetica
// is a WinAnsi (Latin-1) standard font — pdf-lib throws when asked to draw
// or set field text containing characters outside it (Hebrew, this
// project's actual user's language, included). @pdf-lib/fontkit lets
// pdf-lib embed an arbitrary TrueType/OpenType/WOFF/WOFF2 font instead of a
// standard one; @fontsource/noto-sans-hebrew ships one, but split into
// per-Unicode-range files for web use (a "hebrew" subset with no Latin/
// digits, a separate "latin" subset with no Hebrew) — no single file in it
// covers both scripts. Rather than pull in a second font package, text is
// split into per-script runs and each run is drawn with whichever embedded
// font actually covers it (Helvetica for everything else, the Hebrew
// subset only for the Hebrew runs) — this does not attempt bidi/visual
// reordering, only "don't throw and keep both scripts legible".
// ---------------------------------------------------------------------------

const HEBREW_RANGE = /[\u0590-\u05FF\uFB1D-\uFB4F]/;

let cachedHebrewFontBytes: Buffer | undefined;

function loadHebrewFontBytes(): Buffer {
  if (!cachedHebrewFontBytes) {
    const url = import.meta.resolve('@fontsource/noto-sans-hebrew/files/noto-sans-hebrew-hebrew-400-normal.woff2');
    cachedHebrewFontBytes = fs.readFileSync(fileURLToPath(url));
  }
  return cachedHebrewFontBytes;
}

interface TextFonts {
  latin: PDFFont;
  hebrew?: PDFFont;
}

/** Embeds Helvetica always; the Hebrew-coverage font too, but only when the value being drawn actually needs it. */
async function embedTextFonts(pdfDoc: PDFDocumentType, needsHebrew: boolean): Promise<TextFonts> {
  const { StandardFonts } = await import('pdf-lib');
  const latin = await pdfDoc.embedFont(StandardFonts.Helvetica);
  if (!needsHebrew) return { latin };

  const fontkitModule = await import('@pdf-lib/fontkit');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfDoc.registerFontkit(((fontkitModule as any).default ?? fontkitModule) as any);
  const hebrew = await pdfDoc.embedFont(loadHebrewFontBytes(), { subset: true });
  return { latin, hebrew };
}

/** Splits `text` into maximal runs that are each entirely Hebrew-range or entirely not. */
function splitByScript(text: string): Array<{ text: string; hebrew: boolean }> {
  const runs: Array<{ text: string; hebrew: boolean }> = [];
  let current = '';
  let currentHebrew: boolean | null = null;
  for (const ch of text) {
    const hebrew = HEBREW_RANGE.test(ch);
    if (currentHebrew !== null && hebrew !== currentHebrew) {
      runs.push({ text: current, hebrew: currentHebrew });
      current = '';
    }
    current += ch;
    currentHebrew = hebrew;
  }
  if (current) runs.push({ text: current, hebrew: currentHebrew ?? false });
  return runs;
}

/** Draws `text` at (x, y), switching fonts per script run so a Hebrew run doesn't throw on the Latin-only font. */
function drawUnicodeText(page: PDFPage, text: string, x: number, y: number, size: number, fonts: TextFonts): void {
  let cursorX = x;
  for (const run of splitByScript(text)) {
    const font = run.hebrew && fonts.hebrew ? fonts.hebrew : fonts.latin;
    page.drawText(run.text, { x: cursorX, y, size, font });
    cursorX += font.widthOfTextAtSize(run.text, size);
  }
}

/** AcroForm text-field names, for surfacing alongside a first-call line list/render (priority-1 discovery — AD-1). */
async function getAcroFormTextFieldNames(filePath: string): Promise<string[]> {
  const { PDFDocument, PDFTextField } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.load(fs.readFileSync(filePath));
  const form = pdfDoc.getForm();
  return form
    .getFields()
    .filter((f): f is PDFTextFieldType => f instanceof PDFTextField)
    .map((f) => f.getName());
}

function formatFieldNamesNote(fieldNames: string[]): string {
  if (fieldNames.length === 0) return '';
  return (
    `\n\nThis PDF also has fillable form field(s): ${fieldNames.join(', ')}. Call fill_document_field again with ` +
    '"fieldName" and "value" to fill one of those directly instead, if that\'s a better match than a line/position.'
  );
}

async function pdfListLines(rawPath: string): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  const [lines, fieldNames] = await Promise.all([pdfExtractLinesAllPages(rawPath), getAcroFormTextFieldNames(rawPath)]);
  if (lines.length === 0 && fieldNames.length === 0) {
    return err('No text lines or fillable form fields detected on this PDF to target.');
  }

  // Hoisted once rather than recomputed per line (was an O(n^2) scan inside the .map() below).
  const hasMultiplePages = lines.length > 0 && lines.some((l) => l.pageIndex !== lines[0].pageIndex);
  const linesPart =
    lines.length > 0
      ? `Detected lines:\n${lines
          .map((l, i) => (hasMultiplePages ? `${i + 1}. (page ${l.pageIndex + 1}) ${l.text}` : `${i + 1}. ${l.text}`))
          .join('\n')}\n\nCall fill_document_field again with the same "document", this "lineNumber", and a ` +
        '"value" to draw text right after that line, on the same baseline.'
      : 'No text lines detected on this PDF to target as a line overlay.';

  return ok(linesPart + formatFieldNamesNote(fieldNames));
}

// ---------------------------------------------------------------------------
// Signature stamping, PDF path (Story 1.7) — draws a saved signature PNG
// (from save_signature, Story 1.6) at whichever of the three PDF fill
// targets below the call already resolves to, via pdf-lib's
// embedPng/drawImage. Story 1.8 extends signatureName to .docx/.doc too
// (see fillDocx/fillDocxTextLine's own signaturePng handling and the
// ".docx signature stamping" helpers above) — this section stays PDF-only.
// ---------------------------------------------------------------------------

/**
 * A signature stamped next to a line of ~11pt text shouldn't dominate the
 * page — roughly 3-4 lines of body text tall (Design Notes' 40-50pt
 * ballpark). Only used for the two free-form targets (text-layer line,
 * scanned-page pixel position); the AcroForm target instead fits the image
 * to its own widget rectangle (see pdfFillAcroForm).
 */
const SIGNATURE_MAX_HEIGHT_PT = 45;

/** Horizontal gap (points) between a target's existing content and a stamped image/value — the pre-existing pdfFillLine convention, now shared by all three PDF fill targets. */
const FILL_GAP_PT = 8;

/**
 * Resolves `signatureName` to a saved signature's PNG bytes under
 * `memory/signatures/<name>.png` — exact filename match only, no
 * fuzzy/topic matching (unlike `document`). A path separator can never
 * appear in a name save_signature itself produced (slugify() only emits
 * a-z/0-9/-), so treat one as an automatic miss rather than resolving it
 * against the filesystem at all — signatureName is model-controlled input,
 * same class of risk as save_document's `path` argument.
 */
function resolveSignaturePng(baseDir: string, name: string): { bytes: Buffer } | { error: string } {
  const signaturesDir = path.join(baseDir, 'memory', 'signatures');

  const listAvailable = (): string[] => {
    try {
      return fs
        .readdirSync(signaturesDir)
        .filter((f) => f.toLowerCase().endsWith('.png'))
        .map((f) => f.slice(0, -4));
    } catch {
      return [];
    }
  };

  const notFound = (): { error: string } => {
    const names = listAvailable();
    return {
      error:
        `No saved signature named "${name}". ` +
        (names.length > 0
          ? `Saved signatures: ${names.join(', ')}.`
          : 'No signatures are saved yet — use save_signature first.'),
    };
  };

  if (name.includes('/') || name.includes('\\')) return notFound();

  const filePath = path.join(signaturesDir, `${name}.png`);
  if (!fs.existsSync(filePath)) return notFound();

  try {
    return { bytes: fs.readFileSync(filePath) };
  } catch (e) {
    return { error: `Could not read saved signature "${name}": ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Describes what was stamped, for the ok() confirmation message — "the signature", "the signature and "X"", or just "X". */
function describeStamp(hasSignature: boolean, value: string | undefined): string {
  const signaturePart = hasSignature ? 'the signature' : undefined;
  const valuePart = value !== undefined ? `"${value}"` : undefined;
  return [signaturePart, valuePart].filter(Boolean).join(' and ');
}

async function pdfFillLine(
  rawPath: string,
  meta: DocumentMeta,
  lineNumber: number,
  value: string | undefined,
  signaturePng: Buffer | undefined,
  opts: FillOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  const lines = await pdfExtractLinesAllPages(rawPath);
  const target = lines[lineNumber - 1];
  if (!target) return err(`No line ${lineNumber} found — this document has ${lines.length} detected line(s).`);

  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.load(fs.readFileSync(rawPath));
  const page = pdfDoc.getPages()[target.pageIndex];
  const drawX = target.endX + FILL_GAP_PT;
  if (drawX > page.getWidth()) {
    return err(
      `Line ${lineNumber}'s existing content already reaches the page's right edge — no room to draw ` +
        `${describeStamp(signaturePng !== undefined, value)} after it on the same line.`,
    );
  }

  let cursorX = drawX;
  if (signaturePng !== undefined) {
    const image = await pdfDoc.embedPng(signaturePng);
    const { width, height } = image.scale(SIGNATURE_MAX_HEIGHT_PT / image.height);
    // The anchor-x check above only validates drawX itself (where the
    // *text* draw would start) — a wide-aspect signature scaled to a fixed
    // height can still carry drawX + width past the right edge, or
    // target.y + height past the top, even when drawX alone was fine. The
    // image's full bounding box has to fit inside the page's MediaBox on
    // both axes, or it's declined rather than drawn (partially) off-page.
    if (drawX + width > page.getWidth() || target.y < 0 || target.y + height > page.getHeight()) {
      return err(
        `The signature (${Math.round(width)}x${Math.round(height)}pt) would run off the page's edge if drawn ` +
          `after line ${lineNumber} — no room to place it there.`,
      );
    }
    page.drawImage(image, { x: drawX, y: target.y, width, height });
    cursorX = drawX + width + FILL_GAP_PT;
  }
  if (value !== undefined) {
    const fonts = await embedTextFonts(pdfDoc, HEBREW_RANGE.test(value));
    drawUnicodeText(page, value, cursorX, target.y, 11, fonts);
  }

  const outBytes = Buffer.from(await pdfDoc.save());
  const outPath = writeFillOutput(opts.baseDir, meta.slug, 'pdf', outBytes);
  return ok(
    `Drew ${describeStamp(signaturePng !== undefined, value)} right after line ${lineNumber} ("${target.text}") on ` +
      `"${meta.slug}". New file at ${outPath} — call send_file to deliver it.`,
  );
}

/** Unique render filename per call (mirrors save_document's slug+crc32 pattern) — two concurrent fills on the same document must not clobber each other's render. */
function overlayRenderFileNameFor(slug: string): string {
  const unique = crc32(Buffer.from(`${slug}-${process.hrtime.bigint()}-${Math.random()}`, 'utf-8'))
    .toString(16)
    .padStart(8, '0');
  return `${slug}-overlay-${unique}-p1.png`;
}

async function pdfRenderForOverlay(
  rawPath: string,
  meta: DocumentMeta,
  opts: FillOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  const renderPath = path.join(opts.baseDir, '.document-fills', overlayRenderFileNameFor(meta.slug));
  let dims: { width: number; height: number };
  try {
    dims = await renderFirstPageToPng(rawPath, renderPath);
  } catch (e) {
    return err(`Could not render page for overlay targeting: ${e instanceof Error ? e.message : String(e)}`);
  }
  const fieldNames = await getAcroFormTextFieldNames(rawPath);
  return ok(
    'This PDF has no text layer (scanned/image-only). I rendered page 1 ' +
      `(page 1 only), ${dims.width}x${dims.height}px, to ${renderPath}. Look at it, estimate the pixel position ` +
      '(x,y from the top-left corner) where the value should go, then call fill_document_field again with the ' +
      'same "document", "pixelX", "pixelY", and "value" to complete the fill.' +
      formatFieldNamesNote(fieldNames),
  );
}

async function pdfFillPixel(
  rawPath: string,
  meta: DocumentMeta,
  pixelX: number,
  pixelY: number,
  value: string | undefined,
  signaturePng: Buffer | undefined,
  opts: FillOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.load(fs.readFileSync(rawPath));
  const page = pdfDoc.getPages()[0];
  const { width: pageWidthPts, height: pageHeightPts } = page.getSize();

  // Mirrors renderFirstPageToPng's RENDER_SCALE convention: the rendered PNG
  // is pageSizePts * RENDER_SCALE pixels on each axis (72-DPI-native PDF
  // point space, rendered at RENDER_SCALE pixels per point).
  const imageWidthPx = pageWidthPts * RENDER_SCALE;
  const imageHeightPx = pageHeightPts * RENDER_SCALE;
  if (pixelX < 0 || pixelX > imageWidthPx || pixelY < 0 || pixelY > imageHeightPx) {
    return err(
      `pixelX/pixelY (${pixelX}, ${pixelY}) is outside the rendered page image's bounds ` +
        `(${Math.round(imageWidthPx)}x${Math.round(imageHeightPx)}px) — pick a position within it.`,
    );
  }
  const pdfX = (pixelX / imageWidthPx) * pageWidthPts;
  const pdfY = pageHeightPts - (pixelY / imageHeightPx) * pageHeightPts;

  let cursorX = pdfX;
  if (signaturePng !== undefined) {
    const image = await pdfDoc.embedPng(signaturePng);
    const { width, height } = image.scale(SIGNATURE_MAX_HEIGHT_PT / image.height);
    // Same full-bounding-box check as pdfFillLine — the pixel-position
    // bounds check above only validated the anchor point itself, not the
    // sized image's far edges.
    if (pdfX + width > pageWidthPts || pdfY < 0 || pdfY + height > pageHeightPts) {
      return err(
        `The signature (${Math.round(width)}x${Math.round(height)}pt) would run off the page's edge if drawn at ` +
          'the position you specified — pick a position with more room around it.',
      );
    }
    page.drawImage(image, { x: pdfX, y: pdfY, width, height });
    cursorX = pdfX + width + FILL_GAP_PT;
  }
  if (value !== undefined) {
    const fonts = await embedTextFonts(pdfDoc, HEBREW_RANGE.test(value));
    drawUnicodeText(page, value, cursorX, pdfY, 11, fonts);
  }

  const outBytes = Buffer.from(await pdfDoc.save());
  const outPath = writeFillOutput(opts.baseDir, meta.slug, 'pdf', outBytes);
  return ok(
    `Drew ${describeStamp(signaturePng !== undefined, value)} at the position you specified on "${meta.slug}". ` +
      `New file at ${outPath} — call send_file to deliver it.`,
  );
}

async function pdfFillAcroForm(
  rawPath: string,
  meta: DocumentMeta,
  fieldName: string,
  value: string | undefined,
  signaturePng: Buffer | undefined,
  opts: FillOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  const { PDFDocument, PDFDict } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.load(fs.readFileSync(rawPath));
  const form = pdfDoc.getForm();

  const field = form.getFieldMaybe(fieldName);
  if (!field) {
    const names = form.getFields().map((f) => f.getName());
    return err(
      `No field named "${fieldName}" on this PDF's form. Available fields: ${names.length ? names.join(', ') : '(none)'}`,
    );
  }

  // Shared by both the image and text-value cases: signature stamping
  // reuses the exact same field-type validation the plain text-fill path
  // already relied on, rather than accepting any field type (checkbox/
  // radio/dropdown) and silently picking an arbitrary widget/position off
  // of it.
  let textField: ReturnType<typeof form.getTextField>;
  try {
    textField = form.getTextField(fieldName);
  } catch (e) {
    return err(`Field "${fieldName}" exists but isn't a fillable text field: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (signaturePng !== undefined) {
    // Image case: the field's own widget rectangle is used to size/center
    // the image (scale-to-fit, aspect ratio preserved) — the field's text
    // is left unset (image and text-fill are mutually exclusive for one
    // field in one call, per the frozen Boundaries).
    const widgets = field.acroField.getWidgets();
    if (widgets.length !== 1) {
      return err(
        `Field "${fieldName}" has ${widgets.length} widgets — signature stamping only supports a ` +
          'single-widget text field currently.',
      );
    }
    const widget = widgets[0];
    const rect = widget.getRectangle();
    if (rect.width <= 0 || rect.height <= 0) {
      return err(
        `Field "${fieldName}"'s widget has a degenerate rectangle (${rect.width}x${rect.height}pt) — cannot ` +
          'size an image within it.',
      );
    }

    // Resolve which page the widget is on. The widget's own /P entry is
    // the fast path (populated by pdf-lib itself, and by many PDF
    // producers); a single-page document short-circuits to its only page
    // (the overwhelmingly common case for a saved, simple form); otherwise
    // fall back to scanning each page's /Annots array for a reference that
    // dereferences to this exact widget dict (some producers legally omit
    // /P — see Design Notes). A malformed Annots entry (not itself a
    // dereferenceable dict — legal-but-atypical) is skipped rather than
    // left to throw and surface as a generic top-level error.
    const pages = pdfDoc.getPages();
    let page = pages.find((p) => p.ref === widget.P());
    if (!page && pages.length === 1) page = pages[0];
    if (!page) {
      for (const candidate of pages) {
        const annots = candidate.node.Annots();
        if (!annots) continue;
        for (let i = 0; i < annots.size(); i++) {
          let candidateDict: unknown;
          try {
            candidateDict = annots.lookup(i, PDFDict);
          } catch {
            continue;
          }
          if (candidateDict === widget.dict) {
            page = candidate;
            break;
          }
        }
        if (page) break;
      }
    }
    if (!page) {
      return err(`Could not determine which page field "${fieldName}"'s widget is on — cannot place an image on it.`);
    }

    const image = await pdfDoc.embedPng(signaturePng);
    const { width: imgWidth, height: imgHeight } = image.scaleToFit(rect.width, rect.height);
    const imgX = rect.x + (rect.width - imgWidth) / 2;
    const imgY = rect.y + (rect.height - imgHeight) / 2;
    page.drawImage(image, { x: imgX, y: imgY, width: imgWidth, height: imgHeight });

    if (value !== undefined) {
      const fonts = await embedTextFonts(pdfDoc, HEBREW_RANGE.test(value));
      drawUnicodeText(page, value, imgX + imgWidth + FILL_GAP_PT, imgY, 11, fonts);
    }

    const outBytes = Buffer.from(await pdfDoc.save());
    const outPath = writeFillOutput(opts.baseDir, meta.slug, 'pdf', outBytes);
    return ok(
      `Stamped ${describeStamp(true, value)} into field "${fieldName}" on "${meta.slug}" (field text left unset). ` +
        `New file at ${outPath} — call send_file to deliver it.`,
    );
  }

  if (value === undefined) return err('value or signatureName is required together with fieldName.');

  textField.setText(value);
  const fonts = await embedTextFonts(pdfDoc, HEBREW_RANGE.test(value));
  form.updateFieldAppearances(fonts.hebrew ?? fonts.latin);

  const outBytes = Buffer.from(await pdfDoc.save());
  const outPath = writeFillOutput(opts.baseDir, meta.slug, 'pdf', outBytes);
  return ok(`Filled field "${fieldName}" on "${meta.slug}". New file at ${outPath} — call send_file to deliver it.`);
}

async function fillPdf(
  rawPath: string,
  meta: DocumentMeta,
  args: Record<string, unknown>,
  opts: FillOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  const fieldName = typeof args.fieldName === 'string' ? args.fieldName : undefined;
  const value = typeof args.value === 'string' ? args.value : undefined;
  const lineNumber = typeof args.lineNumber === 'number' ? args.lineNumber : undefined;
  const pixelX = typeof args.pixelX === 'number' ? args.pixelX : undefined;
  const pixelY = typeof args.pixelY === 'number' ? args.pixelY : undefined;
  const signatureNameRaw = typeof args.signatureName === 'string' ? args.signatureName : undefined;
  const signatureName = signatureNameRaw?.trim();
  if (signatureNameRaw !== undefined && !signatureName) return err('signatureName cannot be empty.');

  // Resolved once here (Code Map), regardless of which target branch below
  // ends up being picked — a "no target given" discovery call still gets
  // this validated up front, but its response is otherwise unmodified (the
  // resolved bytes are simply unused on that path).
  let signaturePng: Buffer | undefined;
  if (signatureName !== undefined) {
    const resolved = resolveSignaturePng(opts.baseDir, signatureName);
    if ('error' in resolved) return err(resolved.error);
    signaturePng = resolved.bytes;
  }

  // Priority 1: AcroForm field — if fieldName is given at all, this is the
  // only path tried; a mismatch is a clear error, never a silent fall
  // through to the overlay paths. (When fieldName is NOT given, the
  // "first call" branches below still surface any AcroForm field names
  // they find, so the caller can discover and use this path next time —
  // see getAcroFormTextFieldNames/formatFieldNamesNote.)
  if (fieldName !== undefined) {
    if (value === undefined && signaturePng === undefined) {
      return err('value or signatureName is required together with fieldName.');
    }
    return pdfFillAcroForm(rawPath, meta, fieldName, value, signaturePng, opts);
  }

  let pdfText: string;
  try {
    pdfText = await extractPdfText(rawPath);
  } catch (e) {
    return err(`Could not read PDF: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Priority 2: text layer with no matching field requested — line overlay.
  if (hasTextLayer(pdfText)) {
    if (lineNumber === undefined) return pdfListLines(rawPath);
    if (value === undefined && signaturePng === undefined) {
      return err('value or signatureName is required together with lineNumber.');
    }
    return pdfFillLine(rawPath, meta, lineNumber, value, signaturePng, opts);
  }

  // Priority 3: no text layer at all — scanned-page pixel overlay.
  if (pixelX === undefined || pixelY === undefined) return pdfRenderForOverlay(rawPath, meta, opts);
  if (value === undefined && signaturePng === undefined) {
    return err('value or signatureName is required together with pixelX/pixelY.');
  }
  return pdfFillPixel(rawPath, meta, pixelX, pixelY, value, signaturePng, opts);
}

// ---------------------------------------------------------------------------
// fill_document_field — .doc path. There's no practical way to edit the
// legacy binary format directly, so a saved `.doc` is converted to `.docx`
// once via headless LibreOffice, into a throwaway scratch directory, and
// the resulting file is handed to the *existing*, completely unmodified
// fillDocx() — the entire table-row/text-line fill pipeline is reused as-is
// (Story 1.2/1.4). Output is always `.docx`; the original `.doc` is never
// touched or reconstructed.
// ---------------------------------------------------------------------------

const DOC_CONVERSION_NOTE =
  ' (This was a legacy .doc file — converted to .docx to make it editable. The returned file is .docx, not a ' +
  'reconstructed .doc.)';

/**
 * Every successful fill path (table row, text line, PDF field/line/pixel —
 * see fillDocxTextLine/fillDocx/pdfFillLine/pdfFillPixel/pdfFillAcroForm)
 * writes this exact marker into its ok() text. Reused here, rather than a
 * new convention, to tell a *completed* fill apart from a discovery/
 * candidate-list/ambiguous-table prompt — the only kind of response the
 * .doc-origin disclosure below is ever allowed to attach to.
 */
const FILL_SUCCESS_MARKER = 'New file at ';

const SUBPROCESS_OUTPUT_TAIL_CHARS = 500;

/** Truncates captured subprocess output to a readable tail for an error message — the full buffer could be arbitrarily large or noisy. */
function tailOf(buf: unknown): string {
  if (!buf) return '';
  const text = Buffer.isBuffer(buf) ? buf.toString('utf-8') : String(buf);
  const trimmed = text.trim();
  return trimmed.length > SUBPROCESS_OUTPUT_TAIL_CHARS ? `…${trimmed.slice(-SUBPROCESS_OUTPUT_TAIL_CHARS)}` : trimmed;
}

/**
 * Builds the argv for a headless LibreOffice conversion. Exported and
 * reused (with a different target format) by this file's own test fixture
 * builder (`buildDocViaSoffice` in documents.test.ts) — a single source of
 * truth for the flag set, so a future flag change can't silently drift the
 * production invocation and the test fixture's invocation apart.
 */
export function sofficeConvertArgs(inputPath: string, targetFormat: string, outDir: string, profileDir: string): string[] {
  return [
    '--headless',
    '--norestore',
    `-env:UserInstallation=file://${profileDir}`,
    '--convert-to',
    targetFormat,
    '--outdir',
    outDir,
    inputPath,
  ];
}

/**
 * Converts `rawPath` (a .doc) to .docx via `soffice --headless --convert-to
 * docx`, into a fresh, isolated scratch directory. Each call gets its own
 * `-env:UserInstallation` profile directory — headless LibreOffice takes an
 * exclusive lock on its user profile, so two concurrent conversions sharing
 * one profile would collide; a unique per-call profile avoids that
 * lock-file conflict entirely rather than needing any retry/queueing logic.
 */
function convertDocToDocx(rawPath: string, scratchDir: string): { path: string } | { error: string } {
  const profileDir = path.join(scratchDir, 'profile');

  // Scratch-space setup gets its own try/catch — a disk-full/permissions
  // failure here must produce a clear, .doc-conversion-specific error
  // (and get logged, per every other extraction failure in this file),
  // not fall through to fillDoc's/fillDocumentFieldImpl's generic
  // catch-all with no trace of what actually happened.
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (e) {
    const error = `Could not prepare scratch space for .doc conversion: ${e instanceof Error ? e.message : String(e)}`;
    log(`.doc conversion failed for ${rawPath}: ${error}`);
    return { error };
  }

  try {
    execFileSync('soffice', sofficeConvertArgs(rawPath, 'docx', scratchDir, profileDir), {
      timeout: DOC_TIMEOUT_MS,
      stdio: 'pipe',
    });
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') {
      const error =
        'LibreOffice (soffice) is not installed in this container — cannot convert a legacy .doc file for ' +
        'filling.';
      log(`.doc conversion failed for ${rawPath}: ${error}`);
      return { error };
    }

    // execFileSync populates .stdout/.stderr on the thrown error when stdio
    // is 'pipe' (as here) — the real LibreOffice diagnostic (e.g. "source
    // file could not be loaded") lives there, not in e.message, which is
    // just Node's generic "Command failed" wrapper.
    const errObj = e as { killed?: boolean; signal?: string | null; stdout?: unknown; stderr?: unknown };
    const isTimeout = Boolean(errObj?.killed || errObj?.signal);
    const output = [tailOf(errObj?.stderr), tailOf(errObj?.stdout)].filter(Boolean).join(' | ');
    const outputSuffix = output ? ` LibreOffice output: ${output}` : '';
    const error = isTimeout
      ? `.doc conversion timed out after ${DOC_TIMEOUT_MS}ms.${outputSuffix}`
      : `Could not convert .doc to .docx: ${e instanceof Error ? e.message : String(e)}.${outputSuffix}`;
    log(`.doc conversion failed for ${rawPath}: ${error}`);
    return { error };
  }

  const convertedName = `${path.basename(rawPath, path.extname(rawPath))}.docx`;
  const convertedPath = path.join(scratchDir, convertedName);
  if (!fs.existsSync(convertedPath)) {
    const error = 'LibreOffice did not produce a converted .docx — the source .doc may be corrupted or unsupported.';
    log(`.doc conversion failed for ${rawPath}: ${error}`);
    return { error };
  }
  return { path: convertedPath };
}

/**
 * The .doc-origin disclosure only belongs on a response that represents an
 * actually-completed fill (a new file was written — see FILL_SUCCESS_MARKER
 * above). A bare-discovery response, a "row is required" / table-count
 * prompt, or an ambiguous-slug clarification never wrote a file at all, so
 * appending "converted to .docx" to one of those would be a factually wrong
 * claim about work that didn't happen.
 */
function withDocConversionNote(
  result: ReturnType<typeof ok> | ReturnType<typeof err>,
): ReturnType<typeof ok> | ReturnType<typeof err> {
  if ('isError' in result && result.isError) return result;
  const text = result.content[0]?.text;
  if (typeof text !== 'string' || !text.includes(FILL_SUCCESS_MARKER)) return result;
  return ok(`${text}${DOC_CONVERSION_NOTE}`);
}

async function fillDoc(
  rawPath: string,
  meta: DocumentMeta,
  args: Record<string, unknown>,
  opts: FillOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  // A true ephemeral os.tmpdir() location, NOT opts.baseDir (the agent
  // group's *persistent* memory volume) — a container death mid-conversion
  // (OOM, host restart) must never orphan a scratch dir (including the
  // LibreOffice profile) permanently in durable storage the way it would
  // if this lived under baseDir. The finally below still cleans up the
  // normal path; os.tmpdir() only changes where an *abandoned* one ends up.
  // crypto.randomUUID() (rather than Date.now()+Math.random()) rules out
  // any realistic collision between concurrent fills on the same document.
  const scratchDir = path.join(os.tmpdir(), 'nanoclaw-doc-conversion', crypto.randomUUID());
  try {
    const converted = convertDocToDocx(rawPath, scratchDir);
    if ('error' in converted) return err(converted.error);
    const result = await fillDocx(converted.path, meta, args, opts);
    return withDocConversionNote(result);
  } finally {
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      // Best effort — a leftover scratch dir is harmless, never blocks the response.
    }
  }
}

// `lineNumber` is a shared arg (Story 1.4 adds it to .docx text-line targeting, alongside
// its pre-existing Story 1.2 use for a .pdf text-layer line) — it belongs in neither
// file-type-exclusive list below. `signatureName` used to be PDF-only (Story 1.7); Story
// 1.8 extends it to .docx/.doc too, so it no longer belongs in either exclusive list.
const DOCX_ONLY_ARGS = ['table', 'row', 'column'] as const;
const PDF_ONLY_ARGS = ['fieldName', 'pixelX', 'pixelY'] as const;

function presentArgNames(args: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.filter((k) => args[k] !== undefined);
}

export async function fillDocumentFieldImpl(
  args: Record<string, unknown>,
  opts: FillOpts,
): Promise<ReturnType<typeof ok> | ReturnType<typeof err>> {
  try {
    const documentQueryRaw = typeof args.document === 'string' ? args.document : undefined;
    const documentQuery = documentQueryRaw?.trim();
    if (!documentQuery) return err('document is required — the saved document\'s name/slug/topic to fill.');

    const documentsDir = path.join(opts.baseDir, 'memory', 'documents');
    const filesDir = path.join(documentsDir, 'files');
    const resolution = resolveDocument(documentsDir, filesDir, documentQuery);

    if (resolution.kind === 'not-found') {
      log(`fill_document_field: no match for document "${documentQuery}"`);
      return err(`No saved document matches "${documentQuery}".`);
    }
    if (resolution.kind === 'candidates') {
      log(`fill_document_field: ${resolution.metas.length} candidates for document "${documentQuery}"`);
      return ok(
        `Multiple saved documents match "${documentQuery}":\n${formatDocumentCandidates(resolution.metas)}\n\n` +
          'Call fill_document_field again with the exact slug (first column) to pick one.',
      );
    }

    const meta = resolution.meta;
    if (meta.ambiguousExtensions) {
      return err(
        `Multiple files found for document "${meta.slug}" (${meta.ambiguousExtensions.join(', ')}) — this ` +
          'shouldn\'t normally happen. Check memory/documents/files/ for this slug manually before retrying.',
      );
    }

    if (IMAGE_EXTENSIONS.has(meta.ext)) {
      return err(
        `"${meta.slug}" is a saved image (.${meta.ext}) — fill_document_field only fills/stamps a .docx, .doc, ` +
          'or .pdf document. There is no field/target to fill on a plain image.',
      );
    }

    if (meta.ext === 'pdf') {
      const wrongArgs = presentArgNames(args, DOCX_ONLY_ARGS);
      if (wrongArgs.length > 0) {
        return err(`These arguments don't apply to a .pdf document: ${wrongArgs.join(', ')}.`);
      }
    } else {
      const wrongArgs = presentArgNames(args, PDF_ONLY_ARGS);
      if (wrongArgs.length > 0) {
        return err(`These arguments don't apply to a .${meta.ext} document: ${wrongArgs.join(', ')}.`);
      }
    }

    const rawPath = path.join(filesDir, `${meta.slug}.${meta.ext}`);
    if (!fs.existsSync(rawPath)) return err(`Saved raw file for "${meta.slug}" is missing.`);

    const result =
      meta.ext === 'docx'
        ? await fillDocx(rawPath, meta, args, opts)
        : meta.ext === 'doc'
          ? await fillDoc(rawPath, meta, args, opts)
          : await fillPdf(rawPath, meta, args, opts);
    log(`fill_document_field: ${meta.slug} (${meta.ext}) -> ${'isError' in result && result.isError ? 'error' : 'ok'}`);
    return result;
  } catch (e) {
    return err(`fill_document_field failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const fillDocumentField: McpToolDefinition = {
  tool: {
    name: 'fill_document_field',
    description:
      'Fill a value into a named target in a document already saved via save_document, and produce a new file ' +
      "(the stored copy is never modified) — call send_file with the returned path to deliver it. For a .docx " +
      "with a table: targets a table row (table/row, column optional — defaults to the row's last cell) — this " +
      'always wins over line targeting when row/table is given. For a .docx with no table (or when you give ' +
      'lineNumber instead of row): targets a plain paragraph\'s fill-in-the-blank line — an underscore blank or ' +
      'a trailing-colon label — a first call with neither row nor lineNumber returns a discovery response ' +
      '(the detected blank lines, the table-row prompt, or both if the document has both a table and non-table ' +
      'blanks). Never pass row/table together with lineNumber. For a .pdf: targets an AcroForm field (fieldName) ' +
      'if the PDF has one matching, otherwise a text-layer line (a first call with no lineNumber returns the ' +
      'detected lines to choose from) or, for a scanned PDF, a pixel position on a rendered page (a first call ' +
      'with no pixelX/pixelY renders page 1 and returns its pixel dimensions). For any file type, "signatureName" ' +
      '(instead of, or together with, "value") stamps a signature already saved via save_signature at whichever ' +
      'target the call resolves to — for a .pdf: image only for the AcroForm case (the field\'s text is left ' +
      'unset), image plus text beside it if "value" is also given for the line/pixel cases; for a .docx: the ' +
      'image is always an additional inserted run (never a replacement) at the same table-cell or ' +
      'fill-in-the-blank-line target row/lineNumber would otherwise resolve, with an additional text run right ' +
      'after it if "value" is also given. For a legacy .doc: converts it to ' +
      '.docx once (via LibreOffice), then applies the same .docx targeting rules above — the returned file is ' +
      'always .docx, never a reconstructed .doc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        document: {
          type: 'string',
          description: 'Name/slug/topic of the saved document to fill (same matching as list_documents).',
        },
        value: {
          type: 'string',
          description: 'The value to write. Required on the call that actually performs the fill.',
        },
        table: {
          type: 'integer',
          description: '.docx only: 1-indexed table number. Optional if the document has exactly one table.',
        },
        row: {
          type: 'integer',
          description:
            '.docx only: 1-indexed row number within the target table. Give this (or table) to fill a table ' +
            'row. Mutually exclusive with lineNumber for a .docx — passing both is an error. Omit both row and ' +
            'lineNumber to get a discovery response: the "row is required" prompt if the document has a table, ' +
            'the detected fill-in-the-blank line list if it has no table, or both (naming either option) if it ' +
            'has a table AND non-table blank paragraphs.',
        },
        column: {
          type: 'integer',
          description:
            '.docx only: 1-indexed column (cell) within the target row. Defaults to the last cell. Requires row ' +
            '(or table) — an error if given without either, since it only applies to table-row targeting.',
        },
        fieldName: {
          type: 'string',
          description: '.pdf only: an AcroForm field name to fill directly, no page redraw.',
        },
        lineNumber: {
          type: 'integer',
          description:
            '1-indexed line (from a prior discovery call\'s numbered list) — for a .pdf text-layer, draws the ' +
            'value after that line on the same baseline; for a .docx, fills that fill-in-the-blank paragraph\'s ' +
            'underscore run (each blank in a paragraph is its own numbered line) or trailing-colon label. ' +
            'Mutually exclusive with row/table for a .docx — passing both is an error.',
        },
        pixelX: {
          type: 'number',
          description: '.pdf, scanned only: x pixel position (from top-left) on the rendered page-1 image.',
        },
        pixelY: {
          type: 'number',
          description: '.pdf, scanned only: y pixel position (from top-left) on the rendered page-1 image.',
        },
        signatureName: {
          type: 'string',
          description:
            'The exact name of a signature already saved via save_signature (matches ' +
            'memory/signatures/<name>.png exactly — no fuzzy matching). Works for .pdf, .docx, and .doc. Stamps ' +
            'that signature image at whichever of fieldName/lineNumber/pixelX+pixelY (.pdf) or row+table/' +
            'lineNumber (.docx/.doc) the call resolves to — for a .docx/.doc this is always an additional ' +
            'inserted image, never a replacement of existing cell/paragraph text. Give "value" alongside it to ' +
            'also draw/insert a text run (e.g. a date) right beside/after the image in the same call.',
        },
      },
      required: ['document'],
    },
  },
  handler: (args) => fillDocumentFieldImpl(args, { baseDir: '/workspace/agent' }),
};

export const saveDocument: McpToolDefinition = {
  tool: {
    name: 'save_document',
    description:
      "Save a Word (.docx or legacy .doc), PDF, or image (.jpg/.jpeg/.png) file to this agent group's persistent " +
      "memory: copies the raw file, extracts its text (a scanned/image-only PDF's page 1 is OCR'd automatically " +
      '(English and Hebrew) in the same call; a plain image asks you to read it yourself and call back with ' +
      'extractedText — and so does a scanned PDF in the rare case OCR finds little to no readable text), and ' +
      'records an entry in memory/index.md so it can be recalled later without resending it. Declines cleanly ' +
      'for any other file type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'Path to the file, as shown in the [<type>: name — saved to /workspace/inbox/...] line. Give the ' +
            'part after /workspace/, e.g. "inbox/<msgId>/name.pdf" (an absolute path also works, but must ' +
            'resolve inside /workspace/inbox).',
        },
        extractedText: {
          type: 'string',
          description:
            'Only used on a follow-up call: for a plain image, the text you read yourself from it; for a ' +
            'scanned PDF whose page-1 OCR came back with little to no readable text, either the text you read ' +
            'yourself from the still-present render, or "" to accept a placeholder note instead — after a prior ' +
            'save_document call on the same path asked you to read/decide and call back.',
        },
      },
      required: ['path'],
    },
  },
  handler: (args) => saveDocumentImpl(args, { baseDir: '/workspace/agent', workspaceRoot: '/workspace' }),
};

registerTools([saveDocument, listDocuments, fillDocumentField, saveSignature]);
