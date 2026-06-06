// Optional OCR for scanned / image-only PDF pages, via Tesseract.js — free, open
// source, and fully local (it runs in its own Web Workers + WASM). Used only on pages
// where the PDF has little or no real text, so normal documents pay no cost. Fully
// resilient: if Tesseract can't load (e.g. offline first run), OCR is skipped and the
// rest of indexing proceeds normally.
import { createWorker } from 'https://esm.sh/tesseract.js@5';

let workerPromise = null;
let unavailable = false;

function getWorker() {
  if (unavailable) return Promise.resolve(null);
  if (!workerPromise) {
    // createWorker('eng') downloads the engine + English data once, then caches them.
    workerPromise = createWorker('eng').catch((e) => {
      unavailable = true;
      workerPromise = null;
      console.warn('OCR unavailable:', e);
      return null;
    });
  }
  return workerPromise;
}

// Is OCR usable? (Triggers the one-time engine/lang download on first call.)
export async function available() {
  return !!(await getWorker());
}

// Recognize text from a canvas/ImageBitmap/Blob; returns '' on any failure.
export async function recognize(image) {
  const w = await getWorker();
  if (!w) return '';
  try {
    const { data: { text } } = await w.recognize(image);
    return (text || '').trim();
  } catch (e) {
    console.warn('OCR failed on a page:', e);
    return '';
  }
}

export async function shutdown() {
  const w = workerPromise && (await workerPromise);
  try { await w?.terminate?.(); } catch { /* ignore */ }
  workerPromise = null;
}
