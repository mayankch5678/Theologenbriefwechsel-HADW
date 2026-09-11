# ThBW RAG Chatbot

RAG chatbot over the Theologenbriefwechsel der Kurpfalz (1550–1620) letter archive
from the Heidelberger Akademie der Wissenschaften.

Standalone and local-only: it lives entirely outside the original `ThBw/` and
`dataset/` code, touches nothing in those directories, and only *reads* from the
restored local MongoDB `letters` database.

## What it does

- Searches 36,721 letters using hybrid retrieval (subject tags + deterministic
  filters + stemmed regest index + embedding neighbours + transcription passages)
- Answers in German, English, or French — matches the query language
- Resolves follow-up questions: prior turns are rewritten into a self-contained
  query before retrieval, so "und was schrieb er 1563?" works
- Cites every claim with a Brief ID; refuses to answer when evidence is insufficient
- Serves only `offen` records — never `intern`, asserted by the eval harness on every run

## Stack

| Component | Tool |
|---|---|
| Embeddings | Ollama / `bge-m3` (local) |
| Generation | DeepSeek API (`deepseek-flash`, cloud) |
| Search index | Flat binary (`embeddings.bin`), brute-force cosine |
| Rerank | `BAAI/bge-reranker-v2-m3` cross-encoder sidecar (optional) |
| Server | Express.js, port 5055 |
| Data source | MongoDB (`letters` database, read-only) |

## Data reality check (verified against MongoDB 2026-08-21)

- 36,721 letters (`briefs`), 24,219 people, 5,247 places, 20,752 subjects.
- **19,608 letters (53%)** have a `regest` (scholarly abstract); the rest get a
  synthesised one-line metadata abstract (flagged `regestSynthetic`).
- **Primary-source text exists and is used**: 2,215 letters carry a verbatim
  `transkription.volltext`, 31k an `incipit`, 3.3k an editorial `erlaeuterung`.
  They are carried on each corpus record and shown to the model as evidence for
  top hits, but deliberately NOT mixed into the embedded text — early-modern
  German/Latin would dilute the modern-German regest signal.
- Every letter has a stable citation URL (`https://thbw.hadw-bw.de/brief/{id}`)
  and a CMIF/TEI XML snippet with sourced person/place/date references, used here
  as the traceability mechanism.
- Both `offen` (22,812) and `intern` (13,909) records are in the corpus file;
  retrieval only ever serves `offen`.

## Setup

Prerequisites: MongoDB with the restored `letters` database, Ollama running,
Node >= 20.12 (the repo pins 24 via `.node-version`), and `uv` for the optional
rerank sidecar.

```bash
npm install
ollama pull bge-m3
cp .env.example .env
```

Fill in your key:

```
DEEPSEEK_API_KEY=sk-your-key
```

Build the corpus and index:

```bash
npm run build:corpus
npm run build:index
npm start
```

Then open http://localhost:5055.

`build:corpus` writes `data/corpus.jsonl` + `data/fulltext.jsonl` (read-only against
MongoDB). `build:index` embeds the corpus into `data/embeddings.bin` and is resumable
— it appends and derives progress from file size. Budget ~30 min at ~20 letters/s on
an M1 Pro, ~2.5 h at 4.6/s on an 8 GB M-series Air. It is only needed when the corpus
`text` field changes; metadata-only rebuilds keep existing embeddings valid.

## Optional layers: passage index and rerank

```bash
npm run build:chunks
uv run --project rerank python rerank/server.py
```

`build:chunks` produces ~16.8k chunks of 800 chars / 150 overlap over transcriptions
and commentary (public letters only, ~15 min via Ollama, resumable, needs
`build:corpus` first). The rerank sidecar runs on :5056; the first start downloads
~1.1 GB (`uv sync` once).

Both are optional — the server logs what it found at startup and works without either.
With the chunk index, top matching transcription passages join the retrieval candidates
and the *matching passage* is shown to the model instead of the first 1,500 chars. With
the sidecar, embedding-only extras are re-scored and those below `RERANK_MIN` (0.3,
calibrated with `node test/calibrateRerank.js`) are dropped; keyword-backed hits are
never touched.

## Retrieval paths (what answers a question)

1. **Subject tags** — the editors' `Schlagworte`, plus synonym rings and
   comma-qualified variants; inflection-tolerant via crude German stemming, so
   "Kometen" reaches the tag "Komet". Generic tags carried by >150 letters are dropped.
2. **Correspondents / year / letter id** — deterministic filters. When one of these
   answers the question ("X an Y", "aus dem Jahr 1563", "Brief 18494"), the fuzzy
   paths below are switched off.
3. **Regest text** — stemmed inverted index over regests and editorial commentary;
   several terms must form a phrase. This is what finds letters whose regest mentions
   something the editors did not tag: on the content questions in the eval it took
   recall on untagged letters from 1% to ~68%.
4. **Embedding neighbours** and **transcription passages** — capped, floored,
   reranked; supplements only.

## Agent mode (`POST /api/agent`)

