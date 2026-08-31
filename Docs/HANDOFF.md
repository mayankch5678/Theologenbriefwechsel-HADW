# Handoff — evaluation harness & retrieval overhaul (branch `eval-harness`)

**For:** Mayank · **From:** Zonghan · **Date:** 2026-08-31
**Baseline:** your prototype as of commit `0628404` and your handoff notes of 2026-08-14.

This document covers everything that happened on the `eval-harness` branch:
what was built, how retrieval works now, the measured numbers, how to run
and re-run everything, and what is deliberately left open.

---

## 1. TL;DR

Your prototype answered the flagship question with 558 sources at 7.9%
precision (German) and 26.7% recall (English). The same system now runs a
65-question evaluation on every change and scores:

| Metric | Your baseline (2026-08-14) | Now |
|---|---|---|
| "Welche Briefe erwähnen den Heidelberger Katechismus?" | recall 97.8%, precision 7.9% (558 sources) | **recall 100%, precision 93.9%** (49 sources) |
| Generated template questions (48: subjects + persons) | recall 84.7%, precision 2.0% | **recall 100%, precision 61.0%** * |
| Content questions, recall on letters with **no matching tag** | — (not measurable) | **67.7%** (was 1.0% before the regest-text path) |
| "Which letters from X to Y" with bracketed/collective names | 0% recall | 100% |
| Year questions ("aus dem Jahr 1563") | 3.9% recall | 100% recall, 97.7% precision |
| Citation recall (gold letters the answer actually cites) | — | **99.0%** |
| Greeting / off-topic / archive-stats / nonexistent-letter questions | 30 sources each, answered | **0 sources, deterministic refusal** |
| Intern leaks / invented citations / false refusals | unmeasured | **0 / 0 / 0**, stable across 3 repeated runs |

\* Precision against *tag-derived* gold. The questions ask "erwähnen X", so a
letter whose regest mentions X is a correct answer the tag gold does not
count — see §6 "Honest caveats".

Scope decision (2026-08-21): **German only** for now. Multilingual questions
were dropped from the eval; the English/French promise in the old system
prompt is descoped.

---

## 2. How retrieval works now (server/server.js)

Four paths; every letter in the result carries a `Treffer:` line saying
which path selected it (shown to the model *and* in the UI source cards).

1. **Subject tags** — your `subjectIndex`, extended:
   - the editors' synonym rings (`saches.alternativen[].text.v`, carried on
     corpus records as `subjectVariants`),
   - comma-qualified variants ("Heidelberger Katechismus, Frage 60" is
     reachable from both the base subject and "Frage 60"; multi-word
     segments only — a single-word base like "Bullinger" dragged the genus
     back in),
   - crude German stemming on both sides (umlaut folding + one suffix), so
     "Kometen" reaches the tag "Komet" (whole-word matching missed 20 of 24),
   - **most-specific-wins**: a matched form contained in a longer matched
     form is dropped ("katechismus" when "heidelberger katechismus" hit),
   - **bucket cap** `MAX_SUBJECT_BUCKET=150`: genus tags ("Briefe", 406
     letters) never union in. This alone took the flagship question from
     558 to ~60 sources.

2. **Structured filters** — deterministic, and when one of them answers the
   question the fuzzy paths are **switched off** (they can only add noise
   to a closed-form answer):
   - sender→recipient intersection over `senders`/`recipients` canonical
     names (bracket/title/collective-tolerant; this fixed the 0%-recall
     person questions),
   - year filter for explicitly dated phrasings ("aus dem Jahr 1563"),
   - letter-id lookup ("Fasse den Brief 18494 zusammen."); ids that resolve
     to nothing short-circuit the whole retrieval to empty (the Brief-99999
     case),
   - aggregate questions ("Wie viele Briefe …") short-circuit to a fixed
     refusal without calling the model — left to the model this was flaky.

