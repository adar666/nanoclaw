import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

import { PNG } from 'pngjs';

import type JSZipType from 'jszip';

import {
  slugify,
  docxXmlToText,
  saveDocumentImpl,
  saveDocument,
  listDocumentsImpl,
  listDocuments,
  fillDocumentFieldImpl,
  fillDocumentField,
  fillDocumentFieldBatchImpl,
  fillDocumentFieldBatch,
  sofficeConvertArgs,
  saveSignatureImpl,
  saveSignature,
  listDocumentVersionsImpl,
  listDocumentVersions,
  describePdfReadError,
  withLock,
  ocrPngText,
  ensureOcrLangData,
} from './documents.js';

// ---------------------------------------------------------------------------
// tesseract.js mock (spec-2-1) — real OCR needs network access on first use
// (fetches `eng.traineddata` from a CDN, per documents.ts's `ocrPngText`
// comment) and takes real wall-clock time even once cached, neither of which
// belongs in this suite. tesseract.js is a dependency added specifically for
// `documents.ts`'s scanned-PDF OCR path and has no other consumer anywhere
// in this codebase (verified), so mocking its module here for the whole test
// process is safe — no other test file relies on the real implementation.
// `documents.ts` only ever imports it dynamically (`await import('tesseract
// .js')`) inside `ocrPngText`, so this mock just needs to be registered
// before that call happens at runtime, not before documents.ts's own
// (static) import at the top of this file.
//
// `mockOcrResult` is mutable, set per test before calling saveDocumentImpl,
// and reset to a safe default in beforeEach below. `lastCreateWorkerCall`
// captures the args documents.ts's `ocrPngText` actually passed to
// `createWorker`, so a test can assert the Bun-specific workerPath/cachePath
// wiring is real rather than just trusting an ignored mock call — a broken
// computation there would otherwise still show a fully green suite.
// ---------------------------------------------------------------------------

let mockOcrResult: { text: string } | { error: string } = { text: '' };
let lastCreateWorkerCall:
  | { langs: unknown; oem: unknown; options: { workerPath?: string; cachePath?: string } }
  | undefined;

// Concurrency instrumentation for the withOcrCacheDirLock regression test
// below (deferred-work.md, ocr-fallback item) — `createWorkerDelayMs` lets a
// test hold createWorker "in flight" long enough for a second concurrent
// call to genuinely overlap if the lock didn't exist;
// `maxConcurrentCreateWorkerCalls` records the real high-water mark. Both
// reset to their neutral defaults in beforeEach below so they never leak
// into an unrelated test.
let createWorkerDelayMs = 0;
let activeCreateWorkerCalls = 0;
let maxConcurrentCreateWorkerCalls = 0;
// Makes createWorker() itself throw (rather than the later recognize()
// call) — used only to test that withOcrCacheDirLock's chain doesn't get
// permanently wedged by a failing call.
let createWorkerShouldThrow: string | undefined;

mock.module('tesseract.js', () => ({
  createWorker: async (langs: unknown, oem: unknown, options: { workerPath?: string; cachePath?: string }) => {
    lastCreateWorkerCall = { langs, oem, options };
    activeCreateWorkerCalls++;
    maxConcurrentCreateWorkerCalls = Math.max(maxConcurrentCreateWorkerCalls, activeCreateWorkerCalls);
    if (createWorkerDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, createWorkerDelayMs));
    }
    activeCreateWorkerCalls--;
    if (createWorkerShouldThrow !== undefined) {
      throw new Error(createWorkerShouldThrow);
    }
    return {
      recognize: async () => {
        if ('error' in mockOcrResult) throw new Error(mockOcrResult.error);
        return { data: { text: mockOcrResult.text, confidence: mockOcrResult.text.trim() ? 90 : 0 } };
      },
      terminate: async () => {},
    };
  },
}));

// ---------------------------------------------------------------------------
// Test fixtures — hand-rolled, dependency-free builders so these tests don't
// need jszip/pdf-lib (excluded from this story) or a system `zip` binary
// (only `unzip`, already in the base image, is assumed available).
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

/** Minimal valid ZIP archive, "stored" (uncompressed) entries only. */
function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    const localEntry = Buffer.concat([localHeader, nameBuf, data]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([centralHeader, nameBuf]));

    offset += localEntry.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function buildDocx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`)
    .join('');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`;
  return buildStoredZip([{ name: 'word/document.xml', data: Buffer.from(documentXml, 'utf-8') }]);
}

function escapePdfString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Minimal, byte-accurate single-page PDF. `text` null => blank page (no text layer). */
function buildMinimalPdf(text: string | null): Buffer {
  const catalog = '<< /Type /Catalog /Pages 2 0 R >>';
  const pages = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  const page =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ' +
    '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';
  const streamContent = text ? `BT /F1 18 Tf 20 100 Td (${escapePdfString(text)}) Tj ET` : '';
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  const parts: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [0];
  let cursor = parts[0].length;

  function pushObj(num: number, body: string): void {
    offsets[num] = cursor;
    const s = `${num} 0 obj\n${body}\nendobj\n`;
    parts.push(s);
    cursor += s.length;
  }

  pushObj(1, catalog);
  pushObj(2, pages);
  pushObj(3, page);
  pushObj(4, `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`);
  pushObj(5, font);

  const xrefOffset = cursor;
  const total = 6;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  parts.push(xref, `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return Buffer.from(parts.join(''), 'latin1');
}

/**
 * A PDF with one page per entry in `pages`: a string draws real text (a
 * genuine text layer, via pdf-lib's own drawText/embedFont — the same
 * pattern `buildTextPdfWithAcroForm` below already uses and already proven
 * to extract cleanly via pdfjs-dist); `null` leaves the page completely
 * blank — no content-stream text at all, so pdfjs-dist's getTextContent()
 * legitimately returns nothing for it, the same "needs OCR" signal a real
 * scanned page gives, without needing an actual embedded raster image for
 * these tests to exercise save_document's render+OCR fallback per page
 * (`buildMultiPageAcroFormPdf` further below already relies on this same
 * blank-page-means-no-text-layer property for its own page 1).
 */
async function buildMultiPagePdf(pages: Array<string | null>): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = pdfDoc.addPage([200, 200]);
    if (text) page.drawText(text, { x: 20, y: 150, size: 14, font });
  }
  return Buffer.from(await pdfDoc.save());
}

/**
 * A white canvas with an optional solid-color ink rectangle — pngjs is
 * already this story's real dependency (production decode/encode both go
 * through it), so building the fixture with it is a real PNG, not a second
 * hand-rolled encoder duplicating encodePng's byte-level work for no
 * verification benefit.
 */
function buildSignaturePng(opts: {
  width: number;
  height: number;
  ink?: { x: number; y: number; w: number; h: number; color?: [number, number, number] };
}): Buffer {
  const { width, height, ink } = opts;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (width * y + x) << 2;
      const isInk = !!ink && x >= ink.x && x < ink.x + ink.w && y >= ink.y && y < ink.y + ink.h;
      const [r, g, b] = isInk ? (ink!.color ?? [0, 0, 0]) : [255, 255, 255];
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function pngChunkForTest(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * A PNG with a degenerate IHDR width (0px) — not producible via pngjs' own
 * encoder (buildSignaturePng above), which never emits a zero dimension,
 * but a byte-valid-enough stream for pngjs' *decoder* to accept (verified:
 * width 0 with any height > 0 decodes cleanly; a 0 *height* instead trips
 * pngjs' own inflate-size validation before ever reaching our own guard, so
 * this only exercises the width axis — sufficient to reach and confirm the
 * production `dims.width <= 0 || dims.height <= 0` check, since either half
 * of that OR is equally reachable from a real-world degenerate/corrupted
 * source). Mirrors the hand-rolled PNG chunk writer `encodePng` in the
 * production file, needed here since buildSignaturePng can't produce this
 * shape at all.
 */
function buildDegeneratePng(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method
  const ihdr = pngChunkForTest('IHDR', ihdrData);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const idat = pngChunkForTest('IDAT', zlib.deflateSync(raw));
  const iend = pngChunkForTest('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

// ---------------------------------------------------------------------------
// soffice (LibreOffice) availability — the .doc conversion path (fill_document_
// field on a saved .doc) and any test that needs a *real* .doc fixture (there's
// no hand-rollable minimal .doc the way buildDocx/buildMinimalPdf hand-roll a
// minimal zip/PDF — .doc is a full OLE2/Compound File Binary structure) both
// depend on the real `soffice` subprocess, which this `bun test` sandbox does
// not have installed. Every test that shells out to it is gated on this check
// and skips cleanly rather than failing the suite (spec requirement).
// ---------------------------------------------------------------------------

function isSofficeAvailable(): boolean {
  try {
    execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const SOFFICE_AVAILABLE = isSofficeAvailable();

/**
 * Builds a real, on-disk .doc file by handing LibreOffice a plain-text
 * source and converting it — the "throwaway .doc via LibreOffice itself"
 * bootstrap the spec's Design Notes call out, avoided for anything more
 * elaborate than a text file because getting LibreOffice to accept a
 * hand-rolled/minimal .docx as *input* isn't reliable (it needs a real
 * OPC package, not just a bare word/document.xml). A plain-text source
 * converted through Writer's "MS Word 97" filter preserves each line as
 * its own paragraph verbatim (including a literal run of underscores),
 * which is exactly what the .doc text-line fill path needs to detect.
 *
 * Reuses `sofficeConvertArgs` (the exact argv-builder `convertDocToDocx`
 * itself calls in production) rather than a second, hand-copied flag list —
 * a future flag change to the production invocation can't silently leave
 * this fixture builder behind.
 */
function buildDocViaSoffice(workDir: string, lines: string[]): Buffer {
  const txtPath = path.join(workDir, 'source.txt');
  fs.writeFileSync(txtPath, lines.join('\n'), 'utf-8');
  const outDir = path.join(workDir, 'converted');
  fs.mkdirSync(outDir, { recursive: true });
  const profileDir = path.join(workDir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  execFileSync('soffice', sofficeConvertArgs(txtPath, 'doc', outDir, profileDir), { timeout: 30_000, stdio: 'pipe' });
  return fs.readFileSync(path.join(outDir, 'source.doc'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpRoot: string;
let baseDir: string;
let inboxDir: string;

// ensureOcrLangData (deferred-work.md, checksum-pin item, 2026-08-28) checks
// `${cacheDir}/${lang}.traineddata` before ever touching the network — pre-
// seeding both files with dummy content makes every test below hit that
// already-cached short-circuit, exactly like a real install's second-and-
// later OCR call would, with zero network dependency and no need to fake a
// real checksum match. `ensureOcrLangData` itself is unit-tested directly,
// separately, against a real fetch mock (see its own describe block).
function seedOcrCache(cacheDir: string): void {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'eng.traineddata'), 'fake-eng-traineddata');
  fs.writeFileSync(path.join(cacheDir, 'heb.traineddata'), 'fake-heb-traineddata');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'save-document-test-'));
  baseDir = path.join(tmpRoot, 'agent');
  inboxDir = path.join(tmpRoot, 'inbox', 'msg1');
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
  seedOcrCache(path.join(baseDir, '.ocr-cache'));
  mockOcrResult = { text: '' };
  lastCreateWorkerCall = undefined;
  createWorkerDelayMs = 0;
  activeCreateWorkerCalls = 0;
  maxConcurrentCreateWorkerCalls = 0;
  createWorkerShouldThrow = undefined;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeInboxFile(name: string, data: Buffer): string {
  const p = path.join(inboxDir, name);
  fs.writeFileSync(p, data);
  return p;
}

function opts(): { baseDir: string; workspaceRoot: string } {
  return { baseDir, workspaceRoot: tmpRoot };
}

describe('slugify', () => {
  it('lowercases, kebab-cases, and strips the extension', () => {
    expect(slugify('Q3 Report.pdf')).toBe('q3-report');
    expect(slugify('My_File Name.docx')).toBe('my-file-name');
  });

  it('falls back to "document" when nothing alphanumeric survives', () => {
    expect(slugify('___.pdf')).toBe('document');
  });
});

describe('docxXmlToText', () => {
  it('extracts text from paragraphs, merging fragmented runs, joined by newlines', () => {
    const xml =
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> World</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    expect(docxXmlToText(xml)).toBe('Hello World\nSecond paragraph');
  });

  it('decodes XML entities', () => {
    const xml = '<w:document><w:body><w:p><w:r><w:t>Tom &amp; Jerry &lt;3&gt;</w:t></w:r></w:p></w:body></w:document>';
    expect(docxXmlToText(xml)).toBe('Tom & Jerry <3>');
  });
});

describe('save_document tool metadata', () => {
  it('declares path as required', () => {
    expect(saveDocument.tool.name).toBe('save_document');
    expect(saveDocument.tool.inputSchema).toMatchObject({ required: ['path'] });
  });
});

describe('save_document — happy path, docx', () => {
  it('saves the file, extracts text, writes concept file + index line', async () => {
    const filePath = writeInboxFile('report.docx', buildDocx(['Hello World', 'Second paragraph']));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();

    const rawFile = path.join(baseDir, 'memory', 'documents', 'files', 'report.docx');
    expect(fs.existsSync(rawFile)).toBe(true);
    expect(fs.readFileSync(rawFile).equals(fs.readFileSync(filePath))).toBe(true);

    const conceptFile = path.join(baseDir, 'memory', 'documents', 'report.md');
    const concept = fs.readFileSync(conceptFile, 'utf-8');
    expect(concept).toContain('type: saved-document');
    expect(concept).toContain('source-filename: "report.docx"');
    expect(concept).toContain('raw-file: "files/report.docx"');
    expect(concept).toContain('saved-date:');
    expect(concept).toContain('Hello World');
    expect(concept).toContain('Second paragraph');

    const index = fs.readFileSync(path.join(baseDir, 'memory', 'index.md'), 'utf-8');
    expect(index).toContain('documents/report.md');

    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'index.md'))).toBe(true);
  });
});

describe('save_document — happy path, PDF with text layer', () => {
  it('extracts text directly via pdfjs-dist, no rendering needed', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMinimalPdf('Hello World'));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'letter.md'), 'utf-8');
    expect(concept).toContain('Hello World');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'letter.pdf'))).toBe(true);
    // No render should have been produced for a text-layer PDF.
    expect(fs.existsSync(path.join(baseDir, '.document-renders'))).toBe(false);
  });
});

describe('describePdfReadError', () => {
  it("names a password-protected PDF distinctly, rather than surfacing pdfjs-dist's generic error text", () => {
    const e = new Error('No password given');
    e.name = 'PasswordException';
    expect(describePdfReadError(e)).toBe(
      'this PDF is password-protected and cannot be read — please provide an unprotected copy',
    );
  });

  it('falls through to the plain error message for any other error', () => {
    expect(describePdfReadError(new Error('Invalid PDF structure'))).toBe('Invalid PDF structure');
    expect(describePdfReadError('a raw string throw')).toBe('a raw string throw');
  });
});

describe('save_document — oversized raw file is refused before any extraction is attempted', () => {
  it('rejects a file over the size cap with a clear error, never touches pdfjs-dist/unzip/OCR', async () => {
    const filePath = path.join(inboxDir, 'huge.pdf');
    // A sparse file: truncate to a size past the cap without actually
    // allocating/writing that many real bytes — fast and light in a test.
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, 101 * 1024 * 1024);

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('File too large');
    expect(result.content[0].text).toContain('101.0MB');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'huge.md'))).toBe(false);
  });

  it('does not reject a file exactly at the cap for its size (the boundary is ">", not ">=")', async () => {
    // Content doesn't matter for this boundary check — only whether
    // resolveInboxPath's size gate itself lets a file of exactly the cap
    // size through to the rest of the pipeline.
    const filePath = path.join(inboxDir, 'at-cap.pdf');
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, 100 * 1024 * 1024);

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.content[0]?.text).not.toContain('File too large');
  });
});

describe('save_document — scanned PDF, no text layer, OCR reads it', () => {
  it('single call: renders page 1, OCRs it, saves the OCR text, and deletes the render', async () => {
    mockOcrResult = { text: 'What OCR read from the rendered page.' };
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'scan.md'), 'utf-8');
    expect(concept).toContain('What OCR read from the rendered page.');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'scan.pdf'))).toBe(true);

    // The render PNG is cleaned up once its OCR text is safely written out —
    // it never persists past a successful save (spec Boundaries).
    const renderDir = path.join(baseDir, '.document-renders');
    expect(fs.existsSync(renderDir) ? fs.readdirSync(renderDir).length : 0).toBe(0);
  });

  it('wires createWorker with both languages, a real workerPath, and the expected cachePath', async () => {
    mockOcrResult = { text: 'legible text' };
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    await saveDocumentImpl({ path: filePath }, opts());

    expect(lastCreateWorkerCall).toBeDefined();
    expect(lastCreateWorkerCall!.langs).toBe('eng+heb');
    // Not a fake/placeholder path — this must resolve to a real file on
    // disk, or the Bun-specific worker-resolution fix this test exists to
    // guard has silently regressed.
    expect(fs.existsSync(lastCreateWorkerCall!.options.workerPath!)).toBe(true);
    expect(lastCreateWorkerCall!.options.workerPath).toMatch(/worker-script[/\\]node[/\\]index\.js$/);
    expect(lastCreateWorkerCall!.options.cachePath).toBe(path.join(baseDir, '.ocr-cache'));
  });

  it('treats a near-empty (but non-empty) OCR result as no readable text, per the Ask-First halt', async () => {
    // A stray single character from a blank/noisy page is not real content
    // — must route through the same halt as a truly empty OCR result,
    // never get silently saved as if it were legible text.
    mockOcrResult = { text: '.' };
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('found little to no readable text');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'scan.md'))).toBe(false);

    // Same as the fully-empty case: the render survives for a possible
    // vision-fallback follow-up.
    const renderDir = path.join(baseDir, '.document-renders');
    expect(fs.readdirSync(renderDir).length).toBe(1);
  });

  it('rejects a non-string extractedText with a clear error instead of silently proceeding', async () => {
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    const result = await saveDocumentImpl({ path: filePath, extractedText: 12345 }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('extractedText must be a string');
  });
});

describe('save_document — abandoned .document-renders/ entries are swept opportunistically', () => {
  it('deletes an old (>1h) leftover render on a fresh scanned-PDF save, but never the one just created', async () => {
    const renderDir = path.join(baseDir, '.document-renders');
    fs.mkdirSync(renderDir, { recursive: true });
    const abandoned = path.join(renderDir, 'some-other-scan-abandoned.png');
    fs.writeFileSync(abandoned, 'stale png bytes');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h old
    fs.utimesSync(abandoned, old, old);

    mockOcrResult = { text: 'fresh OCR text' };
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));
    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(abandoned)).toBe(false); // swept
    // The fresh save's own render is cleaned up on the success path too
    // (existing behavior, unchanged) — the dir ends up empty either way,
    // but for two different reasons; assert via the concept file instead,
    // which only exists if this call's own extraction actually succeeded.
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'scan.md'))).toBe(true);
  });

  it('does not touch a recent (<1h) leftover render — a same-conversation follow-up may still need it', async () => {
    const renderDir = path.join(baseDir, '.document-renders');
    fs.mkdirSync(renderDir, { recursive: true });
    const recent = path.join(renderDir, 'some-other-scan-recent.png');
    fs.writeFileSync(recent, 'recent png bytes');
    const fresh = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes old
    fs.utimesSync(recent, fresh, fresh);

    mockOcrResult = { text: 'fresh OCR text' };
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));
    await saveDocumentImpl({ path: filePath }, opts());

    expect(fs.existsSync(recent)).toBe(true); // not swept — still within the grace window
  });
});

describe('save_document — scanned PDF, OCR finds no readable text (Ask-First halt)', () => {
  it('halts instead of saving, asks the user, and leaves the render in place for a possible vision fallback', async () => {
    mockOcrResult = { text: '' };
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('no extractable text layer');
    expect(result.content[0].text).toContain('found little to no readable text');
    expect(result.content[0].text).toContain('save_document again');
    expect(result.content[0].text).toContain('extractedText: ""');
    // Transparency: a follow-up extractedText must be scoped to the one
    // page being asked about (not "the whole document," now that
    // save_document reads every page independently) — this single-page PDF
    // happens to phrase that as "for page 1 only" too, but the meaning has
    // changed from the old page-1-only-ever-captured caveat to "this reply
    // answers page 1 specifically."
    expect(result.content[0].text).toContain('page 1 only');
    // The render path in the message must be derived from the injected
    // baseDir, not a hardcoded "/workspace/agent/" prefix (which would be
    // wrong for any baseDir other than the production default).
    expect(result.content[0].text).toContain(path.join(baseDir, '.document-renders'));
    expect(result.content[0].text).not.toContain('/workspace/agent/');

    // No partial memory entry from the halted call.
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'scan.md'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'scan.pdf'))).toBe(false);

    // The render must survive the halt — a vision-fallback follow-up needs
    // to be able to read it.
    const renderDir = path.join(baseDir, '.document-renders');
    expect(fs.existsSync(renderDir)).toBe(true);
    const rendered = fs.readdirSync(renderDir);
    expect(rendered.length).toBe(1);
    expect(rendered[0]).toMatch(/\.png$/);
  });

  it('renders the same deterministic filename on repeated halted calls for the same file', async () => {
    mockOcrResult = { text: '' };
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    const r1 = await saveDocumentImpl({ path: filePath }, opts());
    const renderDir = path.join(baseDir, '.document-renders');
    const firstRendered = fs.readdirSync(renderDir);

    const r2 = await saveDocumentImpl({ path: filePath }, opts());
    const secondRendered = fs.readdirSync(renderDir);

    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    // Same source file -> same deterministic render filename -> re-rendered
    // in place, not accumulating a new abandoned PNG per retry.
    expect(secondRendered).toEqual(firstRendered);
  });

  it('follow-up call with real extractedText (vision fallback) completes the save and deletes the render', async () => {
    mockOcrResult = { text: '' };
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    await saveDocumentImpl({ path: filePath }, opts());
    const renderDir = path.join(baseDir, '.document-renders');
    expect(fs.readdirSync(renderDir).length).toBe(1);

    const result = await saveDocumentImpl(
      { path: filePath, extractedText: 'What the agent read from the rendered page.' },
      opts(),
    );

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'scan.md'), 'utf-8');
    expect(concept).toContain('What the agent read from the rendered page.');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'scan.pdf'))).toBe(true);

    // The render PNG for this path is cleaned up on successful completion.
    expect(fs.readdirSync(renderDir).length).toBe(0);
  });

  it('follow-up call with extractedText: "" accepts the placeholder instead of the vision fallback', async () => {
    mockOcrResult = { text: '' };
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    await saveDocumentImpl({ path: filePath }, opts());
    const renderDir = path.join(baseDir, '.document-renders');

    const result = await saveDocumentImpl({ path: filePath, extractedText: '' }, opts());

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'scan.md'), 'utf-8');
    expect(concept).toContain('_(no text extracted)_');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'scan.pdf'))).toBe(true);

    // Still cleaned up — the render has served its purpose either way.
    expect(fs.readdirSync(renderDir).length).toBe(0);
  });

  it('surfaces an OCR engine failure as a clear error, never a silent/partial write, and cleans up the render', async () => {
    mockOcrResult = { error: 'simulated OCR engine crash' };
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Could not OCR scanned PDF page');
    expect(fs.existsSync(path.join(baseDir, 'memory'))).toBe(false);

    // Unlike the near-empty halt (which deliberately keeps the render for a
    // vision-fallback follow-up), a genuine OCR engine failure has no
    // follow-up flow that needs it — it must not be left orphaned.
    const renderDir = path.join(baseDir, '.document-renders');
    expect(fs.existsSync(renderDir) ? fs.readdirSync(renderDir).length : 0).toBe(0);
  });
});

describe('save_document — multi-page PDF, mixed text/image-page handling', () => {
  it('all-text-layer multi-page PDF: extracts every page directly via pdfjs-dist, in order, no rendering at all', async () => {
    const filePath = writeInboxFile(
      'report.pdf',
      await buildMultiPagePdf(['Page one content.', 'Page two content.', 'Page three content.']),
    );

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'report.md'), 'utf-8');
    const idx1 = concept.indexOf('Page one content.');
    const idx2 = concept.indexOf('Page two content.');
    const idx3 = concept.indexOf('Page three content.');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
    // No page marker at all — every page came straight from its own text
    // layer, none needed OCR/transcription.
    expect(concept).not.toContain('— OCR');
    expect(concept).not.toContain('— transcribed');
    expect(fs.existsSync(path.join(baseDir, '.document-renders'))).toBe(false);
  });

  it('all-scanned multi-page PDF: renders and OCRs every page, concatenated in order with per-page markers', async () => {
    mockOcrResult = { text: 'OCR text for this page.' };
    const filePath = writeInboxFile('scan.pdf', await buildMultiPagePdf([null, null, null]));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'scan.md'), 'utf-8');
    expect(concept).toContain('[Page 1 — OCR]');
    expect(concept).toContain('[Page 2 — OCR]');
    expect(concept).toContain('[Page 3 — OCR]');
    // Every page's own render is cleaned up once the whole save succeeds.
    const renderDir = path.join(baseDir, '.document-renders');
    expect(fs.existsSync(renderDir) ? fs.readdirSync(renderDir).length : 0).toBe(0);
  });

  it('mixed PDF: routes each page independently — text pages get no marker, the scanned page does', async () => {
    mockOcrResult = { text: 'OCR text for the scanned page.' };
    const filePath = writeInboxFile(
      'mixed.pdf',
      await buildMultiPagePdf(['Real text on page one.', null, 'Real text on page three.']),
    );

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'mixed.md'), 'utf-8');
    expect(concept).toContain('Real text on page one.');
    expect(concept).toContain('[Page 2 — OCR]');
    expect(concept).toContain('OCR text for the scanned page.');
    expect(concept).toContain('Real text on page three.');
    // Only page 2 needed a marker — pages 1 and 3 came straight from their
    // own text layer and never touched render/OCR.
    expect((concept.match(/— OCR\]/g) ?? []).length).toBe(1);
    const renderDir = path.join(baseDir, '.document-renders');
    expect(fs.existsSync(renderDir) ? fs.readdirSync(renderDir).length : 0).toBe(0);
  });

  it('a bad page halts the whole save even though other pages already have good content, and resumes on that exact page', async () => {
    mockOcrResult = { text: '' };
    const filePath = writeInboxFile(
      'mixed-bad.pdf',
      await buildMultiPagePdf(['Real text on page one.', null, 'Real text on page three.']),
    );

    const halt = await saveDocumentImpl({ path: filePath }, opts());
    expect(halt.isError).toBeFalsy();
    expect(halt.content[0].text).toContain('Page 2');
    expect(halt.content[0].text).toContain('found little to no readable text');
    expect(halt.content[0].text).toContain('page 2');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'mixed-bad.md'))).toBe(false);
    const renderDir = path.join(baseDir, '.document-renders');
    expect(fs.readdirSync(renderDir).length).toBe(1); // only page 2's render survives the halt

    const result = await saveDocumentImpl({ path: filePath, extractedText: 'What I read on page 2.' }, opts());

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'mixed-bad.md'), 'utf-8');
    expect(concept).toContain('Real text on page one.');
    expect(concept).toContain('[Page 2 — transcribed]');
    expect(concept).toContain('What I read on page 2.');
    expect(concept).toContain('Real text on page three.');
    expect(fs.readdirSync(renderDir).length).toBe(0);
  });

  it('extractedText: "" on a multi-page halt marks just that one page unreadable and keeps the rest of the document', async () => {
    mockOcrResult = { text: '' };
    const filePath = writeInboxFile('mixed-blank.pdf', await buildMultiPagePdf(['Real text on page one.', null]));

    await saveDocumentImpl({ path: filePath }, opts());
    const result = await saveDocumentImpl({ path: filePath, extractedText: '' }, opts());

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'mixed-blank.md'), 'utf-8');
    expect(concept).toContain('Real text on page one.');
    expect(concept).toContain('[Page 2 — no readable text]');
    // Deliberately NOT the whole-document '_(no text extracted)_' fallback
    // — that's reserved for a genuinely single-page document (see the
    // regression tests above); this document still has real content overall.
    expect(concept).not.toContain('_(no text extracted)_');
  });

  it('two separate bad pages need two separate Ask-First round trips, one page resolved per call', async () => {
    mockOcrResult = { text: '' };
    const filePath = writeInboxFile('two-bad.pdf', await buildMultiPagePdf([null, 'Real text on page two.', null]));

    const halt1 = await saveDocumentImpl({ path: filePath }, opts());
    expect(halt1.isError).toBeFalsy();
    expect(halt1.content[0].text).toContain('Page 1');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'two-bad.md'))).toBe(false);

    const halt2 = await saveDocumentImpl({ path: filePath, extractedText: 'What I read on page 1.' }, opts());
    expect(halt2.isError).toBeFalsy();
    // Page 2 (real text) was resolved silently in between — the second halt
    // is on page 3, not page 2.
    expect(halt2.content[0].text).toContain('Page 3');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'two-bad.md'))).toBe(false);

    const result = await saveDocumentImpl({ path: filePath, extractedText: 'What I read on page 3.' }, opts());

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'two-bad.md'), 'utf-8');
    expect(concept).toContain('[Page 1 — transcribed]');
    expect(concept).toContain('What I read on page 1.');
    expect(concept).toContain('Real text on page two.');
    expect(concept).toContain('[Page 3 — transcribed]');
    expect(concept).toContain('What I read on page 3.');
    const renderDir = path.join(baseDir, '.document-renders');
    expect(fs.readdirSync(renderDir).length).toBe(0);
  });

  it('rejects a PDF over the page-count cap with a clear error before doing any rendering/OCR work', async () => {
    const manyPages: Array<string | null> = Array.from({ length: 301 }, () => null);
    const filePath = writeInboxFile('huge.pdf', await buildMultiPagePdf(manyPages));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Could not read PDF');
    expect(result.content[0].text).toContain('300-page limit');
    expect(fs.existsSync(path.join(baseDir, '.document-renders'))).toBe(false);
  });
});

describe('save_document — malformed PDF', () => {
  it('returns a clear "Could not read PDF" error rather than throwing raw', async () => {
    const filePath = writeInboxFile('garbage.pdf', Buffer.from('this is not a pdf file at all', 'utf-8'));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Could not read PDF');
    expect(fs.existsSync(path.join(baseDir, 'memory'))).toBe(false);
  });
});

describe('save_document — docx with missing/broken word/document.xml', () => {
  it('still saves the raw file, with an extraction-failed note instead of throwing', async () => {
    const emptyZip = Buffer.alloc(22);
    emptyZip.writeUInt32LE(0x06054b50, 0); // valid empty-zip EOCD, no entries at all
    const filePath = writeInboxFile('broken.docx', emptyZip);

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'broken.docx'))).toBe(true);
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'broken.md'), 'utf-8');
    expect(concept).toContain('Could not extract text automatically');
  });
});

describe('save_document — unsupported file type', () => {
  it('declines cleanly, no memory entry at all', async () => {
    const filePath = writeInboxFile('notes.txt', Buffer.from('just some text', 'utf-8'));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unsupported file type');
    expect(fs.existsSync(path.join(baseDir, 'memory'))).toBe(false);
  });

  it('declines an unrelated Office format (.xlsx) — .doc is now in scope, .xlsx still is not', async () => {
    const filePath = writeInboxFile('numbers.xlsx', Buffer.from('not a real xlsx file', 'utf-8'));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unsupported file type');
  });
});

function buildTinyPng(): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10;
    png.data[i + 1] = 20;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('save_document — image (jpg/png), vision-read two-call pattern', () => {
  it('first call asks the agent to read the image itself, without saving anything yet', async () => {
    const filePath = writeInboxFile('receipt.png', buildTinyPng());

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('image');
    expect(result.content[0].text).toContain('save_document again');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'receipt.md'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'receipt.png'))).toBe(false);
  });

  it('second call, with extractedText, completes the save', async () => {
    const filePath = writeInboxFile('receipt.jpg', buildTinyPng());

    await saveDocumentImpl({ path: filePath }, opts());
    const result = await saveDocumentImpl(
      { path: filePath, extractedText: 'Barcode: 123456789. Voucher for 200 ILS.' },
      opts(),
    );

    expect(result.isError).toBeFalsy();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'receipt.md'), 'utf-8');
    expect(concept).toContain('Barcode: 123456789');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'receipt.jpg'))).toBe(true);
  });

  it('a saved image cannot be targeted by fill_document_field — declines clearly, does not crash', async () => {
    const filePath = writeInboxFile('receipt.png', buildTinyPng());
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'Barcode 123' }, opts());

    const result = await fillDocumentFieldImpl({ document: 'receipt', value: 'x' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('saved image');
  });
});

describe('save_document — .doc with unreadable content', () => {
  it('still saves the raw file, with an extraction-failed note instead of throwing', async () => {
    // Not a real OLE2/Compound File Binary structure — word-extractor should
    // fail to parse it, and that failure must not be fatal to the save
    // (mirrors the "docx with missing/broken word/document.xml" case above).
    const filePath = writeInboxFile('legacy.doc', Buffer.from('not a real doc file at all', 'utf-8'));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'legacy.doc'))).toBe(true);
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'legacy.md'), 'utf-8');
    expect(concept).toContain('Could not extract text automatically');
  });
});

describe('save_document — missing path / file not found', () => {
  it('rejects a call with no path', async () => {
    const result = await saveDocumentImpl({}, opts());
    expect(result.isError).toBe(true);
  });

  it('rejects a path that does not exist', async () => {
    const result = await saveDocumentImpl({ path: path.join(inboxDir, 'ghost.pdf') }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('File not found');
  });
});

describe('save_document — slug collision', () => {
  it('appends -2 when a second document normalizes to an existing slug', async () => {
    const first = writeInboxFile('report.docx', buildDocx(['First document']));
    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const secondPath = path.join(inboxDir, 'msg2', 'REPORT.docx');
    fs.mkdirSync(path.dirname(secondPath), { recursive: true });
    fs.writeFileSync(secondPath, buildDocx(['Second document']));

    const r1 = await saveDocumentImpl({ path: first }, opts());
    const r2 = await saveDocumentImpl({ path: secondPath }, opts());

    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'report-2.md'))).toBe(true);

    const index = fs.readFileSync(path.join(baseDir, 'memory', 'index.md'), 'utf-8');
    expect(index).toContain('documents/report.md');
    expect(index).toContain('documents/report-2.md');
  });
});

describe('save_document — concurrent saves, same group', () => {
  it('both entries land intact in memory/index.md under the locked read-modify-write', async () => {
    const fileA = writeInboxFile('alpha.docx', buildDocx(['Document A']));
    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const fileB = path.join(inboxDir, 'msg2', 'beta.docx');
    fs.writeFileSync(fileB, buildDocx(['Document B']));

    const [r1, r2] = await Promise.all([
      saveDocumentImpl({ path: fileA }, opts()),
      saveDocumentImpl({ path: fileB }, opts()),
    ]);

    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();

    const index = fs.readFileSync(path.join(baseDir, 'memory', 'index.md'), 'utf-8');
    const savedLines = index.split('\n').filter((l) => l.includes('saved document,'));
    expect(savedLines).toHaveLength(2);
    expect(index).toContain('documents/alpha.md');
    expect(index).toContain('documents/beta.md');

    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'alpha.md'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'beta.md'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', '.index.lock'))).toBe(false);
  });

  it('concurrent saves that normalize to the SAME slug still both land, as <slug>.md and <slug>-2.md', async () => {
    // Guards the invariant that uniqueSlug() is computed *inside* the lock —
    // a regression that hoisted it outside would let both concurrent calls
    // see "report" as free and race to overwrite the same raw/concept files.
    const first = writeInboxFile('report.docx', buildDocx(['First document']));
    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const secondPath = path.join(inboxDir, 'msg2', 'REPORT.docx');
    fs.writeFileSync(secondPath, buildDocx(['Second document']));

    const [r1, r2] = await Promise.all([
      saveDocumentImpl({ path: first }, opts()),
      saveDocumentImpl({ path: secondPath }, opts()),
    ]);

    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();

    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'report-2.md'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'report.docx'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'report-2.docx'))).toBe(true);

    // Each concept file has distinct, non-clobbered content.
    const bodies = [
      fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'report.md'), 'utf-8'),
      fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'report-2.md'), 'utf-8'),
    ];
    expect(bodies.some((b) => b.includes('First document'))).toBe(true);
    expect(bodies.some((b) => b.includes('Second document'))).toBe(true);

    const index = fs.readFileSync(path.join(baseDir, 'memory', 'index.md'), 'utf-8');
    const savedLines = index.split('\n').filter((l) => l.includes('saved document,'));
    expect(savedLines).toHaveLength(2);
  });
});

describe('save_document — path containment (path traversal)', () => {
  it('rejects an absolute path outside /workspace/inbox', async () => {
    const outsideDir = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'secret.pdf');
    fs.writeFileSync(outsideFile, buildMinimalPdf('Secret'));

    const result = await saveDocumentImpl({ path: outsideFile }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outside the inbox');
    expect(fs.existsSync(path.join(baseDir, 'memory'))).toBe(false);
  });

  it('rejects a relative path that traverses out of the inbox with ".."', async () => {
    // "inbox/msg1/../../outside/secret.pdf" resolves outside workspaceRoot/inbox.
    const outsideDir = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.pdf'), buildMinimalPdf('Secret'));

    const result = await saveDocumentImpl({ path: 'inbox/msg1/../../outside/secret.pdf' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outside the inbox');
  });

  it('accepts a well-formed relative inbox path (the documented convention)', async () => {
    writeInboxFile('report.docx', buildDocx(['Hello']));

    const result = await saveDocumentImpl({ path: 'inbox/msg1/report.docx' }, opts());

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'report.md'))).toBe(true);
  });
});

describe('save_document — stale lock recovery', () => {
  it('recovers from an abandoned lock (crashed holder) instead of failing forever', async () => {
    const documentsDir = path.join(baseDir, 'memory', 'documents');
    fs.mkdirSync(documentsDir, { recursive: true });
    const lockPath = path.join(documentsDir, '.index.lock');
    fs.writeFileSync(lockPath, '999999'); // simulate a lock left by a crashed process
    const old = new Date(Date.now() - 60_000); // 60s ago, older than the 30s staleness threshold
    fs.utimesSync(lockPath, old, old);

    const filePath = writeInboxFile('report.docx', buildDocx(['Hello World']));
    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(path.join(documentsDir, 'report.md'))).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('reclaims a lock immediately when its holder pid is dead, even with a fresh mtime (does not wait out the staleness window)', async () => {
    const documentsDir = path.join(baseDir, 'memory', 'documents');
    fs.mkdirSync(documentsDir, { recursive: true });
    const lockPath = path.join(documentsDir, '.index.lock');
    fs.writeFileSync(lockPath, '999999'); // a pid essentially guaranteed dead in any real environment
    // Deliberately fresh mtime — the mtime-based staleness check alone would
    // NOT reclaim this lock (nowhere near the 30s threshold); only the
    // pid-liveness check can, and it must not wait for the mtime window.

    const filePath = writeInboxFile('report.docx', buildDocx(['Hello World']));
    const start = Date.now();
    const result = await saveDocumentImpl({ path: filePath }, opts());
    const elapsedMs = Date.now() - start;

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(path.join(documentsDir, 'report.md'))).toBe(true);
    // The mtime path alone would need ~30s (LOCK_STALE_MS) before it even
    // starts retrying; finishing well under that proves the pid-liveness
    // check fired instead, not a lucky race against mtime staleness.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('falls back to mtime-based staleness when the lock content is not a plain pid', async () => {
    const documentsDir = path.join(baseDir, 'memory', 'documents');
    fs.mkdirSync(documentsDir, { recursive: true });
    const lockPath = path.join(documentsDir, '.index.lock');
    fs.writeFileSync(lockPath, 'not-a-pid'); // pid-liveness check can't apply to this
    const old = new Date(Date.now() - 60_000); // older than the 30s staleness threshold
    fs.utimesSync(lockPath, old, old);

    const filePath = writeInboxFile('report.docx', buildDocx(['Hello World']));
    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(path.join(documentsDir, 'report.md'))).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('save_document — rollback on partial failure inside the lock', () => {
  it('unlinks the raw file and concept file if the memory/index.md append fails', async () => {
    // Force the final write (memory/index.md append) to fail by pre-creating
    // it as a directory, after the raw copy and concept file have already
    // succeeded — exercises the rollback path, not just the happy path.
    fs.mkdirSync(path.join(baseDir, 'memory', 'index.md'), { recursive: true });

    const filePath = writeInboxFile('report.docx', buildDocx(['Hello World']));
    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'report.md'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'report.docx'))).toBe(false);
    // The lock is still released even though the critical section threw.
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', '.index.lock'))).toBe(false);
  });
});

describe('save_document — YAML/Markdown escaping of untrusted filenames', () => {
  it('escapes control characters in YAML frontmatter and brackets/parens in generated Markdown', async () => {
    // A literal newline is a legal filename byte on POSIX (only NUL and "/"
    // are forbidden) and would otherwise corrupt the frontmatter block; the
    // brackets/parens would otherwise break or hijack the generated
    // Markdown link syntax.
    const trickyName = 'report [v2]\n(final).docx';
    const filePath = writeInboxFile(trickyName, buildDocx(['Hello World']));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();

    const conceptFiles = fs.readdirSync(path.join(baseDir, 'memory', 'documents')).filter((f) => f.endsWith('.md'));
    const conceptFile = conceptFiles.find((f) => f !== 'index.md');
    expect(conceptFile).toBeDefined();
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', conceptFile!), 'utf-8');

    // Frontmatter is well-formed: exactly a closed "--- ... ---" block, with
    // no raw control character breaking it out of the quoted scalar.
    const frontmatterMatch = /^---\n([\s\S]*?)\n---\n/.exec(concept);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch![1];
    expect(frontmatter).not.toMatch(/\n\(final\)/); // the raw newline must not have survived into frontmatter
    const sourceLine = frontmatter.split('\n').find((l) => l.startsWith('source-filename:'));
    expect(sourceLine).toBeDefined();
    expect(sourceLine).not.toContain('\n');

    // The Markdown heading and the memory/index.md link both escape [ ] ( ).
    expect(concept).toContain('\\[v2\\]');
    expect(concept).toContain('\\(final\\)');

    const index = fs.readFileSync(path.join(baseDir, 'memory', 'index.md'), 'utf-8');
    expect(index).toContain('\\[v2\\]');
    expect(index).toContain('\\(final\\)');
    // Unescaped brackets/parens from the filename must not appear in the link line.
    const linkLine = index.split('\n').find((l) => l.includes('saved document,'));
    expect(linkLine).toBeDefined();
    expect(linkLine).not.toMatch(/[^\\]\[v2[^\\]\]/);
  });
});

// ---------------------------------------------------------------------------
// fill_document_field / list_documents (Story 1.2) fixtures
// ---------------------------------------------------------------------------

function cellXml(text: string): string {
  return `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
}

function emptyCellXml(): string {
  return '<w:tc><w:p><w:pPr/></w:p></w:tc>';
}

function rowXml(cells: string[]): string {
  return `<w:tr>${cells.map(cellXml).join('')}</w:tr>`;
}

function tableXml(rows: string[][]): string {
  return `<w:tbl><w:tblPr/>${rows.map(rowXml).join('')}</w:tbl>`;
}

/** A row whose last cell's <w:tc> holds a nested <w:tbl> — the "decline, don't miscount" case. */
function nestedTableRowXml(): string {
  return `<w:tr>${cellXml('a')}<w:tc>${tableXml([['nested-a', 'nested-b']])}</w:tc></w:tr>`;
}

/** A row whose last cell has a paragraph but no <w:t> run at all — the "insert a run" case. */
function rowWithEmptyLastCellXml(firstCellText: string): string {
  return `<w:tr>${cellXml(firstCellText)}${emptyCellXml()}</w:tr>`;
}

function buildDocxWithTables(tables: string[][][]): Buffer {
  const body = tables.map(tableXml).join('');
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`;
  return buildStoredZip([{ name: 'word/document.xml', data: Buffer.from(xml, 'utf-8') }]);
}

function buildDocxWithRawTable(tableInnerXml: string): Buffer {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:tbl><w:tblPr/>${tableInnerXml}</w:tbl></w:body></w:document>`;
  return buildStoredZip([{ name: 'word/document.xml', data: Buffer.from(xml, 'utf-8') }]);
}

/** Same shape as buildDocxWithRawTable, but binds the WordprocessingML namespace to a non-"w:" prefix — simulates a document authored/re-saved by a tool that made a different (but still spec-legal) prefix choice, which parseOoxmlTree's "w:"-only tokenizer cannot see. */
function buildDocxWithRawTableNonWPrefix(tableInnerXml: string, prefix = 'ns0'): Buffer {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<${prefix}:document xmlns:${prefix}="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<${prefix}:body><${prefix}:tbl><${prefix}:tblPr/>${tableInnerXml.replace(/w:/g, `${prefix}:`)}</${prefix}:tbl></${prefix}:body></${prefix}:document>`;
  return buildStoredZip([{ name: 'word/document.xml', data: Buffer.from(xml, 'utf-8') }]);
}

async function readDocxXml(buf: Buffer): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('word/document.xml missing from produced docx');
  return file.async('string');
}

