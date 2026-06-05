// Ingestion pipeline: parse a file -> split into overlapping chunks -> embed each
// chunk -> store in SQLite. Runs entirely locally.
import { parseFile } from './parsers/index.js';
import { embed, toBlob } from './embedder.js';
import { createSource, insertChunks, setSourceChunkCount } from './db.js';

const MAX_WORDS = 220; // ~chunk size; small enough for precise citations
const OVERLAP = 40;    // words shared between adjacent chunks to avoid cutting context

// Split one parsed segment into chunk-sized windows, preserving its locator/page.
function windowSegment(seg) {
  const words = seg.text.split(/\s+/);
  if (words.length <= MAX_WORDS) return [seg];
  const out = [];
  for (let start = 0; start < words.length; start += MAX_WORDS - OVERLAP) {
    const text = words.slice(start, start + MAX_WORDS).join(' ');
    out.push({ ...seg, text });
    if (start + MAX_WORDS >= words.length) break;
  }
  return out;
}

export async function ingestFile(notebookId, filename, buffer) {
  const { kind, segments } = await parseFile(filename, buffer);
  const chunks = segments.flatMap(windowSegment).filter((c) => c.text.trim().length > 1);
  if (chunks.length === 0) throw new Error('No readable text found in this file.');

  // Embed in batches to keep memory reasonable on large docs. If embeddings are
  // unavailable (model not yet downloaded), embed() returns null and we store
  // chunks without vectors — keyword search still works.
  const vectors = [];
  const BATCH = 32;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH).map((c) => c.text);
    const embs = await embed(batch);
    if (embs === null) {
      for (let j = 0; j < batch.length; j++) vectors.push(null);
    } else {
      for (const e of embs) vectors.push(e);
    }
  }

  const sourceId = createSource(notebookId, filename, kind);
  insertChunks(
    chunks.map((c, i) => ({
      source_id: sourceId,
      notebook_id: notebookId,
      ordinal: i,
      page: c.page ?? null,
      locator: c.locator ?? null,
      text: c.text,
      embedding: vectors[i] ? toBlob(vectors[i]) : null,
    }))
  );
  setSourceChunkCount(sourceId, chunks.length);
  return { sourceId, kind, chunkCount: chunks.length };
}
