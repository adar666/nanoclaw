/**
 * save_document — persist a Word (.docx) or PDF attachment to the agent
 * group's durable per-group memory (see docs/memory.md's OKF convention),
 * so a later, unrelated conversation can be answered from it without the
 * file being resent.
 *
 * All work runs synchronously in-container, in the same MCP tool call
 * (no host round-trip — this needs no external API/credential):
 *
 *   - `.pdf` with a text layer: `pdfjs-dist` extracts the text directly.
 *   - `.pdf` with no text layer (scanned/image-only): `@hyzyla/pdfium`
 *     renders page 1 (page 1 only — later pages are not captured) to a PNG
 *     and the tool asks the *agent's own* multimodal turn to read it —
 *     never a tool-embedded OCR call. The agent reads the image (its own
 *     Read tool) and calls `save_document` again on the same path with an
 *     `extractedText` argument to finish.
 *   - `.docx`: text is pulled out of `word/document.xml` (body paragraphs
 *     only — headers, footers, footnotes, and text boxes are not read) by
 *     shelling out to the `unzip` CLI (already in the base image for other
 *     purposes) and stripping the OOXML markup with a small regex-based
 *     reader — no new zip dependency for this story (`jszip`/`pdf-lib` are
 *     Story 1.2's, needed only for *writing* back into a document).
 *
 * Only `.docx` and `.pdf` are in scope; anything else is declined cleanly
 * with no memory footprint at all.
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
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

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

const SUPPORTED_EXTENSIONS = new Set(['docx', 'pdf']);

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

export function uniqueSlug(documentsDir: string, filename: string): string {
  const base = slugify(filename);
  let candidate = base;
  let n = 2;
  while (fs.existsSync(path.join(documentsDir, `${candidate}.md`))) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
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
// pulling it in). The agent's own multimodal turn reads the image; this
// tool never does OCR itself (AD-4).
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
        `Unsupported file type "${ext ? `.${ext}` : '(none)'}" — save_document only handles Word (.docx) ` +
          'and PDF (.pdf) files.',
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
          let dims: { width: number; height: number };
          try {
            dims = await renderFirstPageToPng(resolvedPath, renderPath);
          } catch (e) {
            return err(`Could not render scanned PDF page: ${e instanceof Error ? e.message : String(e)}`);
          }
          return ok(
            'This PDF has no extractable text layer (scanned/image-only). ' +
              `I rendered page 1 (page 1 only — later pages are not captured), ${dims.width}x${dims.height}px, ` +
              `to ${renderPath}. Read that image yourself, then call save_document again with the same path ` +
              `("${filePath}") and an "extractedText" argument containing what you read, to finish saving this ` +
              'document to memory.',
          );
        }

        bodyText = extractedText;
        renderPathToCleanup = renderPath;
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

export const saveDocument: McpToolDefinition = {
  tool: {
    name: 'save_document',
    description:
      "Save a Word (.docx) or PDF file to this agent group's persistent memory: copies the raw file, " +
      'extracts its text, and records an entry in memory/index.md so it can be recalled later without ' +
      'resending it. Declines cleanly for any other file type.',
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
            'Only used on a follow-up call: the text you read yourself from a rendered page image after a prior ' +
            'save_document call on the same path asked you to read one and call back.',
        },
      },
      required: ['path'],
    },
  },
  handler: (args) => saveDocumentImpl(args, { baseDir: '/workspace/agent', workspaceRoot: '/workspace' }),
};

registerTools([saveDocument]);
