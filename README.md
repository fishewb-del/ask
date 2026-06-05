# AskDocs

A standalone, **fully-offline** NotebookLM-style app. Feed it your documents, ask
questions in plain English, and get answers that **cite the exact source and page**.
No API keys. No accounts. Nothing leaves your machine.

## What it does (Phase 1)

- Add **PDF, Word (.docx), Markdown/Text, and CSV** files to a "notebook"
- It reads them, splits them into passages, and builds a local semantic index
- Ask a question → it finds the most relevant passages using **hybrid search**
  (meaning-based embeddings + keyword matching) and answers with clickable citations
- 100% local: embeddings run on your machine via a small bundled model

## Quick start

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

> **First run:** the embedding model (~25MB) downloads once into `data/model-cache/`
> and is cached forever. After that, it works with no internet at all.

## How it works

```
file → parse → chunk → embed (local model) → SQLite
question → embed + keyword search → fuse & rank → cited passages
```

| Piece | What it is |
|-------|-----------|
| `server/parsers/` | PDF (pdf.js), Word (mammoth), CSV (papaparse), text/markdown |
| `server/embedder.js` | Local offline embeddings (transformers.js + MiniLM) |
| `server/search.js` | Hybrid retrieval (semantic + keyword) with rank fusion |
| `server/generator.js` | Answer assembly — **the seam where a local LLM plugs in later** |
| `web/` | No-build browser UI |

Data lives in `data/askdocs.db` (a single SQLite file).

## Phase 2 — generated prose answers (later)

Today answers are stitched from your retrieved passages (extractive). To add
NotebookLM-style written prose, implement `generateLocal()` in
`server/generator.js` to call a local model (e.g. Llama 3.2 / Phi via Ollama, or a
transformers.js text-generation model) using the retrieved passages as grounding,
then flip `MODE` to `'local-llm'`. Nothing else changes.
