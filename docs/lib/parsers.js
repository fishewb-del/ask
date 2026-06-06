// Turns an uploaded file into an array of text "segments". A segment is a unit of
// text plus where it came from (page number for PDFs, row for CSVs) so we can cite
// it precisely later. The chunker then splits segments into embedding-sized pieces.
// Browser builds: pdf.js (ESM + worker), mammoth (Word), papaparse (CSV).
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import mammoth from 'https://esm.sh/mammoth@1.9.0';
import Papa from 'https://esm.sh/papaparse@5.5.2';
import * as ocr from './ocr.js';

// Pages whose embedded text is shorter than this are treated as scanned/image-only
// and sent to OCR (when enabled).
const SPARSE_CHARS = 100;

// pdf.js needs a worker; point it at the matching CDN build.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

const decode = (buf) => new TextDecoder('utf-8').decode(buf);
const minBy = (arr, f) => arr.reduce((m, t) => Math.min(m, f(t)), Infinity);
const maxBy = (arr, f) => arr.reduce((m, t) => Math.max(m, f(t)), -Infinity);

// --- Structure-aware PDF text reconstruction ---------------------------------
// pdf.js hands us positioned text fragments. Rather than naively joining them
// (which scrambles columns and glues paragraphs together), we use their x/y
// geometry and font size to rebuild lines, paragraphs, columns, and headings.
// This yields clean, paragraph-level segments — far better chunks and citations.

// Detect a two-column layout by finding a vertical gutter that almost no text
// crosses. Conservative: only splits when the split is clean and balanced.
function detectColumns(toks) {
  if (toks.length < 40) return [toks];
  const minX = minBy(toks, (t) => t.x);
  const maxX = maxBy(toks, (t) => t.x + t.w);
  const width = maxX - minX;
  if (width <= 0) return [toks];
  let best = null;
  for (let f = 0.35; f <= 0.66; f += 0.05) {
    const X = minX + width * f;
    let crossing = 0, left = 0, right = 0;
    for (const t of toks) {
      if (t.x < X && t.x + t.w > X) crossing++;
      else if (t.x + t.w <= X) left++;
      else right++;
    }
    if (left > toks.length * 0.2 && right > toks.length * 0.2 &&
        (!best || crossing < best.crossing)) {
      best = { X, crossing };
    }
  }
  if (best && best.crossing <= toks.length * 0.02) {
    return [
      toks.filter((t) => t.x + t.w <= best.X),
      toks.filter((t) => t.x + t.w > best.X),
    ];
  }
  return [toks];
}

function reconstructSegments(items, pageNum) {
  const toks = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const h = it.height || Math.hypot(tr[2], tr[3]) || 10;
    toks.push({ str: it.str, x: tr[4], y: tr[5], w: it.width || 0, h });
  }
  if (!toks.length) return [];

  const sortedH = toks.map((t) => t.h).sort((a, b) => a - b);
  const medianH = sortedH[Math.floor(sortedH.length / 2)] || 10;
  const locator = `p.${pageNum}`;
  const segments = [];

  for (const col of detectColumns(toks)) {
    col.sort((a, b) => b.y - a.y || a.x - b.x); // top-to-bottom, then left-to-right

    // Group tokens into lines (same y, within ~half a line height).
    const lines = [];
    let cur = [], lastY = null;
    for (const t of col) {
      if (lastY === null || Math.abs(t.y - lastY) <= medianH * 0.6) cur.push(t);
      else { lines.push(cur); cur = [t]; }
      lastY = t.y;
    }
    if (cur.length) lines.push(cur);

    // Render each line, inserting spaces only where there's a real horizontal gap.
    const lineObjs = [];
    for (const ln of lines) {
      ln.sort((a, b) => a.x - b.x);
      let text = '', prev = null;
      for (const t of ln) {
        if (prev && t.x - (prev.x + prev.w) > prev.h * 0.3) text += ' ';
        text += t.str;
        prev = t;
      }
      text = text.replace(/\s+/g, ' ').trim();
      if (text) lineObjs.push({ text, y: ln[0].y, h: maxBy(ln, (t) => t.h) });
    }

    // Group lines into paragraphs by vertical gaps; headings (larger font) break too.
    let para = [], prevLine = null, prevHeading = false;
    const flush = () => {
      if (!para.length) return;
      const text = para.join(' ').replace(/\s+/g, ' ').trim();
      if (text.length > 1) segments.push({ text, page: pageNum, locator });
      para = [];
    };
    for (const ln of lineObjs) {
      const isHeading = ln.h > medianH * 1.35 && ln.text.length <= 120;
      if (prevLine && (prevLine.y - ln.y > medianH * 1.7 || isHeading || prevHeading)) flush();
      para.push(ln.text);
      prevLine = ln;
      prevHeading = isHeading;
    }
    flush();
  }
  return segments;
}

// Render a PDF page to a canvas, capped in size, for OCR.
async function renderPageToCanvas(page, maxDim = 2200) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(1, Math.min(2.5, maxDim / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

async function ocrPage(page, p) {
  const canvas = await renderPageToCanvas(page);
  const text = await ocr.recognize(canvas);
  canvas.width = canvas.height = 0; // free the bitmap
  if (!text) return [];
  return text
    .split(/\n{2,}/)
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 1)
    .map((t) => ({ text: t, page: p, locator: `p.${p} (scanned)` }));
}

async function parsePdf(buffer, onProgress, opts = {}) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const wantOcr = opts.ocr !== false;
  let ocrChecked = false, ocrOk = false;
  const segments = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let segs = reconstructSegments(content.items, p);
    const chars = segs.reduce((a, s) => a + s.text.length, 0);

    // Scanned/image-only page? OCR it (loading the engine lazily, just once).
    if (wantOcr && chars < SPARSE_CHARS) {
      if (!ocrChecked) { ocrChecked = true; ocrOk = await ocr.available(); }
      if (ocrOk) {
        if (onProgress) onProgress({ phase: 'ocr', page: p, pages: doc.numPages });
        try {
          const ocrSegs = await ocrPage(page, p);
          if (ocrSegs.length) segs = segs.concat(ocrSegs);
        } catch { /* keep whatever embedded text we had */ }
      }
    }

    if (segs.length) {
      segments.push(...segs);
    } else {
      // Fallback to a naive join if geometry-based reconstruction found nothing.
      const text = content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (text) segments.push({ text, page: p, locator: `p.${p}` });
    }
    page.cleanup?.(); // free the page's resources to keep memory flat
    if (onProgress) onProgress({ phase: 'parse', page: p, pages: doc.numPages });
    if (p % 2 === 0) await new Promise((r) => setTimeout(r)); // yield to the event loop
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

// `buffer` is an ArrayBuffer read from the user's File. onProgress (optional) is
// forwarded to parsers that support it (PDF) and ignored by the others.
export async function parseFile(filename, buffer, onProgress, opts) {
  const ext = extOf(filename);
  const fn = EXT[ext];
  if (!fn) throw new Error(`Unsupported file type: ${ext || '(none)'}`);
  return fn(buffer, onProgress, opts);
}
