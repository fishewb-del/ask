// Hybrid retrieval: combines semantic similarity (embeddings) with keyword search
// (MiniSearch/BM25) using Reciprocal Rank Fusion. Semantic catches paraphrases;
// keyword nails exact terms, codes, and names. Together they're far more robust
// than either alone. Returns ranked passages with citations and highlights.
import MiniSearch from 'https://esm.sh/minisearch@7.1.1';
import { embed } from './embedder.js';
import { getNotebookChunks } from './db.js';

// Per-notebook in-memory index, lazily built and cached. Invalidated on ingest/delete.
const cache = new Map();

export function invalidate(notebookId) {
  cache.delete(notebookId);
}

async function buildIndex(notebookId) {
  const rows = await getNotebookChunks(notebookId);
  const chunks = rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    filename: r.filename,
    page: r.page,
    locator: r.locator,
    text: r.text,
    vector: r.embedding || null, // already a Float32Array from IndexedDB
  }));

  const mini = new MiniSearch({
    fields: ['text'],
    storeFields: [],
    searchOptions: { boost: { text: 1 }, fuzzy: 0.2, prefix: true },
  });
  mini.addAll(chunks.map((c) => ({ id: c.id, text: c.text })));

  const byId = new Map(chunks.map((c) => [c.id, c]));
  const index = { chunks, mini, byId };
  cache.set(notebookId, index);
  return index;
}

const getIndex = async (notebookId) => cache.get(notebookId) || buildIndex(notebookId);

// Very common words carry little signal for keyword matching; drop them so the
// query's meaningful terms (codes, materials, names) dominate the ranking.
const STOPWORDS = new Set(
  ('a an and are as at be by for from how in is it of on or that the this to was what ' +
   'when where which who why will with do does can could would should about tell me my')
    .split(' ')
);
const keywordize = (q) =>
  (q.toLowerCase().match(/[\w#./-]+/g) || []).filter((w) => !STOPWORDS.has(w)).join(' ') || q;

// Reciprocal Rank Fusion: merge two ranked lists into one score per id.
function rrf(rankedLists, k = 60) {
  const scores = new Map();
  for (const list of rankedLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
    });
  }
  return scores;
}

// Pull the most query-relevant sentence out of a chunk for a tight preview.
function bestSnippet(text, queryTerms) {
  // Drop markdown header markers and collapse whitespace so previews read cleanly.
  const clean = text.replace(/^#+\s+/gm, '').replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  if (sentences.length <= 1) return text;
  let best = sentences[0];
  let bestScore = -1;
  for (const s of sentences) {
    const low = s.toLowerCase();
    const score = queryTerms.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best.trim();
}

export async function search(notebookId, query, k = 6) {
  const index = await getIndex(notebookId);
  if (index.chunks.length === 0) return { results: [], totalChunks: 0, mode: 'keyword' };

  // --- Semantic ranking (skipped if embeddings unavailable) ---
  const qVec = await embed(query);
  let semRanked = [];
  let mode = 'keyword';
  if (qVec) {
    const semScored = index.chunks
      .filter((c) => c.vector)
      .map((c) => {
        let dot = 0;
        for (let i = 0; i < qVec.length; i++) dot += qVec[i] * c.vector[i];
        return { id: c.id, score: dot };
      });
    semScored.sort((a, b) => b.score - a.score);
    semRanked = semScored.slice(0, 50).map((x) => x.id);
    if (semRanked.length) mode = 'hybrid';
  }

  // --- Keyword ranking (stopword-filtered) ---
  const kwRanked = index.mini.search(keywordize(query)).slice(0, 50).map((r) => r.id);

  // --- Fuse (one or both lists) ---
  const fused = rrf([semRanked, kwRanked]);
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);

  const queryTerms = query.toLowerCase().match(/\w+/g) || [];
  const results = ranked.map(([id, score]) => {
    const c = index.byId.get(id);
    return {
      chunkId: c.id,
      filename: c.filename,
      locator: c.locator,
      page: c.page,
      snippet: bestSnippet(c.text, queryTerms),
      text: c.text,
      score: Number(score.toFixed(4)),
    };
  });

  return { results, totalChunks: index.chunks.length, mode };
}