The one-shot path above cannot answer archive-level questions — "which event
is discussed most often", "letters written by women", "which Bible passage is
cited most with the Eucharist" — because no top-K sample stands in for the
whole archive. In agent mode (checkbox in the UI, or `POST /api/agent` with the
same body as `/api/chat`) the model drives deterministic tools over the same
public indexes and decides the next step itself (`server/agent.js`):

| Tool | What it does |
|---|---|
| `search_letters` | the hybrid retrieval above, as a tool |
| `filter_letters` | metadata filter over the whole public archive (sender, recipient, years, places, subject, subject category, female sender, regest contains …) |
| `count_by` | group-by count over the archive or a filtered subset (e.g. subjects of category *Ereignis*) |
| `list_values` | exact spellings of subjects / names / places with letter counts |
| `regest_issues` | findings of the offline regest quality check (see below) |
| `read_letter` | one letter in full: metadata, regest, tags with category, commentary, transcription |

Guard rails are the same as `/api/chat`: tools only ever see `offen` letters,
and an answer may cite only ids that some tool result contained (one
corrective retry). The response carries the tool trace (`agent.trace`), shown
in the UI as "Rechercheschritte"; every run is appended to
`data/agent-log.jsonl`. Expect 1 step / 3–10 s for count and filter questions
and 5–6 steps / 70–90 s for open research questions. `AGENT_MAX_STEPS` (8)
caps the loop.

Two offline batch jobs feed the agent with what the archive itself does not
record (both resumable, both call DeepSeek, both write to `data/`):

```bash
npm run classify:places   # data/places.json — every place name → land / im_reich
                          # (3,665 names, ~5 min); gives filter_letters/count_by the
                          # land_sent / land_mentioned / mentions_foreign fields
npm run check:regests     # data/regest-check.jsonl — every editorial regest checked for
                          # broken sentences, word errors, typos (18k regests, hours;
                          # CONCURRENCY=30); read by the regest_issues tool, partial
                          # results are served with the checked/total count
```

The agent path has its own evaluation, `npm run eval:agent` (`test/agentEval.js`):
per question it checks what can be checked deterministically — tools used,
step count, strings and ids the answer must (not) contain, citation
precision against the gold fixtures — and writes `test/agent-review-latest.md`
with every trace and answer for human grading. Hard failures (an `intern`
letter, an id no tool returned) exit 1.

Corpus fields added for this (rebuild with `npm run build:corpus`; the
embedded `text` is unchanged, so `build:index` is not needed): `senderIds`,
`recipientIds`, `senderFemale`, `recipientFemale` (from `people.weiblich`),
`keywordSubjectGroups` (subject category, from `saches.typ` → `sachgruppes`).
`keywordPeople` is now populated — letters reference persons through the
`zitiernames` collection, which the corpus build previously did not resolve.

## Evaluation

`test/` contains the evaluation harness (question catalog in `Docs/`). Gold sets are
derived from the editors' own tags:

```bash
npm run build:gold
npm run build:questions
npm run eval
npm run eval:full
```

Run `build:gold` and `build:questions` after every mongorestore. `eval` is
retrieval-only (seconds, free); `eval:full` is end-to-end including DeepSeek and
writes `test/review-latest.md` for human grading. `--repeat=3` reruns the handwritten
questions and reports whether every generation-side check was stable across runs.
Hard assertions: no `intern` letter in any result, no invented citations. Metrics are
compared against `test/baseline.json` on every run.

## Project structure

```
scripts/
  buildCorpus.js       MongoDB → corpus.jsonl (synthesises regest for metadata-only letters)
  buildIndex.js        corpus.jsonl → embeddings.bin (batched, resumable)
  buildChunkIndex.js   transcriptions/commentary → chunks.jsonl + chunk_embeddings.bin
server/
  server.js            Express API — hybrid retrieval, follow-up rewriting, DeepSeek generation
public/
  index.html           Chat UI
rerank/
  server.py            Cross-encoder rerank sidecar (uv project)
test/
  eval.js              Evaluation harness
  baseline.json        Committed metric baseline
  calibrateRerank.js   Calibrates RERANK_MIN
data/
  corpus.jsonl         (generated, gitignored)
  embeddings.bin       (generated, gitignored)
  chunks.jsonl         (generated, gitignored)
```

## Known limitations

- Answers can only be as good as the `regest` summaries — for the ~47% of letters
  without one, the bot can state sender/recipient/date/place but not letter content,
  and is instructed to say so rather than invent it.
- Retrieval is brute-force cosine similarity in Node. Fine at 36k documents; well
  beyond this scale it would need a real vector index (sqlite-vec, FAISS).
- No auth or access control on the `intern`/`offen` distinction. This is a
  single-user local prototype, not a deployable multi-user service.
- Generation is a cloud call: the retrieved *public* letters and the question go to
  the DeepSeek API on every question. `intern` records never reach retrieval, but
  they are present in cleartext in `data/corpus.jsonl` on disk.
