// Browser storage for notebooks, sources, and embedded chunks — the in-browser
// counterpart of the server's SQLite layer. Everything lives in IndexedDB, which
// is private to the user's browser. Nothing is ever uploaded. Embeddings are stored
// as Float32Array values directly (IndexedDB clones typed arrays natively).

const DB_NAME = 'askdocs';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notebooks')) {
        db.createObjectStore('notebooks', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('sources')) {
        const s = db.createObjectStore('sources', { keyPath: 'id', autoIncrement: true });
        s.createIndex('notebook_id', 'notebook_id');
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const c = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
        c.createIndex('notebook_id', 'notebook_id');
        c.createIndex('source_id', 'source_id');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Wrap a single IDBRequest as a promise.
const reqP = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

// Wrap a write transaction (multiple ops) as a promise that resolves on commit.
const txDone = (t) =>
  new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });

// Each helper opens its own short transaction. We never await between two requests
// on the same transaction (that can let it auto-close), so this stays robust.
async function getAll(store, query) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).getAll(query));
}
async function getAllByIndex(store, index, value) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).index(index).getAll(value));
}
async function getKeysByIndex(store, index, value) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).index(index).getAllKeys(value));
}
async function getOne(store, key) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readonly').objectStore(store).get(key));
}
async function addOne(store, value) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readwrite').objectStore(store).add(value));
}
async function putOne(store, value) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readwrite').objectStore(store).put(value));
}
async function delOne(store, key) {
  const db = await openDB();
  return reqP(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}
async function delMany(store, keys) {
  if (!keys.length) return;
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  const os = t.objectStore(store);
  for (const k of keys) os.delete(k);
  return txDone(t);
}

const now = () => new Date().toISOString();

// ---- Notebooks ----
export const createNotebook = (name) =>
  addOne('notebooks', { name, created_at: now() });

export async function listNotebooks() {
  const [notebooks, sources] = await Promise.all([getAll('notebooks'), getAll('sources')]);
  const counts = new Map();
  for (const s of sources) counts.set(s.notebook_id, (counts.get(s.notebook_id) || 0) + 1);
  return notebooks
    .map((n) => ({ ...n, source_count: counts.get(n.id) || 0 }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export const getNotebook = (id) => getOne('notebooks', id);

export async function deleteNotebook(id) {
  const [chunkKeys, sourceKeys] = await Promise.all([
    getKeysByIndex('chunks', 'notebook_id', id),
    getKeysByIndex('sources', 'notebook_id', id),
  ]);
  await delMany('chunks', chunkKeys);
  await delMany('sources', sourceKeys);
  await delOne('notebooks', id);
}

// ---- Sources ----
export const createSource = (notebookId, filename, kind) =>
  addOne('sources', {
    notebook_id: notebookId, filename, kind, num_chunks: 0, created_at: now(),
  });

export async function setSourceChunkCount(sourceId, n) {
  const s = await getOne('sources', sourceId);
  if (s) { s.num_chunks = n; await putOne('sources', s); }
}

export async function listSources(notebookId) {
  const rows = await getAllByIndex('sources', 'notebook_id', notebookId);
  return rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function deleteSource(id) {
  const chunkKeys = await getKeysByIndex('chunks', 'source_id', id);
  await delMany('chunks', chunkKeys);
  await delOne('sources', id);
}

// ---- Chunks ----
export async function insertChunks(rows) {
  if (!rows.length) return;
  const db = await openDB();
  const t = db.transaction('chunks', 'readwrite');
  const os = t.objectStore('chunks');
  for (const r of rows) os.add(r);
  return txDone(t);
}

// Load every chunk for a notebook (used to build the in-memory search index),
// joining in each chunk's source filename for citations.
export async function getNotebookChunks(notebookId) {
  const [chunks, sources] = await Promise.all([
    getAllByIndex('chunks', 'notebook_id', notebookId),
    getAllByIndex('sources', 'notebook_id', notebookId),
  ]);
  const filenameOf = new Map(sources.map((s) => [s.id, s.filename]));
  return chunks
    .map((c) => ({ ...c, filename: filenameOf.get(c.source_id) }))
    .sort((a, b) => a.source_id - b.source_id || a.ordinal - b.ordinal);
}
