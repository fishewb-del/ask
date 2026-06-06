// Ingestion pipeline: read a File -> parse -> split into overlapping chunks ->
// embed each chunk -> store in IndexedDB. The heavy work (parsing geometry, and
// especially embedding) is kept off the main thread / streamed in batches so the UI
// stays responsive even for large or multiple PDFs. Progress is reported via the
// onProgress callback.
import { parseFile } from './parsers.js';
import { embed } from './embedder.js';
import { createSource, insertChunks, setSourceChunkCount } from './db.js';
import { putFile } from './files.js';

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

export async function ingestFile(notebookId, file, onProgress = () => {}, opts = {}) {
  const buffer = await file.arrayBuffer();
  const { kind, segments } = await parseFile(file.name, buffer, onProgress, opts);
  const chunks = segments.flatMap(windowSegment).filter((c) => c.text.trim().length > 1);
  if (chunks.length === 0) throw new Error('No readable text found in this file.');

  const sourceId = await createSource(notebookId, file.name, kind);

  // Keep the original PDF on-device (OPFS) so it can be viewed full-fidelity later.
  // Best-effort: a storage failure must never break indexing.
  if (kind === 'pdf') {
    try { await putFile(sourceId, file); } catch { /* viewing just won't be available */ }
  }

  // Embed + store in batches: keeps memory flat and lets the index grow incrementally.
  // The embedding model runs in a worker, so this loop never blocks the UI. If
  // embeddings are unavailable, embed() returns null and we store chunks without
  // vectors — keyword search still works.
  const BATCH = 32;
  let done = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const embs = await embed(slice.map((c) => c.text));
    await insertChunks(
      slice.map((c, j) => ({
        source_id: sourceId,
        notebook_id: notebookId,
        ordinal: i + j,
        page: c.page ?? null,
        locator: c.locator ?? null,
        text: c.text,
        embedding: embs && embs[j] ? embs[j] : null,
      }))
    );
    done += slice.length;
    onProgress({ phase: 'embed', done, total: chunks.length });
  }

  await setSourceChunkCount(sourceId, chunks.length);
  return { sourceId, kind, chunkCount: chunks.length };
}
