// Answer assembly. Two modes:
//
//  • 'extractive' (always available): no language model. It pulls the most
//    query-relevant sentences from several retrieved passages, de-duplicates them,
//    and stitches them into a short, coherent answer with inline [n] citations.
//
//  • 'local-llm' (optional, browser): a small open-source model runs in the browser
//    (see lib/llm.js) and writes a reasoned, prose answer grounded in the same
//    passages. This module provides buildMessages()/citationsFor() so app.js can
//    drive streaming generation. If the model isn't loaded, we fall back to
//    extractive mode automatically — so the app always answers.

export const MODE = 'extractive'; // default; app.js switches to LLM when the user enables it

const STOP = new Set(
  ('a an and are as at be by for from how in is it of on or that the this to was what ' +
   'when where which who why will with do does can could would should about tell me my ' +
   'your you our we i their there here a of').split(' ')
);
const contentTerms = (q) =>
  [...new Set((q.toLowerCase().match(/[\w#./-]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w)))];
const splitSentences = (t) =>
  t.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

const wordSet = (s) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) || []));
function jaccard(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// Numbered citation objects matching the inline [n] markers (n = passage rank).
export function citationsFor(passages) {
  return passages.map((p, i) => ({
    n: i + 1,
    filename: p.filename,
    locator: p.locator,
    page: p.page,
    snippet: p.snippet,
  }));
}

function extractiveAnswer(query, passages) {
  if (passages.length === 0) {
    return {
      mode: 'extractive',
      answer:
        "I couldn't find anything relevant to that in your sources. Try rephrasing, " +
        'or add a document that covers it.',
      citations: [],
    };
  }

  const terms = contentTerms(query);
  // Gather the best query-matching sentences across passages, tagged with their
  // citation number (the passage's rank).
  const candidates = [];
  passages.forEach((p, i) => {
    splitSentences(p.text)
      .map((s) => {
        const low = s.toLowerCase();
        return { s, score: terms.reduce((acc, t) => acc + (low.includes(t) ? 1 : 0), 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .forEach((x) => candidates.push({ text: x.s, score: x.score + (passages.length - i) * 0.05, n: i + 1 }));
  });
  candidates.sort((a, b) => b.score - a.score);

  // Greedily pick up to 4 distinct sentences (drop near-duplicates).
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= 4) break;
    if (picked.some((p) => jaccard(p.text, c.text) > 0.55)) continue;
    picked.push(c);
  }

  let answer;
  if (picked.length) {
    picked.sort((a, b) => a.n - b.n || b.score - a.score); // readable order
    const body = picked
      .map((p) => {
        let s = p.text.trim();
        if (!/[.!?]$/.test(s)) s += '.';
        return `${s} [${p.n}]`;
      })
      .join(' ');
    answer = `Based on your sources: ${body}`;
  } else {
    // No keyword overlap — surface the top passage rather than nothing.
    answer = `Here's the most relevant passage I found:\n\n> ${passages[0].snippet} [1]`;
  }

  return { mode: 'extractive', answer, citations: citationsFor(passages) };
}

// Build chat messages for the local LLM: a strict, grounded RAG prompt that forces
// inline [n] citations and discourages making things up.
export function buildMessages(query, passages) {
  const sources = passages
    .map((p, i) => {
      const where = [p.filename, p.locator].filter(Boolean).join(' ');
      const body = p.text.replace(/\s+/g, ' ').trim().slice(0, 700);
      return `[${i + 1}] (${where})\n${body}`;
    })
    .join('\n\n');

  const system =
    'You are AskDocs, a careful research assistant. Answer the question using ONLY ' +
    'the numbered sources provided. Cite the sources you use inline with their number ' +
    'in square brackets, like [1] or [2][3]. Be concise and specific. If the sources ' +
    "do not contain the answer, say you couldn't find it in the provided documents — " +
    'do not invent facts.';

  const user = `Question: ${query}\n\nSources:\n${sources}\n\n` +
    'Answer the question, citing sources inline with [n].';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// Single-shot extractive answer (used directly when not in LLM mode).
export async function answer(query, passages) {
  return extractiveAnswer(query, passages);
}
