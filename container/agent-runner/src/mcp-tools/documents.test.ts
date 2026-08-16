import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  slugify,
  docxXmlToText,
  saveDocumentImpl,
  saveDocument,
  listDocumentsImpl,
  listDocuments,
  fillDocumentFieldImpl,
  fillDocumentField,
} from './documents.js';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpRoot: string;
let baseDir: string;
let inboxDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'save-document-test-'));
  baseDir = path.join(tmpRoot, 'agent');
  inboxDir = path.join(tmpRoot, 'inbox', 'msg1');
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });
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

describe('save_document — scanned PDF, no text layer', () => {
  it('first call renders page 1 and asks the agent to read it, without saving anything yet', async () => {
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('no extractable text layer');
    expect(result.content[0].text).toContain('save_document again');
    // Transparency: the response must disclose that only page 1 was captured.
    expect(result.content[0].text).toContain('page 1 only');
    // The render path in the message must be derived from the injected
    // baseDir, not a hardcoded "/workspace/agent/" prefix (which would be
    // wrong for any baseDir other than the production default).
    expect(result.content[0].text).toContain(path.join(baseDir, '.document-renders'));
    expect(result.content[0].text).not.toContain('/workspace/agent/');

    // No partial memory entry from the first (render-only) call.
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'scan.md'))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, 'memory', 'documents', 'files', 'scan.pdf'))).toBe(false);

    const renderDir = path.join(baseDir, '.document-renders');
    expect(fs.existsSync(renderDir)).toBe(true);
    const rendered = fs.readdirSync(renderDir);
    expect(rendered.length).toBe(1);
    expect(rendered[0]).toMatch(/\.png$/);
  });

  it('renders the same deterministic filename on repeated first calls for the same file', async () => {
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

  it('second call, with extractedText, completes the save and deletes the render PNG', async () => {
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

  it('rejects a non-string extractedText with a clear error instead of silently re-rendering', async () => {
    const filePath = writeInboxFile('scan.pdf', buildMinimalPdf(null));

    const result = await saveDocumentImpl({ path: filePath, extractedText: 12345 }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('extractedText must be a string');
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

  it('declines legacy .doc (binary, not in scope for this story)', async () => {
    const filePath = writeInboxFile('legacy.doc', Buffer.from('not a real doc file', 'utf-8'));

    const result = await saveDocumentImpl({ path: filePath }, opts());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unsupported file type');
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

async function readDocxXml(buf: Buffer): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('word/document.xml missing from produced docx');
  return file.async('string');
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
  const streamContent = lines.map((text, i) => `BT /F1 14 Tf 20 ${160 - i * 20} Td (${escapePdfString(text)}) Tj ET`).join('\n');
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
  it('fills the row\'s last cell by default, leaving everything else byte-identical', async () => {
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
  it('inserts a new run right after the paragraph\'s last existing run', async () => {
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
  it('returns the specific "value is required together with lineNumber" error', async () => {
    const filePath = writeInboxFile('intake.docx', buildDocx(['שם: ___________']));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'intake', lineNumber: 1 }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('value is required together with lineNumber');
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

    const result = await fillDocumentFieldImpl(
      { document: 'intake', column: 2, lineNumber: 1, value: 'X' },
      opts(),
    );
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
    const filePath = writeInboxFile(
      'intake.docx',
      buildDocx(['_____________________________', 'שם: ___________']),
    );
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

function extractRenderPath(text: string): string {
  const m = /to (\S+\.png)\./.exec(text);
  if (!m) throw new Error(`No render path found in response: ${text}`);
  return m[1];
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

// --- 5. Merged-cell (gridSpan) detect-and-decline ---------------------------

describe('fill_document_field — docx, merged cell (gridSpan)', () => {
  it('declines cleanly instead of miscounting the visual column', async () => {
    const filePath = writeInboxFile('report.docx', buildDocxWithRawTable(gridSpanRowXml()));
    await saveDocumentImpl({ path: filePath }, opts());

    const result = await fillDocumentFieldImpl({ document: 'report', row: 1, column: 2, value: 'X' }, opts());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('merged cell');
    expect(fs.existsSync(path.join(baseDir, '.document-fills'))).toBe(false);
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
