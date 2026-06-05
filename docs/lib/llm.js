// Optional in-browser LLM, powered by WebLLM (MLC) — all open source, all free.
// The model (open-weights: Llama 3.2 / Qwen2.5 / Phi-3.5) is downloaded once from
// the public Hugging Face hub and runs locally on your GPU via WebGPU. No API keys,
// no accounts, no server — and after the first download it works offline.
//
// Requirements: a browser with WebGPU (Chrome/Edge on a machine with a GPU; Safari
// 17+ and recent Firefox also work). If WebGPU isn't available, the app stays in the
// lightweight extractive mode instead — nothing breaks.
import * as webllm from 'https://esm.run/@mlc-ai/web-llm@0.2';

// Friendly options, matched against WebLLM's prebuilt catalog so we never hardcode a
// stale model id. Ordered smallest/fastest first.
const PREFERRED = [
  { match: /Llama-3\.2-1B-Instruct/i,  label: 'Llama 3.2 1B — fastest (~0.9 GB)' },
  { match: /Qwen2\.5-1\.5B-Instruct/i, label: 'Qwen2.5 1.5B — balanced (~1.2 GB)' },
  { match: /Llama-3\.2-3B-Instruct/i,  label: 'Llama 3.2 3B — smarter (~2.2 GB)' },
  { match: /Phi-3\.5-mini-instruct/i,  label: 'Phi-3.5 mini — smart (~2.2 GB)' },
];

export const webgpuAvailable = () =>
  typeof navigator !== 'undefined' && !!navigator.gpu;

// The models we can offer, filtered to those actually present in this WebLLM build.
export function availableModels() {
  const ids = (webllm.prebuiltAppConfig?.model_list || []).map((m) => m.model_id);
  const out = [];
  for (const p of PREFERRED) {
    const id = ids.find((x) => p.match.test(x));
    if (id) out.push({ id, label: p.label });
  }
  if (!out.length) {
    // Fallback: surface a few instruct-tuned models if our preferred ones moved.
    ids.filter((x) => /instruct/i.test(x)).slice(0, 4).forEach((id) => out.push({ id, label: id }));
  }
  return out;
}

let engine = null;
let loadedId = null;

export const isLoaded = () => !!engine;
export const currentModel = () => loadedId;

// Download (first time) and initialize a model. onProgress({progress, text}) is called
// repeatedly during the one-time download/compile so the UI can show a progress bar.
export async function loadModel(modelId, onProgress) {
  if (!webgpuAvailable()) {
    throw new Error('WebGPU is not available in this browser. Try Chrome or Edge on a desktop with a GPU.');
  }
  if (engine && loadedId === modelId) return;
  if (engine) { try { await engine.unload(); } catch { /* ignore */ } engine = null; loadedId = null; }
  engine = await webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (r) => { if (onProgress) onProgress(r); },
  });
  loadedId = modelId;
}

// Stream a grounded answer. `messages` is a chat array; onToken(delta) fires per
// streamed token. Returns the full text. Low temperature keeps it faithful.
export async function generate(messages, onToken, { temperature = 0.3 } = {}) {
  if (!engine) throw new Error('Model not loaded');
  const stream = await engine.chat.completions.create({ messages, temperature, stream: true });
  let full = '';
  for await (const chunk of stream) {
    const delta = chunk?.choices?.[0]?.delta?.content || '';
    if (delta) { full += delta; if (onToken) onToken(delta); }
  }
  return full;
}
