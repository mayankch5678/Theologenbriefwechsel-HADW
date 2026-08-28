# ThBw RAG Chatbot — Prototype (Mayank's playground)

A standalone, local-only RAG chatbot over the ThBw correspondence archive
(early modern theologians' letters). Built entirely outside the original
`ThBw/` and `dataset/` code — nothing in this repo touches or depends on
changes to those directories; it only *reads* from the already-restored
local MongoDB `letters` database.

## Data reality check (verified against MongoDB 2026-08-21)

- 36,721 letters (`briefs`), 24,219 people, 5,247 places, 20,752 subjects.
- **19,608 letters (53%)** have a `regest` (scholarly abstract); the rest
  get a synthesised one-line metadata abstract (flagged `regestSynthetic`).
- **Primary-source text exists and is used**: 2,215 letters carry a verbatim
  `transkription.volltext`, 31k an `incipit`, 3.3k an editorial
  `erlaeuterung`. (An earlier revision of this README claimed these fields
  were empty — that was wrong.) They are carried on each corpus record and
  shown to the model as evidence for top hits; they are deliberately NOT
  mixed into the embedded text, where early-modern German/Latin would dilute
  the modern-German regest signal.
- Every letter has a stable citation URL (`https://thbw.hadw-bw.de/brief/{id}`)
  and a CMIF/TEI XML snippet with sourced person/place/date references —
  used here as the traceability mechanism.
- Includes both `offen` (public, 22,812) and `intern` (internal, 13,909)
  records in the corpus file; retrieval only ever serves `offen` — the eval
  harness asserts this on every run.

## Architecture

1. `scripts/buildCorpus.js` — read-only MongoDB → `data/corpus.jsonl`.
   Flattens ThBw's `{m, v}` edit-metadata envelope, resolves person/place/
   subject ObjectId references to labels, and builds one clean record per
   letter (citation line, regest or metadata-only stub, sender/recipient,
   date, places, keywords, URL, CMIF).
2. `scripts/buildIndex.js` — embeds every record's text with a local Ollama
   embedding model (`bge-m3`, multilingual) → `data/embeddings.bin` +
   `data/embeddings.meta.json`.
3. `server/server.js` — Express API. On each question: embeds the query
   locally via Ollama (`bge-m3`), does brute-force cosine retrieval over
   the local vectors, then sends the retrieved letters + question to the
   **DeepSeek API** (`deepseek-chat`, cloud) to generate the answer *only*
   from that context, and returns the answer plus the source letters (URL,
   regest excerpt, CMIF) for cross-checking.
4. `public/index.html` — minimal chat UI, renders the answer with clickable
   source cards linking back to the original archive record.

## Hardware note (8GB MacBook Air) — hybrid local/cloud

Generation moved from a local Ollama model to the DeepSeek API (`deepseek-chat`)
to avoid running two loaded models at once on 8GB of unified memory. Embeddings
(`bge-m3`) still run locally via Ollama — only the retrieved context and
question are sent to DeepSeek for answer generation.

- Set `DEEPSEEK_API_KEY` in `.env` (copy `.env.example`) before `npm start`.
- Running MongoDB + Ollama's embedding model is still tight on 8GB of unified
  memory — during the first embedding attempt, physical memory usage hit
  ~7.5/8GB with active swap/compression, which is why throughput dropped
  from ~10/s to ~4.6/s as it ran.
- Consider stopping MongoDB (`brew services stop mongodb-community`) once
  `data/corpus.jsonl` has been built — it's only needed for the corpus
  build step, not for answering chat questions.

## Setup

Prerequisites (already done in this session): Ollama installed via
Homebrew and running (`brew services start ollama`), models pulled:

```
ollama pull llama3.2:3b
ollama pull bge-m3
```

```
npm install
cp .env.example .env    # then fill in DEEPSEEK_API_KEY=
npm run build:corpus   # MongoDB -> data/corpus.jsonl (read-only) — already done
npm run build:index    # data/corpus.jsonl -> data/embeddings.bin — NOT YET RUN, see below
npm start               # serves http://localhost:5055
```

Then open http://localhost:5055 in a browser.

### Embedding build

`npm run build:index` is resumable (appends and derives progress from file
size). ~2.5 h at 4.6 letters/s on an 8 GB M-series Air; ~30 min at ~20/s on
an M1 Pro. Only needed when the corpus `text` field changes — metadata-only
corpus rebuilds keep existing embeddings valid.

## Optional layers: passage index and rerank

```
npm run build:chunks      # transcriptions/commentary -> data/chunks.jsonl + chunk_embeddings.bin
                          # (~16.8k chunks of 800 chars / 150 overlap, public letters only,
                          #  ~15 min via Ollama, resumable; needs build:corpus first)
uv run --project rerank python rerank/server.py     # cross-encoder sidecar on :5056
                          # (BAAI/bge-reranker-v2-m3, first start downloads ~1.1 GB; uv sync once)
```

Both are optional: the server logs what it found at startup and works
without either. With the chunk index, the top matching transcription
passages join the retrieval candidates and the *matching passage* is shown
to the model (and in the UI) instead of the first 1,500 chars. With the
sidecar, embedding-only extras are re-scored and those below `RERANK_MIN`
(0.3, calibrated with `node test/calibrateRerank.js`) are dropped;
keyword-backed hits are never touched. Closed-form questions (X an Y,
a year, a letter id) skip the fuzzy paths entirely.

## Evaluation

`test/` contains the evaluation harness (see the question catalog in
`Docs/`): gold sets derived from the editors' own tags,
`npm run build:gold` + `npm run build:questions` after every mongorestore,
then `npm run eval` (retrieval-only, seconds, free) or `npm run eval:full`
(end-to-end incl. DeepSeek; writes `test/review-latest.md` for human
grading). Hard assertions: no `intern` letter in any result, no invented
citations. Metrics are compared against `test/baseline.json` on every run.

## Known limitations

- Answers can only be as good as the `regest` summaries — for the ~47% of
  letters without one, the bot can state sender/recipient/date/place but
  not letter content, and is instructed to say so rather than invent it.
- Retrieval is brute-force cosine similarity in Node (fine at 36k
  documents; would need a real vector index — e.g. sqlite-vec/FAISS — well
  beyond this scale).
- No auth/access control on the `intern` vs `offen` distinction — this is
  a single-user local prototype, not a deployable multi-user service.
- Generation is no longer local: retrieved letter context (which can include
  `intern`/internal-only records, per the scope note above) is sent to the
  DeepSeek API for each question. Embeddings and retrieval stay on-machine;
  only the final prompt + context leaves the Mac. Reconsider this if `intern`
  records should never leave local infrastructure.