/** Loads a produced .docx's raw JSZip instance, for inspecting whichever parts (rels, content-types, media) a test needs beyond word/document.xml. */
async function loadDocxZip(buf: Buffer): Promise<JSZipType> {
  const JSZip = (await import('jszip')).default;
  return JSZip.loadAsync(buf);
}

/**
 * A minimal .docx whose word/media/ already has an image1.png and whose
 * word/_rels/document.xml.rels already has a matching rId1 image
 * relationship (plus a [Content_Types].xml that already declares the PNG
 * default) — used to confirm a new signature stamp picks the next free
 * filename/rId/content-type state without colliding with or duplicating
 * any of this pre-existing entry.
 */
function buildDocxWithExistingImage(tables: string[][][]): Buffer {
  const body = tables.map(tableXml).join('');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}<w:p><w:r><w:drawing>` +
    '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
    '<wp:docPr id="1" name="Picture 1"/>' +
    '</wp:inline></w:drawing></w:r></w:p></w:body></w:document>';
  const relsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
    'Target="media/image1.png"/></Relationships>';
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/></Types>';
  const existingImage = buildSignaturePng({ width: 10, height: 10, ink: { x: 0, y: 0, w: 5, h: 5 } });
  return buildStoredZip([
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf-8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(relsXml, 'utf-8') },
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf-8') },
    { name: 'word/media/image1.png', data: existingImage },
  ]);
}

/**
 * A .docx whose [Content_Types].xml has a PNG `Override` scoped to one
 * specific, unrelated part's PartName — but no extension-wide `Default` for
 * `.png` — used to confirm ensurePngContentType doesn't mistake an
 * Override's narrow scope for extension-wide PNG coverage (OPC content-type
 * resolution: an Override only applies to its own exact PartName).
 */
function buildDocxWithScopedPngOverride(tables: string[][][]): Buffer {
  const body = tables.map(tableXml).join('');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`;
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/media/image1.png" ContentType="image/png"/></Types>';
  return buildStoredZip([
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf-8') },
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf-8') },
  ]);
}

/**
 * A .docx whose existing relationship, docPr id, and Content-Types PNG
 * Default all use single-quoted XML attribute values (spec-legal — XML
 * allows either quote style) — used to confirm the next-free-id scans and
 * the Default-detection regex aren't fooled by that, blind to a real
 * collision/duplication risk a double-quote-only regex would create.
 */
function buildDocxWithSingleQuotedParts(tables: string[][][]): Buffer {
  const body = tables.map(tableXml).join('');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}<w:p><w:r><w:drawing>` +
    '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
    "<wp:docPr id='7' name='Picture 7'/>" +
    '</wp:inline></w:drawing></w:r></w:p></w:body></w:document>';
  const relsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    "<Relationship Id='rId5' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/image' " +
    "Target='media/image5.png'/></Relationships>";
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    "<Default Extension='png' ContentType='image/png'/></Types>";
  const existingImage = buildSignaturePng({ width: 10, height: 10, ink: { x: 0, y: 0, w: 5, h: 5 } });
  return buildStoredZip([
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf-8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(relsXml, 'utf-8') },
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf-8') },
    { name: 'word/media/image5.png', data: existingImage },
  ]);
}

/**
 * A .docx with a single table row whose *last* cell already contains a
 * (fake but well-formed) inline image referencing rId1/image1.png — as
 * opposed to buildDocxWithExistingImage's image, which lives in a separate
 * paragraph outside the table entirely. Used to confirm a signature stamp
 * targeting that exact cell appends alongside the existing image rather
 * than corrupting or displacing it.
 */
function buildDocxWithImageInTargetCell(): Buffer {
  const existingDrawingXml =
    '<w:r><w:drawing>' +
    '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">' +
    '<wp:docPr id="1" name="Picture 1"/>' +
    '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:blipFill><a:blip r:embed="rId1" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></pic:blipFill>' +
    '</pic:pic></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r>';
  const cellWithImage = `<w:tc><w:p>${existingDrawingXml}</w:p></w:tc>`;
  const tableInner = `<w:tr>${cellXml('label')}${cellWithImage}</w:tr>`;
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:tbl><w:tblPr/>${tableInner}</w:tbl></w:body></w:document>`;
  const relsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
    'Target="media/image1.png"/></Relationships>';
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="png" ContentType="image/png"/></Types>';
  const existingImage = buildSignaturePng({ width: 10, height: 10, ink: { x: 0, y: 0, w: 5, h: 5 } });
  return buildStoredZip([
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf-8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(relsXml, 'utf-8') },
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf-8') },
    { name: 'word/media/image1.png', data: existingImage },
  ]);
}

/** Returns the single contiguous region where `original` and `modified` differ. */
function diffMiddle(original: string, modified: string): { before: string; after: string } {
  let prefix = 0;
  while (prefix < original.length && prefix < modified.length && original[prefix] === modified[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < modified.length - prefix &&
    original[original.length - 1 - suffix] === modified[modified.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    before: original.slice(prefix, original.length - suffix),
    after: modified.slice(prefix, modified.length - suffix),
  };
}

/** Extracts the output path from a `list_document_versions` entry line (`N. <timestamp> — <target> — <path>`). */
function extractVersionPath(text: string, target: string): string {
  const line = text.split('\n').find((l) => l.includes(` — ${target} — `));
  if (!line) throw new Error(`No "${target}" entry found in list_document_versions text: ${text}`);
  const idx = line.lastIndexOf(' — ');
  return line.slice(idx + 3).trim();
}

function extractOutPath(text: string): string {
  const m = /New file at (.+?) — call send_file/.exec(text);
  if (!m) throw new Error(`No output path found in response: ${text}`);
  return m[1];
}

async function extractAllPdfText(filePath: string): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = getDocument({ data, verbosity: 0 });
  try {
    const doc = await loadingTask.promise;
    const texts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      texts.push(content.items.map((it: any) => ('str' in it ? it.str : '')).join(' '));
      page.cleanup();
    }
    return texts.join('\n');
  } finally {
    await loadingTask.destroy();
  }
}

