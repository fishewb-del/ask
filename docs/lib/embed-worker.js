// Embedding worker — runs the sentence-embedding model OFF the main thread so the
// UI never freezes while indexing documents. transformers.js (WASM) computes vectors
// here; the page thread only sends text and receives Float32Array buffers back.
// Requests are processed one at a time (a simple promise chain) so concurrent calls
// from indexing and from a user's question can't trip over each other.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';

env.allowLocalModels = false; // fetch the small public model once; then it's cached

const MODEL = 'Xenova/all-MiniLM-L6-v2'; // 384-dim sentence embeddings
let extractorPromise = null;
const getExtractor = () =>
  (extractorPromise ??= pipeline('feature-extraction', MODEL, { dtype: 'q8' }));

async function handle({ id, type, texts }) {
  try {
    if (type === 'warmup') {
      await getExtractor();
      self.postMessage({ id, ok: true });
      return;
    }
    const extractor = await getExtractor();
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    const [n, dim] = out.dims;
    const flat = new Float32Array(out.data); // copy into an owned, transferable buffer
    self.postMessage({ id, ok: true, n, dim, buf: flat.buffer }, [flat.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
}

// Serialize work so only one embedding job runs at a time.
let chain = Promise.resolve();
self.onmessage = (e) => {
  const job = e.data;
  chain = chain.then(() => handle(job)).catch(() => {});
};
