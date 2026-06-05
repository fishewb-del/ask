// Local, offline text embeddings via transformers.js (no API, no internet after
// the first run). The model (~25MB, quantized) downloads once into data/model-cache
// and is reused forever. Embeddings are what let us match a question to passages
// by *meaning*, not just keywords.
import { pipeline, env } from '@huggingface/transformers';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keep all model files inside the project so it stays self-contained.
env.cacheDir = join(__dirname, '..', 'data', 'model-cache');
env.allowLocalModels = true;

const MODEL = 'Xenova/all-MiniLM-L6-v2'; // 384-dim sentence embeddings
export const EMBED_DIM = 384;

let extractorPromise = null;
let unavailable = false; // true once we know the model can't load (e.g. no model + no network)

const getExtractor = () => {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL, { dtype: 'q8' });
  }
  return extractorPromise;
};

// Have we got working embeddings? If the model isn't cached and can't be fetched,
// the app falls back to keyword-only search instead of failing outright.
export async function embeddingsReady() {
  if (unavailable) return false;
  try {
    await getExtractor();
    return true;
  } catch (e) {
    unavailable = true;
    extractorPromise = null;
    return false;
  }
}

// Warm the model at startup so the first question is fast (and to learn early
// whether we're in semantic or keyword-only mode).
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

// Serialize/deserialize vectors for SQLite BLOB storage.
export const toBlob = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
export const fromBlob = (buf) =>
  new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