async function buildAcroFormPdf(fieldName: string): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([200, 200]);
  const form = pdfDoc.getForm();
  const textField = form.createTextField(fieldName);
  textField.addToPage(page, { x: 20, y: 100, width: 150, height: 20 });
  return Buffer.from(await pdfDoc.save());
}

/** Same object-table boilerplate as buildMinimalPdf, but with N text lines at distinct y positions. */
function buildMultilineTextPdf(lines: string[]): Buffer {
  const catalog = '<< /Type /Catalog /Pages 2 0 R >>';
  const pages = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  const page =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] ' +
    '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';
  const streamContent = lines
    .map((text, i) => `BT /F1 14 Tf 20 ${160 - i * 20} Td (${escapePdfString(text)}) Tj ET`)
    .join('\n');
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  const parts: string[] = ['%PDF-1.4\n'];
  const offsets: number[] = [0];
  let cursor = parts[0].length;

  function pushObj(num: number, body: string): void {
    offsets[num] = cursor;
    const s = `${num} 0 obj\n${body}\nendobj\n`;
    parts.push(s);
    cursor += s.length;
  }

  pushObj(1, catalog);
  pushObj(2, pages);
  pushObj(3, page);
  pushObj(4, `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`);
  pushObj(5, font);

  const xrefOffset = cursor;
  const total = 6;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  parts.push(xref, `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return Buffer.from(parts.join(''), 'latin1');
}

// ---------------------------------------------------------------------------
// save_document — refresh (spec 2-4)
// ---------------------------------------------------------------------------

describe('save_document tool metadata — document argument (spec 2-4)', () => {
  it('declares document as an optional property, not required', () => {
    const schema = saveDocument.tool.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties.document).toBeDefined();
    expect(schema.required).toEqual(['path']);
  });
});

describe('save_document — refresh, unambiguous match', () => {
  it('overwrites the raw file + concept body in place, same slug, no new document created', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocx(['Original content'])) }, opts());

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-edited.docx');
    fs.writeFileSync(editedPath, buildDocx(['Edited content']));

    const result = await saveDocumentImpl({ path: editedPath, document: 'report' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('report');

    // Same slug — no new document/concept file created for this refresh.
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'report-2.md'))).toBe(false);

    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'report.md'), 'utf-8');
    expect(concept).toContain('Edited content');
    expect(concept).not.toContain('Original content');

    const rawFile = path.join(baseDir, 'memory', 'documents', 'files', 'report.docx');
    expect(fs.readFileSync(rawFile).equals(fs.readFileSync(editedPath))).toBe(true);
  });

  it('leaves memory/index.md byte-identical — no new entry, no rewritten line', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocx(['Original content'])) }, opts());
    const indexBefore = fs.readFileSync(path.join(baseDir, 'memory', 'index.md'), 'utf-8');

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-edited.docx');
    fs.writeFileSync(editedPath, buildDocx(['Edited content']));
    await saveDocumentImpl({ path: editedPath, document: 'report' }, opts());

    const indexAfter = fs.readFileSync(path.join(baseDir, 'memory', 'index.md'), 'utf-8');
    expect(indexAfter).toBe(indexBefore);
  });
});

describe("save_document — document omitted, unchanged today's behavior", () => {
  it('still creates a new, separately-slugged document even when a same-named one already exists', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocx(['First'])) }, opts());
    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const secondPath = path.join(inboxDir, 'msg2', 'report.docx');
    fs.writeFileSync(secondPath, buildDocx(['Second']));

    const result = await saveDocumentImpl({ path: secondPath }, opts());

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'report-2.md'))).toBe(true);
    const first = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'report.md'), 'utf-8');
    expect(first).toContain('First');
  });
});

describe('save_document — refresh, document matches nothing', () => {
  it('errors, writes nothing', async () => {
    const filePath = writeInboxFile('report.docx', buildDocx(['New content']));

    const result = await saveDocumentImpl({ path: filePath, document: 'nonexistent' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents'))).toBe(false);
  });
});

describe('save_document — refresh, document matches more than one saved document', () => {
  it('returns a numbered candidate list (not an error) and writes nothing', async () => {
    await saveDocumentImpl({ path: writeInboxFile('Report A.docx', buildDocx(['A'])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('Report B.docx', buildDocx(['B'])) }, opts());

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'edited.docx');
    fs.writeFileSync(editedPath, buildDocx(['Edited']));

    const result = await saveDocumentImpl({ path: editedPath, document: 'report' }, opts());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('report-a');
    expect(result.content[0].text).toContain('report-b');

    // Nothing was overwritten or newly created.
    const conceptA = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'report-a.md'), 'utf-8');
    const conceptB = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'report-b.md'), 'utf-8');
    expect(conceptA).toContain('A');
    expect(conceptB).toContain('B');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'edited.md'))).toBe(false);
  });
});

describe('save_document — refresh, document must be a string', () => {
  it('rejects a non-string document argument', async () => {
    const filePath = writeInboxFile('report.docx', buildDocx(['content']));
    const result = await saveDocumentImpl({ path: filePath, document: 42 }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('document must be a string');
  });
});

describe('save_document — refresh, pre-refresh raw file is snapshotted into fill-history', () => {
  it('is recoverable via list_document_versions, with the exact pre-refresh bytes', async () => {
    const originalBytes = buildDocx(['Original content']);
    await saveDocumentImpl({ path: writeInboxFile('report.docx', originalBytes) }, opts());

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-edited.docx');
    fs.writeFileSync(editedPath, buildDocx(['Edited content']));
    await saveDocumentImpl({ path: editedPath, document: 'report' }, opts());

    const versions = await listDocumentVersionsImpl({ document: 'report' }, opts());
    expect(versions.isError).toBeFalsy();
    expect(versions.content[0].text).toContain('pre-refresh snapshot');

    const snapshotPath = extractVersionPath(versions.content[0].text, 'pre-refresh snapshot');
    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(fs.readFileSync(snapshotPath).equals(originalBytes)).toBe(true);
  });
});

describe('save_document — refresh, a second fill afterward compounds on the refreshed content', () => {
  it('fill_document_field operates on the refreshed document, not the pre-refresh original', async () => {
    await saveDocumentImpl(
      {
        path: writeInboxFile(
          'report.docx',
          buildDocxWithTables([
            [
              ['Name:', 'orig1'],
              ['Date:', 'orig2'],
            ],
          ]),
        ),
      },
      opts(),
    );

    const fill1 = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'FirstValue' }, opts());
    expect(fill1.isError).toBeFalsy();
    const fill1Path = extractOutPath(fill1.content[0].text);

    const refresh = await saveDocumentImpl({ path: fill1Path, document: 'report' }, opts());
    expect(refresh.isError).toBeFalsy();

    const fill2 = await fillDocumentFieldImpl({ document: 'report', row: 2, value: 'SecondValue' }, opts());
    expect(fill2.isError).toBeFalsy();
    const fill2Path = extractOutPath(fill2.content[0].text);

    const finalXml = await readDocxXml(fs.readFileSync(fill2Path));
    // Both edits are present — row 1's edit survived because the second fill
    // ran against the refreshed (already-edited) raw file, not the
    // pre-refresh original (which never had "FirstValue" in it at all).
    expect(finalXml).toContain('FirstValue');
    expect(finalXml).toContain('SecondValue');
  });
});

describe('save_document — refresh, source file type differs from the original', () => {
  it("changes the raw file's extension, updates the raw-file frontmatter pointer, and snapshots the old-extension file", async () => {
    const originalPdfBytes = buildMinimalPdf('Original PDF text');
    await saveDocumentImpl({ path: writeInboxFile('report.pdf', originalPdfBytes) }, opts());
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'report.pdf'))).toBe(true);
    const indexBefore = fs.readFileSync(path.join(baseDir, 'memory', 'index.md'), 'utf-8');

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-edited.docx');
    fs.writeFileSync(editedPath, buildDocx(['Edited docx content']));

    const result = await saveDocumentImpl({ path: editedPath, document: 'report' }, opts());
    expect(result.isError).toBeFalsy();

    // memory/index.md is untouched by a cross-extension refresh too — same
    // invariant already covered for the same-extension case above.
    const indexAfter = fs.readFileSync(path.join(baseDir, 'memory', 'index.md'), 'utf-8');
    expect(indexAfter).toBe(indexBefore);

    // Old-extension raw file is gone; new-extension raw file holds the new content.
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'report.pdf'))).toBe(false);
    const newRaw = path.join(baseDir, 'memory', 'documents', 'files', 'report.docx');
    expect(fs.existsSync(newRaw)).toBe(true);
    expect(fs.readFileSync(newRaw).equals(fs.readFileSync(editedPath))).toBe(true);

    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'report.md'), 'utf-8');
    expect(concept).toContain('raw-file: "files/report.docx"');
    expect(concept).toContain('Edited docx content');

    // The old .pdf is still recoverable through the snapshot, not just deleted outright.
    const versions = await listDocumentVersionsImpl({ document: 'report' }, opts());
    const snapshotPath = extractVersionPath(versions.content[0].text, 'pre-refresh snapshot');
    expect(fs.readFileSync(snapshotPath).equals(originalPdfBytes)).toBe(true);
  });
});

describe('save_document — refresh, rollback on partial failure inside the critical section', () => {
  it('restores the pre-refresh raw file if the concept-file write throws after the raw file was already replaced', async () => {
    const originalPdfBytes = buildMinimalPdf('Original PDF text');
    await saveDocumentImpl({ path: writeInboxFile('report.pdf', originalPdfBytes) }, opts());

    const documentsDir = path.join(baseDir, 'memory', 'documents');
    const conceptPath = path.join(documentsDir, 'report.md');
    const rawPath = path.join(documentsDir, 'files', 'report.pdf');

    // Force the concept-file write specifically to fail, *after* the raw
    // file has already been replaced. The concept write is now temp-file-
    // then-rename (spec-2 retro item 1) — a rename that replaces an
    // existing path only needs write permission on its *directory*, not on
    // the target file's own mode bits, so chmod'ing conceptPath itself (the
    // old technique) would no longer block it. Making documentsDir itself
    // read-only instead blocks *creating* the concept temp file there,
    // while leaving files/ (a separate, still-writable subdirectory) —
    // and the per-slug raw-file lock, which lives entirely outside
    // documentsDir under baseDir/.document-raw-locks/ (spec-2 retro item 3)
    // — untouched.
    fs.chmodSync(documentsDir, 0o555);

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-edited.pdf');
    fs.writeFileSync(editedPath, buildMinimalPdf('Edited PDF text'));

    const result = await saveDocumentImpl({ path: editedPath, document: 'report' }, opts());

    // Restore write perms immediately — every assertion/cleanup below must
    // not itself be blocked by the same guard.
    fs.chmodSync(documentsDir, 0o755);

    expect(result.isError).toBe(true);
    // The document is left no worse off than before the refresh started —
    // the raw file is restored at its original path with its original
    // bytes, not missing and not the (never-committed) edited content.
    expect(fs.existsSync(rawPath)).toBe(true);
    expect(fs.readFileSync(rawPath).equals(originalPdfBytes)).toBe(true);
    // The concept file was never actually overwritten — its own
    // temp-file-then-rename never got far enough to rename onto conceptPath
    // (creating the temp file itself is what failed), so conceptPath still
    // describes the original.
    const concept = fs.readFileSync(conceptPath, 'utf-8');
    expect(concept).toContain('Original PDF text');
    // The pre-refresh snapshot written before the failure is still safely
    // on disk, even though this call overall failed and never got to index
    // it via recordFillHistory (list_document_versions won't show it).
    const fillsDir = path.join(baseDir, '.document-fills');
    expect(fs.existsSync(fillsDir) ? fs.readdirSync(fillsDir).length : 0).toBeGreaterThan(0);
  });
});

describe("save_document — refresh preserves the original document's source-filename/description/heading", () => {
  it("does not overwrite them with the refresh source's own (often machine-generated) filename", async () => {
    await saveDocumentImpl({ path: writeInboxFile('Quarterly Report.docx', buildDocx(['Original content'])) }, opts());

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-filled-1735012345-a3f9k2.docx');
    fs.writeFileSync(editedPath, buildDocx(['Edited content']));

    const result = await saveDocumentImpl({ path: editedPath, document: 'quarterly-report' }, opts());
    expect(result.isError).toBeFalsy();

    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'quarterly-report.md'), 'utf-8');
    expect(concept).toContain('source-filename: "Quarterly Report.docx"');
    expect(concept).toContain('description: "Saved document: Quarterly Report.docx"');
    expect(concept).toContain('# Quarterly Report.docx');
    expect(concept).not.toContain('report-filled-1735012345-a3f9k2.docx');
    expect(concept).toContain('Edited content');
  });
});

describe('save_document — refresh, document must not be empty', () => {
  it('rejects a whitespace-only document argument instead of silently treating it as omitted', async () => {
    const filePath = writeInboxFile('report.docx', buildDocx(['content']));
    const result = await saveDocumentImpl({ path: filePath, document: '   ' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('document must not be empty');
    // Did NOT silently fall through to a fresh save.
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents'))).toBe(false);
  });
});

describe('save_document — refresh, Ask-First halt message preserves refresh intent', () => {
  it('tells the agent to include document again on the image follow-up call', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocx(['Original'])) }, opts());

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const imgPath = path.join(inboxDir, 'msg2', 'photo.png');
    fs.writeFileSync(imgPath, buildSignaturePng({ width: 4, height: 4 }));

    const result = await saveDocumentImpl({ path: imgPath, document: 'report' }, opts());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('document: "report"');
  });
});

describe('save_document — refresh, ambiguous slug (two raw files under one slug)', () => {
  it('errors with a specific message instead of proceeding, and touches neither raw file', async () => {
    const documentsDir = path.join(baseDir, 'memory', 'documents');
    const filesDir = path.join(documentsDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    const docxBytes = buildDocxWithTables([[['a1', 'b1']]]);
    const pdfBytes = buildMinimalPdf('Hello');
    fs.writeFileSync(path.join(filesDir, 'dup.docx'), docxBytes);
    fs.writeFileSync(path.join(filesDir, 'dup.pdf'), pdfBytes);
    fs.writeFileSync(
      path.join(documentsDir, 'dup.md'),
      '---\ntype: saved-document\ndescription: "A duplicated slug"\nsource-filename: "dup"\nsaved-date: 2026-01-01T00:00:00.000Z\n---\n\nbody\n',
    );

    const editedPath = writeInboxFile('dup-edited.docx', buildDocx(['Edited']));
    const result = await saveDocumentImpl({ path: editedPath, document: 'dup' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('dup');
    expect(result.content[0].text).toContain('Multiple files');

    // Neither raw file was touched.
    expect(fs.readFileSync(path.join(filesDir, 'dup.docx')).equals(docxBytes)).toBe(true);
    expect(fs.readFileSync(path.join(filesDir, 'dup.pdf')).equals(pdfBytes)).toBe(true);
  });
});

describe('save_document — refresh, symlink refusal at the old (pre-refresh) raw file path', () => {
  it('refuses to touch a symlink planted at the old raw file location', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocx(['Original'])) }, opts());

    const oldRawPath = path.join(baseDir, 'memory', 'documents', 'files', 'report.docx');
    const outsideTarget = path.join(tmpRoot, 'outside-old-raw.bin');
    fs.writeFileSync(outsideTarget, 'do not touch me');
    fs.unlinkSync(oldRawPath);
    fs.symlinkSync(outsideTarget, oldRawPath);

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-edited.docx');
    fs.writeFileSync(editedPath, buildDocx(['Edited']));

    const result = await saveDocumentImpl({ path: editedPath, document: 'report' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('symlink');
    expect(fs.readFileSync(outsideTarget, 'utf-8')).toBe('do not touch me');
  });
});

describe('save_document — refresh, symlink refusal at the new (post-refresh) raw file path', () => {
  it('refuses to touch a symlink planted at the new-extension raw file location', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.pdf', buildMinimalPdf('Original PDF')) }, opts());

    const filesDir = path.join(baseDir, 'memory', 'documents', 'files');
    // Dangling on purpose (target doesn't exist) — a *live* symlink here
    // would make fs.existsSync see it as a second real raw file and trip
    // the earlier ambiguousExtensions guard instead of ever reaching this
    // specific check; refuseIfSymlink uses lstat (not existsSync), so a
    // dangling link is exactly what isolates this one code path.
    const newRawPath = path.join(filesDir, 'report.docx');
    fs.symlinkSync(path.join(tmpRoot, 'does-not-exist.bin'), newRawPath);

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-edited.docx');
    fs.writeFileSync(editedPath, buildDocx(['Edited docx content']));

    const result = await saveDocumentImpl({ path: editedPath, document: 'report' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('symlink');
    // The dangling symlink itself was never followed/replaced.
    expect(fs.lstatSync(newRawPath).isSymbolicLink()).toBe(true);
    // The refusal happens before anything (including the pre-refresh
    // snapshot) is written — the old .pdf raw file is untouched too.
    expect(fs.existsSync(path.join(filesDir, 'report.pdf'))).toBe(true);
  });
});

describe('save_document — refresh, symlink refusal at the concept file path', () => {
  it('refuses to touch a symlink planted at the concept .md file location', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocx(['Original'])) }, opts());

    const conceptPath = path.join(baseDir, 'memory', 'documents', 'report.md');
    const outsideTarget = path.join(tmpRoot, 'outside-concept.bin');
    fs.writeFileSync(outsideTarget, 'do not touch me');
    fs.unlinkSync(conceptPath);
    fs.symlinkSync(outsideTarget, conceptPath);

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-edited.docx');
    fs.writeFileSync(editedPath, buildDocx(['Edited']));

    const result = await saveDocumentImpl({ path: editedPath, document: 'report' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('symlink');
    expect(fs.readFileSync(outsideTarget, 'utf-8')).toBe('do not touch me');
  });
});

describe('save_document — refresh, source path outside both inbox and .document-fills', () => {
  it('refuses an arbitrary absolute path elsewhere, does not silently allow it through', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocx(['Original'])) }, opts());

    const outsideDir = path.join(tmpRoot, 'elsewhere');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsidePath = path.join(outsideDir, 'sneaky.docx');
    fs.writeFileSync(outsidePath, buildDocx(['Sneaky content']));

    const result = await saveDocumentImpl({ path: outsidePath, document: 'report' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outside the inbox');
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'report.md'), 'utf-8');
    expect(concept).toContain('Original');
    expect(concept).not.toContain('Sneaky content');
  });
});

describe('save_document — a plain (non-refresh) save cannot source its path from .document-fills', () => {
  it('refuses a .document-fills path when document is omitted (regression guard for the item-3 fix)', async () => {
    // Produce a real .document-fills output the normal way (a fill).
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());
    const fill = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(fill.isError).toBeFalsy();
    const fillOutputPath = extractOutPath(fill.content[0].text);
    expect(fs.existsSync(fillOutputPath)).toBe(true);

    // No `document` argument — this must stay inbox-only, exactly like
    // before this story; sourcing from .document-fills is only allowed on
    // an explicit refresh call.
    const result = await saveDocumentImpl({ path: fillOutputPath }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outside the inbox');
  });
});

// ---------------------------------------------------------------------------
// list_documents
// ---------------------------------------------------------------------------

describe('list_documents tool metadata', () => {
  it('has no required arguments', () => {
    expect(listDocuments.tool.name).toBe('list_documents');
    expect(listDocuments.tool.inputSchema.required ?? []).toEqual([]);
  });
});

describe('list_documents', () => {
  it('reports no saved documents when memory is empty', async () => {
    const result = await listDocumentsImpl({}, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('No saved documents');
  });

  it('returns everything when no query is given', async () => {
    await saveDocumentImpl({ path: writeInboxFile('alpha.docx', buildDocx(['A'])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('beta.docx', buildDocx(['B'])) }, opts());

    const result = await listDocumentsImpl({}, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('alpha');
    expect(result.content[0].text).toContain('beta');
  });

  it('errors clearly when a query matches nothing', async () => {
    await saveDocumentImpl({ path: writeInboxFile('alpha.docx', buildDocx(['A'])) }, opts());

    const result = await listDocumentsImpl({ query: 'no-such-document' }, opts());
    expect(result.isError).toBe(true);
  });

  it('returns a numbered candidate list when a query matches more than one document', async () => {
    await saveDocumentImpl({ path: writeInboxFile('Report A.docx', buildDocx(['A'])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('Report B.docx', buildDocx(['B'])) }, opts());

    const result = await listDocumentsImpl({ query: 'report' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('1.');
    expect(result.content[0].text).toContain('2.');
    expect(result.content[0].text).toContain('report-a');
    expect(result.content[0].text).toContain('report-b');
  });
});

// ---------------------------------------------------------------------------
// fill_document_field — targeting/tool metadata + document resolution
// ---------------------------------------------------------------------------

describe('fill_document_field tool metadata', () => {
  it('declares document as the only required argument', () => {
    expect(fillDocumentField.tool.name).toBe('fill_document_field');
    expect(fillDocumentField.tool.inputSchema).toMatchObject({ required: ['document'] });
  });
});

describe('fill_document_field — document resolution', () => {
  it('errors clearly when no saved document matches', async () => {
    const result = await fillDocumentFieldImpl({ document: 'nonexistent', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
  });

  it('returns a numbered candidate list (not an error) when the reference is ambiguous', async () => {
    await saveDocumentImpl({ path: writeInboxFile('Report A.docx', buildDocx(['A'])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('Report B.docx', buildDocx(['B'])) }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('report-a');
    expect(result.content[0].text).toContain('report-b');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fill_document_field — .docx table-row path
// ---------------------------------------------------------------------------

describe('fill_document_field — docx happy path', () => {
  it("fills the row's last cell by default, leaving everything else byte-identical", async () => {
    const original = buildDocxWithTables([
      [
        ['a1', 'b1'],
        ['a2', 'b2'],
      ],
    ]);
    const filePath = writeInboxFile('report.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', table: 1, row: 2, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const originalXml = await readDocxXml(original);
    const newBuf = fs.readFileSync(outPath);
    const newXml = await readDocxXml(newBuf);

    expect(newXml).not.toEqual(originalXml);
    const { before, after } = diffMiddle(originalXml, newXml);
    expect(before).toBe('b2');
    expect(after).toBe('X');

    // Rest of the document round-trips through jszip untouched.
    expect(docxXmlToText(newXml)).toContain('a1');
    expect(docxXmlToText(newXml)).toContain('b1');
    expect(docxXmlToText(newXml)).toContain('a2');
    expect(docxXmlToText(newXml)).not.toContain('b2');
    expect(docxXmlToText(newXml)).toContain('X');
  });
});

describe('fill_document_field — docx, control characters in value are stripped', () => {
  it('strips a raw control byte from value before splicing into word/document.xml', async () => {
    const original = buildDocxWithTables([[['a1', 'b1']]]);
    const filePath = writeInboxFile('report.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    // eslint-disable-next-line no-control-regex
    const dirtyValue = 'be\x01fore\nafter';
    const result = await fillDocumentFieldImpl({ document: 'report', table: 1, row: 1, value: dirtyValue }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));

    // The inserted run itself carries no control bytes -- only the value's alphanumeric
    // content survives, joined with nothing (the control byte and the newline are both gone).
    const insertedRun = /<w:t[^>]*>beforeafter<\/w:t>/.exec(newXml);
    expect(insertedRun).not.toBeNull();
    expect(docxXmlToText(newXml)).toContain('beforeafter');
  });
});

describe('fill_document_field — docx, explicit column', () => {
  it('fills the first cell instead of the last when column is given', async () => {
    const original = buildDocxWithTables([[['a1', 'b1']]]);
    const filePath = writeInboxFile('report.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    expect(docxXmlToText(newXml)).toContain('X');
    expect(docxXmlToText(newXml)).toContain('b1');
    expect(docxXmlToText(newXml)).not.toContain('a1');
  });
});

describe('fill_document_field — docx, single table, no table number given', () => {
  it('infers table 1', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('table 1');
  });

  it('asks for a table number when more than one table exists', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1']], [['a2']]]));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('table');
  });
});

describe('fill_document_field — docx, nested table', () => {
  it('declines cleanly instead of miscounting or corrupting the cell', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(nestedTableRowXml()));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nested table');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field — docx, empty target cell (no existing run)', () => {
  it('inserts a new run rather than erroring', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(rowWithEmptyLastCellXml('a1')));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    expect(docxXmlToText(newXml)).toContain('X');
    expect(docxXmlToText(newXml)).toContain('a1');
  });
});

describe('fill_document_field — docx, unresolvable target', () => {
  it('declines cleanly when the table number does not exist, no file written', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', table: 9, row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });

  it('declines cleanly when the row number does not exist, no file written', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 9, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fill_document_field — .docx text-line fill (Story 1.4)
// ---------------------------------------------------------------------------

function bodyParagraphXml(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text.replace(/&/g, '&amp;')}</w:t></w:r></w:p>`;
}

/** A paragraph whose text is split across multiple runs, e.g. a label run followed by a separate blank run. */
function bodyParagraphWithRunsXml(texts: string[]): string {
  const runs = texts.map((t) => `<w:r><w:t xml:space="preserve">${t.replace(/&/g, '&amp;')}</w:t></w:r>`).join('');
  return `<w:p>${runs}</w:p>`;
}

