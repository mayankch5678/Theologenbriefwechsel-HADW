# ThBW RAG Chatbot

RAG chatbot over the Theologenbriefwechsel der Kurpfalz (1550–1620) letter archive from the Heidelberger Akademie der Wissenschaften.

## What it does

- Searches 36,556 letters using hybrid retrieval (keyword tags + semantic embeddings)
- Answers in German, English, or French — matches the query language
- Cites every claim with a Brief ID; refuses to answer when evidence is insufficient
- Filters out internal (`intern`) records automatically

## Stack

| Component | Tool |
|---|---|
| Embeddings | Ollama / `bge-m3` (local) |
| Generation | DeepSeek API (`deepseek-chat`) |
| Search index | Flat binary (`embeddings.bin`), brute-force cosine |
| Server | Express.js |
| Data source | MongoDB (`letters` database) |

## Setup

```bash
npm install
```

Create `.env`:
```
DEEPSEEK_API_KEY=sk-your-key
```

Install and start [Ollama](https://ollama.com), then pull the embedding model:
```bash
ollama pull bge-m3
```

Build corpus and index (requires MongoDB running with the `letters` DB populated):
```bash
npm run build:corpus   # ~1 min — exports 36,556 letters to data/corpus.jsonl
npm run build:index    # ~30-45 min — embeds corpus into data/embeddings.bin (resumable)
```

Run:
```bash
npm start              # http://localhost:3000
```

## Project structure

```
scripts/
  buildCorpus.js       # MongoDB → corpus.jsonl (synthesizes regest for metadata-only letters)
  buildIndex.js        # corpus.jsonl → embeddings.bin (batched, resumable)
server/
  server.js            # Express API — hybrid retrieval + DeepSeek generation
public/
  index.html           # Chat UI
data/
  corpus.jsonl          # (generated, gitignored)
  embeddings.bin        # (generated, gitignored)
  embeddings.meta.json  # (generated, gitignored)
```

## Known limitations

- Recall ceiling on enumerative queries — full-text search over regest content not yet implemented
- No reranker — cosine similarity only
- No evaluation test set yet
- Brute-force search; no vector DB (fine at 36K scale)
