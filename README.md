# AskDocs

A **NotebookLM-style** app that runs entirely in your **web browser**. Feed it your
documents, ask questions in plain English, and get answers that **cite the exact
source and page**. No install, no accounts, no API keys — and your documents never
leave your device.

Live (once Pages is enabled — see below):

```
https://fishewb-del.github.io/ask/
```

## What it does

- Add **PDF, Word (.docx), Markdown/Text, and CSV** files to a "notebook"
- It reads them (with **structure-aware PDF parsing** — real paragraphs, multi-column
  layouts, and headings), splits them into passages, and builds a local index
- Ask a question → **hybrid search** (meaning-based embeddings + keyword matching)
  finds the most relevant passages, with near-duplicates filtered out
- Get an answer with clickable citations and highlighted matches

### Two answer modes

- **Quick (default, no download):** stitches the most relevant sentences from several
  passages into a concise, cited answer. Instant, runs on any device.
- **AI prose (optional):** a small **open-source** model (Llama 3.2 / Qwen2.5 /
  Phi-3.5) runs **in your browser** via WebGPU and writes a reasoned, cited answer.
  No setup beyond one click — the model downloads once from the public Hugging Face
  hub, then works offline. Requires a browser with WebGPU (Chrome/Edge on a machine
  with a GPU; recent Safari/Firefox too). If WebGPU isn't available, the app simply
  stays in Quick mode — nothing breaks.

Everything is 100% client-side: documents are processed in the browser and stored in
**IndexedDB**. The only things ever fetched are public, open-source models — never
your files.

## Using it

Just open the URL above. Create a notebook, add files, and ask. To turn on AI prose
answers, pick **Answers → AI prose** in the sidebar, choose a model, and click
**Download & enable** (one-time download).

## Enabling GitHub Pages (one-time, ~30 seconds)

1. On GitHub, open this repo → **Settings** → **Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Set **Branch** to `main` and the folder to **`/docs`**, then **Save**.
4. Wait a minute, then visit the URL above. Free for public repos.

The whole app is the static files in [`docs/`](docs/) — GitHub Pages just serves that
folder. No build step.

## How it works

```
file → parse → chunk → embed (in-browser model) → IndexedDB
question → embed + keyword search → fuse, de-dup & rank → cited answer
            (Quick: extractive  |  AI: in-browser LLM, grounded in the passages)
```

| Piece | File |
|-------|------|
| Parsing (structure-aware PDF, Word, CSV, text) | `docs/lib/parsers.js` |
| In-browser embeddings (transformers.js + MiniLM) | `docs/lib/embedder.js` |
| Hybrid retrieval (semantic + keyword) with de-dup | `docs/lib/search.js` |
| Answer assembly (extractive + LLM prompt) | `docs/lib/generator.js` |
| In-browser LLM (WebLLM / WebGPU) | `docs/lib/llm.js` |
| Storage (IndexedDB) | `docs/lib/db.js` |
| UI | `docs/index.html`, `docs/app.js`, `docs/styles.css` |

Libraries load from public CDNs as ES modules, so there's no build step.

The `samples/` folder has a couple of example documents you can upload to try it out.