function buildDocxRawBody(bodyPartsXml: string[]): Buffer {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${bodyPartsXml.join('')}</w:body></w:document>`;
  return buildStoredZip([{ name: 'word/document.xml', data: Buffer.from(xml, 'utf-8') }]);
}

describe('fill_document_field — docx text-line, discovery (no tables)', () => {
  it('returns a numbered list of detected fill-in-the-blank paragraphs, excluding plain prose', async () => {
    const filePath = writeInboxFile(
      'intake.docx',
      buildDocx(['שם: ___________', 'Just a sentence with no blank.', 'תאריך:']),
    );
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('1. שם: ___________');
    expect(result.content[0].text).toContain('2. תאריך:');
    expect(result.content[0].text).not.toContain('Just a sentence');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field — docx text-line, underscore blank in its own run', () => {
  it('replaces exactly the underscore run, leaving a separate label run and other paragraphs byte-identical', async () => {
    const original = buildDocxRawBody([
      bodyParagraphWithRunsXml(['שם: ', '___________']),
      bodyParagraphXml('Second paragraph, untouched.'),
    ]);
    const filePath = writeInboxFile('intake.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 1, value: 'Ada Lovelace' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Filled line 1');

    const outPath = extractOutPath(result.content[0].text);
    const originalXml = await readDocxXml(original);
    const newXml = await readDocxXml(fs.readFileSync(outPath));

    expect(newXml).not.toEqual(originalXml);
    const { before, after } = diffMiddle(originalXml, newXml);
    expect(before).toBe('___________');
    expect(after).toBe('Ada Lovelace');

    expect(docxXmlToText(newXml)).toContain('שם: Ada Lovelace');
    expect(docxXmlToText(newXml)).toContain('Second paragraph, untouched.');
  });
});

describe('fill_document_field — docx text-line, label and blank sharing a single run', () => {
  it('replaces the whole run (accepted limitation, same wholesale-splice behavior as a table cell)', async () => {
    const filePath = writeInboxFile('intake.docx', buildDocx(['שם: ___________']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 1, value: 'Ada Lovelace' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    expect(docxXmlToText(newXml)).toBe('Ada Lovelace');
  });
});

describe('fill_document_field — docx text-line, underscore run fragmented across multiple <w:t> nodes', () => {
  it('sets the value on the first overlapping run and blanks the rest, mirroring replaceCellText', async () => {
    const original = buildDocxRawBody([bodyParagraphWithRunsXml(['label: ', '___', '________'])]);
    const filePath = writeInboxFile('intake.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    expect(docxXmlToText(newXml)).toBe('label: X');
  });
});

describe('fill_document_field — docx text-line, trailing-colon blank (no underscores)', () => {
  it("inserts a new run right after the paragraph's last existing run", async () => {
    const original = buildDocxRawBody([bodyParagraphXml('תאריך:'), bodyParagraphXml('Untouched paragraph.')]);
    const filePath = writeInboxFile('intake.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 1, value: '16/08/2026' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const originalXml = await readDocxXml(original);
    const newXml = await readDocxXml(fs.readFileSync(outPath));

    expect(newXml).not.toEqual(originalXml);
    // The original run ("תאריך:") is untouched; a brand-new <w:t> run was inserted right after it.
    expect(newXml).toContain('<w:t xml:space="preserve">תאריך:</w:t>');
    expect(docxXmlToText(newXml)).toContain('תאריך: 16/08/2026');
    expect(docxXmlToText(newXml)).toContain('Untouched paragraph.');
  });
});

describe('fill_document_field — docx, table + non-table paragraph, row given', () => {
  it('table-row targeting wins; the non-table blank-line paragraph is untouched', async () => {
    const original = buildDocxRawBody([tableXml([['a1', 'b1']]), bodyParagraphXml('שם: ___________')]);
    const filePath = writeInboxFile('mixed.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'mixed', row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('table 1');

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    expect(docxXmlToText(newXml)).toContain('a1');
    expect(docxXmlToText(newXml)).toContain('X');
    expect(docxXmlToText(newXml)).toContain('שם: ___________');
  });
});

describe('fill_document_field — docx, table + non-table paragraph, lineNumber given', () => {
  it('text-line targeting wins against the paragraph; the table is untouched', async () => {
    const original = buildDocxRawBody([tableXml([['a1', 'b1']]), bodyParagraphXml('שם: ___________')]);
    const filePath = writeInboxFile('mixed.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'mixed', lineNumber: 1, value: 'Ada Lovelace' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Filled line 1');

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    expect(docxXmlToText(newXml)).toContain('a1');
    expect(docxXmlToText(newXml)).toContain('b1');
    expect(docxXmlToText(newXml)).not.toContain('___________');
    expect(docxXmlToText(newXml)).toContain('Ada Lovelace');
  });
});

describe('fill_document_field — docx, table + non-table paragraph, bare discovery', () => {
  it('names both possibilities: the table-row prompt AND the numbered blank-line list', async () => {
    const original = buildDocxRawBody([tableXml([['a1', 'b1']]), bodyParagraphXml('שם: ___________')]);
    const filePath = writeInboxFile('mixed.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'mixed' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('row is required');
    expect(result.content[0].text).toContain('lineNumber');
    expect(result.content[0].text).toContain('1. שם: ___________');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field — docx, table only, bare discovery', () => {
  it('still returns the table-row prompt (no blank-line list, unchanged from Story 1.2)', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('row is required');
    expect(result.content[0].text).not.toContain('Detected fill-in-the-blank');
  });
});

describe('fill_document_field — docx text-line, lineNumber given with no value', () => {
  it('returns the specific "value or signatureName is required together with lineNumber" error', async () => {
    const filePath = writeInboxFile('intake.docx', buildDocx(['שם: ___________']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 1 }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('value or signatureName is required together with lineNumber');
  });
});

describe('fill_document_field — docx, row and lineNumber given together', () => {
  it('errors instead of silently picking the table path', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, lineNumber: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('row');
    expect(result.content[0].text).toContain('lineNumber');
    expect(result.content[0].text).toContain('not both');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field — docx, column given without row/table', () => {
  it('errors instead of silently ignoring column', async () => {
    const filePath = writeInboxFile('intake.docx', buildDocx(['שם: ___________']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake', column: 2, lineNumber: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('column');
    expect(result.content[0].text).toContain('row');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field — docx text-line, two blanks in one paragraph', () => {
  it('produces two separate numbered candidates, both independently fillable', async () => {
    // Each blank in its own <w:t> run (the realistic Word shape) so filling one never
    // wholesale-replaces the other -- that's the separate, already-documented single-run
    // limitation (see "label and blank sharing a single run" above), not this case.
    const original = buildDocxRawBody([bodyParagraphWithRunsXml(['Name: ', '___', ' Date: ', '___'])]);
    const filePath = writeInboxFile('intake.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    const discovery = await fillDocumentFieldImpl({ document: 'intake' }, opts());
    expect(discovery.isError).toBeFalsy();
    expect(discovery.content[0].text).toContain('1. Name: ___ Date: ___');
    expect(discovery.content[0].text).toContain('2. Name: ___ Date: ___');

    const firstFill = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 1, value: 'Ada' }, opts());
    expect(firstFill.isError).toBeFalsy();
    const firstOutPath = extractOutPath(firstFill.content[0].text);
    const firstXml = await readDocxXml(fs.readFileSync(firstOutPath));
    expect(docxXmlToText(firstXml)).toContain('Ada');
    expect(docxXmlToText(firstXml)).toContain('Date: ___');

    const secondFill = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 2, value: '16/08/2026' }, opts());
    expect(secondFill.isError).toBeFalsy();
    const secondOutPath = extractOutPath(secondFill.content[0].text);
    const secondXml = await readDocxXml(fs.readFileSync(secondOutPath));
    expect(docxXmlToText(secondXml)).toContain('Name: ___');
    expect(docxXmlToText(secondXml)).toContain('16/08/2026');
  });
});

describe('fill_document_field — docx text-line, purely decorative underscore divider', () => {
  it('is never offered as a fill target (no label text once underscores are stripped)', async () => {
    const filePath = writeInboxFile('intake.docx', buildDocx(['_____________________________', 'שם: ___________']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake' }, opts());
    expect(result.isError).toBeFalsy();
    // Only the real label+blank line is listed, numbered 1 -- the pure divider is skipped entirely.
    expect(result.content[0].text).toContain('1. שם: ___________');
    expect(result.content[0].text).not.toContain('_____________________________');
  });
});

describe('fill_document_field — docx text-line, trailing-colon false-positive guard', () => {
  it('does not treat a long prose sentence ending in ":" as a fill-in-the-blank line', async () => {
    const filePath = writeInboxFile(
      'prose.docx',
      buildDocx(['Please review the following important items before signing:', 'תאריך:']),
    );
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'prose' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('1. תאריך:');
    expect(result.content[0].text).not.toContain('Please review');
  });
});

describe('fill_document_field — docx text-line, tab between label and blank', () => {
  it('renders the tab as a space in the discovery listing text', async () => {
    // Label run, then a run containing only a <w:tab/>, then the blank run.
    const paragraph =
      '<w:p><w:r><w:t xml:space="preserve">שם:</w:t></w:r><w:r><w:tab/></w:r>' +
      '<w:r><w:t xml:space="preserve">___________</w:t></w:r></w:p>';
    const doc = buildDocxRawBody([paragraph]);
    const filePath = writeInboxFile('intake.docx', doc);
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('1. שם: ___________');
  });
});

describe('fill_document_field — docx text-line, no marker found anywhere', () => {
  it('declines clearly when there is no table and no fill-in-the-blank line, no file written', async () => {
    const filePath = writeInboxFile('prose.docx', buildDocx(['Just a plain sentence.', 'Another one, no blanks.']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'prose' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no tables');
    expect(result.content[0].text).toContain('fill-in-the-blank');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field — docx text-line, lineNumber out of range', () => {
  it('declines clearly and states how many lines were found, no file written', async () => {
    const filePath = writeInboxFile('intake.docx', buildDocx(['שם: ___________', 'תאריך:']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 5, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('2 detected');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fill_document_field — .pdf AcroForm path
// ---------------------------------------------------------------------------

describe('fill_document_field — PDF AcroForm field match', () => {
  it('sets the field value via pdf-lib with no page redraw', async () => {
    const pdfBytes = await buildAcroFormPdf('Name');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    // This fixture has no page content stream text (only a form widget), so
    // save_document takes its scanned/no-text-layer two-call path.
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A form with a Name field.' }, opts());

    const result = await fillDocumentFieldImpl({ document: 'form', fieldName: 'Name', value: 'Ada Lovelace' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const { PDFDocument } = await import('pdf-lib');
    const filledDoc = await PDFDocument.load(fs.readFileSync(outPath));
    expect(filledDoc.getForm().getTextField('Name').getText()).toBe('Ada Lovelace');
  });
});

describe('fill_document_field — PDF AcroForm no match', () => {
  it('errors listing the actual field names on the form', async () => {
    const pdfBytes = await buildAcroFormPdf('Name');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A form with a Name field.' }, opts());

    const result = await fillDocumentFieldImpl({ document: 'form', fieldName: 'DoesNotExist', value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Name');
  });
});

// ---------------------------------------------------------------------------
// fill_document_field — .pdf text-layer line-overlay path (two-call)
// ---------------------------------------------------------------------------

describe('fill_document_field — PDF text-layer, first call', () => {
  it('returns a numbered list of detected lines', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Name: ______', 'Date: ______']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'letter' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Name:');
    expect(result.content[0].text).toContain('Date:');
    expect(result.content[0].text).toContain('lineNumber');
  });
});

describe('fill_document_field — PDF text-layer, second call', () => {
  it('draws the value right after the chosen line, preserving the original content', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Name: ______', 'Date: ______']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'letter', lineNumber: 1, value: 'Ada Lovelace' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const text = await extractAllPdfText(outPath);
    expect(text).toContain('Name:');
    expect(text).toContain('Date:');
    expect(text).toContain('Ada Lovelace');
  });
});

// ---------------------------------------------------------------------------
// fill_document_field — .pdf scanned pixel-overlay path (two-call)
// ---------------------------------------------------------------------------

describe('fill_document_field — PDF scanned, first call', () => {
  it('renders page 1 and returns its pixel dimensions', async () => {
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A scanned page.' }, opts());

    const result = await fillDocumentFieldImpl({ document: 'scan' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/\d+x\d+px/);
    expect(result.content[0].text).toContain('pixelX');
  });
});

describe('fill_document_field — PDF scanned, second call', () => {
  it('draws the value at the converted point-space position', async () => {
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A scanned page.' }, opts());

    const result = await fillDocumentFieldImpl({ document: 'scan', pixelX: 40, pixelY: 60, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    expect(fs.existsSync(outPath)).toBe(true);
    const text = await extractAllPdfText(outPath);
    expect(text).toContain('X');
  });
});

// ---------------------------------------------------------------------------
// Storage never mutated by a fill (spine's Deferred default)
// ---------------------------------------------------------------------------

describe('fill_document_field — stored canonical copy is never modified', () => {
  it('leaves the stored .docx and its extracted-text concept file untouched', async () => {
    const original = buildDocxWithTables([[['a1', 'b1']]]);
    const filePath = writeInboxFile('report.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());

    const rawPath = path.join(baseDir, 'memory', 'documents', 'files', 'report.docx');
    const conceptPath = path.join(baseDir, 'memory', 'documents', 'report.md');
    const rawBefore = fs.readFileSync(rawPath);
    const conceptBefore = fs.readFileSync(conceptPath, 'utf-8');

    await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());

    expect(fs.readFileSync(rawPath).equals(rawBefore)).toBe(true);
    expect(fs.readFileSync(conceptPath, 'utf-8')).toBe(conceptBefore);
  });
});

// ---------------------------------------------------------------------------
// Code-review findings (patch tier), applied to this same story:
//   1. AcroForm auto-discovery on a PDF's first call
//   2. Hebrew (non-Latin1) values on PDF fills
//   3. Overlay-render filename uniqueness (concurrency)
//   4. Wrong-file-type args rejected instead of silently ignored
//   5. Merged-cell (gridSpan) detect-and-decline
//   6. Malformed-OOXML safety
//   7. PDF pixel-position bounds check
//   8. Off-page line-overlay check
//   9. Empty/whitespace document query rejected
//  10. CRLF-tolerant frontmatter parsing
//  12. Ambiguous-slug (two raw files under one slug) clarity
//  13. Multi-run <w:t> cell / non-text AcroForm field coverage
// ---------------------------------------------------------------------------

function cellWithMultipleRunsXml(texts: string[]): string {
  const runs = texts.map((t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`).join('');
  return `<w:tc><w:p>${runs}</w:p></w:tc>`;
}

function gridSpanRowXml(): string {
  return (
    '<w:tr>' +
    '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">merged</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t xml:space="preserve">c3</w:t></w:r></w:p></w:tc>' +
    '</w:tr>'
  );
}

/** An unclosed <w:tr> — </w:tbl> ends up closing the table while the row/cell/paragraph/run are still open. */
function unclosedRowXml(): string {
  return '<w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">a</w:t></w:r></w:p>';
}

async function buildTextPdfWithAcroForm(text: string, fieldName: string): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([300, 200]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 20, y: 150, size: 14, font });
  const form = pdfDoc.getForm();
  const textField = form.createTextField(fieldName);
  textField.addToPage(page, { x: 20, y: 100, width: 150, height: 20 });
  return Buffer.from(await pdfDoc.save());
}

async function buildAcroFormCheckboxPdf(fieldName: string): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([200, 200]);
  const form = pdfDoc.getForm();
  const checkBox = form.createCheckBox(fieldName);
  checkBox.addToPage(page, { x: 20, y: 100, width: 20, height: 20 });
  return Buffer.from(await pdfDoc.save());
}

/** A text field with two widgets (e.g. the same field repeated on two pages) — legal, but ambiguous for image placement. */
async function buildAcroFormPdfWithTwoWidgets(fieldName: string): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const page1 = pdfDoc.addPage([200, 200]);
  const page2 = pdfDoc.addPage([200, 200]);
  const form = pdfDoc.getForm();
  const textField = form.createTextField(fieldName);
  textField.addToPage(page1, { x: 20, y: 100, width: 150, height: 20 });
  textField.addToPage(page2, { x: 20, y: 100, width: 150, height: 20 });
  return Buffer.from(await pdfDoc.save());
}

/** A degenerate (zero-area) widget rectangle — legal per the PDF spec, but nothing to size an image against. */
/**
 * A degenerate widget rectangle. addToPage's own { width: 0, height: 0 }
 * isn't enough on its own — pdf-lib's createWidget() inflates the
 * requested rect by its default border width (see the AcroForm signature
 * test's own comment on this same quirk), so a real, atypical-but-legal
 * `/Rect` has to be forced directly via the widget's own setRectangle()
 * after normal construction, bypassing that inflation entirely.
 */
async function buildAcroFormPdfWithZeroRect(fieldName: string): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([200, 200]);
  const form = pdfDoc.getForm();
  const textField = form.createTextField(fieldName);
  textField.addToPage(page, { x: 20, y: 100, width: 150, height: 20 });
  const widget = textField.acroField.getWidgets()[0];
  widget.setRectangle({ x: 20, y: 100, width: 0, height: 0 });
  return Buffer.from(await pdfDoc.save());
}

/**
 * A real multi-page PDF whose target field's widget lives on page 2, not
 * page 1 — the only fixture in this suite that actually exercises the
 * widget->page resolution beyond the trivial single-page shortcut.
 * `stripP`, when true, deletes the widget's own /P entry after
 * construction (a legal-but-atypical PDF producer omission), forcing
 * pdfFillAcroForm's fallback (scanning each page's /Annots for a matching
 * dict) rather than the fast /P-ref match.
 *
 * Deliberately carries no page content text (mirrors buildAcroFormPdf's
 * shape) — save_document's own text-layer detection would otherwise treat
 * a first save_document call as already-complete, and a second call on
 * the same source path would land as a genuinely separate save (a real
 * slug collision) rather than the scanned-PDF two-call continuation these
 * tests intend.
 */
async function buildMultiPageAcroFormPdf(fieldName: string, opts: { stripP?: boolean } = {}): Promise<Buffer> {
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([200, 200]); // page 1 — deliberately blank, no field, no text
  const page2 = pdfDoc.addPage([200, 200]);
  const form = pdfDoc.getForm();
  const textField = form.createTextField(fieldName);
  textField.addToPage(page2, { x: 20, y: 100, width: 150, height: 20 });

  if (opts.stripP) {
    const widget = form.getTextField(fieldName).acroField.getWidgets()[0];
    widget.dict.delete(PDFName.of('P'));
  }

  return Buffer.from(await pdfDoc.save());
}

function extractRenderPath(text: string): string {
  const m = /to (\S+\.png)\./.exec(text);
  if (!m) throw new Error(`No render path found in response: ${text}`);
  return m[1];
}

// ---------------------------------------------------------------------------
// Signature stamping (Story 1.7) test helpers.
//
// pdf-lib's own drawImage()/drawText() emit deterministic, unrotated
// operator sequences (verified against node_modules/pdf-lib/src/api/
// operations.ts) — a `cm ... cm ... cm ... cm Do` block per drawImage call
// (translate, identity-rotate, scale, identity-skew, in that fixed order)
// and a `Tm` per drawText call. Decoding the real, saved-and-reloaded PDF's
// content stream (FlateDecode by default) and reading those operators back
// out is a genuine, non-mocked check that the production code passed the
// right x/y/width/height into drawImage/drawText — not just that some
// bytes changed.
// ---------------------------------------------------------------------------

/** mirrors documents.ts's FILL_GAP_PT (not exported — a literal here is fine, this is the one value this suite pins down independently of the implementation). */
const GAP_PT = 8;
/** mirrors documents.ts's SIGNATURE_MAX_HEIGHT_PT. */
const SIGNATURE_MAX_HEIGHT_PT = 45;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPageContentsText(page: any): Promise<string> {
  const { PDFArray, PDFRawStream, decodePDFRawStream } = await import('pdf-lib');
  const contents = page.node.Contents();
  if (!contents) return '';
  const streams =
    contents instanceof PDFArray
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (Array.from({ length: contents.size() }, (_, i) => contents.lookup(i, PDFRawStream)) as any[])
      : [contents];
  return streams.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')).join('\n');
}

function extractCmMatrices(text: string): number[][] {
  const re = /^(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm$/gm;
  const out: number[][] = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text))) out.push(m.slice(1, 7).map(Number));
  return out;
}

function extractTmPositions(text: string): Array<{ x: number; y: number }> {
  const re = /^(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) Tm$/gm;
  const out: Array<{ x: number; y: number }> = [];
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text))) out.push({ x: Number(m[5]), y: Number(m[6]) });
  return out;
}

/** A drawImage() call emits exactly 4 `cm` ops (translate, rotate, scale, skew) — [0] is the translate (x,y in e,f), [2] is the scale (width,height in a,d). */
function extractImageDraw(text: string): { x: number; y: number; width: number; height: number } {
  const matrices = extractCmMatrices(text);
  if (matrices.length < 3) {
    throw new Error(`Expected a drawImage()'s cm operators (4), found ${matrices.length} in:\n${text}`);
  }
  const [translate, , scaleM] = matrices;
  return { x: translate[4], y: translate[5], width: scaleM[0], height: scaleM[3] };
}

function writeSavedSignature(name: string, data: Buffer): void {
  const dir = path.join(baseDir, 'memory', 'signatures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.png`), data);
}

// --- 1. AcroForm auto-discovery ---------------------------------------------

describe('fill_document_field — PDF AcroForm auto-discovery', () => {
  it('surfaces the field name alongside the detected-lines list on a first call', async () => {
    const pdfBytes = await buildTextPdfWithAcroForm('Name: ______', 'Name');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    await saveDocumentImpl({ path: filePath }, opts()); // real text layer -> single-call save

    const result = await fillDocumentFieldImpl({ document: 'form' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Name: ______');
    expect(result.content[0].text).toContain('fillable form field');
    expect(result.content[0].text).toContain('Name');
    expect(result.content[0].text).toContain('fieldName');
  });
});

// --- 2. Hebrew (non-Latin1) values -------------------------------------------

describe('fill_document_field — Hebrew value on the PDF line-overlay path', () => {
  it('does not throw and produces a real, non-trivial output PDF', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Name: ______', 'Date: ______']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'letter', lineNumber: 1, value: 'שלום עולם' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const bytes = fs.readFileSync(outPath);
    expect(bytes.length).toBeGreaterThan(500);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

// --- 3. Overlay-render filename uniqueness (concurrency) -------------------

describe('fill_document_field — concurrent scanned-PDF first calls', () => {
  it('renders to distinct paths, neither clobbering the other', async () => {
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A scanned page.' }, opts());

    const [r1, r2] = await Promise.all([
      fillDocumentFieldImpl({ document: 'scan' }, opts()),
      fillDocumentFieldImpl({ document: 'scan' }, opts()),
    ]);
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();

    const p1 = extractRenderPath(r1.content[0].text);
    const p2 = extractRenderPath(r2.content[0].text);
    expect(p1).not.toBe(p2);
    expect(fs.existsSync(p1)).toBe(true);
    expect(fs.existsSync(p2)).toBe(true);
    expect(fs.readFileSync(p1).length).toBeGreaterThan(0);
    expect(fs.readFileSync(p2).length).toBeGreaterThan(0);
  });
});

// --- 4. Wrong-file-type args rejected ---------------------------------------

describe('fill_document_field — wrong-file-type arguments', () => {
  it('rejects .docx-only args against a .pdf document', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Line one']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'letter', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('.pdf');
    expect(result.content[0].text).toContain('row');
  });

  it('rejects .pdf-only args against a .docx document', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', fieldName: 'X', value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('.docx');
    expect(result.content[0].text).toContain('fieldName');
  });

  // Story 1.4: lineNumber moved from PDF-exclusive to a shared arg — a .docx
  // no longer rejects it outright (it addresses the text-line fill path
  // below instead).
  it('no longer rejects lineNumber against a .docx (now a shared arg); a table cell paragraph is never a candidate', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', lineNumber: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("don't apply to a .docx");
    expect(result.content[0].text).toContain('0 detected fill-in-the-blank line');
  });
});

// --- 5. Merged-cell (gridSpan) visual-column targeting -----------------------
//
// gridSpanRowXml(): cell 1 has gridSpan=2 (occupies visual columns 1-2,
// text "merged"), cell 2 is ordinary (visual column 3, text "c3"). Raw
// <w:tc> count is 2; total visual width is 3.

function threeGridSpanCellsRowXml(): string {
  return (
    '<w:tr>' +
    '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">a</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">b</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t xml:space="preserve">c</w:t></w:r></w:p></w:tc>' +
    '</w:tr>'
  );
}

function malformedGridSpanRowXml(gridSpanVal: string): string {
  return (
    '<w:tr>' +
    `<w:tc><w:tcPr><w:gridSpan w:val="${gridSpanVal}"/></w:tcPr>` +
    '<w:p><w:r><w:t xml:space="preserve">first</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t xml:space="preserve">second</w:t></w:r></w:p></w:tc>' +
    '</w:tr>'
  );
}

describe('fill_document_field — docx, merged cell (gridSpan) visual-column targeting', () => {
  it('targets the merged cell when the requested column falls inside its span', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(gridSpanRowXml()));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 2, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    const text = docxXmlToText(newXml);
    expect(text).toContain('X');
    expect(text).not.toContain('merged');
    expect(text).toContain('c3'); // the ordinary cell after the span is untouched
  });

  it('targets the ordinary cell after a merged span when the requested column falls there', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(gridSpanRowXml()));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 3, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    const text = docxXmlToText(newXml);
    expect(text).toContain('X');
    expect(text).not.toContain('c3');
    expect(text).toContain('merged'); // the merged cell is untouched
  });

  it('errors in visual-column terms, not raw <w:tc> count, when the column is beyond the row\'s visual width', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(gridSpanRowXml()));
    await saveDocumentImpl({ path: filePath }, opts());

    // Raw <w:tc> count is 2; total visual width is 3 (span-2 + span-1).
    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 4, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('3 visual column(s)');
    expect(result.content[0].text).not.toContain('2 cell(s)');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });

  it('resolves correctly across multiple gridSpan cells in one row', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(threeGridSpanCellsRowXml()));
    await saveDocumentImpl({ path: filePath }, opts());
    // Visual layout: cell "a" spans cols 1-2, cell "b" spans cols 3-4, cell "c" is col 5.

    const resultA = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 1, value: 'X' }, opts());
    expect(docxXmlToText(await readDocxXml(fs.readFileSync(extractOutPath(resultA.content[0].text))))).toBe('X\nb\nc');

    const resultB = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 4, value: 'X' }, opts());
    expect(docxXmlToText(await readDocxXml(fs.readFileSync(extractOutPath(resultB.content[0].text))))).toBe('a\nX\nc');

    const resultC = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 5, value: 'X' }, opts());
    expect(docxXmlToText(await readDocxXml(fs.readFileSync(extractOutPath(resultC.content[0].text))))).toBe('a\nb\nX');
  });

  it('treats a malformed/unparseable gridSpan value defensively as span 1 rather than crashing', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(malformedGridSpanRowXml('not-a-number')));
    await saveDocumentImpl({ path: filePath }, opts());

    // Treated as span 1 -> visual layout is just [first, second], column 2 hits "second".
    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 2, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    const text = docxXmlToText(await readDocxXml(fs.readFileSync(extractOutPath(result.content[0].text))));
    expect(text).toBe('first\nX');
  });

  it('treats a zero gridSpan value defensively as span 1', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(malformedGridSpanRowXml('0')));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    const text = docxXmlToText(await readDocxXml(fs.readFileSync(extractOutPath(result.content[0].text))));
    expect(text).toBe('X\nsecond');
  });

  it('leaves an unmerged row unaffected (regression safety)', async () => {
    // No gridSpan anywhere in this row — visual columns == raw <w:tc> position,
    // exactly as before merged-cell support existed.
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1', 'c1']]]));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 2, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    const text = docxXmlToText(await readDocxXml(fs.readFileSync(extractOutPath(result.content[0].text))));
    expect(text).toBe('a1\nX\nc1');
  });
});

