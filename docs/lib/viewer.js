// Lossless drawing viewer. Loads the ORIGINAL PDF from on-device storage and renders
// one page at a time, on demand, at whatever zoom you pick — so you always see the
// real drawing at full fidelity (re-rasterized at the chosen scale, never a
// pre-compressed image). Memory stays low: only the current page is rendered, and the
// document is released when you close the viewer.
//
// Imports pdf.js from the SAME CDN URL as parsers.js, so it's the same cached module
// instance (shares the worker config; no second download).
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import { getFile } from './files.js';

const MIN_SCALE = 0.15;
const MAX_SCALE = 8;

let modal = null;
const v = { doc: null, page: 1, scale: 1, fitScale: 1 };

function build() {
  if (modal) return modal;
  modal = document.createElement('div');
  modal.className = 'viewer hidden';
  modal.innerHTML = `
    <div class="viewer-bar">
      <span class="viewer-title"></span>
      <span class="viewer-spacer"></span>
      <button class="vbtn" data-act="prev" title="Previous page">‹</button>
      <span class="viewer-page"></span>
      <button class="vbtn" data-act="next" title="Next page">›</button>
      <button class="vbtn" data-act="zoomout" title="Zoom out">－</button>
      <span class="viewer-zoom"></span>
      <button class="vbtn" data-act="zoomin" title="Zoom in">＋</button>
      <button class="vbtn" data-act="fit" title="Fit width">Fit</button>
      <button class="vbtn" data-act="close" title="Close">✕</button>
    </div>
    <div class="viewer-stage"><canvas class="viewer-canvas"></canvas></div>`;
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) { if (e.target === modal) close(); return; } // click backdrop to close
    if (act === 'close') close();
    else if (act === 'prev') go(v.page - 1);
    else if (act === 'next') go(v.page + 1);
    else if (act === 'zoomin') zoom(1.25);
    else if (act === 'zoomout') zoom(0.8);
    else if (act === 'fit') fitWidth().then(render);
  });
  document.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(v.page + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(v.page - 1);
  });
  return modal;
}

const stage = () => modal.querySelector('.viewer-stage');

async function fitWidth() {
  const page = await v.doc.getPage(v.page);
  const natural = page.getViewport({ scale: 1 }).width;
  page.cleanup?.();
  const avail = stage().clientWidth - 32;
  v.fitScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, avail / natural));
  v.scale = v.fitScale;
}

async function render() {
  if (!v.doc) return;
  const canvas = modal.querySelector('.viewer-canvas');
  const page = await v.doc.getPage(v.page);
  const viewport = page.getViewport({ scale: v.scale });
  const ctx = canvas.getContext('2d');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup?.();
  modal.querySelector('.viewer-page').textContent = `${v.page} / ${v.doc.numPages}`;
  modal.querySelector('.viewer-zoom').textContent = `${Math.round(v.scale * 100)}%`;
}

function go(n) {
  if (!v.doc) return;
  const next = Math.min(Math.max(1, n), v.doc.numPages);
  if (next === v.page) return;
  v.page = next;
  stage().scrollTop = 0;
  render();
}

function zoom(factor) {
  v.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
  render();
}

function close() {
  if (!modal) return;
  modal.classList.add('hidden');
  try { v.doc?.destroy(); } catch { /* ignore */ }
  v.doc = null;
}

function showMessage(title, msg) {
  build();
  modal.classList.remove('hidden');
  modal.querySelector('.viewer-title').textContent = title;
  modal.querySelector('.viewer-page').textContent = '';
  modal.querySelector('.viewer-zoom').textContent = '';
  const c = modal.querySelector('.viewer-canvas');
  c.width = 0; c.height = 0;
  stage().innerHTML = `<div class="viewer-msg">${msg}</div>`;
}

// Open the viewer for a stored PDF source at a given page.
export async function openViewer(sourceId, filename, page = 1) {
  build();
  modal.classList.remove('hidden');
  modal.querySelector('.viewer-title').textContent = filename || 'Document';
  if (!stage().querySelector('.viewer-canvas')) {
    stage().innerHTML = '<canvas class="viewer-canvas"></canvas>';
  }
  modal.querySelector('.viewer-page').textContent = 'Loading…';
  try {
    const blob = await getFile(sourceId);
    if (!blob) throw new Error('Original file not found. (Files added before viewing was enabled aren’t stored — re-add it to view.)');
    const buf = await blob.arrayBuffer();
    v.doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    v.page = Math.min(Math.max(1, page || 1), v.doc.numPages);
    await fitWidth();
    await render();
  } catch (e) {
    showMessage(filename || 'Document', e.message);
  }
}