3. **Regest text** — a stemmed inverted index over regests + editorial
   commentary (`matchRegest`). Multiple terms must occur **as an adjacent
   phrase** (bag-of-words AND produced "studied in Heidelberg … wrote a
   Katechismus" false positives); compounds match by prefix
   (Hexenprozess ⊃ Hexe); no OR fallback (leftover adjectives like "beste"
   became search terms). This path is what finds letters the editors did
   not tag — it took untagged-content recall from 1% to 68%.

4. **Embedding neighbours + transcription passages** — supplements only:
   - `MIN_SCORE=0.5` (measured knee: greetings top out at 0.44–0.49,
     genuine questions at 0.59–0.64) applies to embedding-only hits;
     keyword-backed hits are never floored,
   - with keyword evidence present, at most `EMBED_EXTRA_K=10` extras,
   - chunk index over the 2,215 full transcriptions + 3.3k commentaries
     (`npm run build:chunks`, 16,843 chunks of 800 chars/150 overlap,
     public letters only); the top passages join as candidates and the
     **matching passage** is what the model and the UI show, instead of
     the first 1,500 chars,
   - optional cross-encoder rerank (bge-reranker-v2-m3 sidecar, §4): extras
     below `RERANK_MIN=0.3` are dropped. Calibration finding: across 51
     tag-gold questions, none of the 632 embedding extras was gold
     (median rerank 0.005) — but tag gold cannot see untagged-but-relevant
     letters, so the threshold deliberately keeps the endorsed ones.

**Context ordering matters:** keyword-backed letters precede embedding
extras, most-specifically-matched first. Letter 25851 (the only one tagged
"…, Frage 60") sat at position 55 of 57 by cosine and the model denied it
existed; at position 1 it answers correctly.

**Deterministic generation guards** (prompt rules alone did not stick):
- *citation guard*: an answer citing a Brief number absent from the sources
  gets one corrective retry (observed digit-mutations like 41710→41510),
- *refusal guard*: an answer opening with "keine Informationen"/"Kein(e) …"
  while curated-match letters were in context gets one corrective retry,
- retries instruct the model not to apologise or reference the prior
  attempt (it otherwise opens with "Entschuldigung für den Fehler"),
- one 2 s backoff retry on DeepSeek transport errors; generation failure
  returns 503 with "search found N letters, generation is down" instead of
  a bare "Connection error",
- `max_tokens: 8192` — 40+-letter enumerations were truncated at ~25 entries.

---

## 3. The evaluation harness (test/)

**This is the main deliverable.** Nothing in §2 was changed without it.

```
npm run build:gold        # gold sets from Mongo (tags/names/dates)  — rerun after every mongorestore
npm run build:questions   # 56 generated questions + their gold, seeded & committed
npm run eval              # retrieval-only via POST /api/retrieve — ~5 s, free, deterministic
npm run eval:full         # end-to-end incl. DeepSeek — writes test/review-latest.md for human grading
npm run eval:full -- --repeat=3   # + stability smoke: are all generation-side checks identical across runs?
node test/calibrateRerank.js      # rerank-threshold calibration (server with RERANK_MIN=0)
```

- **Question tiers** (65 total): 9 handwritten (incl. greeting, off-topic,
  archive-stats, nonexistent-letter controls) reported per question;
  33 subject + 15 person template questions sampled from the DB with a
  fixed seed; 8 content questions whose gold comes from the **regest text**
  and is split into tagged/untagged (only the non-tag paths can score on
  the untagged part).
- **Gold is regenerated from Mongo, never hardcoded** — the archive drifts
  (36,556 → 36,721 letters between your dump and mine; the Heidelberg gold
  set grew 47 → 48).
- **Hard assertions** (exit 1): no `intern` letter in any result (checked
  by id *and* by `sichtbar` flag), no invented citations (ids echoed out of
  regest/CMIF text are warned, not failed).
- **Metrics vs baseline**: every run diffs against `test/baseline.json` and
  prints `⚠ REGRESSION`. Delete the file to re-baseline after an intended
  change.
- **Generation-side checks** (full mode): answer language is German,
  citation recall (share of in-context gold letters actually cited),
  must-include letters cited, false refusals, refusal behaviour of the
  control questions.
- **Human review**: `eval:full` writes `test/review-latest.md` — question,
  full answer, top sources, blank grade line. Two human review rounds
  happened; both found failure classes the automated checks could not see
  ("retrieved but denied", enumeration truncation, tooling blind spots),
  and each finding was converted into an automated check afterwards.
  Do the same when you change generation.

**UI** (`public/index.html`): the sidebar loads the full grouped question
set from `GET /api/questions` (kept in sync with the fixtures), answers
render as Markdown with every Brief number linked to the archive record, a
tick-mark outline lets you jump back to any asked question, and the status
line shows "N Briefe gefunden – formuliere Antwort…" after the (fast)
retrieval phase.

---

## 4. Running it

```bash
# prerequisites: MongoDB (only for data rebuilds), Ollama with bge-m3, Node >= 20.12, uv (optional, rerank)
cp .env.example .env            # add your own DEEPSEEK_API_KEY

# data (after a fresh clone or a new mongorestore):
npm run build:corpus            # Mongo -> data/corpus.jsonl + data/fulltext.jsonl (~1 min)
npm run build:index             # letter embeddings (~30 min M1 Pro; resumable; only needed if corpus *text* changed)
npm run build:chunks            # passage index (~15 min; resumable)
npm run build:gold && npm run build:questions

# run:
uv sync --project rerank                             # once
uv run --project rerank python rerank/server.py &    # optional sidecar on :5056
npm start                                            # http://localhost:5055
```

Or `./start-demo.sh` — checks Ollama, starts the sidecar and the server,
waits for health, opens the browser. The server logs at startup exactly
which optional layers it found; it works without the sidecar and with a
partial chunk index.

**Gotcha:** if generation suddenly fails with DNS errors for
`api.deepseek.com`, check Tailscale — its MagicDNS (100.100.100.100)
intercepted resolution twice during development (once REFUSED, once the
daemon was offline). `tailscale up`, or disable "Use Tailscale DNS".

---

## 5. Schema facts learned the hard way (beyond your §3)

- `verfasser[].person.v` ids do **not** resolve against `people._id` in the
  current dump — use the denormalised `verfasser[].nameMitAmt.combi`.
  Canonical names come in bracketed variants (`[Matthias Hafenreffer]`,
  also mid-string: `[Johann Ulrich Pregitzer], Rektor`) — treat bracketed
  and plain spellings as the same person or you undercount.
- `saches.alternativen[].text.v` is a hand-curated synonym ring (Latin and
  period German) on 7,296 subjects — indexing it is free recall.
- Editors reference *other* letters inside regests and CMIF snippets; a
  model echoing such an id is not fabricating. The eval distinguishes the
  two.
- Your README's claim that transcriptions are empty was wrong (you knew);
  `hasFullText` is now real, and `data/fulltext.jsonl` carries the 2,215
  transcriptions + commentaries for the chunk index. They are deliberately
  **not** embedded into the letter vectors (early-modern German/Latin
  dilutes the modern-German regest signal).

---

## 6. Honest caveats & where to go next

1. **Tag gold understates the regest path.** Questions say "erwähnen X";
   a regest mentioning X is a correct answer that tag gold counts as a
   false positive (that is most of the gap between 93.9% and 61.0%
   precision). The right next step is a human spot-check of ~30
   "regest-only" hits to estimate that path's true precision.
2. **Content recall is 68%, not 100%** — regests use verb forms and
   compounds the crude stemmer misses ("träumte", "Traumgesicht"; the
   Traum question scores 15%). A real stemmer (snowball) or a small word
   list would help; measure side effects with the eval before keeping it.
3. **Deployment prerequisites are untouched by design**: no auth, CORS is
   wide open, no per-question cost cap (enumerations build large prompts),
   `data/corpus.jsonl` holds `intern` letters in cleartext on disk, and
   generation is a cloud call. Retrieval never serves `intern` (asserted
   every run), but these need explicit decisions before anyone but us uses
   it.
4. **No streaming** — answers arrive whole after 10–30 s; the two-phase
   status line only softens the wait.
5. **Brute-force cosine** (36k letter + 17k chunk vectors) costs ~100 ms per
   query — fine now, replace with FAISS/sqlite-vec at deployment scale.
6. **Multilingual is descoped**, not impossible: bge-m3 is multilingual;
   the keyword paths are German-only. If it comes back, start by re-adding
   the en/fr questions to the eval — they document the exact failure modes.
7. **Pure functions have no unit tests** (`stemWord`, `subjectForms`,
   `matchRegest`); the end-to-end eval covers them today.

---

## 7. Where things live

```
server/server.js          retrieval paths, guards, prompt, API (incl. /api/retrieve, /api/questions)
scripts/buildCorpus.js    Mongo -> corpus.jsonl + fulltext.jsonl (adds subjectVariants, primary-source fields)
scripts/buildChunkIndex.js  passage index (resumable, sha1-guarded)
rerank/                   uv-managed cross-encoder sidecar (bge-reranker-v2-m3)
test/eval.js              the harness (see §3); test/buildGoldSets.js, test/generateQuestions.js, test/calibrateRerank.js
test/fixtures/            committed gold sets + generated questions
test/baseline.json        current metric baseline (committed)
test/review-latest.md     latest human-review sheet (gitignored, regenerated by eval:full)
Docs/HANDOFF.md           this file
local-docs/               (gitignored) Chinese working notes: per-round test reports, question catalog,
                          both human-review write-ups, and your 2026-08-14 handoff — ask Zonghan if you want them
```

Commit history on `eval-harness` tells the story in order — each fix commit
carries its before/after numbers in the message.