// --- 5b. Non-"w:"-prefixed namespace binding --------------------------------

describe('fill_document_field — docx, non-"w:" OOXML namespace prefix', () => {
  it('names the real cause instead of the generic "no tables" message, on the row-targeting path', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTableNonWPrefix(rowXml(['Name', ''])));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ns0:');
    expect(result.content[0].text).toContain('"w:"');
    // Not the plain, misleading "genuinely no tables" message.
    expect(result.content[0].text).not.toBe('This document has no tables to fill.');
  });

  it('names the real cause instead of the generic "no tables" message, on the bare-discovery path', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTableNonWPrefix(rowXml(['Name', ''])));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ns0:');
    expect(result.content[0].text).toContain('"w:"');
  });

  it('still reports the plain "no tables" message for a genuinely table-less, standard-"w:" document', async () => {
    const filePath = writeInboxFile('report.docx', buildDocx(['Just a plain paragraph, no table here.']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('This document has no tables to fill.');
    expect(result.content[0].text).not.toContain('prefix');
  });
});

// --- 6. Malformed-OOXML safety ----------------------------------------------

describe('fill_document_field — docx, malformed table XML', () => {
  it('declines cleanly on an unbalanced tag instead of corrupting the output', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(unclosedRowXml()));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('malformed');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

// --- 7. PDF pixel-position bounds check -------------------------------------

describe('fill_document_field — PDF scanned, out-of-bounds pixel position', () => {
  it('errors clearly rather than drawing off the page', async () => {
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A scanned page.' }, opts());

    const result = await fillDocumentFieldImpl({ document: 'scan', pixelX: 99999, pixelY: 60, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('bounds');
  });
});

// --- 8. Off-page line-overlay check ------------------------------------------

describe('fill_document_field — PDF text-layer, line already at the page edge', () => {
  it('errors clearly instead of drawing off the visible page', async () => {
    // MediaBox is 300pt wide; a line whose text already runs to the edge
    // leaves no room to draw anything after it on the same baseline.
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['x'.repeat(80)]));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'letter', lineNumber: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('right edge');
  });
});

// --- 9. Empty/whitespace document query -------------------------------------

describe('fill_document_field — whitespace-only document query', () => {
  it('is rejected the same as a missing document argument', async () => {
    const result = await fillDocumentFieldImpl({ document: '   ', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('document is required');
  });
});

// --- 10. CRLF-tolerant frontmatter parsing -----------------------------------

describe('list_documents / fill_document_field — CRLF frontmatter', () => {
  it('parses a concept file whose frontmatter uses CRLF line endings', async () => {
    const documentsDir = path.join(baseDir, 'memory', 'documents');
    const filesDir = path.join(documentsDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, 'crlf-doc.docx'), buildDocxWithTables([[['a1', 'b1']]]));

    const conceptBody = [
      '---',
      'type: saved-document',
      'description: "A CRLF test document"',
      'source-filename: "crlf-doc.docx"',
      'saved-date: 2026-01-01T00:00:00.000Z',
      '---',
      '',
      '# crlf-doc.docx',
      '',
      'body text',
      '',
    ].join('\r\n');
    fs.writeFileSync(path.join(documentsDir, 'crlf-doc.md'), conceptBody);

    const listResult = await listDocumentsImpl({ query: 'crlf' }, opts());
    expect(listResult.isError).toBeFalsy();
    expect(listResult.content[0].text).toContain('crlf-doc');
    expect(listResult.content[0].text).toContain('A CRLF test document');

    const fillResult = await fillDocumentFieldImpl({ document: 'crlf-doc', row: 1, value: 'X' }, opts());
    expect(fillResult.isError).toBeFalsy();
  });
});

// --- 12. Ambiguous-slug clarity ----------------------------------------------

describe('fill_document_field — ambiguous slug (two raw files under one slug)', () => {
  it('errors with a specific message instead of a generic not-found', async () => {
    const documentsDir = path.join(baseDir, 'memory', 'documents');
    const filesDir = path.join(documentsDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(path.join(filesDir, 'dup.docx'), buildDocxWithTables([[['a1', 'b1']]]));
    fs.writeFileSync(path.join(filesDir, 'dup.pdf'), buildMinimalPdf('Hello'));
    fs.writeFileSync(
      path.join(documentsDir, 'dup.md'),
      '---\ntype: saved-document\ndescription: "A duplicated slug"\nsource-filename: "dup"\nsaved-date: 2026-01-01T00:00:00.000Z\n---\n\nbody\n',
    );

    const result = await fillDocumentFieldImpl({ document: 'dup', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('dup');
    expect(result.content[0].text).toContain('Multiple files');
  });
});

// --- 13a. Multi-run <w:t> cell -----------------------------------------------

describe('fill_document_field — docx, multi-run target cell', () => {
  it('sets the value on the first run in document order and blanks the rest', async () => {
    const row = `<w:tr>${cellXml('a1')}${cellWithMultipleRunsXml(['first', 'second'])}</w:tr>`;
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(row));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    const text = docxXmlToText(newXml);
    expect(text).toContain('X');
    expect(text).not.toContain('first');
    expect(text).not.toContain('second');
  });
});

// --- 13b. Non-text AcroForm field --------------------------------------------

describe('fill_document_field — PDF AcroForm field matched but not a text field', () => {
  it('errors clearly rather than throwing uncaught', async () => {
    const pdfBytes = await buildAcroFormCheckboxPdf('Agree');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A form with a checkbox.' }, opts());

    const result = await fillDocumentFieldImpl({ document: 'form', fieldName: 'Agree', value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Agree');
    expect(result.content[0].text).toContain("isn't a fillable text field");
  });
});

// --- 14. .doc — soffice unavailable ------------------------------------------
//
// This describe block runs only when `soffice` is NOT on PATH — the normal
// state of this `bun test` sandbox (spec: "the host bun test sandbox has no
// LibreOffice installed"). It's the deterministic counterpart to the
// soffice-gated block below: it exercises the real absence-handling path
// (execFileSync throwing ENOENT) rather than skipping outright.

// Conversion scratch dirs live under a true ephemeral os.tmpdir() location
// (never opts.baseDir — that's the agent group's *persistent* memory
// volume, and a container death mid-conversion must not orphan a scratch
// dir there), so that's what these tests check for leftovers, not baseDir.
const DOC_CONVERSION_SCRATCH_ROOT = path.join(os.tmpdir(), 'nanoclaw-doc-conversion');

function conversionScratchLeftoverCount(): number {
  return fs.existsSync(DOC_CONVERSION_SCRATCH_ROOT) ? fs.readdirSync(DOC_CONVERSION_SCRATCH_ROOT).length : 0;
}

describe.skipIf(SOFFICE_AVAILABLE)('fill_document_field — .doc, soffice not installed', () => {
  it('declines clearly instead of throwing, when LibreOffice is unavailable', async () => {
    const filePath = writeInboxFile('legacy.doc', Buffer.from('not a real doc file at all', 'utf-8'));
    await saveDocumentImpl({ path: filePath }, opts());

    const before = conversionScratchLeftoverCount();
    const result = await fillDocumentFieldImpl({ document: 'legacy', lineNumber: 1, value: 'X' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('LibreOffice');
    expect(result.content[0].text).toContain('not installed');
    // No conversion scratch dir left behind (per-call subdir is cleaned up
    // in a finally, even on failure), and no fill output file produced.
    expect(conversionScratchLeftoverCount()).toBe(before);
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

// --- 15. .doc — save, recall, and fill via real LibreOffice conversion ------
//
// Gated on a real `soffice` binary being present (see isSofficeAvailable
// above) — skips cleanly rather than failing when it's absent, per the spec's
// explicit requirement. The .doc fixture itself is generated at test time by
// converting a plain-text source through LibreOffice (see buildDocViaSoffice)
// rather than hand-rolled, since .doc is a full OLE2/Compound File Binary
// structure with no practical way to construct one inline.

describe.skipIf(!SOFFICE_AVAILABLE)('save_document / fill_document_field — .doc via real LibreOffice', () => {
  it('saves a .doc, extracting real text via word-extractor (no LibreOffice call in this path)', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-fixture-'));
    const docBytes = buildDocViaSoffice(work, ['Hello from a legacy .doc file.', 'Second paragraph.']);
    const filePath = writeInboxFile('legacy.doc', docBytes);

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    const rawFile = path.join(baseDir, 'memory', 'documents', 'files', 'legacy.doc');
    expect(fs.existsSync(rawFile)).toBe(true);
    expect(fs.readFileSync(rawFile).equals(docBytes)).toBe(true);

    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'legacy.md'), 'utf-8');
    expect(concept).toContain('raw-file: "files/legacy.doc"');
    expect(concept).toContain('Hello from a legacy .doc file.');
    expect(concept).toContain('Second paragraph.');

    fs.rmSync(work, { recursive: true, force: true });
  });

  it('fills a fill-in-the-blank line on a saved .doc: converts once, reuses fillDocx, returns .docx with a disclosure note', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-fixture-'));
    try {
      const docBytes = buildDocViaSoffice(work, ['Name: ___________']);
      const filePath = writeInboxFile('intake.doc', docBytes);
      await saveDocumentImpl({ path: filePath }, opts());

      const before = conversionScratchLeftoverCount();
      const result = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 1, value: 'Ada Lovelace' }, opts());

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Ada Lovelace');
      // Explicit format-change disclosure — never implies the original .doc was edited.
      expect(result.content[0].text).toContain('legacy .doc file');
      expect(result.content[0].text).toContain('.docx');
      // The disclosure note is appended exactly once, not duplicated.
      expect(result.content[0].text.split('legacy .doc file')).toHaveLength(2);

      const fillsDir = path.join(baseDir, '.document-fills');
      const produced = fs.readdirSync(fillsDir);
      expect(produced.length).toBe(1);
      expect(produced[0]).toMatch(/\.docx$/);

      // Conversion scratch space is cleaned up — not left behind per call.
      expect(conversionScratchLeftoverCount()).toBe(before);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('bare-discovery call on a saved .doc never carries the .doc-origin disclosure — no file was written', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-fixture-'));
    try {
      const docBytes = buildDocViaSoffice(work, ['Name: ___________']);
      const filePath = writeInboxFile('intake.doc', docBytes);
      await saveDocumentImpl({ path: filePath }, opts());

      // No row/table/lineNumber given — discovery only, nothing filled.
      const result = await fillDocumentFieldImpl({ document: 'intake' }, opts());

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Detected fill-in-the-blank line');
      // The disclosure only belongs on a completed fill (FILL_SUCCESS_MARKER
      // present) — a discovery response wrote no file, so claiming "this was
      // converted to .docx" here would be factually wrong.
      expect(result.content[0].text).not.toContain('legacy .doc file');
      expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  // Simulates a genuine JS-level throw landing between "scratch dir claimed"
  // (convertDocToDocx has already run real LibreOffice and produced a valid
  // converted .docx in the scratch dir) and fillDoc's `finally` cleanup
  // running — the gap deferred-work.md flagged: only the happy path and
  // synchronous-failure paths (soffice missing, malformed input, etc. — all
  // of which return an err() *before* any throw) were previously covered.
  // Forced here by pre-creating `.document-fills` as a plain file instead of
  // a directory, so writeFillOutput's own fs.mkdirSync (called only after a
  // real, successful conversion) throws EEXIST uncaught — a realistic
  // disk/permission-shaped failure, not a contrived one. A real out-of-process
  // crash (OOM, host restart) can't be simulated in-process at all; os.tmpdir()
  // placement (see fillDoc's own comment) is what bounds *that* case's blast
  // radius, not this test.
  it('still cleans up the scratch dir via finally when a throw happens after a real conversion succeeds', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-fixture-'));
    try {
      const docBytes = buildDocViaSoffice(work, ['Name: ___________']);
      const filePath = writeInboxFile('intake.doc', docBytes);
      await saveDocumentImpl({ path: filePath }, opts());

      // Blocks writeFillOutput's fs.mkdirSync(dir, { recursive: true }) with
      // an uncaught EEXIST — this only fires *after* convertDocToDocx has
      // already succeeded and fillDocx has already parsed/edited the real
      // converted .docx, i.e. strictly between scratch-dir-claim and finally.
      fs.writeFileSync(path.join(baseDir, '.document-fills'), 'blocking file, not a directory');

      const before = conversionScratchLeftoverCount();
      const result = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 1, value: 'Ada Lovelace' }, opts());

      // fillDocumentFieldImpl's own outer try/catch converts the throw into
      // an err() result rather than propagating it — the thing under test
      // here is that the scratch dir doesn't leak despite the throw, not the
      // exact shape of the resulting error.
      expect(result.isError).toBe(true);
      expect(conversionScratchLeftoverCount()).toBe(before);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('reuses the real (unmodified) fillDocx table dispatch after conversion — no table present, so it declines with the same "no tables" error', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-fixture-'));
    try {
      const docBytes = buildDocViaSoffice(work, ['Just a plain paragraph, no table here.']);
      const filePath = writeInboxFile('plain.doc', docBytes);
      await saveDocumentImpl({ path: filePath }, opts());

      const result = await fillDocumentFieldImpl({ document: 'plain', row: 1, value: 'X' }, opts());

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('no tables to fill');
      // An error result must never carry the success-only disclosure note.
      expect(result.content[0].text).not.toContain('legacy .doc file');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('conversion failure (unreadable .doc content) declines clearly, with no partial/broken output file', async () => {
    // Saved successfully (extraction failure alone is never fatal to a save —
    // see the "unreadable content" save test above), but LibreOffice itself
    // cannot make sense of this as a document when fill tries to convert it.
    const filePath = writeInboxFile('garbage.doc', Buffer.from('not a real doc file at all', 'utf-8'));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'garbage', lineNumber: 1, value: 'X' }, opts());

    expect(result.isError).toBe(true);
    // No output .docx produced from a failed conversion.
    const fillsDir = path.join(baseDir, '.document-fills');
    expect(fs.existsSync(fillsDir) ? fs.readdirSync(fillsDir).length : 0).toBe(0);
  });

  it('two concurrent .doc fills on the same document do not collide (unique scratch dir per call)', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-fixture-'));
    try {
      const docBytes = buildDocViaSoffice(work, ['Name: ___________']);
      const filePath = writeInboxFile('concurrent.doc', docBytes);
      await saveDocumentImpl({ path: filePath }, opts());

      const [r1, r2] = await Promise.all([
        fillDocumentFieldImpl({ document: 'concurrent', lineNumber: 1, value: 'Ada Lovelace' }, opts()),
        fillDocumentFieldImpl({ document: 'concurrent', lineNumber: 1, value: 'Grace Hopper' }, opts()),
      ]);

      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      expect(r1.content[0].text).toContain('Ada Lovelace');
      expect(r2.content[0].text).toContain('Grace Hopper');

      // Two distinct, uncorrupted output files — no shared scratch dir/profile collision.
      const fillsDir = path.join(baseDir, '.document-fills');
      const produced = fs.readdirSync(fillsDir);
      expect(produced.length).toBe(2);
      for (const name of produced) {
        expect(name).toMatch(/\.docx$/);
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// save_signature (Story 1.6)
// ---------------------------------------------------------------------------

describe('save_signature tool metadata', () => {
  it('declares path and name as required', () => {
    expect(saveSignature.tool.name).toBe('save_signature');
    expect(saveSignature.tool.inputSchema).toMatchObject({ required: ['path', 'name'] });
  });
});

describe('save_signature — happy path', () => {
  it('removes the near-white background, crops to the ink bounding box, and writes memory/signatures/<name>.png', async () => {
    const filePath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 20, height: 20, ink: { x: 5, y: 8, w: 6, h: 3 } }),
    );

    const result = await saveSignatureImpl({ path: filePath, name: 'uriel' }, opts());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('uriel');
    expect(result.content[0].text).toContain('memory/signatures/uriel.png');

    const destPath = path.join(baseDir, 'memory', 'signatures', 'uriel.png');
    expect(fs.existsSync(destPath)).toBe(true);

    const decoded = PNG.sync.read(fs.readFileSync(destPath));
    // Output PNG's dimensions are the bounding box's, not the source image's (20x20).
    expect(decoded.width).toBe(6);
    expect(decoded.height).toBe(3);

    // Every pixel in the tightly-cropped output is opaque ink (black, alpha 255) —
    // no white border survived the crop.
    for (let i = 0; i < decoded.data.length; i += 4) {
      expect(decoded.data[i]).toBe(0);
      expect(decoded.data[i + 1]).toBe(0);
      expect(decoded.data[i + 2]).toBe(0);
      expect(decoded.data[i + 3]).toBe(255);
    }
  });

  it('makes near-white pixels (>= 240,240,240) fully transparent, leaving darker pixels opaque', async () => {
    // A 3x1 canvas: a near-white pixel (245) that must become transparent, a
    // borderline-dark pixel (239) that must stay opaque, and a black ink pixel.
    const png = new PNG({ width: 3, height: 1 });
    png.data.set([245, 245, 245, 255], 0);
    png.data.set([239, 239, 239, 255], 4);
    png.data.set([0, 0, 0, 255], 8);
    const filePath = writeInboxFile('threshold.png', PNG.sync.write(png));

    const result = await saveSignatureImpl({ path: filePath, name: 'threshold-test' }, opts());
    expect(result.isError).toBeFalsy();

    const decoded = PNG.sync.read(fs.readFileSync(path.join(baseDir, 'memory', 'signatures', 'threshold-test.png')));
    // Bounding box crops out the now-transparent near-white pixel at x=0,
    // leaving just the two surviving pixels (the borderline-dark one and ink).
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(1);
    expect(decoded.data[3]).toBe(255); // former x=1 (239,239,239) stayed opaque
    expect(decoded.data[7]).toBe(255); // former x=2 (black ink) stayed opaque
  });
});

describe('save_signature — no name given', () => {
  it('declines and asks for a name, without writing anything', async () => {
    const filePath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 2, y: 2, w: 3, h: 3 } }),
    );

    const result = await saveSignatureImpl({ path: filePath }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('name is required');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures'))).toBe(false);
  });

  it('also declines for a blank/whitespace-only name', async () => {
    const filePath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 2, y: 2, w: 3, h: 3 } }),
    );

    const result = await saveSignatureImpl({ path: filePath, name: '   ' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('name is required');
  });

  it('declines with a distinct message for a non-string name (e.g. a number), rather than a generic "required"', async () => {
    const filePath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 2, y: 2, w: 3, h: 3 } }),
    );

    const result = await saveSignatureImpl({ path: filePath, name: 42 }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('name must be a string');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures'))).toBe(false);
  });
});

describe('save_signature — name with no Latin letters or digits', () => {
  it('declines rather than silently falling back to slugify\'s generic "document" name', async () => {
    const filePath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 2, y: 2, w: 3, h: 3 } }),
    );

    // A Hebrew-only name: slugify() strips every character (nothing survives
    // its [^a-z0-9]+ filter) and would otherwise fall back to the literal
    // "document" — an invented, unstated name the spec's Boundaries
    // explicitly forbid for a signature.
    const result = await saveSignatureImpl({ path: filePath, name: 'אוריאל' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).not.toContain('name is required'); // distinct from the empty-name case
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures'))).toBe(false);
    // Never silently saved under the generic fallback name either.
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures', 'document.png'))).toBe(false);
  });

  it('an emoji-only name is declined the same way', async () => {
    const filePath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 2, y: 2, w: 3, h: 3 } }),
    );

    const result = await saveSignatureImpl({ path: filePath, name: '🖋️' }, opts());

    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures'))).toBe(false);
  });

  it('a name that is literally "document" is allowed through (not misdetected as the fallback)', async () => {
    const filePath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 2, y: 2, w: 3, h: 3 } }),
    );

    const result = await saveSignatureImpl({ path: filePath, name: 'document' }, opts());

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures', 'document.png'))).toBe(true);
  });
});

describe('save_signature — non-PNG input', () => {
  it('declines cleanly with no file written', async () => {
    const filePath = writeInboxFile('sig.jpg', Buffer.from('not actually a png', 'utf-8'));

    const result = await saveSignatureImpl({ path: filePath, name: 'uriel' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('.jpg');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures'))).toBe(false);
  });
});

describe('save_signature — all-white / blank input', () => {
  it('declines cleanly (no bounding box survives thresholding)', async () => {
    const filePath = writeInboxFile('blank.png', buildSignaturePng({ width: 10, height: 10 }));

    const result = await saveSignatureImpl({ path: filePath, name: 'uriel' }, opts());

    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures', 'uriel.png'))).toBe(false);
  });
});

describe('save_signature — name collision', () => {
  it('appends -2 instead of overwriting the existing file', async () => {
    const first = writeInboxFile(
      'first.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 1, y: 1, w: 2, h: 2 } }),
    );
    const second = writeInboxFile(
      'second.png',
      buildSignaturePng({ width: 12, height: 12, ink: { x: 2, y: 2, w: 4, h: 4 } }),
    );

    const r1 = await saveSignatureImpl({ path: first, name: 'uriel' }, opts());
    expect(r1.isError).toBeFalsy();
    const originalBytes = fs.readFileSync(path.join(baseDir, 'memory', 'signatures', 'uriel.png'));

    const r2 = await saveSignatureImpl({ path: second, name: 'uriel' }, opts());
    expect(r2.isError).toBeFalsy();
    expect(r2.content[0].text).toContain('uriel-2');

    // Original untouched, second written alongside it under the suffixed name.
    expect(fs.readFileSync(path.join(baseDir, 'memory', 'signatures', 'uriel.png')).equals(originalBytes)).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures', 'uriel-2.png'))).toBe(true);
  });

  it('replace: true overwrites the existing file instead of suffixing', async () => {
    const first = writeInboxFile(
      'first.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 1, y: 1, w: 2, h: 2 } }),
    );
    const second = writeInboxFile(
      'second.png',
      buildSignaturePng({ width: 12, height: 12, ink: { x: 2, y: 2, w: 4, h: 4 } }),
    );

    await saveSignatureImpl({ path: first, name: 'uriel' }, opts());
    const r2 = await saveSignatureImpl({ path: second, name: 'uriel', replace: true }, opts());

    expect(r2.isError).toBeFalsy();
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures', 'uriel-2.png'))).toBe(false);

    const decoded = PNG.sync.read(fs.readFileSync(path.join(baseDir, 'memory', 'signatures', 'uriel.png')));
    // The second (replace) save's 4x4 ink rectangle, not the first save's 2x2 one.
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(4);
  });

  it('rejects a non-boolean replace argument', async () => {
    const filePath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 1, y: 1, w: 2, h: 2 } }),
    );

    const result = await saveSignatureImpl({ path: filePath, name: 'uriel', replace: 'yes' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('replace');
  });

  it('replace: true refuses to write through a symlink planted at the destination', async () => {
    const signaturesDir = path.join(baseDir, 'memory', 'signatures');
    fs.mkdirSync(signaturesDir, { recursive: true });

    // Plant a symlink at the exact destination replace:true would write to,
    // pointing at a file outside memory/signatures/ entirely — if the write
    // followed it, that outside file would be silently truncated.
    const outsideTarget = path.join(tmpRoot, 'outside-target.txt');
    fs.writeFileSync(outsideTarget, 'do not touch me');
    fs.symlinkSync(outsideTarget, path.join(signaturesDir, 'uriel.png'));

    const filePath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 1, y: 1, w: 2, h: 2 } }),
    );

    const result = await saveSignatureImpl({ path: filePath, name: 'uriel', replace: true }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('symlink');
    // The symlink target was never touched.
    expect(fs.readFileSync(outsideTarget, 'utf-8')).toBe('do not touch me');
  });
});

