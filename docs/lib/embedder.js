// Local, in-browser text embeddings — now run in a Web Worker (see embed-worker.js)
// so heavy indexing never freezes the page. This module is just the main-thread
// client: it ships text to the worker and turns the returned buffers back into
// Float32Array vectors. Same API as before (warmup / embeddingsReady / embed), so the
// rest of the app is unchanged. If the worker or model can't load, embed() returns
// null and the app degrades to keyword-only search.
export const EMBED_DIM = 384;

let worker = null;
let unavailable = false; // true once we know embeddings can't work here
let ready = false;
let reqId = 0;
const pending = new Map();

function makeWorker() {
  const w = new Worker(new URL('./embed-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => {
    const { id, ok, error, ...rest } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(rest) : p.reject(new Error(error || 'embed error'));
  };
  w.onerror = () => {
    unavailable = true;
    for (const [, p] of pending) p.reject(new Error('embedding worker failed'));
    pending.clear();
  };
  return w;
}

function getWorker() {
  if (!worker && !unavailable) {
    try { worker = makeWorker(); } catch { unavailable = true; }
  }
  return worker;
}

function call(msg) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) { reject(new Error('no embedding worker')); return; }
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ...msg });
  });
}

// Have we got working embeddings? Loads the model in the worker on first call.
export async function embeddingsReady() {
  if (unavailable) return false;
  if (ready) return true;
  try {
    await call({ type: 'warmup' });
    ready = true;
    return true;
  } catch (e) {
    unavailable = true;
    console.warn('Embeddings unavailable — keyword-only mode:', e);
    return false;
  }
}

export const warmup = () => embeddingsReady();

// Embed one or many strings -> Float32Array(s), or null if embeddings are
// unavailable (callers then degrade to keyword search).
export async function embed(texts) {
  if (!(await embeddingsReady())) return null;
  const single = typeof texts === 'string';
  const arr = single ? [texts] : texts;
  if (arr.length === 0) return single ? null : [];
  try {
    const { n, dim, buf } = await call({ type: 'embed', texts: arr });
    const flat = new Float32Array(buf);
    const vectors = [];
    for (let i = 0; i < n; i++) vectors.push(flat.slice(i * dim, (i + 1) * dim));
    return single ? vectors[0] : vectors;
  } catch (e) {
    unavailable = true;
    console.warn('Embedding failed — keyword-only mode:', e);
    return null;
  }
}
