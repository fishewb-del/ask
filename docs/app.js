// AskDocs frontend — plain ES modules, no build step. In-browser edition: it talks
// directly to local modules that store data in IndexedDB, run the embedding model in
// the browser, and (optionally) run a small open-source LLM in the browser for
// reasoned, cited prose answers. Nothing is ever uploaded.
import * as db from './lib/db.js';
import { ingestFile } from './lib/ingest.js';
import { search, invalidate } from './lib/search.js';
import { answer, buildMessages, citationsFor } from './lib/generator.js';
import { warmup } from './lib/embedder.js';
import * as llm from './lib/llm.js';
import { openViewer } from './lib/viewer.js';
import { deleteFile } from './lib/files.js';

const isPdf = (name) => /\.pdf$/i.test(name || '');

const $ = (sel) => document.querySelector(sel);
const state = { notebookId: null, notebookName: '', answerMode: 'extractive', llmReady: false };

// ---------- Engine status (embeddings) ----------
const engine = $('#engineStatus');
engine.textContent = 'Loading local AI model… (one-time ~25MB download)';
warmup().then((ok) => {
  if (ok) {
    engine.textContent = 'Ready · semantic + keyword search · runs in your browser';
    engine.className = 'engine ready';
  } else {
    engine.textContent = 'Keyword-only mode (model needs internet once, then works offline)';
    engine.className = 'engine warn';
  }
});

// ---------- AI answers (optional in-browser LLM) ----------
const answerMode = $('#answerMode');
const aiSetup = $('#aiSetup');
const modelSelect = $('#modelSelect');
const loadModelBtn = $('#loadModelBtn');
const aiProgress = $('#aiProgress');

(async function initAiPanel() {
  const caps = await llm.gpuCapabilities();
  if (!caps.ok) {
    // No usable WebGPU → keep AI option visible but explain it can't run here.
    const opt = answerMode.querySelector('option[value="llm"]');
    opt.textContent = 'AI prose — needs WebGPU';
    opt.disabled = true;
    return;
  }
  // Only offer models this GPU can actually run (hides f16-only models when the
  // GPU lacks shader-f16, which otherwise crashes with a GPU buffer error).
  for (const m of llm.availableModels({ f16: caps.f16 })) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    modelSelect.appendChild(o);
  }
})();

answerMode.onchange = () => {
  state.answerMode = answerMode.value;
  const wantLlm = state.answerMode === 'llm';
  aiSetup.classList.toggle('hidden', !wantLlm || state.llmReady);
};

loadModelBtn.onclick = async () => {
  const id = modelSelect.value;
  if (!id) return;
  loadModelBtn.disabled = true;
  aiProgress.className = 'ai-progress';
  aiProgress.classList.remove('hidden');
  aiProgress.textContent = 'Starting download…';
  try {
    await llm.loadModel(id, (r) => {
      const pct = r.progress ? ` ${Math.round(r.progress * 100)}%` : '';
      aiProgress.textContent = (r.text || 'Loading model…') + pct;
    });
    state.llmReady = true;
    state.answerMode = 'llm';
    answerMode.value = 'llm';
    aiProgress.className = 'ai-progress ready';
    aiProgress.textContent = `AI answers ready · ${llm.currentModel()}`;
    setTimeout(() => aiSetup.classList.add('hidden'), 1500);
  } catch (e) {
    aiProgress.className = 'ai-progress warn';
    aiProgress.textContent = e.message;
    answerMode.value = 'extractive';
    state.answerMode = 'extractive';
  }
  loadModelBtn.disabled = false;
};