describe('save_signature — decode failure', () => {
  it('a corrupted/non-PNG byte stream with a .png extension declines via "Could not decode PNG"', async () => {
    const filePath = writeInboxFile('corrupt.png', Buffer.from('this is not png data at all, just text', 'utf-8'));

    const result = await saveSignatureImpl({ path: filePath, name: 'uriel' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Could not decode PNG');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures'))).toBe(false);
  });

  it('a zero-byte .png file declines via "Could not decode PNG" rather than crashing', async () => {
    const filePath = writeInboxFile('empty.png', Buffer.alloc(0));

    const result = await saveSignatureImpl({ path: filePath, name: 'uriel' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Could not decode PNG');
    expect(fs.existsSync(path.join(baseDir, 'memory', 'signatures'))).toBe(false);
  });
});

describe('save_signature — sequential same-group saves (not a genuine race)', () => {
  // These two calls run through Promise.all, but saveSignatureImpl has no
  // internal await between its fs calls, so under the single-threaded event
  // loop the two invocations actually execute fully sequentially — never
  // interleaved. That still proves something real (idempotent back-to-back
  // saves, first-use mkdirSync not blowing up on a second call), just not a
  // genuine race. The EEXIST-retry branch itself is exercised for real by
  // the dedicated test below, which forces an actual race condition on the
  // wx write rather than relying on incidental interleaving.
  it('two same-name calls, back-to-back, both complete and land on separate files (uriel.png + uriel-2.png)', async () => {
    const a = writeInboxFile('a.png', buildSignaturePng({ width: 10, height: 10, ink: { x: 1, y: 1, w: 2, h: 2 } }));
    const b = writeInboxFile('b.png', buildSignaturePng({ width: 14, height: 14, ink: { x: 3, y: 3, w: 5, h: 5 } }));

    const [r1, r2] = await Promise.all([
      saveSignatureImpl({ path: a, name: 'race' }, opts()),
      saveSignatureImpl({ path: b, name: 'race' }, opts()),
    ]);

    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();

    const signaturesDir = path.join(baseDir, 'memory', 'signatures');
    const written = fs.readdirSync(signaturesDir);
    // Two distinct files (race.png + race-2.png) — neither call silently
    // overwrote the other's output.
    expect(written.length).toBe(2);
    expect(written).toContain('race.png');
    expect(written).toContain('race-2.png');
  });

  it('two different-name calls, back-to-back, both succeed on the first mkdirSync of memory/signatures/', async () => {
    const a = writeInboxFile('a.png', buildSignaturePng({ width: 10, height: 10, ink: { x: 1, y: 1, w: 2, h: 2 } }));
    const b = writeInboxFile('b.png', buildSignaturePng({ width: 10, height: 10, ink: { x: 1, y: 1, w: 2, h: 2 } }));

    const [r1, r2] = await Promise.all([
      saveSignatureImpl({ path: a, name: 'alice' }, opts()),
      saveSignatureImpl({ path: b, name: 'bob' }, opts()),
    ]);

    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();
    const signaturesDir = path.join(baseDir, 'memory', 'signatures');
    expect(fs.existsSync(path.join(signaturesDir, 'alice.png'))).toBe(true);
    expect(fs.existsSync(path.join(signaturesDir, 'bob.png'))).toBe(true);
  });
});

describe('save_signature — EEXIST retry path (writeSignaturePng), genuinely forced', () => {
  it("recovers from a real EEXIST on the wx write (not just uniqueName's up-front check) and completes on retry", async () => {
    const signaturesDir = path.join(baseDir, 'memory', 'signatures');
    fs.mkdirSync(signaturesDir, { recursive: true });
    // Base name already taken, so uniqueName's first legitimate candidate is "uriel-2".
    fs.writeFileSync(path.join(signaturesDir, 'uriel.png'), Buffer.from('existing'));

    const filePath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 10, height: 10, ink: { x: 1, y: 1, w: 2, h: 2 } }),
    );

    const targetPath = path.join(signaturesDir, 'uriel-2.png');
    const realWriteFileSync = fs.writeFileSync;
    let attempts = 0;
    let forced = false;
    // Monkey-patch the exact `{ flag: 'wx' }` write for this one path to
    // throw a real EEXIST once — simulating another writer having just
    // claimed "uriel-2.png" between uniqueName's existsSync check and this
    // write. This forces writeSignaturePng's actual catch block to run (not
    // just its up-front candidate-selection logic), then lets the retry's
    // own write through for real.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fs as any).writeFileSync = (p: fs.PathOrFileDescriptor, data: any, options?: any) => {
      if (p === targetPath && options && options.flag === 'wx') {
        attempts += 1;
        if (!forced) {
          forced = true;
          const eexist: NodeJS.ErrnoException = new Error(`EEXIST: file already exists, open '${p}'`);
          eexist.code = 'EEXIST';
          throw eexist;
        }
      }
      return realWriteFileSync(p, data, options);
    };

    try {
      const result = await saveSignatureImpl({ path: filePath, name: 'uriel' }, opts());

      expect(result.isError).toBeFalsy();
      // Two attempts at the exact same candidate path: the first genuinely
      // threw EEXIST (forced above), the second is the real retry succeeding
      // — proof the catch-and-retry branch itself ran, not just that the
      // final filename happened to land correctly.
      expect(attempts).toBe(2);
      expect(forced).toBe(true);
      expect(result.content[0].text).toContain('uriel-2');
      expect(fs.existsSync(targetPath)).toBe(true);
    } finally {
      fs.writeFileSync = realWriteFileSync;
    }
  });
});

describe('save_signature — path outside inbox', () => {
  it('declines via the existing containment check', async () => {
    const outsidePath = path.join(tmpRoot, 'outside.png');
    fs.writeFileSync(outsidePath, buildSignaturePng({ width: 10, height: 10, ink: { x: 1, y: 1, w: 2, h: 2 } }));

    const result = await saveSignatureImpl({ path: outsidePath, name: 'uriel' }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('inbox');
  });
});

// ---------------------------------------------------------------------------
// fill_document_field — signature stamping (Story 1.7)
// ---------------------------------------------------------------------------

describe('fill_document_field — PDF, signature stamped into AcroForm field', () => {
  it('embeds the image at the widget rect, scaled/centered, aspect-preserved, and leaves the field text unset', async () => {
    const pdfBytes = await buildAcroFormPdf('Signature');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A form with a Signature field.' }, opts());

    // 2:1 aspect ratio source image.
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'form', fieldName: 'Signature', signatureName: 'uriel' },
      opts(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('field text left unset');

    const outPath = extractOutPath(result.content[0].text);
    const { PDFDocument } = await import('pdf-lib');
    const filledDoc = await PDFDocument.load(fs.readFileSync(outPath));
    expect(filledDoc.getForm().getTextField('Signature').getText() || '').toBe('');

    const page = filledDoc.getPages()[0];
    const contentsText = await getPageContentsText(page);
    const draw = extractImageDraw(contentsText);

    // pdf-lib's own createWidget() inflates the { x:20,y:100,w:150,h:20 }
    // requested at addToPage() time by its default border width — read the
    // widget's *actual* on-page rectangle back from the original PDF
    // (exactly what the production code itself reads) rather than
    // hardcoding the requested numbers, so this test verifies our
    // scale-to-fit + centering math against the real rect, not a stale
    // assumption about pdf-lib's own rendering.
    const { PDFDocument: PDFDocumentForRect } = await import('pdf-lib');
    const originalDoc = await PDFDocumentForRect.load(pdfBytes);
    const originalField = originalDoc.getForm().getFieldMaybe('Signature')!;
    const rect = originalField.acroField.getWidgets()[0].getRectangle();
    const expectedImage = await originalDoc.embedPng(
      buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }),
    );
    const { width: expectedWidth, height: expectedHeight } = expectedImage.scaleToFit(rect.width, rect.height);
    const expectedX = rect.x + (rect.width - expectedWidth) / 2;
    const expectedY = rect.y + (rect.height - expectedHeight) / 2;

    expect(draw.width).toBeCloseTo(expectedWidth, 0);
    expect(draw.height).toBeCloseTo(expectedHeight, 0);
    expect(draw.x).toBeCloseTo(expectedX, 0);
    expect(draw.y).toBeCloseTo(expectedY, 0);
    // Aspect ratio preserved (never stretched/distorted).
    expect(draw.width / draw.height).toBeCloseTo(100 / 50, 1);
    // And it actually fits within the widget's own rectangle (never overflows it).
    expect(draw.width).toBeLessThanOrEqual(rect.width + 0.01);
    expect(draw.height).toBeLessThanOrEqual(rect.height + 0.01);
  });

  it("draws text beside the image, at the image's own bottom, when value is also given", async () => {
    const pdfBytes = await buildAcroFormPdf('Signature');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A form with a Signature field.' }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'form', fieldName: 'Signature', signatureName: 'uriel', value: '2026-08-17' },
      opts(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('the signature and "2026-08-17"');
    expect(result.content[0].text).toContain('field text left unset');

    const outPath = extractOutPath(result.content[0].text);
    const { PDFDocument } = await import('pdf-lib');
    const filledDoc = await PDFDocument.load(fs.readFileSync(outPath));
    // The field's own value is still untouched — value only went onto the page.
    expect(filledDoc.getForm().getTextField('Signature').getText() || '').toBe('');

    const page = filledDoc.getPages()[0];
    const contentsText = await getPageContentsText(page);
    const draw = extractImageDraw(contentsText);
    const tmPositions = extractTmPositions(contentsText);
    expect(tmPositions.length).toBeGreaterThan(0);
    expect(tmPositions[0].x).toBeCloseTo(draw.x + draw.width + GAP_PT, 0);
    expect(tmPositions[0].y).toBeCloseTo(draw.y, 0);

    const text = await extractAllPdfText(outPath);
    expect(text).toContain('2026-08-17');
  });
});

// --- Code-review patches (post-implementation) -------------------------------
//  1. Off-page bounding-box check for the line/pixel image targets
//  2. Degenerate (zero/negative-area) widget rectangle declines cleanly
//  3. Non-text / multi-widget AcroForm fields decline cleanly (no arbitrary pick)
//  4. Multi-page widget->page resolution, both the /P fast path and the
//     /Annots-scan fallback (with /P deliberately stripped)
//  5. A malformed /Annots entry is skipped, not left to throw uncaught
// ------------------------------------------------------------------------------

describe('fill_document_field — PDF, signature would run off the page edge', () => {
  it('declines on the text-layer line target instead of drawing off-page', async () => {
    // 300x40 (wide, short) source image scaled to SIGNATURE_MAX_HEIGHT_PT
    // (45pt, always — scaling is by height) comes out ~337pt wide, already
    // wider than the page itself (buildMultilineTextPdf's MediaBox is
    // 300pt) — a pure x-axis overflow. A spacer first line puts the target
    // line (line 2, y=140) well clear of the y-axis check (60pt of
    // headroom, more than the 45pt the image needs), isolating the case to
    // "the derived width alone runs off the right edge."
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Spacer', 'x'.repeat(30)]));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('wide', buildSignaturePng({ width: 300, height: 40, ink: { x: 10, y: 5, w: 280, h: 30 } }));

    const result = await fillDocumentFieldImpl({ document: 'letter', lineNumber: 2, signatureName: 'wide' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('edge');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });

  it('declines on the scanned pixel target instead of drawing off-page', async () => {
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A scanned page.' }, opts());
    writeSavedSignature('wide', buildSignaturePng({ width: 300, height: 40, ink: { x: 10, y: 5, w: 280, h: 30 } }));

    // buildMinimalPdf's MediaBox is 200x200. pixelY=140 -> pdfY=130, 70pt
    // of headroom (more than the 45pt the image needs) — isolates this to
    // a pure x-axis overflow: the ~337pt-wide scaled image alone runs off
    // the right edge from pdfX=20.
    const result = await fillDocumentFieldImpl(
      { document: 'scan', pixelX: 40, pixelY: 140, signatureName: 'wide' },
      opts(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('edge');
  });

  it('declines when the vertical extent alone would overrun the top of the page', async () => {
    // A tall-aspect (narrow, tall) signature anchored near the top of the
    // page overruns on the y axis even though x has plenty of room.
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A scanned page.' }, opts());
    writeSavedSignature('tall', buildSignaturePng({ width: 20, height: 300, ink: { x: 2, y: 5, w: 16, h: 280 } }));

    // pixelY near 0 -> pdfY near the page's top edge (200pt); any
    // meaningful height pushes pdfY + height past 200.
    const result = await fillDocumentFieldImpl(
      { document: 'scan', pixelX: 40, pixelY: 2, signatureName: 'tall' },
      opts(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('edge');
  });
});

describe('fill_document_field — PDF, degenerate AcroForm widget rectangle', () => {
  it('declines instead of returning a false success for a zero-area rect', async () => {
    const pdfBytes = await buildAcroFormPdfWithZeroRect('Signature');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A form with a zero-rect field.' }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'form', fieldName: 'Signature', signatureName: 'uriel' },
      opts(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('degenerate');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field — PDF, AcroForm signature stamp against a non-text/multi-widget field', () => {
  it('declines cleanly for a checkbox field rather than picking an arbitrary widget', async () => {
    const pdfBytes = await buildAcroFormCheckboxPdf('Agree');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A form with a checkbox.' }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'form', fieldName: 'Agree', signatureName: 'uriel' },
      opts(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Agree');
    expect(result.content[0].text).toContain("isn't a fillable text field");
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });

  it('declines cleanly for a text field with more than one widget', async () => {
    const pdfBytes = await buildAcroFormPdfWithTwoWidgets('Signature');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    // Both pages carry only a form-field widget, no drawn text — each needs
    // OCR under save_document's per-page routing. A non-empty mock OCR
    // result lets both resolve without an Ask-First halt, so a single call
    // (unlike the old page-1-only flow's fixed two-call pattern) completes
    // the save; this test is about fill_document_field's own widget-count
    // check downstream, not save_document's extraction path.
    mockOcrResult = { text: 'A form with a two-widget field.' };
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'form', fieldName: 'Signature', signatureName: 'uriel' },
      opts(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Signature');
    expect(result.content[0].text).toContain('2 widgets');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field — PDF, AcroForm signature stamp, multi-page widget->page resolution', () => {
  it('stamps on the page the widget is actually on (page 2), via the /P fast path', async () => {
    const pdfBytes = await buildMultiPageAcroFormPdf('Signature');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    // Neither page has drawn text (page 1 is deliberately blank; page 2's
    // form-field widget draws nothing to the content stream either) — both
    // need OCR under save_document's per-page routing. A non-empty mock OCR
    // result resolves both without an Ask-First halt, so one call completes
    // the save; this test is about fill_document_field's own widget->page
    // resolution downstream, not save_document's extraction path.
    mockOcrResult = { text: 'A two-page form, field on page 2.' };
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'form', fieldName: 'Signature', signatureName: 'uriel' },
      opts(),
    );
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const { PDFDocument } = await import('pdf-lib');
    const filledDoc = await PDFDocument.load(fs.readFileSync(outPath));
    const [page1, page2] = filledDoc.getPages();

    const page1Text = await getPageContentsText(page1);
    expect(() => extractImageDraw(page1Text)).toThrow(); // nothing drawn on page 1

    const page2Text = await getPageContentsText(page2);
    const draw = extractImageDraw(page2Text); // does not throw — image is here
    expect(draw.width).toBeGreaterThan(0);
    expect(draw.height).toBeGreaterThan(0);
  });

  it('stamps on the correct page via the /Annots-scan fallback when /P is stripped', async () => {
    const pdfBytes = await buildMultiPageAcroFormPdf('Signature', { stripP: true });
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    // See the sibling /P-fast-path test above — neither page has drawn
    // text, so both need OCR; a non-empty mock result resolves both in one
    // save_document call.
    mockOcrResult = { text: 'A two-page form, field on page 2, /P stripped.' };
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'form', fieldName: 'Signature', signatureName: 'uriel' },
      opts(),
    );
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const { PDFDocument } = await import('pdf-lib');
    const filledDoc = await PDFDocument.load(fs.readFileSync(outPath));
    const [page1, page2] = filledDoc.getPages();

    const page1Text = await getPageContentsText(page1);
    expect(() => extractImageDraw(page1Text)).toThrow();

    const page2Text = await getPageContentsText(page2);
    const draw = extractImageDraw(page2Text);
    expect(draw.width).toBeGreaterThan(0);
    expect(draw.height).toBeGreaterThan(0);
  });
});

describe('fill_document_field — PDF, AcroForm signature stamp, malformed /Annots entry', () => {
  it('skips a non-dict Annots entry during the fallback scan instead of throwing uncaught', async () => {
    // /P stripped forces the fallback scan; a bogus (non-dict) entry is
    // spliced into page 2's own /Annots array ahead of the real widget ref
    // so the scan has to survive it and keep going.
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.create();
    const page1 = pdfDoc.addPage([200, 200]);
    const page2 = pdfDoc.addPage([200, 200]);
    const form = pdfDoc.getForm();
    const textField = form.createTextField('Signature');
    textField.addToPage(page2, { x: 20, y: 100, width: 150, height: 20 });

    const widget = form.getTextField('Signature').acroField.getWidgets()[0];
    widget.dict.delete(PDFName.of('P'));

    // A bare PDFNumber pushed directly (not as a ref) into /Annots — dereferencing
    // it with .lookup(i, PDFDict) throws UnexpectedObjectTypeError in production
    // pdf-lib, exactly the malformed-entry case this patch guards against.
    const annots = page2.node.Annots();
    if (!annots) throw new Error('expected page 2 to already have an /Annots array from addToPage');
    annots.push(pdfDoc.context.obj(42));

    const pdfBytes = Buffer.from(await pdfDoc.save());
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    // Neither page has drawn text — both need OCR under save_document's
    // per-page routing; a non-empty mock result resolves both in one call.
    mockOcrResult = { text: 'A two-page form with a malformed Annots entry.' };
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'form', fieldName: 'Signature', signatureName: 'uriel' },
      opts(),
    );
    // Must not surface as the generic top-level "fill_document_field failed: ..." catch.
    expect(result.content[0].text).not.toContain('fill_document_field failed');
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const filledDoc = await PDFDocument.load(fs.readFileSync(outPath));
    const page2Text = await getPageContentsText(filledDoc.getPages()[1]);
    const draw = extractImageDraw(page2Text);
    expect(draw.width).toBeGreaterThan(0);
  });
});

describe('fill_document_field — PDF text-layer line, signature stamp', () => {
  it('draws the image at the same anchor a text draw would use, max-height-constrained, aspect-preserved', async () => {
    // A spacer first line pushes the target line ("Date: ______", line 2)
    // down to y=140 — line 1's own y=160 only leaves 40pt of headroom above
    // it on this fixture's 200pt-tall page, less than SIGNATURE_MAX_HEIGHT_PT
    // (45), which the new off-page bounding-box check (rightly) declines.
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Name: ______', 'Date: ______']));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl({ document: 'letter', lineNumber: 2, signatureName: 'uriel' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('the signature');
    expect(result.content[0].text).not.toContain('undefined');

    const outPath = extractOutPath(result.content[0].text);
    const { PDFDocument } = await import('pdf-lib');
    const filledDoc = await PDFDocument.load(fs.readFileSync(outPath));
    const page = filledDoc.getPages()[0];
    const contentsText = await getPageContentsText(page);
    const draw = extractImageDraw(contentsText);

    // buildMultilineTextPdf's line 2 is drawn at y=140.
    expect(draw.y).toBeCloseTo(140, 0);
    expect(draw.height).toBeCloseTo(SIGNATURE_MAX_HEIGHT_PT, 0);
    expect(draw.width).toBeCloseTo(SIGNATURE_MAX_HEIGHT_PT * (100 / 50), 0);
    expect(draw.x).toBeGreaterThan(20); // right of the line's own text start
  });
});

describe('fill_document_field — PDF scanned pixel, signature stamp', () => {
  it('draws the image at the pixel-converted position, max-height-constrained', async () => {
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));
    await saveDocumentImpl({ path: filePath }, opts());
    await saveDocumentImpl({ path: filePath, extractedText: 'A scanned page.' }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    // pixelY=60 -> pdfY=170, only 30pt of headroom above it on this 200pt
    // page — less than SIGNATURE_MAX_HEIGHT_PT (45), which the off-page
    // bounding-box check (rightly) declines. pixelY=140 -> pdfY=130, 70pt
    // of headroom, comfortably fits.
    const result = await fillDocumentFieldImpl(
      { document: 'scan', pixelX: 40, pixelY: 140, signatureName: 'uriel' },
      opts(),
    );
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const { PDFDocument } = await import('pdf-lib');
    const filledDoc = await PDFDocument.load(fs.readFileSync(outPath));
    const page = filledDoc.getPages()[0];
    const contentsText = await getPageContentsText(page);
    const draw = extractImageDraw(contentsText);

    // buildMinimalPdf's MediaBox is 200x200; RENDER_SCALE=2 -> rendered
    // image is 400x400px. pdfX = (40/400)*200 = 20; pdfY = 200 - (140/400)*200 = 130.
    expect(draw.x).toBeCloseTo(20, 0);
    expect(draw.y).toBeCloseTo(130, 0);
    expect(draw.height).toBeCloseTo(SIGNATURE_MAX_HEIGHT_PT, 0);
    expect(draw.width).toBeCloseTo(SIGNATURE_MAX_HEIGHT_PT * (100 / 50), 0);
  });
});

describe('fill_document_field — PDF, signature + value together (line target)', () => {
  it('draws both the image and text beside it, same call, same baseline', async () => {
    // Spacer first line — see the previous describe block's comment: line
    // 1 alone doesn't leave enough headroom above it for a 45pt-tall image
    // on this fixture's 200pt page.
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Spacer', 'Name: ______']));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'letter', lineNumber: 2, signatureName: 'uriel', value: '2026-08-17' },
      opts(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('the signature and "2026-08-17"');

    const outPath = extractOutPath(result.content[0].text);
    const text = await extractAllPdfText(outPath);
    expect(text).toContain('2026-08-17');
    expect(text).toContain('Name:');

    const { PDFDocument } = await import('pdf-lib');
    const filledDoc = await PDFDocument.load(fs.readFileSync(outPath));
    const page = filledDoc.getPages()[0];
    const contentsText = await getPageContentsText(page);
    const draw = extractImageDraw(contentsText);
    const tmPositions = extractTmPositions(contentsText);
    expect(tmPositions.length).toBeGreaterThan(0);
    expect(tmPositions[0].x).toBeCloseTo(draw.x + draw.width + GAP_PT, 0);
    expect(tmPositions[0].y).toBeCloseTo(draw.y, 0);
  });
});

describe('fill_document_field — PDF, unknown signature name', () => {
  it('declines and lists the saved signature names actually present', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Name: ______']));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const result = await fillDocumentFieldImpl({ document: 'letter', lineNumber: 1, signatureName: 'bob' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('bob');
    expect(result.content[0].text).toContain('uriel');
  });

  it('says none saved yet when memory/signatures has nothing saved', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Name: ______']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'letter', lineNumber: 1, signatureName: 'bob' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('no signatures are saved yet');
  });

  it('errors immediately on a bad signatureName even with no target given — never silently reaches discovery', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Name: ______']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'letter', signatureName: 'nope' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nope');
  });

  it('treats a signatureName containing a path separator as a miss rather than resolving it against the filesystem', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Name: ______']));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'letter', lineNumber: 1, signatureName: '../uriel' },
      opts(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('../uriel');
  });
});

// ---------------------------------------------------------------------------
// fill_document_field — .docx/.doc signature stamping (Story 1.8)
// ---------------------------------------------------------------------------

describe('fill_document_field — .docx signature stamping, table cell target', () => {
  it('inserts an image run into the target cell, leaves existing text untouched, and writes well-formed new zip parts', async () => {
    const original = buildDocxWithTables([[['Name', 'John Doe']]]);
    const filePath = writeInboxFile('report.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'report', row: 1, column: 2, signatureName: 'uriel' },
      opts(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('New file at ');
    expect(result.content[0].text).toContain('table 1, row 1, column 2');

    const outPath = extractOutPath(result.content[0].text);
    const zip = await loadDocxZip(fs.readFileSync(outPath));

    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('<w:drawing>');
    expect(docXml).toContain('<wp:inline');
    expect(docXml).toContain('<pic:pic');
    // Existing cell text (both cells) is untouched — an inserted run, never a replacement.
    expect(docxXmlToText(docXml)).toContain('Name');
    expect(docxXmlToText(docXml)).toContain('John Doe');

    const relsXml = await zip.file('word/_rels/document.xml.rels')!.async('string');
    const relMatch =
      /<Relationship Id="rId(\d+)" Type="[^"]*\/relationships\/image" Target="media\/(image\d+\.png)"\/>/.exec(relsXml);
    expect(relMatch).not.toBeNull();
    const [, relId, mediaTarget] = relMatch!;
    expect(docXml).toContain(`r:embed="rId${relId}"`);

    const mediaFile = zip.file(`word/media/${mediaTarget}`);
    expect(mediaFile).not.toBeNull();
    const mediaBytes = await mediaFile!.async('nodebuffer');
    expect(mediaBytes.length).toBeGreaterThan(0);
    // Decodes as a real PNG (pngjs round-trip), not just "some bytes were written".
    expect(() => PNG.sync.read(mediaBytes)).not.toThrow();

    const contentTypesXml = await zip.file('[Content_Types].xml')!.async('string');
    expect(contentTypesXml).toContain('<Default Extension="png" ContentType="image/png"/>');
  });
});

describe('fill_document_field — .docx signature stamping, fill-in-the-blank line target', () => {
  it('appends the image run right after the target paragraph, leaving the label/blank text untouched', async () => {
    const filePath = writeInboxFile('form.docx', buildDocx(['Name: ______', 'Date: ______']));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl({ document: 'form', lineNumber: 1, signatureName: 'uriel' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('New file at ');
    expect(result.content[0].text).toContain('line 1');

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    expect(newXml).toContain('<w:drawing>');
    // The blank itself (and the untargeted second line) are untouched.
    expect(docxXmlToText(newXml)).toContain('Name: ______');
    expect(docxXmlToText(newXml)).toContain('Date: ______');
  });
});

describe('fill_document_field — .docx signature stamping, signature + value together (line target)', () => {
  it('inserts the text run immediately after the image run, same paragraph', async () => {
    const filePath = writeInboxFile('form.docx', buildDocx(['Date: ______']));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'form', lineNumber: 1, signatureName: 'uriel', value: '2026-08-17' },
      opts(),
    );
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    const drawingIndex = newXml.indexOf('<w:drawing>');
    const valueIndex = newXml.indexOf('2026-08-17');
    expect(drawingIndex).toBeGreaterThan(-1);
    expect(valueIndex).toBeGreaterThan(drawingIndex); // text run comes after the image run
    expect(docxXmlToText(newXml)).toContain('2026-08-17');
  });
});

describe('fill_document_field — .docx signature stamping, signature + value together (table-cell target)', () => {
  it('inserts the text run immediately after the image run inside the target cell too', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['Name', 'John Doe']]]));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'report', row: 1, column: 2, signatureName: 'uriel', value: '2026-08-17' },
      opts(),
    );
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const newXml = await readDocxXml(fs.readFileSync(outPath));
    const drawingIndex = newXml.indexOf('<w:drawing>');
    const valueIndex = newXml.indexOf('2026-08-17');
    expect(drawingIndex).toBeGreaterThan(-1);
    expect(valueIndex).toBeGreaterThan(drawingIndex); // text run comes after the image run
    // Existing cell text (both cells) is still untouched — same "additional run, never a replacement" rule.
    expect(docxXmlToText(newXml)).toContain('Name');
    expect(docxXmlToText(newXml)).toContain('John Doe');
    expect(docxXmlToText(newXml)).toContain('2026-08-17');
  });
});

