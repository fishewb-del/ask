# AskDocs

A **NotebookLM-style** app you can run two ways. Feed it your documents, ask
questions in plain English, and get answers that **cite the exact source and page**.
No API keys. No accounts. Your documents never leave your device.

## Two editions

| | **Browser edition** (`docs/`) | **Desktop/server edition** (`server/` + `web/`) |
|---|---|---|
| How you run it | Just open a web page — **no install** | `npm install && npm start` |
| Best for | Locked-down machines (work laptops), sharing a link, zero setup | Your own PC; fastest, fully offline |
| Hosting | **Free on GitHub Pages** | Runs locally on `http://localhost:3000` |
| Storage | Browser (IndexedDB) | `data/askdocs.db` (SQLite) |
| AI model | Runs in the browser (transformers.js, WASM/WebGPU) | Runs in Node (transformers.js) |
| Privacy | Documents stay in the browser; only the public model is fetched (once) | 100% local |

Both use the same approach: parse → chunk → embed → **hybrid search**
(meaning-based embeddings + keyword matching) → answers with clickable citations.
Supported files: **PDF, Word (.docx), Markdown/Text, and CSV**.

---

## Browser edition — free, no install

Live (once Pages is enabled, see below):

```
https://fishewb-del.github.io/ask/
```

Open it in any modern browser (Chrome/Edge/Firefox/Safari). Create a notebook, add
files, and ask. Everything runs in the browser tab — your files are never uploaded.

> **First visit:** the embedding model (~25MB) is fetched once from the Hugging Face
> Hub and then cached by your browser, so later visits work even offline. If you're
> offline on the very first visit, it automatically falls back to keyword-only search.

### Enabling GitHub Pages (one-time, ~30 seconds)

1. On GitHub, open this repo → **Settings** → **Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Set **Branch** to `main` and the folder to **`/docs`**, then **Save**.
4. Wait a minute, then visit the URL above. That's it — it's free for public repos.

The whole browser app is the static files in [`docs/`](docs/); GitHub Pages just
serves that folder. No build step.

---

## Desktop/server edition — run it locally

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

> **First run:** the embedding model (~25MB) downloads once into `data/model-cache/`
> and is cached forever. After that, it works with no internet at all.

## How it works

```
file → parse → chunk → embed (local model) → store
question → embed + keyword search → fuse & rank → cited passages
```

| Piece | Server edition | Browser edition |
|-------|----------------|-----------------|
| Parsing | `server/parsers/` | `docs/lib/parsers.js` |
| Embeddings | `server/embedder.js` | `docs/lib/embedder.js` |
| Hybrid retrieval | `server/search.js` | `docs/lib/search.js` |
| Answer assembly (LLM seam) | `server/generator.js` | `docs/lib/generator.js` |
| Storage | SQLite (`data/askdocs.db`) | IndexedDB (`docs/lib/db.js`) |
| UI | `web/` | `docs/index.html` + `docs/app.js` |

## Phase 2 — generated prose answers (later)

Today answers are stitched from your retrieved passages (extractive). To add
NotebookLM-style written prose, implement `generateLocal()` in the relevant
`generator.js` and flip `MODE` to `'local-llm'`:

- **Server edition:** call a local model (e.g. Llama 3.2 / Phi via Ollama, or a
  transformers.js text-generation model).
- **Browser edition:** run a small text-generation model in the browser via
  transformers.js (WebGPU recommended).

The contract (an answer string + the citation list) stays identical, so nothing
else changes.
