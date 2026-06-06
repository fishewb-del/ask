// On-device storage for the ORIGINAL uploaded files, so we can show full-fidelity
// drawings on demand without ever recompressing them — and without holding them in
// RAM. Prefers OPFS (Origin Private File System: fast, disk-backed, private); falls
// back to a dedicated IndexedDB store where OPFS isn't available. Keyed by sourceId.
const HAS_OPFS = typeof navigator !== 'undefined' &&
  navigator.storage && typeof navigator.storage.getDirectory === 'function';
const DIR = 'originals';

async function opfsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

// IndexedDB fallback lives in its own database so it never touches the main schema.
let idbPromise = null;
function idb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((res, rej) => {
    const r = indexedDB.open('askdocs-files', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return idbPromise;
}
const reqP = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

// Save the original file bytes for a source.
export async function putFile(id, blob) {
  if (HAS_OPFS) {
    try {
      const d = await opfsDir();
      const fh = await d.getFileHandle(String(id), { create: true });
      const ws = await fh.createWritable();
      await ws.write(blob);
      await ws.close();
      return;
    } catch { /* fall back to IndexedDB */ }
  }
  const db = await idb();
  await reqP(db.transaction('files', 'readwrite').objectStore('files').put({ id, blob }));
}

// Get the original file as a Blob, or null if we don't have it.
export async function getFile(id) {
  if (HAS_OPFS) {
    try {
      const d = await opfsDir();
      const fh = await d.getFileHandle(String(id)); // throws if missing
      return await fh.getFile();
    } catch { /* maybe it's in IndexedDB, or simply absent */ }
  }
  try {
    const db = await idb();
    const rec = await reqP(db.transaction('files', 'readonly').objectStore('files').get(id));
    return rec ? rec.blob : null;
  } catch {
    return null;
  }
}

export async function deleteFile(id) {
  if (HAS_OPFS) {
    try { const d = await opfsDir(); await d.removeEntry(String(id)); } catch { /* ignore */ }
  }
  try {
    const db = await idb();
    await reqP(db.transaction('files', 'readwrite').objectStore('files').delete(id));
  } catch { /* ignore */ }
}