describe('fill_document_field — .docx signature stamping, pre-existing image in the source document', () => {
  it('gets a non-colliding filename/rId; the pre-existing image and its own rel/content-type entries are untouched', async () => {
    const original = buildDocxWithExistingImage([[['a1', 'b1']]]);
    const filePath = writeInboxFile('report.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, signatureName: 'uriel' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const zip = await loadDocxZip(fs.readFileSync(outPath));

    // The pre-existing image1.png is untouched, and a new image2.png was added alongside it.
    expect(zip.file('word/media/image1.png')).not.toBeNull();
    const newMediaFile = zip.file('word/media/image2.png');
    expect(newMediaFile).not.toBeNull();
    const originalImage1 = (await loadDocxZip(original)).file('word/media/image1.png');
    const originalBytes = await originalImage1!.async('nodebuffer');
    const roundTrippedBytes = await zip.file('word/media/image1.png')!.async('nodebuffer');
    expect(roundTrippedBytes.equals(originalBytes)).toBe(true);

    const relsXml = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(relsXml).toContain('Id="rId1"'); // pre-existing relationship untouched
    expect(relsXml).toContain('Target="media/image1.png"');
    expect(relsXml).toContain('Id="rId2"'); // new relationship picked the next free id
    expect(relsXml).toContain('Target="media/image2.png"');

    // The pre-existing PNG content-type default is not duplicated.
    const contentTypesXml = await zip.file('[Content_Types].xml')!.async('string');
    const pngDefaultCount = (contentTypesXml.match(/<Default Extension="png"/g) || []).length;
    expect(pngDefaultCount).toBe(1);

    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('r:embed="rId2"'); // the new run references the new relationship, not the old one
  });
});

describe('fill_document_field — .docx signature stamping, target cell already contains an image', () => {
  it('appends the new image run alongside the existing one without corrupting it', async () => {
    const original = buildDocxWithImageInTargetCell();
    const filePath = writeInboxFile('report.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'report', row: 1, column: 2, signatureName: 'uriel' },
      opts(),
    );
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const zip = await loadDocxZip(fs.readFileSync(outPath));
    const docXml = await zip.file('word/document.xml')!.async('string');

    // Both drawings present — the pre-existing one and the newly stamped one.
    const drawingCount = (docXml.match(/<w:drawing>/g) || []).length;
    expect(drawingCount).toBe(2);
    expect(docXml).toContain('r:embed="rId1"'); // pre-existing image's own reference untouched
    expect(docXml).toContain('r:embed="rId2"'); // new image's reference, next free id

    // The pre-existing media file is untouched, and a new one was added alongside it.
    const originalImage1 = (await loadDocxZip(original)).file('word/media/image1.png');
    const originalBytes = await originalImage1!.async('nodebuffer');
    const roundTrippedBytes = await zip.file('word/media/image1.png')!.async('nodebuffer');
    expect(roundTrippedBytes.equals(originalBytes)).toBe(true);
    expect(zip.file('word/media/image2.png')).not.toBeNull();
  });
});

describe('fill_document_field — .docx signature stamping, unknown signature name', () => {
  it('declines and lists actual saved signature names, no file written', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, signatureName: 'bob' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('uriel');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field — .docx signature stamping, Content-Types Override does not falsely satisfy PNG coverage', () => {
  it('adds a Default entry even when a PNG Override exists for a different, unrelated part', async () => {
    const original = buildDocxWithScopedPngOverride([[['a1', 'b1']]]);
    const filePath = writeInboxFile('report.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, signatureName: 'uriel' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const zip = await loadDocxZip(fs.readFileSync(outPath));
    const contentTypesXml = await zip.file('[Content_Types].xml')!.async('string');

    // The pre-existing, unrelated Override is untouched...
    expect(contentTypesXml).toContain('PartName="/word/media/image1.png"');
    // ...but a Default was still added — the Override alone doesn't cover the *new* part.
    expect(contentTypesXml).toContain('<Default Extension="png" ContentType="image/png"/>');
  });
});

describe('fill_document_field — .docx signature stamping, single-quoted existing XML attributes', () => {
  it('does not collide the next rId/docPr id, and does not duplicate a single-quoted PNG Default', async () => {
    const original = buildDocxWithSingleQuotedParts([[['a1', 'b1']]]);
    const filePath = writeInboxFile('report.docx', original);
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, signatureName: 'uriel' }, opts());
    expect(result.isError).toBeFalsy();

    const outPath = extractOutPath(result.content[0].text);
    const zip = await loadDocxZip(fs.readFileSync(outPath));

    const relsXml = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(relsXml).toContain("Id='rId5'"); // pre-existing (single-quoted) relationship untouched
    expect(relsXml).toContain('Id="rId6"'); // next free id, correctly not colliding with rId5

    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('r:embed="rId6"');
    expect(docXml).toContain('<wp:docPr id="8"'); // next free docPr id, not colliding with the existing id='7'

    const contentTypesXml = await zip.file('[Content_Types].xml')!.async('string');
    const pngDefaultCount = (contentTypesXml.match(/<Default Extension=["']png["']/g) || []).length;
    expect(pngDefaultCount).toBe(1); // the single-quoted Default was recognized — no duplicate double-quoted one added
  });
});

describe('fill_document_field — .docx signature stamping, degenerate signature PNG dimensions', () => {
  it('declines cleanly instead of emitting Infinity/NaN into the drawing XML', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());
    // Hand-placed under memory/signatures/, bypassing save_signature's own empty-bbox guard —
    // e.g. a corrupted file, or one dropped in some other way than save_signature itself.
    writeSavedSignature('broken', buildDegeneratePng(0, 10));

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, signatureName: 'broken' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('degenerate dimensions');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field — .docx signature stamping, existing decline conditions still apply', () => {
  it('stamps into the correct visual column of a gridSpan row, the same resolution the value-fill path uses', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(gridSpanRowXml()));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    // column 2 falls inside the gridSpan=2 "merged" cell (visual cols 1-2).
    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 2, signatureName: 'uriel' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('table 1, row 1, column 2');

    const outPath = extractOutPath(result.content[0].text);
    const zip = await loadDocxZip(fs.readFileSync(outPath));
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('<w:drawing>');
    // Existing cell text is untouched — an inserted run, never a replacement.
    expect(docxXmlToText(docXml)).toContain('merged');
    expect(docxXmlToText(docXml)).toContain('c3');
  });

  it('still declines a gridSpan row when the target cell contains a nested table', async () => {
    const rowXml =
      '<w:tr>' +
      '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">a</w:t></w:r></w:p></w:tc>' +
      `<w:tc>${tableXml([['nested-a', 'nested-b']])}</w:tc>` +
      '</w:tr>';
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(rowXml));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    // column 3 resolves to the second <w:tc>, which contains a nested table.
    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 3, signatureName: 'uriel' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nested table');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });

  it('rejects row/table together with lineNumber even when signatureName is also given', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const result = await fillDocumentFieldImpl(
      { document: 'report', row: 1, lineNumber: 1, signatureName: 'uriel' },
      opts(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not both');
  });
});

describe('fill_document_field — .docx signature stamping, stored canonical copy never modified', () => {
  it('leaves the stored .docx untouched', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]]));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const rawPath = path.join(baseDir, 'memory', 'documents', 'files', 'report.docx');
    const rawBefore = fs.readFileSync(rawPath);

    await fillDocumentFieldImpl({ document: 'report', row: 1, signatureName: 'uriel' }, opts());

    expect(fs.readFileSync(rawPath).equals(rawBefore)).toBe(true);
  });
});

describe.skipIf(!SOFFICE_AVAILABLE)(
  'fill_document_field — .doc signature stamping (via the unmodified conversion delegation)',
  () => {
    it('stamps the signature into the converted .docx and discloses the .doc-origin note', async () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-signature-test-'));
      try {
        const docBuf = buildDocViaSoffice(work, ['Name: ______']);
        const filePath = writeInboxFile('form.doc', docBuf);
        await saveDocumentImpl({ path: filePath }, opts());
        writeSavedSignature(
          'uriel',
          buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }),
        );

        const result = await fillDocumentFieldImpl({ document: 'form', lineNumber: 1, signatureName: 'uriel' }, opts());
        expect(result.isError).toBeFalsy();
        expect(result.content[0].text).toContain('legacy .doc file');
        expect(result.content[0].text).toContain('.docx, not a');

        const outPath = extractOutPath(result.content[0].text);
        expect(outPath.endsWith('.docx')).toBe(true);
        const newXml = await readDocxXml(fs.readFileSync(outPath));
        expect(newXml).toContain('<w:drawing>');
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
  },
);

describe('fill_document_field — PDF, no target given, signatureName present', () => {
  it('returns the identical discovery response the text-only path already returns', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Name: ______', 'Date: ______']));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const withoutSignature = await fillDocumentFieldImpl({ document: 'letter' }, opts());
    const withSignature = await fillDocumentFieldImpl({ document: 'letter', signatureName: 'uriel' }, opts());

    expect(withSignature.isError).toBeFalsy();
    expect(withSignature.content[0].text).toBe(withoutSignature.content[0].text);
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });

  it('same equivalence on the AcroForm auto-discovery response', async () => {
    const pdfBytes = await buildTextPdfWithAcroForm('Name: ______', 'Name');
    const filePath = writeInboxFile('form.pdf', pdfBytes);
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const withoutSignature = await fillDocumentFieldImpl({ document: 'form' }, opts());
    const withSignature = await fillDocumentFieldImpl({ document: 'form', signatureName: 'uriel' }, opts());

    expect(withSignature.isError).toBeFalsy();
    expect(withSignature.content[0].text).toBe(withoutSignature.content[0].text);
  });
});