// ---------- Notebooks ----------
async function loadNotebooks() {
  const notebooks = await db.listNotebooks();
  const list = $('#notebookList');
  list.innerHTML = '';
  for (const nb of notebooks) {
    const li = document.createElement('li');
    if (nb.id === state.notebookId) li.classList.add('active');
    li.innerHTML = `<span class="name">${esc(nb.name)}</span>
      <span class="count">${nb.source_count}</span>
      <button class="del" title="Delete">✕</button>`;
    li.querySelector('.name').onclick = () => selectNotebook(nb.id, nb.name);
    li.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete notebook "${nb.name}" and all its sources?`)) return;
      const srcs = await db.listSources(nb.id);
      await db.deleteNotebook(nb.id);
      for (const s of srcs) deleteFile(s.id); // remove stored originals
      invalidate(nb.id);
      if (state.notebookId === nb.id) resetMain();
      loadNotebooks();
    };
    list.appendChild(li);
  }
}

$('#newNotebookBtn').onclick = async () => {
  const name = (prompt('Name this notebook:', 'My notebook') || '').trim();
  if (!name) return;
  const id = await db.createNotebook(name);
  await loadNotebooks();
  selectNotebook(id, name);
};

function resetMain() {
  state.notebookId = null;
  $('#chat').classList.add('hidden');
  $('#sourcesArea').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
}

async function selectNotebook(id, name) {
  state.notebookId = id;
  state.notebookName = name;
  $('#emptyState').classList.add('hidden');
  $('#chat').classList.remove('hidden');
  $('#sourcesArea').classList.remove('hidden');
  $('#chatTitle').textContent = name;
  $('#messages').innerHTML = '';
  await Promise.all([loadNotebooks(), loadSources()]);
}

// ---------- Sources ----------
async function loadSources() {
  const sources = await db.listSources(state.notebookId);
  const list = $('#sourceList');
  list.innerHTML = '';
  let chunks = 0;
  for (const s of sources) {
    chunks += s.num_chunks;
    const li = document.createElement('li');
    const viewable = isPdf(s.filename);
    li.innerHTML = `<span class="kind">${kindIcon(s.kind)}</span>
      <span class="name${viewable ? ' viewable' : ''}" title="${viewable ? 'Open drawing' : esc(s.filename)}">${esc(s.filename)}</span>
      <button class="del" title="Remove">✕</button>`;
    if (viewable) li.querySelector('.name').onclick = () => openViewer(s.id, s.filename, 1);
    li.querySelector('.del').onclick = async () => {
      await db.deleteSource(s.id);
      deleteFile(s.id); // remove stored original
      invalidate(state.notebookId);
      loadSources();
    };
    list.appendChild(li);
  }
  $('#chatMeta').textContent = sources.length
    ? `${sources.length} source(s) · ${chunks} passages indexed`
    : 'No sources yet — add documents to get started.';
}

$('#fileInput').onchange = async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const status = $('#uploadStatus');
  status.classList.remove('hidden');
  status.style.color = 'var(--muted)';
  status.textContent = `Reading & indexing ${files.length} file(s)… (first run loads the model)`;

  const failed = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    const prefix = files.length > 1 ? `(${fi + 1}/${files.length}) ` : '';
    status.textContent = `${prefix}Reading ${f.name}…`;
    try {
      await ingestFile(state.notebookId, f, (p) => {
        if (p.phase === 'parse') {
          status.textContent = `${prefix}${f.name}: reading page ${p.page}/${p.pages}…`;
        } else if (p.phase === 'embed') {
          status.textContent = `${prefix}${f.name}: indexing ${p.done}/${p.total} passages…`;
        }
      });
    } catch (err) {
      failed.push({ filename: f.name, error: err.message });
    }
    // Make each finished file searchable and visible right away.
    invalidate(state.notebookId);
    loadSources();
  }

  if (failed.length) {
    status.style.color = 'var(--warn)';
    status.textContent = failed.map((f) => `${f.filename}: ${f.error}`).join(' · ');
  } else {
    status.classList.add('hidden');
  }
  e.target.value = '';
  loadSources();
};

// ---------- Asking ----------
$('#askForm').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#askInput');
  const query = input.value.trim();
  if (!query || !state.notebookId) return;
  input.value = '';
  addMessage('user', esc(query));
  const thinking = addMessage('bot', '<span class="thinking">Searching your sources…</span>');
  const btn = $('#askForm button');
  btn.disabled = true;
  try {
    const { results } = await search(state.notebookId, query, 6);
    const useLlm = state.answerMode === 'llm' && state.llmReady && results.length > 0;
    if (useLlm) {
      await streamLlmAnswer(thinking, query, results);
    } else {
      const composed = await answer(query, results);
      thinking.innerHTML = renderAnswer(composed, query);
      wireCitations(thinking);
    }
  } catch (err) {
    thinking.innerHTML = `<div class="answer">⚠️ ${esc(err.message)}</div>`;
  }
  btn.disabled = false;
  $('#messages').scrollTop = $('#messages').scrollHeight;
};

// Stream a generated answer token-by-token, then swap in clickable citations. If the
// GPU model faults, fall back to a Quick (extractive) answer so the user still gets a
// result, and reset the AI panel so they can re-enable.
async function streamLlmAnswer(thinking, query, results) {
  thinking.innerHTML = '<div class="answer"></div>';
  const ansEl = thinking.querySelector('.answer');
  const messages = buildMessages(query, results);
  let buf = '';
  try {
    const full = await llm.generate(messages, (delta) => {
      buf += delta;
      ansEl.textContent = buf; // textContent escapes; safe during streaming
      $('#messages').scrollTop = $('#messages').scrollHeight;
    });
    thinking.innerHTML = renderAnswer({ answer: full || buf, citations: citationsFor(results) }, query);
    wireCitations(thinking);
  } catch (err) {
    // Model died (e.g. GPU error). Drop to Quick mode and still answer the question.
    state.llmReady = false;
    state.answerMode = 'extractive';
    answerMode.value = 'extractive';
    aiSetup.classList.remove('hidden');
    aiProgress.className = 'ai-progress warn';
    aiProgress.textContent = 'AI model unloaded after a GPU error — re-enable to retry, or use Quick mode.';
    const composed = await answer(query, results);
    thinking.innerHTML = renderAnswer(composed, query) +
      `<div class="upload-status">⚠️ ${esc(err.message)}</div>`;
    wireCitations(thinking);
  }
}

function renderAnswer(res, query) {
  const answerHtml = esc(res.answer).replace(/\[(\d+)\]/g,
    (_, n) => `<span class="cite-ref" data-n="${n}">[${n}]</span>`);
  const cites = (res.citations || []).map((c) => {
    const view = (isPdf(c.filename) && c.sourceId != null)
      ? `<button class="view-page" data-src="${c.sourceId}" data-page="${c.page || 1}"
                 data-file="${esc(c.filename)}" title="Open this page">view</button>`
      : '';
    return `
    <div class="citation" data-n="${c.n}">
      <div class="src">[${c.n}] ${esc(c.filename)}${c.locator ? ' · ' + esc(c.locator) : ''} ${view}</div>
      <div class="snip">${highlight(esc(c.snippet), query)}</div>
    </div>`;
  }).join('');
  return `<div class="answer">${answerHtml}</div>
    ${cites ? `<div class="citations">${cites}</div>` : ''}`;
}

function wireCitations(el) {
  el.querySelectorAll('.cite-ref').forEach((ref) => {
    ref.onclick = () => {
      const target = el.querySelector(`.citation[data-n="${ref.dataset.n}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.animate([{ background: '#3a4a6b' }, { background: 'var(--panel-2)' }],
          { duration: 1200 });
      }
    };
  });
  el.querySelectorAll('.view-page').forEach((btn) => {
    btn.onclick = () => openViewer(Number(btn.dataset.src), btn.dataset.file, Number(btn.dataset.page));
  });
}

function addMessage(role, html) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = html;
  $('#messages').appendChild(div);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return div;
}

// ---------- helpers ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const HL_STOP = new Set('the and for that this with from what when where which who why how are was about your you our'.split(' '));
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Wrap query terms in <mark> within already-escaped snippet text.
function highlight(escaped, query) {
  if (!query) return escaped;
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9#./-]{3,}/g) || [])
    .filter((w) => !HL_STOP.has(w)))];
  if (!terms.length) return escaped;
  const re = new RegExp(`\\b(${terms.map(rx).join('|')})`, 'gi');
  return escaped.replace(re, '<mark>$&</mark>');
}

const kindIcon = (k) => ({ pdf: '📄', docx: '📝', csv: '📊', text: '🗒️' }[k] || '📄');

loadNotebooks();
