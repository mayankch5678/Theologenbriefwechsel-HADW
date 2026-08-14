# ThBw RAG Chatbot — Prototype (Mayank's playground)

A standalone, local-only RAG chatbot over the ThBw correspondence archive
(early modern theologians' letters). Built entirely outside the original
`ThBw/` and `dataset/` code — nothing in this repo touches or depends on
changes to those directories; it only *reads* from the already-restored
local MongoDB `letters` database.

## Data reality check (see conversation for full detail)

- 36,556 letters (`briefs`), 24,028 people, 5,210 places, 20,662 subjects.
- Only **19,428 letters (53%)** have a `regest` (scholarly abstract). The
  rest are metadata-only (sender/recipient/date/place, no summary text).
  `transkription`/`erlaeuterung`/`incipit` (full transcriptions) are empty
  for every letter in the DB — there is no full letter text to retrieve.
- Every letter has a stable citation URL (`https://thbw.hadw-bw.de/brief/{id}`)
  and a CMIF/TEI XML snippet with sourced person/place/date references —
  used here as the traceability mechanism.
- Includes both `offen` (public, 22,552) and `intern` (internal, 14,004)
  records, per your choice — reconsider this scope if this tool is ever
  exposed outside the internal team.

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

### Resuming the embedding build

`npm run build:index` was started once and deliberately stopped partway
through (15,000/36,556 letters) to free up the machine overnight — it does
**not** checkpoint, so re-running starts from 0. At the observed steady-state
rate (~4.6 letters/sec) the full run takes roughly **2-2.5 hours** on this
machine. Run it when you don't need the Mac for anything else demanding;
`data/embeddings.bin` and `data/embeddings.meta.json` only appear once it
finishes.

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
