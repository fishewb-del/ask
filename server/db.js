// SQLite storage for notebooks, sources, and embedded chunks.
// Everything lives in a single local file (data/askdocs.db) — no server, no setup.
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'askdocs.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS notebooks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- pdf | docx | text | csv
    num_chunks  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id   INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    notebook_id INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,       -- position within the source
    page        INTEGER,                -- page number for PDFs (citations)
    locator     TEXT,                   -- human label, e.g. "p.4" or "row 12"
    text        TEXT NOT NULL,
    embedding   BLOB                    -- Float32Array of the chunk vector
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_notebook ON chunks(notebook_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_source   ON chunks(source_id);
  CREATE INDEX IF NOT EXISTS idx_sources_notebook ON sources(notebook_id);
`);

// ---- Notebooks ----
export const createNotebook = (name) =>
  db.prepare('INSERT INTO notebooks (name) VALUES (?)').run(name).lastInsertRowid;

export const listNotebooks = () =>
  db.prepare(`
    SELECT n.*,
           (SELECT COUNT(*) FROM sources s WHERE s.notebook_id = n.id) AS source_count
    FROM notebooks n ORDER BY n.created_at DESC
  `).all();

export const getNotebook = (id) =>
  db.prepare('SELECT * FROM notebooks WHERE id = ?').get(id);

export const deleteNotebook = (id) =>
  db.prepare('DELETE FROM notebooks WHERE id = ?').run(id);

// ---- Sources ----
export const createSource = (notebookId, filename, kind) =>
  db.prepare('INSERT INTO sources (notebook_id, filename, kind) VALUES (?, ?, ?)')
    .run(notebookId, filename, kind).lastInsertRowid;

export const setSourceChunkCount = (sourceId, n) =>
  db.prepare('UPDATE sources SET num_chunks = ? WHERE id = ?').run(n, sourceId);

export const listSources = (notebookId) =>
  db.prepare('SELECT * FROM sources WHERE notebook_id = ? ORDER BY created_at').all(notebookId);

export const deleteSource = (id) =>
  db.prepare('DELETE FROM sources WHERE id = ?').run(id);

// ---- Chunks ----
const insertChunkStmt = db.prepare(`
  INSERT INTO chunks (source_id, notebook_id, ordinal, page, locator, text, embedding)
  VALUES (@source_id, @notebook_id, @ordinal, @page, @locator, @text, @embedding)
`);

export const insertChunks = db.transaction((rows) => {
  for (const r of rows) insertChunkStmt.run(r);
});

// Load every chunk for a notebook (used to build the in-memory search index).
export const getNotebookChunks = (notebookId) =>
  db.prepare(`
    SELECT c.id, c.source_id, c.ordinal, c.page, c.locator, c.text, c.embedding,
           s.filename
    FROM chunks c JOIN sources s ON s.id = c.source_id
    WHERE c.notebook_id = ?
    ORDER BY c.source_id, c.ordinal
  `).all(notebookId);

export default db;
