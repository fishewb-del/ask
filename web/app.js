// AskDocs frontend — plain ES modules, no build step.
const $ = (sel) => document.querySelector(sel);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};

const state = { notebookId: null, notebookName: '' };

// ---------- Notebooks ----------
async function loadNotebooks() {
  const notebooks = await api('/api/notebooks');
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
      await api(`/api/notebooks/${nb.id}`, { method: 'DELETE' });
      if (state.notebookId === nb.id) resetMain();
      loadNotebooks();
    };
    list.appendChild(li);
  }
}

$('#newNotebookBtn').onclick = async () => {
  const name = prompt('Name this notebook:', 'My notebook');
  if (name === null) return;
  const nb = await api('/api/notebooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  await loadNotebooks();
  selectNotebook(nb.id, nb.name);
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
  const sources = await api(`/api/notebooks/${state.notebookId}/sources`);
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
      await api(`/api/sources/${s.id}?notebookId=${state.notebookId}`, { method: 'DELETE' });
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
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f));
  try {
    const { results } = await api(`/api/notebooks/${state.notebookId}/sources`, {
      method: 'POST', body: fd,
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      status.style.color = 'var(--warn)';
      status.textContent = failed.map((f) => `${f.filename}: ${f.error}`).join(' · ');
    } else {
      status.classList.add('hidden');
    }
  } catch (err) {
    status.style.color = 'var(--warn)';
    status.textContent = err.message;
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
    const res = await api(`/api/notebooks/${state.notebookId}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    thinking.innerHTML = renderAnswer(res);
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
  div.innerHTML = role === 'bot' ? html : html;
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
