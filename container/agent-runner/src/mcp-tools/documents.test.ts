import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { slugify, docxXmlToText, saveDocumentImpl, saveDocument } from './documents.js';

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