describe('fill_document_field — signature stamping, end-to-end with save_signature', () => {
  it('stamps a signature actually produced by save_signature (cropped/thresholded), not a hand-built fixture', async () => {
    // Spacer first line, same reasoning as above.
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Spacer', 'Name: ______']));
    await saveDocumentImpl({ path: filePath }, opts());

    const sigPath = writeInboxFile(
      'sig.png',
      buildSignaturePng({ width: 100, height: 50, ink: { x: 10, y: 10, w: 80, h: 30 } }),
    );
    const saveResult = await saveSignatureImpl({ path: sigPath, name: 'uriel' }, opts());
    expect(saveResult.isError).toBeFalsy();

    const result = await fillDocumentFieldImpl({ document: 'letter', lineNumber: 2, signatureName: 'uriel' }, opts());
    expect(result.isError).toBeFalsy();
    const outPath = extractOutPath(result.content[0].text);
    expect(fs.existsSync(outPath)).toBe(true);
    const bytes = fs.readFileSync(outPath);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('fill_document_field — signature stamping, stored canonical copy never modified', () => {
  it('leaves the stored .pdf untouched', async () => {
    const filePath = writeInboxFile('letter.pdf', buildMultilineTextPdf(['Name: ______']));
    await saveDocumentImpl({ path: filePath }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 40, height: 20, ink: { x: 5, y: 5, w: 20, h: 10 } }));

    const rawPath = path.join(baseDir, 'memory', 'documents', 'files', 'letter.pdf');
    const rawBefore = fs.readFileSync(rawPath);

    await fillDocumentFieldImpl({ document: 'letter', lineNumber: 1, signatureName: 'uriel' }, opts());

    expect(fs.readFileSync(rawPath).equals(rawBefore)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fill_document_field_batch (spec 2-2)
// ---------------------------------------------------------------------------

describe('fill_document_field_batch tool metadata', () => {
  it('has no required arguments (documents/matchQuery exclusivity is handler-enforced)', () => {
    expect(fillDocumentFieldBatch.tool.name).toBe('fill_document_field_batch');
    expect(fillDocumentFieldBatch.tool.inputSchema.required ?? []).toEqual([]);
  });
});

describe('fill_document_field_batch — all targets resolve and fill successfully', () => {
  it('reports N/N succeeded with each output path, via documents[]', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('letter.docx', buildDocxWithTables([[['c1', 'd1']]])) }, opts());

    const result = await fillDocumentFieldBatchImpl({ documents: ['report', 'letter'], row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('2/2 succeeded');
    expect(text).toContain('report');
    expect(text).toContain('letter');
    expect(text).toContain('New file at');

    // Both output files actually landed on disk and contain the fill.
    const matches = [...text.matchAll(/New file at (\S+) — call send_file/g)].map((m) => m[1]);
    expect(matches.length).toBe(2);
    for (const outPath of matches) {
      expect(fs.existsSync(outPath)).toBe(true);
    }
  });

  it('reports N/N succeeded via matchQuery, one target per match', async () => {
    await saveDocumentImpl({ path: writeInboxFile('invoice-a.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('invoice-b.docx', buildDocxWithTables([[['c1', 'd1']]])) }, opts());

    const result = await fillDocumentFieldBatchImpl({ matchQuery: 'invoice', row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('2/2 succeeded');
  });
});

describe('fill_document_field_batch — mixed success/failure across the batch', () => {
  it('fills the existing document, names the missing one as a per-item failure, no batch abort', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const result = await fillDocumentFieldBatchImpl(
      { documents: ['report', 'missing-doc'], row: 1, value: 'X' },
      opts(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('1/2 succeeded');
    expect(text).toContain('New file at');
    expect(text).toContain('No saved document matches "missing-doc".');
  });
});

describe('fill_document_field_batch — an entry in documents is itself ambiguous', () => {
  it('reports that entry as a per-item failure; other entries still processed', async () => {
    await saveDocumentImpl({ path: writeInboxFile('Report A.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('Report B.docx', buildDocxWithTables([[['c1', 'd1']]])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('letter.docx', buildDocxWithTables([[['e1', 'f1']]])) }, opts());

    const result = await fillDocumentFieldBatchImpl({ documents: ['report', 'letter'], row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('1/2 succeeded');
    expect(text).toContain('ambiguous, be more specific');
    expect(text).toContain('letter');
    expect(text).toContain('New file at');
  });
});

describe('fill_document_field_batch — matchQuery matches zero documents', () => {
  it('returns a whole-call error rather than an empty/silent success report', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const result = await fillDocumentFieldBatchImpl({ matchQuery: 'nonexistent', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No saved document matches "nonexistent".');
  });
});

describe('fill_document_field_batch — neither or both of documents/matchQuery given', () => {
  it('rejects an empty call before attempting any fill', async () => {
    const result = await fillDocumentFieldBatchImpl({ row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Provide exactly one of documents or matchQuery');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });

  it('rejects a call giving both before attempting any fill', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const result = await fillDocumentFieldBatchImpl(
      { documents: ['report'], matchQuery: 'report', row: 1, value: 'X' },
      opts(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Provide exactly one of documents or matchQuery');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe("fill_document_field_batch — targeting args do not apply to one document's file type", () => {
  it('reports that document as a per-item failure with the existing validation error text; others unaffected', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const pdfBytes = await buildAcroFormPdf('Name');
    const pdfPath = writeInboxFile('form.pdf', pdfBytes);
    await saveDocumentImpl({ path: pdfPath }, opts());
    await saveDocumentImpl({ path: pdfPath, extractedText: 'A form with a Name field.' }, opts());

    const result = await fillDocumentFieldBatchImpl(
      { documents: ['report', 'form'], fieldName: 'Name', value: 'Ada Lovelace' },
      opts(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('1/2 succeeded');
    expect(text).toContain("These arguments don't apply to a .docx document: fieldName.");
    expect(text).toContain('New file at');
  });
});

describe('fill_document_field_batch — never touches the stored canonical files', () => {
  it('leaves both stored raw copies untouched after a successful batch fill', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('letter.docx', buildDocxWithTables([[['c1', 'd1']]])) }, opts());

    const reportRaw = path.join(baseDir, 'memory', 'documents', 'files', 'report.docx');
    const letterRaw = path.join(baseDir, 'memory', 'documents', 'files', 'letter.docx');
    const reportBefore = fs.readFileSync(reportRaw);
    const letterBefore = fs.readFileSync(letterRaw);

    await fillDocumentFieldBatchImpl({ documents: ['report', 'letter'], row: 1, value: 'X' }, opts());

    expect(fs.readFileSync(reportRaw).equals(reportBefore)).toBe(true);
    expect(fs.readFileSync(letterRaw).equals(letterBefore)).toBe(true);
  });
});

describe('fill_document_field_batch — one target throws instead of returning err(), earlier successes are preserved', () => {
  it('reports the earlier success even though a later target corrupts partway through the loop', async () => {
    await saveDocumentImpl({ path: writeInboxFile('good.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('corrupt.docx', buildDocxWithTables([[['c1', 'd1']]])) }, opts());

    // Corrupt the stored raw copy directly (not the inbox source) so fillDocx's
    // unguarded `JSZip.loadAsync` throws instead of `fillOneDocument` returning
    // a handled err() — this is the real, uncaught-exception shape the fix
    // targets, not a validation-level failure.
    const corruptRaw = path.join(baseDir, 'memory', 'documents', 'files', 'corrupt.docx');
    fs.writeFileSync(corruptRaw, Buffer.from('not a zip file at all'));

    const result = await fillDocumentFieldBatchImpl({ documents: ['good', 'corrupt'], row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('1/2 succeeded');
    expect(text).toContain('good: OK');
    expect(text).toContain('New file at');
    expect(text).toContain('corrupt: FAILED');
  });
});

describe('fill_document_field_batch — signatureName is not supported', () => {
  it('rejects the whole call before any fill runs', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());
    writeSavedSignature('uriel', buildSignaturePng({ width: 20, height: 10, ink: { x: 2, y: 2, w: 10, h: 5 } }));

    const result = await fillDocumentFieldBatchImpl({ documents: ['report'], row: 1, signatureName: 'uriel' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('signatureName is not supported by fill_document_field_batch');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field_batch — duplicate documents[] entries resolving to the same document', () => {
  it('fills and reports the document once, not twice', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const result = await fillDocumentFieldBatchImpl({ documents: ['report', 'report'], row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('1/1 succeeded');
    expect(text.match(/report: OK/g)?.length).toBe(1);
  });

  it('also dedupes when two different query strings resolve to the same document', async () => {
    await saveDocumentImpl(
      { path: writeInboxFile('quarterly-report.docx', buildDocxWithTables([[['a1', 'b1']]])) },
      opts(),
    );

    const result = await fillDocumentFieldBatchImpl(
      { documents: ['quarterly-report', 'report'], row: 1, value: 'X' },
      opts(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('1/1 succeeded');
    expect(text.match(/quarterly-report: OK/g)?.length).toBe(1);
  });
});

describe('fill_document_field_batch — batch-size cap', () => {
  it('rejects a matchQuery match set larger than the limit, before any fill runs', async () => {
    for (let i = 0; i < 26; i++) {
      // eslint-disable-next-line no-await-in-loop
      await saveDocumentImpl(
        { path: writeInboxFile(`invoice-${i}.docx`, buildDocxWithTables([[['a1', 'b1']]])) },
        opts(),
      );
    }

    const result = await fillDocumentFieldBatchImpl({ matchQuery: 'invoice', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exceeding the 25-document limit');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
  });
});

describe('fill_document_field_batch — resolveBatchTargets input-shape validation', () => {
  it('rejects a non-array documents value', async () => {
    const result = await fillDocumentFieldBatchImpl({ documents: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('documents must be a non-empty array of non-empty strings.');
  });

  it('rejects an empty documents array', async () => {
    const result = await fillDocumentFieldBatchImpl({ documents: [], row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('documents must be a non-empty array of non-empty strings.');
  });

  it('rejects a documents array containing a blank/non-string entry', async () => {
    const blankEntry = await fillDocumentFieldBatchImpl({ documents: ['report', '   '], row: 1, value: 'X' }, opts());
    expect(blankEntry.isError).toBe(true);
    expect(blankEntry.content[0].text).toContain('documents must be a non-empty array of non-empty strings.');

    const nonStringEntry = await fillDocumentFieldBatchImpl({ documents: ['report', 42], row: 1, value: 'X' }, opts());
    expect(nonStringEntry.isError).toBe(true);
    expect(nonStringEntry.content[0].text).toContain('documents must be a non-empty array of non-empty strings.');
  });

  it('rejects an empty-string matchQuery', async () => {
    const result = await fillDocumentFieldBatchImpl({ matchQuery: '   ', row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('matchQuery must be a non-empty string.');
  });

  it('rejects a non-string matchQuery', async () => {
    const result = await fillDocumentFieldBatchImpl({ matchQuery: 42, row: 1, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('matchQuery must be a non-empty string.');
  });
});

describe('fill_document_field_batch — every documents[] entry fails to resolve', () => {
  it('is a soft 0/N report, not a whole-call error', async () => {
    const result = await fillDocumentFieldBatchImpl(
      { documents: ['missing-a', 'missing-b'], row: 1, value: 'X' },
      opts(),
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('0/2 succeeded');
    expect(text).toContain('No saved document matches "missing-a".');
    expect(text).toContain('No saved document matches "missing-b".');
  });
});

describe('fill_document_field_batch — a discovery/prompt response does not count as a success', () => {
  it('reports FAILED and excludes it from the succeeded count', async () => {
    const original = buildDocxRawBody([tableXml([['a1', 'b1']]), bodyParagraphXml('שם: ___________')]);
    await saveDocumentImpl({ path: writeInboxFile('mixed.docx', original) }, opts());

    // No row/table/lineNumber at all -> fillDocx returns docxDiscoveryResponse's
    // ok(TABLE_ROW_REQUIRED_MESSAGE...) — a real, non-error ok() with no
    // FILL_SUCCESS_MARKER, since nothing was actually filled.
    const result = await fillDocumentFieldBatchImpl({ documents: ['mixed'] }, opts());
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('0/1 succeeded');
    expect(text).toContain('mixed: FAILED');
    expect(text).toContain('row is required');
    expect(text).not.toContain('New file at');
  });
});

describe('fill_document_field — existing single-call tool untouched by the batch addition', () => {
  it('still declares document as the only required argument, unchanged', () => {
    expect(fillDocumentField.tool.name).toBe('fill_document_field');
    expect(fillDocumentField.tool.inputSchema).toMatchObject({ required: ['document'] });
  });

  it('still fills a single document exactly as before', async () => {
    const original = buildDocxWithTables([[['a1', 'b1']]]);
    await saveDocumentImpl({ path: writeInboxFile('report.docx', original) }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    const outPath = extractOutPath(result.content[0].text);
    expect(fs.existsSync(outPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// list_document_versions (spec 2-3) — fill history index over the exact
// output files writeFillOutput already produces.
// ---------------------------------------------------------------------------

function fillHistoryFilePath(baseDirArg: string, slug: string): string {
  return path.join(baseDirArg, 'memory', 'documents', '.fill-history', `${slug}.json`);
}

interface FillHistoryEntryFixture {
  timestamp: string;
  outputPath: string;
  target: string;
}

function readFillHistoryRaw(baseDirArg: string, slug: string): FillHistoryEntryFixture[] {
  return JSON.parse(fs.readFileSync(fillHistoryFilePath(baseDirArg, slug), 'utf-8'));
}

function writeFillHistoryRaw(baseDirArg: string, slug: string, entries: FillHistoryEntryFixture[]): void {
  const p = fillHistoryFilePath(baseDirArg, slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(entries, null, 2));
}

describe('list_document_versions tool metadata', () => {
  it('declares document as the only required argument', () => {
    expect(listDocumentVersions.tool.name).toBe('list_document_versions');
    expect(listDocumentVersions.tool.inputSchema).toMatchObject({ required: ['document'] });
  });
});

describe('list_document_versions — document resolution', () => {
  it('errors clearly when no saved document matches', async () => {
    const result = await listDocumentVersionsImpl({ document: 'nonexistent' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('nonexistent');
  });

  it('returns a numbered candidate list (not an error) when the reference is ambiguous', async () => {
    await saveDocumentImpl({ path: writeInboxFile('Report A.docx', buildDocx(['A'])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('Report B.docx', buildDocx(['B'])) }, opts());

    const result = await listDocumentVersionsImpl({ document: 'report' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('report-a');
    expect(result.content[0].text).toContain('report-b');
  });

  it('requires a non-empty document argument', async () => {
    const result = await listDocumentVersionsImpl({}, opts());
    expect(result.isError).toBe(true);
  });
});

describe('list_document_versions — document never filled', () => {
  it('reports an empty history plainly, not an error', async () => {
    await saveDocumentImpl({ path: writeInboxFile('letter.docx', buildDocx(['Hello'])) }, opts());

    const result = await listDocumentVersionsImpl({ document: 'letter' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('No fill history');
  });
});

describe('list_document_versions — a document filled three times', () => {
  it('returns all three, oldest to newest, with real still-sendable output paths and targets', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const r1 = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'first' }, opts());
    const r2 = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'second' }, opts());
    const r3 = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'third' }, opts());
    const p1 = extractOutPath(r1.content[0].text);
    const p2 = extractOutPath(r2.content[0].text);
    const p3 = extractOutPath(r3.content[0].text);
    expect(fs.existsSync(p1)).toBe(true);
    expect(fs.existsSync(p2)).toBe(true);
    expect(fs.existsSync(p3)).toBe(true);

    const result = await listDocumentVersionsImpl({ document: 'report' }, opts());
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;

    const idx1 = text.indexOf(p1);
    const idx2 = text.indexOf(p2);
    const idx3 = text.indexOf(p3);
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(-1);
    expect(idx3).toBeGreaterThan(-1);
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
    expect(text).toContain('row 1');
  });
});

describe('list_document_versions — a listed output file was manually deleted', () => {
  it('silently drops the deleted entry, never lists it as recoverable', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const r1 = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    const p1 = extractOutPath(r1.content[0].text);
    const r2 = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'Y' }, opts());
    const p2 = extractOutPath(r2.content[0].text);

    fs.unlinkSync(p1);

    const result = await listDocumentVersionsImpl({ document: 'report' }, opts());
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).not.toContain(p1);
    expect(text).toContain(p2);
  });
});

describe('list_document_versions — history exceeds the cap', () => {
  it('drops the oldest entry from the index on the 21st fill; its .document-fills file is untouched on disk', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());
    const slug = 'report';

    const fillsDir = path.join(baseDir, '.document-fills');
    fs.mkdirSync(fillsDir, { recursive: true });
    const seeded: FillHistoryEntryFixture[] = [];
    for (let i = 1; i <= 20; i++) {
      const p = path.join(fillsDir, `seed-${i}.docx`);
      fs.writeFileSync(p, 'dummy');
      seeded.push({ timestamp: new Date(2020, 0, i).toISOString(), outputPath: p, target: `row ${i}` });
    }
    writeFillHistoryRaw(baseDir, slug, seeded);
    const oldestPath = seeded[0].outputPath;

    const result21 = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'newest' }, opts());
    expect(result21.isError).toBeFalsy();
    const newestPath = extractOutPath(result21.content[0].text);

    const historyAfter = readFillHistoryRaw(baseDir, slug);
    expect(historyAfter.length).toBe(20);
    expect(historyAfter.some((e) => e.outputPath === oldestPath)).toBe(false);
    expect(historyAfter.some((e) => e.outputPath === newestPath)).toBe(true);

    // Dropping an entry from the index must not delete its underlying .document-fills file.
    expect(fs.existsSync(oldestPath)).toBe(true);

    const listResult = await listDocumentVersionsImpl({ document: 'report' }, opts());
    expect(listResult.content[0].text).not.toContain(oldestPath);
    expect(listResult.content[0].text).toContain(newestPath);
  });
});

describe('list_document_versions — a batch fill completes', () => {
  it('the batch-produced fill appears in history identically to a single-call fill', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());
    await saveDocumentImpl({ path: writeInboxFile('letter.docx', buildDocxWithTables([[['c1', 'd1']]])) }, opts());

    const batchResult = await fillDocumentFieldBatchImpl(
      { documents: ['report', 'letter'], row: 1, value: 'X' },
      opts(),
    );
    expect(batchResult.isError).toBeFalsy();
    expect(batchResult.content[0].text).toContain('2/2 succeeded');

    const reportHistory = await listDocumentVersionsImpl({ document: 'report' }, opts());
    expect(reportHistory.isError).toBeFalsy();
    expect(reportHistory.content[0].text).toContain('row 1');
    expect(reportHistory.content[0].text).toContain('.document-fills');

    const letterHistory = await listDocumentVersionsImpl({ document: 'letter' }, opts());
    expect(letterHistory.isError).toBeFalsy();
    expect(letterHistory.content[0].text).toContain('row 1');
  });
});

describe('list_document_versions — a discovery/prompt call or per-item batch failure records no entry', () => {
  it('a bare discovery call (no row/lineNumber) records nothing', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const discovery = await fillDocumentFieldImpl({ document: 'report' }, opts());
    expect(discovery.content[0].text).not.toContain('New file at');

    const history = await listDocumentVersionsImpl({ document: 'report' }, opts());
    expect(history.content[0].text).toContain('No fill history');
  });

  it('a discovery/prompt response within a batch call records nothing for that document', async () => {
    await saveDocumentImpl(
      {
        path: writeInboxFile(
          'mixed.docx',
          buildDocxRawBody([tableXml([['a1', 'b1']]), bodyParagraphXml('שם: ___________')]),
        ),
      },
      opts(),
    );

    const batchResult = await fillDocumentFieldBatchImpl({ documents: ['mixed'] }, opts());
    expect(batchResult.isError).toBeFalsy();
    expect(batchResult.content[0].text).toContain('0/1 succeeded');

    const history = await listDocumentVersionsImpl({ document: 'mixed' }, opts());
    expect(history.content[0].text).toContain('No fill history');
  });
});

function writeFillHistoryFileRaw(baseDirArg: string, slug: string, data: unknown): void {
  const p = fillHistoryFilePath(baseDirArg, slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

describe('list_document_versions — a fill-history write failure does not mask a successful fill', () => {
  it('the fill itself still reports success (New file at ...) even though history recording fails', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    // Blocks recordFillHistory's own fs.mkdirSync(dir, { recursive: true })
    // deterministically (EEXIST: a file already occupies the directory's
    // path) — no chmod/permission dependency, which wouldn't reliably fail
    // when running as root.
    const historyDir = path.join(baseDir, 'memory', 'documents', '.fill-history');
    fs.writeFileSync(historyDir, 'blocking this path from being a directory');

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'X' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('New file at');
    const outPath = extractOutPath(result.content[0].text);
    expect(fs.existsSync(outPath)).toBe(true);
  });
});

describe('list_document_versions — corrupted/malformed history file', () => {
  it('a non-array JSON value returns a clean "no history" result, not an error', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());
    writeFillHistoryFileRaw(baseDir, 'report', { not: 'an array' });

    const result = await listDocumentVersionsImpl({ document: 'report' }, opts());
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('No fill history');
  });

  it('an array with one well-formed entry and one entry missing a required field returns only the well-formed one', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const fillsDir = path.join(baseDir, '.document-fills');
    fs.mkdirSync(fillsDir, { recursive: true });
    const goodPath = path.join(fillsDir, 'report-filled-good.docx');
    fs.writeFileSync(goodPath, 'dummy');

    writeFillHistoryFileRaw(baseDir, 'report', [
      { timestamp: '2026-01-01T00:00:00.000Z', outputPath: goodPath, target: 'row 1 = "good"' },
      { timestamp: '2026-01-02T00:00:00.000Z', target: 'row 2 = "missing outputPath"' }, // malformed: no outputPath
    ]);

    const result = await listDocumentVersionsImpl({ document: 'report' }, opts());
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain(goodPath);
    expect(text).toContain('row 1 = "good"');
    expect(text).not.toContain('missing outputPath');
  });
});

describe('list_document_versions — concurrent fills of the same document', () => {
  it('the per-slug lock serializes the read-modify-write; both entries survive', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const [r1, r2] = await Promise.all([
      fillDocumentFieldImpl({ document: 'report', row: 1, value: 'A' }, opts()),
      fillDocumentFieldImpl({ document: 'report', row: 1, value: 'B' }, opts()),
    ]);
    expect(r1.isError).toBeFalsy();
    expect(r2.isError).toBeFalsy();

    const history = readFillHistoryRaw(baseDir, 'report');
    expect(history.length).toBe(2);

    const p1 = extractOutPath(r1.content[0].text);
    const p2 = extractOutPath(r2.content[0].text);
    const recordedPaths = history.map((e) => e.outputPath);
    expect(recordedPaths).toContain(p1);
    expect(recordedPaths).toContain(p2);
  });
});

// ---------------------------------------------------------------------------
// spec-2 retro (epic-2 cross-story hardening) — items 2/3/5
// ---------------------------------------------------------------------------

describe('list_document_versions — fill, then refresh, then fill again (spec-2 retro item 5)', () => {
  it('reports all three entries in order, each labeled with the correct kind', async () => {
    await saveDocumentImpl({ path: writeInboxFile('report.docx', buildDocxWithTables([[['a1', 'b1']]])) }, opts());

    const fill1 = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'first' }, opts());
    expect(fill1.isError).toBeFalsy();
    const fill1Path = extractOutPath(fill1.content[0].text);

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-edited.docx');
    fs.writeFileSync(editedPath, buildDocxWithTables([[['a1-new', 'b1-new']]]));
    const refresh = await saveDocumentImpl({ path: editedPath, document: 'report' }, opts());
    expect(refresh.isError).toBeFalsy();

    const fill2 = await fillDocumentFieldImpl({ document: 'report', row: 1, value: 'second' }, opts());
    expect(fill2.isError).toBeFalsy();
    const fill2Path = extractOutPath(fill2.content[0].text);

    const result = await listDocumentVersionsImpl({ document: 'report' }, opts());
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;

    // Correct order: oldest to newest.
    const idxFill1 = text.indexOf(fill1Path);
    const idxSnapshot = text.indexOf('pre-refresh snapshot');
    const idxFill2 = text.indexOf(fill2Path);
    expect(idxFill1).toBeGreaterThan(-1);
    expect(idxSnapshot).toBeGreaterThan(-1);
    expect(idxFill2).toBeGreaterThan(-1);
    expect(idxFill1).toBeLessThan(idxSnapshot);
    expect(idxSnapshot).toBeLessThan(idxFill2);

    // Each entry's line is labeled with the correct `kind` (spec-2 retro item 2).
    const lines = text.split('\n');
    const fill1Line = lines.find((l) => l.includes(fill1Path));
    const snapshotLine = lines.find((l) => l.includes('pre-refresh snapshot'));
    const fill2Line = lines.find((l) => l.includes(fill2Path));
    expect(fill1Line).toContain('[fill]');
    expect(snapshotLine).toContain('[pre-refresh snapshot]');
    expect(fill2Line).toContain('[fill]');
  });
});

describe('save_document — refresh racing a concurrent fill of the same document (spec-2 retro item 3/5)', () => {
  it('neither call observes a torn/missing raw file; each result is internally self-consistent', async () => {
    await saveDocumentImpl(
      { path: writeInboxFile('report.docx', buildDocxWithTables([[['original-a', 'original-b']]])) },
      opts(),
    );

    fs.mkdirSync(path.join(inboxDir, 'msg2'), { recursive: true });
    const editedPath = path.join(inboxDir, 'msg2', 'report-edited.docx');
    fs.writeFileSync(editedPath, buildDocxWithTables([[['refreshed-a', 'refreshed-b']]]));

    // row 1 has a single row with two cells — fill_document_field with no
    // "column" defaults to the row's *last* cell (b1), so the first cell
    // (a1) is left untouched by the fill and still shows exactly which
    // version (pre- or post-refresh) the fill's own snapshot read.
    const [fillResult, refreshResult] = await Promise.all([
      fillDocumentFieldImpl({ document: 'report', row: 1, value: 'FILLED' }, opts()),
      saveDocumentImpl({ path: editedPath, document: 'report' }, opts()),
    ]);

    // Neither call ever observes a missing raw file (the per-slug lock from
    // item 3 serializes the two operations; the atomic rename from item 1
    // means the raw file is never absent mid-swap, only ever fully-old or
    // fully-new) — no spurious "is missing" error from either side.
    expect(refreshResult.isError).toBeFalsy();
    expect(fillResult.isError).toBeFalsy();
    expect(fillResult.content[0].text).not.toContain('is missing');

    // The refresh always lands its own new content.
    const concept = fs.readFileSync(path.join(baseDir, 'memory', 'documents', 'report.md'), 'utf-8');
    expect(concept).toContain('refreshed-a');

    // The fill's own output is internally self-consistent — its untouched
    // first cell reflects either the pre-refresh or the post-refresh
    // content, but never a mix of both (which would only be possible from a
    // torn read mid-swap).
    const outPath = extractOutPath(fillResult.content[0].text);
    const filledXml = execFileSync('unzip', ['-p', outPath, 'word/document.xml']).toString('utf-8');
    const filledText = docxXmlToText(filledXml);
    const readOriginal = filledText.includes('original-a');
    const readRefreshed = filledText.includes('refreshed-a');
    expect(readOriginal || readRefreshed).toBe(true);
    expect(readOriginal && readRefreshed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withLock — off-by-one + fencing regressions (deferred-work.md, eval-1-3
// item)
//
// eval/lock.ts's own reimplementation of this exact algorithm found (and
// fixed) two real correctness bugs, later ported back here. Both are
// exercised directly against this file's own `withLock`, using the
// test-only `testOpts` override (retryMs/maxAttempts/staleMs) so the
// retry-exhaustion and stale-reclaim-on-the-last-attempt paths run
// deterministically instead of needing a real multi-second wait. Test
// shapes are inspired by `eval/lock.test.ts`'s own withLock suite, adapted
// to bun:test and to this file's two independent reclaim paths (dead-pid,
// then mtime-staleness fallback).
// ---------------------------------------------------------------------------

describe('withLock — off-by-one and fencing regressions', () => {
  it('acquires immediately, writes its own pid, runs fn, and removes the lock file afterward', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'withlock-test-'));
    const lockPath = path.join(work, '.test.lock');
    try {
      let ran = false;
      const result = await withLock(lockPath, () => {
        ran = true;
        expect(fs.existsSync(lockPath)).toBe(true);
        expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
        return 'ok';
      });

      expect(ran).toBe(true);
      expect(result).toBe('ok');
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('still reclaims a dead-pid lock when the reclaim happens on the very last retry attempt (off-by-one regression, pid-liveness path)', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'withlock-test-'));
    const lockPath = path.join(work, '.test.lock');
    try {
      // A pid essentially guaranteed not to be alive in this sandbox — the
      // dead-pid check fires immediately, no mtime backdating/waiting needed.
      const deadPid = 2 ** 30;
      fs.writeFileSync(lockPath, String(deadPid), { flag: 'wx' });

      // maxAttempts: 1 — the dead-pid reclaim fires on the loop's one and
      // only iteration. The pre-fix version's bare `continue` here still
      // runs the for-loop's own increment, so `attempt` reaches
      // maxAttempts and the loop exits WITHOUT ever retrying the
      // exclusive-create — fn() would then run holding no lock at all.
      let ran = false;
      const result = await withLock(
        lockPath,
        () => {
          ran = true;
          expect(fs.existsSync(lockPath)).toBe(true);
          expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
          return 'reclaimed-on-last-attempt';
        },
        { retryMs: 2, maxAttempts: 1, staleMs: 30_000 },
      );

      expect(ran).toBe(true);
      expect(result).toBe('reclaimed-on-last-attempt');
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('still reclaims a stale (non-pid) lock when the reclaim happens on the very last retry attempt (off-by-one regression, mtime path)', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'withlock-test-'));
    const lockPath = path.join(work, '.test.lock');
    try {
      // Non-numeric content (falls through the dead-pid check entirely) plus
      // a backdated mtime — exercises the second, mtime-based reclaim path.
      fs.writeFileSync(lockPath, 'not-a-pid', { flag: 'wx' });
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lockPath, old, old);

      let ran = false;
      const result = await withLock(
        lockPath,
        () => {
          ran = true;
          expect(fs.existsSync(lockPath)).toBe(true);
          expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
          return 'reclaimed-on-last-attempt';
        },
        { retryMs: 2, maxAttempts: 1, staleMs: 1_000 },
      );

      expect(ran).toBe(true);
      expect(result).toBe('reclaimed-on-last-attempt');
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("does not delete a different holder's lock on release (fencing regression)", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'withlock-test-'));
    const lockPath = path.join(work, '.test.lock');
    try {
      // Simulates the real failure mode: this call's fn() outlives staleMs,
      // another process (a different pid/token) reclaims the lock as
      // abandoned and writes its own token in — all *while our fn() is
      // still running*. When our fn() finally returns, the pre-fix
      // version's unconditional unlink would delete that other, still-live
      // holder's lock. The fix only unlinks if the file still holds the
      // exact token this call itself wrote.
      const otherHoldersToken = 'a-different-process-reclaimed-this';

      await withLock(lockPath, () => {
        expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
        fs.writeFileSync(lockPath, otherHoldersToken);
      });

      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(otherHoldersToken);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('throws, naming lockPath, after exhausting the retry budget against a live (fresh) lock', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'withlock-test-'));
    const lockPath = path.join(work, '.test.lock');
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });

      let threw: unknown;
      try {
        await withLock(lockPath, () => 'should not run', { retryMs: 2, maxAttempts: 3, staleMs: 30_000 });
      } catch (e) {
        threw = e;
      }

      expect(threw).toBeInstanceOf(Error);
      expect((threw as Error).message).toContain(lockPath);
      // Our own live lock is untouched — only a failed acquire attempt's
      // own bookkeeping should ever be cleaned up, never a real live holder.
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.readFileSync(lockPath, 'utf-8')).toBe(String(process.pid));
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ocrPngText — per-cacheDir download-race lock (deferred-work.md,
// ocr-fallback item)
//
// Two concurrent first-ever OCR calls against the same fresh (not-yet-
// populated) `.ocr-cache/` dir could otherwise both trigger createWorker's
// own internal eng.traineddata/heb.traineddata download at once. Verified
// here without a real network call: the mocked createWorker (module-level
// mock above) holds "in flight" for `createWorkerDelayMs` and records the
// real concurrent high-water mark via `maxConcurrentCreateWorkerCalls` — if
// the lock weren't there, two calls started together would both be in
// flight at once and that mark would read 2.
// ---------------------------------------------------------------------------

describe('ocrPngText — concurrent calls against the same cacheDir', () => {
  it('never runs two createWorker calls concurrently against the same cacheDir', async () => {
    const cacheDir = path.join(baseDir, '.ocr-cache');
    createWorkerDelayMs = 20;
    mockOcrResult = { text: 'ocr text' };

    const [a, b] = await Promise.all([
      ocrPngText('/fake/page-a.png', { cacheDir }),
      ocrPngText('/fake/page-b.png', { cacheDir }),
    ]);

    expect(maxConcurrentCreateWorkerCalls).toBe(1);
    expect(a).toBe('ocr text');
    expect(b).toBe('ocr text');
  });

  it('does not serialize createWorker calls against two different cacheDirs', async () => {
    createWorkerDelayMs = 20;
    mockOcrResult = { text: 'ocr text' };
    const cacheDirA = path.join(baseDir, 'group-a', '.ocr-cache');
    const cacheDirB = path.join(baseDir, 'group-b', '.ocr-cache');
    seedOcrCache(cacheDirA);
    seedOcrCache(cacheDirB);

    const [a, b] = await Promise.all([
      ocrPngText('/fake/page-a.png', { cacheDir: cacheDirA }),
      ocrPngText('/fake/page-b.png', { cacheDir: cacheDirB }),
    ]);

    // Different agent groups' cache dirs are independent locks — no reason
    // for one group's OCR call to wait on an unrelated group's.
    expect(maxConcurrentCreateWorkerCalls).toBe(2);
    expect(a).toBe('ocr text');
    expect(b).toBe('ocr text');
  });

  it("one call's createWorker failure never wedges a later call against the same cacheDir", async () => {
    const cacheDir = path.join(baseDir, '.ocr-cache');
    createWorkerShouldThrow = 'simulated createWorker failure (e.g. a failed language-data download)';

    await expect(ocrPngText('/fake/page-a.png', { cacheDir })).rejects.toThrow(createWorkerShouldThrow);

    createWorkerShouldThrow = undefined;
    mockOcrResult = { text: 'recovered' };
    const result = await ocrPngText('/fake/page-b.png', { cacheDir });
    expect(result).toBe('recovered');
  });
});

// ---------------------------------------------------------------------------
// ensureOcrLangData — checksum-pinned OCR language data (deferred-work.md,
// ocr-fallback item, resolved 2026-08-28). Never hits the real network or
// real tesseract.js CDN hashes — a self-contained fake lang + matching
// hashes, built fresh per test, exercises the same fetch→verify→write logic
// the real 'eng'/'heb' entries go through.
// ---------------------------------------------------------------------------

describe('ensureOcrLangData — checksum-pinned OCR language data', () => {
  function fakeHashes(decompressed: Buffer): Record<string, { gz: string; decompressed: string }> {
    const gz = zlib.gzipSync(decompressed);
    return {
      testlang: {
        gz: crypto.createHash('sha256').update(gz).digest('hex'),
        decompressed: crypto.createHash('sha256').update(decompressed).digest('hex'),
      },
    };
  }

  it('fetches, verifies, and writes the file when not yet cached', async () => {
    const cacheDir = path.join(baseDir, 'fresh-ocr-cache');
    const content = Buffer.from('real language data contents');
    const gz = zlib.gzipSync(content);
    const hashes = fakeHashes(content);
    const fetchFn = mock(async () => new Response(gz, { status: 200 }));

    await ensureOcrLangData(cacheDir, 'testlang', fetchFn as unknown as typeof fetch, hashes);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const written = fs.readFileSync(path.join(cacheDir, 'testlang.traineddata'));
    expect(written.equals(content)).toBe(true);
  });

  it('is a no-op (never calls fetch) when the file already exists', async () => {
    const cacheDir = path.join(baseDir, 'existing-ocr-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'testlang.traineddata'), 'already here');
    const fetchFn = mock(async () => new Response(Buffer.from('should never be used'), { status: 200 }));

    await ensureOcrLangData(cacheDir, 'testlang', fetchFn as unknown as typeof fetch, fakeHashes(Buffer.from('x')));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(cacheDir, 'testlang.traineddata'), 'utf8')).toBe('already here');
  });

  it('rejects a download whose gz bytes do not match the pinned hash', async () => {
    const cacheDir = path.join(baseDir, 'tampered-gz-cache');
    const pinnedContent = Buffer.from('the real expected content');
    const hashes = fakeHashes(pinnedContent);
    // Server returns something else entirely — a compromised/corrupted CDN.
    const tamperedGz = zlib.gzipSync(Buffer.from('tampered content'));
    const fetchFn = mock(async () => new Response(tamperedGz, { status: 200 }));

    await expect(ensureOcrLangData(cacheDir, 'testlang', fetchFn as unknown as typeof fetch, hashes)).rejects.toThrow(
      /integrity check failed/,
    );
    expect(fs.existsSync(path.join(cacheDir, 'testlang.traineddata'))).toBe(false);
  });

  it('rejects when the decompressed content does not match the pinned hash (gz hash matches, decompressed does not)', async () => {
    const cacheDir = path.join(baseDir, 'tampered-decompressed-cache');
    const content = Buffer.from('actual content');
    const gz = zlib.gzipSync(content);
    const hashes = {
      testlang: {
        gz: crypto.createHash('sha256').update(gz).digest('hex'), // correct
        decompressed: '0'.repeat(64), // deliberately wrong
      },
    };
    const fetchFn = mock(async () => new Response(gz, { status: 200 }));

    await expect(ensureOcrLangData(cacheDir, 'testlang', fetchFn as unknown as typeof fetch, hashes)).rejects.toThrow(
      /integrity check failed/,
    );
    expect(fs.existsSync(path.join(cacheDir, 'testlang.traineddata'))).toBe(false);
  });

  it('refuses to fetch a language with no pinned checksum', async () => {
    const cacheDir = path.join(baseDir, 'unpinned-lang-cache');
    const fetchFn = mock(async () => new Response(Buffer.from('x'), { status: 200 }));

    await expect(ensureOcrLangData(cacheDir, 'unpinned', fetchFn as unknown as typeof fetch, {})).rejects.toThrow(
      /no pinned checksum/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('surfaces a non-2xx response as a clear error, not a generic parse failure', async () => {
    const cacheDir = path.join(baseDir, 'http-error-cache');
    const fetchFn = mock(async () => new Response('not found', { status: 404 }));

    await expect(
      ensureOcrLangData(cacheDir, 'testlang', fetchFn as unknown as typeof fetch, fakeHashes(Buffer.from('x'))),
    ).rejects.toThrow(/HTTP 404/);
  });
});
