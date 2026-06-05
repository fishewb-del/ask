// Turns an uploaded file into an array of text "segments". A segment is a unit of
// text plus where it came from (page number for PDFs, row for CSVs) so we can cite
// it precisely later. The chunker then splits segments into embedding-sized pieces.
import { extname } from 'node:path';
import mammoth from 'mammoth';
import Papa from 'papaparse';

// PDF parsing uses pdf.js's Node-friendly legacy build.
async function parsePdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const segments = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (text) segments.push({ text, page: p, locator: `p.${p}` });
  }
  await doc.destroy();
  return { kind: 'pdf', segments };
}

async function parseDocx(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  // Treat each non-empty paragraph as a segment.
  const segments = value
    .split(/\n{2,}/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text, i) => ({ text, page: null, locator: `¶${i + 1}` }));
  return { kind: 'docx', segments };
}

function parseText(buffer) {
  const raw = buffer.toString('utf8');
  // Split on blank lines (paragraphs / markdown blocks).
  const segments = raw
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text, i) => ({ text, page: null, locator: `block ${i + 1}` }));
  return { kind: 'text', segments };
}

function parseCsv(buffer) {
  const raw = buffer.toString('utf8');
  const { data, meta } = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const headers = meta.fields || [];
  // One segment per row, rendered as "col: value" pairs so it reads naturally.
  const segments = data.map((row, i) => {
    const text = headers.map((h) => `${h}: ${row[h] ?? ''}`).join('; ');
    return { text, page: null, locator: `row ${i + 1}` };
  });
  return { kind: 'csv', segments };
}

const EXT = {
  '.pdf': parsePdf,
  '.docx': parseDocx,
  '.csv': parseCsv,
  '.txt': parseText,
  '.md': parseText,
  '.markdown': parseText,
};

export const SUPPORTED = Object.keys(EXT);

export async function parseFile(filename, buffer) {
  const ext = extname(filename).toLowerCase();
  const fn = EXT[ext];
  if (!fn) throw new Error(`Unsupported file type: ${ext || '(none)'}`);
  return fn(buffer);
}
