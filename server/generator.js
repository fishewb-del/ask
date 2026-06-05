// THE PHASE-2 SEAM.
//
// Right now this runs in "extractive" mode: it doesn't write prose, it stitches the
// most relevant retrieved passages into an answer with inline [n] citations. This is
// the "search now" half of the plan and needs no language model at all.
//
// To add generated prose later ("model later"), implement generateLocal() below to
// call a local model (e.g. Llama 3.2 / Phi via Ollama, or transformers.js text-gen),
// feeding it `query` + the `passages` as grounding context and asking it to cite [n].
// Nothing else in the app has to change — the API contract (an answer string + the
// citation list) stays identical.

export const MODE = 'extractive'; // 'extractive' | 'local-llm'

function extractiveAnswer(query, passages) {
  if (passages.length === 0) {
    return {
      mode: MODE,
      answer:
        "I couldn't find anything relevant to that in your sources. Try rephrasing, " +
        'or add a document that covers it.',
      citations: [],
    };
  }
  // Lead with the single best snippet, then list supporting passages, each citable.
  const lead = passages[0].snippet;
  const answer =
    `Here's what your sources say about that:\n\n` +
    `> ${lead} [1]\n\n` +
    (passages.length > 1
      ? `Related passages: ${passages.slice(1).map((_, i) => `[${i + 2}]`).join(' ')}.`
      : '');
  const citations = passages.map((p, i) => ({
    n: i + 1,
    filename: p.filename,
    locator: p.locator,
    page: p.page,
    snippet: p.snippet,
  }));
  return { mode: MODE, answer, citations };
}

// Placeholder for Phase 2. Wire a local model here and flip MODE to 'local-llm'.
async function generateLocal(query, passages) {
  throw new Error('local-llm mode not implemented yet (Phase 2)');
}

export async function answer(query, passages) {
  if (MODE === 'local-llm') return generateLocal(query, passages);
  return extractiveAnswer(query, passages);
}
