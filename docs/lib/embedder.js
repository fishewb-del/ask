// Local, in-browser text embeddings via transformers.js. The model (~25MB,
// quantized) is fetched once from the Hugging Face Hub and then cached by the
// browser (Cache Storage), so after the first visit it runs with no network.
// Embeddings are what let us match a question to passages by *meaning*, not just
// keywords. Your documents never leave the browser — only the public model is
// fetched, and only once.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';

// On a static host there are no bundled local model files; fetch from the Hub
// (then it's cached). transformers.js handles the caching transparently.
env.allowLocalModels = false;

const MODEL = 'Xenova/all-MiniLM-L6-v2'; // 384-dim sentence embeddings
export const EMBED_DIM = 384;

let extractorPromise = null;
let unavailable = false; // true once we know the model can't load (e.g. offline first run)

const getExtractor = () => {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  }
  return extractorPromise;
};

// Have we got working embeddings? If the model can't be fetched (e.g. offline on
// the very first visit), the app falls back to keyword-only search instead of
// failing outright.
export async function embeddingsReady() {
  if (unavailable) return false;
  try {
    await getExtractor();
    return true;
  } catch (e) {
    unavailable = true;
    extractorPromise = null;
    console.warn('Embeddings unavailable — keyword-only mode:', e);
    return false;
  }
}

// Warm the model early so the first question is fast (and to learn whether we're
// in semantic or keyword-only mode).
export const warmup = () => embeddingsReady();

// Embed one or many strings -> Float32Array(s), or null if embeddings are
// unavailable (callers then degrade to keyword search).
export async function embed(texts) {
  if (!(await embeddingsReady())) return null;
  const single = typeof texts === 'string';
  const input = single ? [texts] : texts;
  const extractor = await getExtractor();
  const output = await extractor(input, { pooling: 'mean', normalize: true });
  const [n, dim] = output.dims;
  const data = output.data; // flat Float32Array of length n*dim
  const vectors = [];
  for (let i = 0; i < n; i++) {
    vectors.push(new Float32Array(data.slice(i * dim, (i + 1) * dim)));
  }
  return single ? vectors[0] : vectors;
}
