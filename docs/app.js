// AskDocs frontend — plain ES modules, no build step. This is the in-browser
// edition: instead of calling a server API, it talks directly to local modules that
// store data in IndexedDB and run the AI model in the browser. Nothing is uploaded.
import * as db from './lib/db.js';
import { ingestFile } from './lib/ingest.js';
import { search, invalidate } from './lib/search.js';
import { answer } from './lib/generator.js';
import { warmup } from './lib/embedder.js';

const $ = (sel) => document.querySelector(sel);
const state = { notebookId: null, notebookName: '' };

// ---------- Engine status ----------
// Load the embedding model in the background and report whether we're in full
// hybrid mode or keyword-only mode (e.g. offline on the very first visit).
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
      await db.deleteNotebook(nb.id);
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
    li.innerHTML = `<span class="kind">${kindIcon(s.kind)}</span>
      <span class="name" title="${esc(s.filename)}">${esc(s.filename)}</span>
      <button class="del" title="Remove">✕</button>`;
    li.querySelector('.del').onclick = async () => {
      await db.deleteSource(s.id);
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

  // Process files one at a time, locally — mirrors the server's per-file results.
  const failed = [];
  for (const f of files) {
    try {
      await ingestFile(state.notebookId, f);
    } catch (err) {
      failed.push({ filename: f.name, error: err.message });
    }
  }
  invalidate(state.notebookId);

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
    const { results, totalChunks } = await search(state.notebookId, query, 6);
    const composed = await answer(query, results);
    thinking.innerHTML = renderAnswer({ ...composed, passages: results, totalChunks });
    wireCitations(thinking);
  } catch (err) {
    thinking.innerHTML = `<div class="answer">⚠️ ${esc(err.message)}</div>`;
  }
  btn.disabled = false;
  $('#messages').scrollTop = $('#messages').scrollHeight;
};

function renderAnswer(res) {
  const answerHtml = esc(res.answer).replace(/\[(\d+)\]/g,
    (_, n) => `<span class="cite-ref" data-n="${n}">[${n}]</span>`);
  const cites = (res.citations || []).map((c) => `
    <div class="citation" data-n="${c.n}">
      <div class="src">[${c.n}] ${esc(c.filename)}${c.locator ? ' · ' + esc(c.locator) : ''}</div>
      <div class="snip">${esc(c.snippet)}</div>
    </div>`).join('');
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
const kindIcon = (k) => ({ pdf: '📄', docx: '📝', csv: '📊', text: '🗒️' }[k] || '📄');

loadNotebooks();
