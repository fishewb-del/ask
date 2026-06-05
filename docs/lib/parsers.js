// Turns an uploaded file into an array of text "segments". A segment is a unit of
// text plus where it came from (page number for PDFs, row for CSVs) so we can cite
// it precisely later. The chunker then splits segments into embedding-sized pieces.
// Browser builds: pdf.js (ESM + worker), mammoth (Word), papaparse (CSV).
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import mammoth from 'https://esm.sh/mammoth@1.9.0';
import Papa from 'https://esm.sh/papaparse@5.5.2';

// pdf.js needs a worker; point it at the matching CDN build.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

const decode = (buf) => new TextDecoder('utf-8').decode(buf);

async function parsePdf(buffer) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
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
  const { value } = await mammoth.extractRawText({ arrayBuffer: buffer });
  // Treat each non-empty paragraph as a segment.
  const segments = value
    .split(/\n{2,}/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text, i) => ({ text, page: null, locator: `¶${i + 1}` }));
  return { kind: 'docx', segments };
}

function parseText(buffer) {
  // Split on blank lines (paragraphs / markdown blocks).
  const segments = decode(buffer)
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((text, i) => ({ text, page: null, locator: `block ${i + 1}` }));
  return { kind: 'text', segments };
}

function parseCsv(buffer) {
  const { data, meta } = Papa.parse(decode(buffer), { header: true, skipEmptyLines: true });
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

const extOf = (name) => {
  const m = /\.[^./\\]+$/.exec(name.toLowerCase());
  return m ? m[0] : '';
};

// `buffer` is an ArrayBuffer read from the user's File.
export async function parseFile(filename, buffer) {
  const ext = extOf(filename);
  const fn = EXT[ext];
  if (!fn) throw new Error(`Unsupported file type: ${ext || '(none)'}`);
  return fn(buffer);
}
