// AskDocs server: serves the web UI and a small JSON API. Single process, single
// command (`npm start`). Everything runs locally.
import express from 'express';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as dbm from './db.js';
import { ingestFile } from './ingest.js';
import { search, invalidate } from './search.js';
import { answer } from './generator.js';
import { warmup } from './embedder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'web')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

// ---- Notebooks ----
app.get('/api/notebooks', wrap(async (_req, res) => res.json(dbm.listNotebooks())));

app.post('/api/notebooks', wrap(async (req, res) => {
  const name = (req.body?.name || '').trim() || 'Untitled notebook';
  const id = dbm.createNotebook(name);
  res.json(dbm.getNotebook(id));
}));

app.delete('/api/notebooks/:id', wrap(async (req, res) => {
  dbm.deleteNotebook(Number(req.params.id));
  invalidate(Number(req.params.id));
  res.json({ ok: true });
}));

// ---- Sources ----
app.get('/api/notebooks/:id/sources', wrap(async (req, res) =>
  res.json(dbm.listSources(Number(req.params.id)))));

app.post('/api/notebooks/:id/sources', upload.array('files'), wrap(async (req, res) => {
  const notebookId = Number(req.params.id);
  if (!dbm.getNotebook(notebookId)) return res.status(404).json({ error: 'No such notebook' });
  const results = [];
  for (const f of req.files || []) {
    try {
      const r = await ingestFile(notebookId, f.originalname, f.buffer);
      results.push({ filename: f.originalname, ok: true, ...r });
    } catch (e) {
      results.push({ filename: f.originalname, ok: false, error: e.message });
    }
  }
  invalidate(notebookId);
  res.json({ results, sources: dbm.listSources(notebookId) });
}));

app.delete('/api/sources/:id', wrap(async (req, res) => {
  dbm.deleteSource(Number(req.params.id));
  if (req.query.notebookId) invalidate(Number(req.query.notebookId));
  res.json({ ok: true });
}));

// ---- Ask ----
app.post('/api/notebooks/:id/ask', wrap(async (req, res) => {
  const notebookId = Number(req.params.id);
  const query = (req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'Empty question' });
  const { results, totalChunks } = await search(notebookId, query, 6);
  const composed = await answer(query, results);
  res.json({ ...composed, passages: results, totalChunks });
}));

app.listen(PORT, () => {
  console.log(`\n  AskDocs running →  http://localhost:${PORT}\n`);
  // Warm the embedding model in the background so the first question is fast.
  warmup().then((ok) => {
    console.log(ok
      ? '  Embedding model ready — semantic + keyword (hybrid) search active.'
      : '  Embedding model unavailable — running in KEYWORD-ONLY mode.\n' +
        '  (It downloads once on a machine with internet, then works fully offline.)');
  });
});
