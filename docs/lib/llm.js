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
// stale model id. We prefer q4f32 builds because they run on the widest range of
// GPUs; q4f16 builds are smaller/faster but require the WebGPU `shader-f16` feature,
// which many integrated GPUs/drivers lack (and which causes GPU buffer crashes).
const PREFERRED = [
  { match: /Llama-3\.2-1B-Instruct-q4f32/i,  f16: false, label: 'Llama 3.2 1B — most compatible (~1.0 GB)' },
  { match: /Qwen2\.5-1\.5B-Instruct-q4f32/i, f16: false, label: 'Qwen2.5 1.5B — compatible (~1.3 GB)' },
  { match: /Llama-3\.2-1B-Instruct-q4f16/i,  f16: true,  label: 'Llama 3.2 1B — smaller, needs f16 (~0.8 GB)' },
  { match: /Llama-3\.2-3B-Instruct-q4f32/i,  f16: false, label: 'Llama 3.2 3B — smarter (~2.4 GB)' },
  { match: /Phi-3\.5-mini-instruct-q4f16/i,  f16: true,  label: 'Phi-3.5 mini — smart, needs f16 (~2.2 GB)' },
];

export const webgpuAvailable = () =>
  typeof navigator !== 'undefined' && !!navigator.gpu;

// Probe the GPU: is WebGPU usable at all, and does it support the `shader-f16`
// feature? We hide f16-only models when it doesn't, to avoid the GPU buffer crash.
export async function gpuCapabilities() {
  if (!webgpuAvailable()) return { ok: false, f16: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, f16: false };
    return { ok: true, f16: adapter.features?.has?.('shader-f16') || false };
  } catch {
    return { ok: false, f16: false };
  }
}

// The models we can offer, filtered to those present in this WebLLM build and to
// what the GPU can actually run.
export function availableModels({ f16 = false } = {}) {
  const ids = (webllm.prebuiltAppConfig?.model_list || []).map((m) => m.model_id);
  const out = [];
  for (const p of PREFERRED) {
    if (p.f16 && !f16) continue;
    const id = ids.find((x) => p.match.test(x));
    if (id) out.push({ id, label: p.label });
  }
  if (!out.length) {
    // Fallback: surface a few instruct models, preferring f32 unless f16 is supported.
    ids.filter((x) => /instruct/i.test(x) && (f16 || /q4f32/i.test(x)))
      .slice(0, 4).forEach((id) => out.push({ id, label: id }));
  }
  return out;
}

let engine = null;
let loadedId = null;

export const isLoaded = () => !!engine && !!loadedId;
export const currentModel = () => loadedId;

// Fully drop the engine and free GPU memory. Used on errors / device loss.
async function teardown() {
  try { await engine?.unload?.(); } catch { /* ignore */ }
  engine = null;
  loadedId = null;
}

// Download (first time) and initialize a model. onProgress({progress, text}) is called
// repeatedly during the one-time download/compile so the UI can show a progress bar.
export async function loadModel(modelId, onProgress) {
  if (!webgpuAvailable()) {
    throw new Error('WebGPU is not available in this browser. Try Chrome or Edge on a desktop with a GPU.');
  }
  if (engine && loadedId === modelId) return;
  await teardown();
  try {
    engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (r) => { if (onProgress) onProgress(r); },
    });
    loadedId = modelId;
  } catch (e) {
    await teardown();
    throw new Error('Could not load this model on your GPU (' + (e?.message || e) +
      '). Try the most-compatible (smallest) model, or use Quick mode.');
  }
}

// Stream a grounded answer. `messages` is a chat array; onToken(delta) fires per
// streamed token. Returns the full text. Low temperature keeps it faithful. If the
// GPU faults mid-generation it invalidates the engine, so we tear down and report a
// clear, recoverable error rather than leaving a half-dead engine behind.
export async function generate(messages, onToken, { temperature = 0.3 } = {}) {
  if (!isLoaded()) {
    throw new Error('The AI model isn’t loaded — click “Download & enable” first.');
  }
  try {
    const stream = await engine.chat.completions.create({ messages, temperature, stream: true });
    let full = '';
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content || '';
      if (delta) { full += delta; if (onToken) onToken(delta); }
    }
    return full;
  } catch (e) {
    await teardown(); // a GPU error can invalidate everything; reset cleanly
    throw new Error('The local model hit a GPU error and was unloaded (' +
      (e?.message || e) + '). This usually means the model is too heavy for this ' +
      'device — try the smallest model, or use Quick mode.');
  }
}
