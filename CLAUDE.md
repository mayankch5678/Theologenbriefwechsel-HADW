# ThBw RAG Chatbot — Project Context & Handoff

**Status:** working prototype, retrieval quality not yet acceptable.
**Handoff date:** 2026-08-14. Written by the previous maintainer (Mayank) for the next one.
**Every number in this file was verified against the live MongoDB on 2026-08-14** — if a
figure here disagrees with `README.md`, trust this file (see "README.md is stale" below).

---

## 1. What this project is

A local-only RAG (retrieval-augmented generation) chatbot over the **ThBw** archive —
*Theologenbriefwechsel im Südwesten des Reichs*, a scholarly edition of early-modern
theologians' correspondence (roughly 1517–1621, centred on the Kurpfalz and Württemberg),
run by the Heidelberger Akademie der Wissenschaften (HAdW).

A researcher asks a question in natural language ("Welche Briefe erwähnen den Heidelberger
Katechismus?"); the bot answers **only** from retrieved letters and returns the source
letters with their permanent archive URLs so the answer can be checked by hand.

The prototype is **strictly read-only** with respect to the archive. It reads the restored
local MongoDB and writes nothing back. It lives entirely outside the upstream `ThBw/`
application code.

### Non-negotiable product constraint

This is a tool for historians. **A plausible-sounding wrong answer is worse than no
answer.** Every claim must be traceable to a letter ID. The system prompt enforces this and
should stay strict. When you change retrieval, check that you have not made the model more
confident, only better sourced.

---

## 2. Repository layout

The working directory is `HAdw-RAG/`, which contains four unrelated things:

| Path | What it is | Touch it? |
|---|---|---|
| `Mayank's playground/` | **This project.** The RAG prototype. Own git repo. | Yes — this is your workspace |
| `ThBw/` | The upstream HAdW web application (`gitlab.hadw-bw.de/thbw/ThBw.git`, branch `master`). The real editorial system the data comes from. | Read-only reference. Do not modify or depend on it |
| `dataset/` | Shell scripts to mount the HAdW network share and restore the Mongo backup | Run `mount_and_restore_mac.sh` for setup; see §9 security warning |
| `rag/` | Empty. Abandoned earlier attempt. | Ignore |

Inside `Mayank's playground/`:

```
scripts/buildCorpus.js    MongoDB  -> data/corpus.jsonl        (read-only ETL)
scripts/buildIndex.js     corpus   -> data/embeddings.bin      (local Ollama embeddings, resumable)
server/server.js          Express API: hybrid retrieval + DeepSeek generation
public/index.html         minimal chat UI (253 lines, vanilla JS, no build step)
data/                     generated artefacts — gitignored, must be rebuilt locally
```

Git: one commit (`0628404`), clean tree, remote
`github.com/mayankch5678/Theologenbriefwechsel-HADW.git`.
`data/corpus.jsonl` and `data/embeddings.bin` are **gitignored** — cloning gets you no data,
you must rebuild both (§4).

---

## 3. The ThBw data model — read this before writing any query

This is the part that costs the most time to rediscover. The schema is unusual.

**Connection:** `mongodb://127.0.0.1:27017`, database `letters`, 26 collections.
Letters are in `briefs`.

### 3.1 Every field is wrapped in an `{ m, v }` envelope

`m` is editorial provenance metadata (who asserted this, when, is it conjectural,
is it doubtful); `v` is the actual value.

```js
db.briefs.findOne().short          // { m: {...}, v: "11328" }
db.briefs.findOne().short.v        // "11328"   <- the letter's human-facing ID
```

So **every query path needs `.v`**: `{"sichtbar.v": "offen"}`, not `{"sichtbar": "offen"}`.
`buildCorpus.js` has an `unwrap()` helper for this. The `m` envelope also carries
`erschlossen` (inferred), `unsicher` (uncertain), `ca` (circa), `fragwuerdig`
(questionable) — scholarly hedging that the RAG currently throws away but arguably
should surface, since "date is conjectural" matters to a historian.

### 3.2 Cross-references are real ObjectIds, not strings

```js
// WRONG - silently returns 0, this cost an hour once
db.briefs.countDocuments({"schlagworte.sachen.v": "5c18e349b8b1730eeb705868"})  // 0

// RIGHT
db.briefs.countDocuments({"schlagworte.sachen.v": ObjectId("5c18e349b8b1730eeb705868")})  // 45
```

`schlagworte` (subject index) has three arrays — `personen`, `orte`, `sachen` — each an
array of `{m, v}` where `v` is an ObjectId into `people` / `orts` / `saches`. The label
lives at `<target>.short.v`. `buildCorpus.js` preloads all four reference collections into
one id→label map to avoid N+1 queries.

### 3.3 Where the text actually lives

| Field path | Non-empty letters | Notes |
|---|---|---|
| `regest.text.v` | **19,428** | Scholarly abstract (German prose). The main retrieval signal today |
| `incipit.v` | **31,204** | Opening words of the letter. **Unused by the RAG** |
| `erlaeuterung.v` | **3,324** | Editorial commentary. **Unused by the RAG** |
| `transkription.volltext.v` | **2,196** | **Full letter text** (Latin/German), avg 4,287 chars, max 127,270, 9.41M chars total. **Unused by the RAG** |
| `xml.v` | 2,202 | TEI/XML of the letter |
| `cmif.v` | most | CMIF `correspDesc` snippet — sourced person/place/date refs, used for traceability |

Other useful fields: `long.v` (the full citation line — `"18494: 3. April 1563,
[Heidelberg]. Kaspar Olevian an Heinrich Bullinger"`), `datierung.iso.v`,
`datierung.schoen.v` (display date), `verfasser[].nameMitAmt.combi` (sender with office),
`adressat[]` (recipient), `absendeort[].name.v`, `literatur[].literaturAngabe.combi`
(secondary literature), `searchTags.v` (a pipe-delimited denormalised blob of all tags —
handy for grepping, but derived, so don't treat it as authoritative).

### 3.4 Corpus totals (verified 2026-08-14)

```
briefs 36,556  |  people 24,028  |  saches 20,662  |  orts 5,210
briefhandschrifts 45,880  |  lateins 54,831  |  logs 686,612

sichtbar:  offen (public) 22,552   |   intern (internal-only) 14,004

                        offen    intern
regest.text.v          17,929     1,499
transkription.volltext  2,132        64
erlaeuterung            2,028     1,296
incipit                22,042     9,162

Truly metadata-only (no regest AND no transkription): 17,012 letters
```

### 3.5 `offen` vs `intern` — a hard privacy boundary

14,004 letters are `intern`: unpublished editorial records not cleared for public view.
`server.js` builds `publicIndices` at load time excluding every `sichtbar === "intern"`
record, and **all retrieval walks only that list**, so internal letters cannot reach an
answer or a citation. Verified: the health endpoint reports `retrievable: 22552`.

Keep it that way. Note two residual exposures: `data/corpus.jsonl` on disk still contains
all 36,556 records including `intern` text, and generation is a **cloud** call (§4), so
anything that does reach the context leaves the machine.

### 3.6 The subject vocabulary is a real thesaurus — and the ETL throws most of it away

`buildCorpus.js` reads only `saches.short.v` (the display label). Each subject record also
carries two fields that are directly the answer to two of the open bugs in §6:

**`uebergeordnet` — broader-term parents** (an array of `{m, v}`, `v` → another `saches`
`_id`). Populated with a resolvable parent on **13,170 of 20,662** subjects (64%). Caveat:
20,211 have a *non-empty array*, but 7,041 of those contain only `null` entries — incomplete
editorial records. So test `{"uebergeordnet.v": {$ne: null}}`, not array length.

The Heidelberg Catechism chain is exactly what you would want:

```
Heidelberger Katechismus, Frage 60   ->  Heidelberger Katechismus  ->  Katechismus
Heidelberger Katechismus, Frage 80   ->  Heidelberger Katechismus
Heidelberger Katechismus, 1573 (...) ->  Heidelberger Katechismus, Katechismus  (two parents)
```

So subject expansion should walk **downward** (a query for X pulls in X's descendants), never
upward (which is what today's substring matching effectively does when `"katechismus"` hoovers
up the whole genus). Note the hierarchy is *incomplete*: of the ten Heidelberg-Catechism tags
in §8, only 3 are registered children. `"Heidelberger Katechismus, Frage 37"` has an
`uebergeordnet` entry whose `v` is `null`; `"Verteidigung des Heidelberger Katechismus"`,
`"Bullinger, Apologie des HK"` and `"De erroribus Catechismi Palatinatus"` are separate
concepts, not children. Hierarchy expansion is a large improvement, not a complete solution —
you will still need the curated gold set in §8 to know where it falls short.

**`alternativen` — a synonym ring.** Present on **12,151 of 20,662** subjects. For
`"Heidelberger Katechismus"`:

```
Heidelbergensis catechismus  |  Pfaltzgreuischer Catechismus
Catechesis Palatina          |  Catechesis Palatinatus
```

That is the editors' own hand-curated list of Latin and early-modern German variants — the
exact forms that appear in the letters and that a paraphrased question might use. Indexing
`alternativen` alongside `short.v` is cheap (no re-embedding needed; the subject index is
built at server startup) and should be one of the first things you do.

Neither field is in `corpus.jsonl` today. Adding them means touching `resolveRefs()` in
`buildCorpus.js` to carry structure rather than a flat label string.

---

## 4. Architecture and how to run it

### Pipeline

1. **`npm run build:corpus`** — MongoDB → `data/corpus.jsonl` (36,556 lines, 92 MB).
   Flattens the `{m,v}` envelope, resolves ObjectId refs to labels, and produces one record
   per letter. For the 17,128 letters with no `regest`, it **synthesises** a one-line German
   abstract from metadata (`"Brief von X an Y, Ort, Datum. Themen: A, B."`) and flags it
   `regestSynthetic: true`, so no letter is unreachable by search.
   Requires MongoDB running. Read-only.
2. **`npm run build:index`** — embeds each record's `text` field via **local Ollama**
   (`bge-m3`, multilingual, 1024-dim) → `data/embeddings.bin` (flat Float32, 150 MB) +
   `embeddings.meta.json`. **Resumable**: appends, derives progress from file size,
   truncates a partial trailing record. Requires Ollama, not MongoDB.
   Full run ≈ 2–2.5 h on an 8 GB M-series Air at the observed ~4.6 records/s.
3. **`npm start`** — Express on `:5055`. Per question: embed query locally → hybrid
   retrieval (§5) → send retrieved letters + question to the **DeepSeek API**
   (`deepseek-chat`) → return answer + full source list.

### Prerequisites

```bash
# MongoDB (Homebrew) — needed only for build:corpus
brew services start mongodb-community
# one-time data restore (mounts HAdW SMB share, runs mongorestore --drop)
../dataset/mount_and_restore_mac.sh

# Ollama — needed for build:index and for every query (query embedding)
brew services start ollama
ollama pull bge-m3

npm install
cp .env.example .env      # then add your own DEEPSEEK_API_KEY=
npm run build:corpus
npm run build:index
npm start                 # http://localhost:5055
```

`llama3.2:3b` and `llama3.1:8b` are also pulled locally, left over from when generation ran
locally. Generation was moved to DeepSeek because running an embedding model and a chat
model simultaneously thrashed swap on 8 GB. If you have more RAM, going fully local is a
legitimate option and removes the cloud-egress concern in §9.

### Current runtime state (verified 2026-08-14)

```
GET /api/health ->
{"ok":true,"letters":36556,"retrievable":22552,"subjects":22959,
 "chatModel":"deepseek-chat","embedModel":"bge-m3"}
```

Embedding build is **complete**: `{"model":"bge-m3","dim":1024,"count":36556,"total":36556}`.

> **`README.md` is stale.** It claims (a) `build:index` was never finished — it is, see
> above; and (b) "`transkription`/`erlaeuterung`/`incipit` are empty for every letter —
> there is no full letter text to retrieve". **That is wrong**, and it is the most
> consequential error in the docs: 2,196 letters have full transcriptions and 31,204 have
> incipits (§3.3). `buildCorpus.js:168` hardcodes `hasFullText: false` on the strength of
> that false premise and never reads those fields. Fix the README when you fix the ETL.

---

## 5. How retrieval works now

`server/server.js` (320 lines). Tunables at the top, all env-overridable:

```js
TOP_K       = 30    // embedding-path candidates
CONTEXT_MAX = 60    // max letters put in the DeepSeek prompt (API response stays uncapped)
MIN_SCORE   = 0.3   // cosine floor on the merged set
MIN_SUBJECT_LEN = 4 // ignore very short subject labels
```

Two retrievers **always both run**, then union:

- **Keyword path** (`matchSubjects`) — the 20,662 curated `saches` subject labels are a real
  controlled vocabulary, which makes them a much better signal than embeddings for
  "which letters are about X" questions. At load time `subjectIndex` maps each normalised
  label (plus a variant with any `"(1530)"`-style parenthetical stripped) to the public
  letters carrying it — 22,959 forms. A subject matches if it appears in the question or the
  question appears in it, whole-word (both sides space-padded, because otherwise the subject
  `"Hand"` matched inside `"handeln"`). Returns **all** matches, uncapped.
- **Embedding path** (`rankByCosine`) — brute-force cosine over all 22,552 public vectors,
  take top `TOP_K`.

Union → dedupe by letter id → rank by cosine → drop anything below `MIN_SCORE`. The API
returns **every** surviving hit in `sources`; only the prompt is trimmed to `CONTEXT_MAX`.
The response includes a `retrieval` block (`matchedSubjects`, `keywordMatches`, `belowFloor`,
`matches`, `inContext`) — use it, it is how you debug this system.

If nothing clears the floor the server returns a fixed "no relevant letter found" string and
never calls the model, rather than inviting invention from an empty context.

This hybrid design is **correct in principle** — a purely dense index cannot answer
enumerative questions, and a purely keyword index breaks on paraphrase. The problem is that
both halves are currently mis-tuned, badly (§6).

---

## 6. Known bugs and open issues — all verified, highest value first

The previous session audited one enumerative question end-to-end
(*"Which letters mention the Heidelberg Catechism?"*) against MongoDB ground truth. Use it
as your first regression test; the gold set is in §8.

### 6.1 Generic curated subjects flood the result set — *critical, precision*

`"Briefe"`, `"Katechismus"`, `"Jahr"`, `"Nachrichten"` are themselves curated `saches`
labels. Any question containing such a word unions in every letter carrying it.

```
Q: "Welche Briefe erwähnen den Heidelberger Katechismus?"
matchedSubjects: ["briefe", "katechismus", "heidelberger katechismus"]
keywordMatches: 538   ->   558 sources returned   (ground truth: 45)
```

The word "Briefe" — unavoidable in a German question about letters — pulls in hundreds of
unrelated records. The code comment at `retrieve()` anticipates this risk but nothing
actually guards against it.

Directions: a stoplist of structurally generic subjects; skip any matched subject whose
bucket exceeds some share of the corpus (IDF-style weighting rather than a flat union);
prefer the **most specific** matched subject and drop matched subjects that are substrings
of it (here `"heidelberger katechismus"` should suppress `"katechismus"`); and/or make
keyword hits a ranking boost rather than an unconditional inclusion.

**The same mechanism also *under*-matches, which is easy to miss.** `subjectForms()` strips
only *parenthetical* qualifiers, so comma-suffixed variants never match a question naming the
base subject: `"Heidelberger Katechismus, Frage 60"` normalises to
`heidelberger katechismus frage 60`, which neither contains nor is contained by the query.
Letter **25851** is tagged with *only* that variant and is consequently missed altogether —
it is the one gold letter the German query loses, despite scoring 0.39 on cosine. Letter
20866 (tagged only `"Heidelberger Katechismus, 1573 (VD16 ZV 24459)"`) is retrieved only by
accident, via the junk `"briefe"` match. So the 97.8% recall above is partly luck, and fixing
6.1 naively — by dropping the generic subjects — will *reduce* recall unless you also make
qualified variants match their base subject. The archive already gives you the machinery for
this and the ETL ignores it: see §3.6.

### 6.2 Keyword path is German-only — *critical, recall*

Subject labels are German. An English or French question never matches them, silently
dropping the good retriever and degrading to embeddings alone:

```
Q: "Which letters mention the Heidelberg Catechism?"
matchedSubjects: []   keywordMatches: 0   ->   30 sources (embedding-only)
```

The system prompt invites answers in German, English or French, so this is a first-class
path, not an edge case. Directions, cheapest first:

1. **Index `alternativen` (§3.6).** Free recall: 12,151 subjects already carry curated
   variant labels, including the Latin forms (`Catechesis Palatina`, `Heidelbergensis
   catechismus`). Won't help English or French, but it costs almost nothing and also fixes
   paraphrase within German and Latin.
2. **Embed the subject labels themselves** and match query↔label by vector similarity rather
   than substring. `bge-m3` is multilingual, so "Heidelberg Catechism" should land near
   "Heidelberger Katechismus". This is the principled fix and it simultaneously replaces the
   brittle substring matching behind 6.1. ~23k label vectors is a trivial index.
3. **Batch-translate the vocabulary** (20,662 labels, one-off, cacheable) if 2 proves too
   fuzzy, or have the chat model extract candidate subject terms from the question first
   (adds a round-trip and a failure mode, so prefer 2).

### 6.3 `MIN_SCORE = 0.3` is a no-op — *high*

Measured cosine distribution for the Heidelberg query over all 22,552 public vectors:

```
min 0.220   max 0.595   mean 0.397
>= 0.30 : 22,272 of 22,552   (98.8% — the "floor" excludes almost nothing)
>= 0.40 : 10,170
>= 0.50 :    322
>= 0.60 :      0
```

`bge-m3` cosine similarities live in a narrow high band, so 0.3 admits essentially the whole
corpus and `belowFloor` was 0 in both test queries. Recalibrate empirically (0.45–0.5 looks
like the meaningful knee) — but do it *after* 6.1, since the union is the bigger problem,
and re-measure per query type rather than trusting a single constant.

### 6.4 `sources` and context diverge, so citations overstate what the model saw — *high*

`matches: 558` but `inContext: 60`. The UI renders all 558 source cards while the model only
ever saw 60 letters. A researcher reasonably reads those cards as "the evidence for this
answer". Either cap `sources` to what was actually in context, or split the response into
"cited" vs "other candidate matches" and have the UI label them differently.

### 6.5 The model is told to flag synthetic regests but is never given the flag — *high*

`SYSTEM_PROMPT` rules 4 and 6 require the model to mark metadata-only letters and
automatically generated summaries. But `buildContext()` emits only `r.regest`, never
`r.regestSynthetic` — so the model **cannot** comply and is being asked to guess. It has
been getting away with it because synthetic text reads mechanically
(`"...Themen: Heidelberger Katechismus."`), which is luck, not design.

Related dead code: `buildCorpus.js` gives *every* record a `regest` (synthetic fallback), so
`r.regest` is never empty — verified 0 empty across 36,556 records. Therefore
`buildContext()`'s `"(Kein Volltext/Regest vorhanden…)"` branch is unreachable and the API's
`hasRegest` field is always `true`. Pass `regestSynthetic` into the context explicitly and
fix `hasRegest` to mean what it says.

### 6.6 The actual letter text is being discarded — *high, biggest quality upside*

Per §3.3 and the README warning in §4: 2,196 full transcriptions (9.41M chars), 3,324
editorial commentaries and 31,204 incipits are in the database and **none of it is indexed**.
For the Heidelberg gold set, **19 of the 47 letters have a full transcription** that the bot
currently cannot see — it is answering from abstracts while the primary sources sit unused.

This is the single largest available improvement in answer quality. It is not free:

- Letters run to 127k chars; `bge-m3` caps around 8,192 tokens, so whole-letter embedding
  would silently truncate. **You need chunking** (with letter-id back-references so
  citations still resolve to a letter) — the current one-vector-per-letter design assumes
  `records[i]` aligns positionally with vector `i`, and chunking breaks that assumption.
  Expect to touch `buildIndex.js`, `loadIndex()` and `rankByCosine()` together.
- Transcriptions are Latin and early-modern German with heavy abbreviation. Verify `bge-m3`
  retrieves sensibly on them before trusting it — spot-check with known Latin phrasing.
- Only 64 of the 2,196 are `intern`, so this barely moves the privacy surface.

### 6.7 Enumerative questions are structurally the wrong shape for RAG — *design*

"Which letters mention X", "how many", "list all" are filter/aggregate operations, not
nearest-neighbour ones. Dense retrieval cannot answer them at any `TOP_K`: the 47 relevant
letters do not cluster tightly enough to occupy the top of the ranking, and letters 18449 /
18466 (Olevian↔Calvin on the catechism's prehistory) outrank several genuinely tagged ones.

Consider detecting enumerative intent and serving it deterministically from the tag index —
returning a complete, counted list with the generation step used only for narration. This is
a different code path from open-ended questions, and pretending otherwise is what produced
the original 7-of-47 answer.

### 6.8 Smaller items

- **Brute-force cosine** over 22,552×1024 floats per query is fine today, but chunking (6.6)
  could 10× the vector count. Plan for `sqlite-vec` / FAISS / hnswlib before it bites.
- **`m`-envelope hedging discarded** — `unsicher`, `erschlossen`, `ca`, `fragwuerdig` never
  reach the answer, so a conjectural date is presented as fact. Historians care.
- **Secondary-literature false positives.** Several letters contain "Heidelberger
  Katechismus" only in a `literatur` citation (e.g. *Hollweg, Heidelberger Katechismus*) or
  in an editorial `aufnehmenAnm` note — 17887, 17949, 18449 among them. If you ever index
  those fields, they will masquerade as content mentions. The curated `sachen` tag is the
  editors' own judgement and is the right ground truth.
- **No auth, no rate limiting, no request logging.** Single-user local prototype.
- **No automated tests at all.** See §8.

---

## 7. Suggested phase plan

Ordered so each phase is independently shippable and testable.

**Phase 1 — Build the evaluation harness first (do this before any fix).**
Without it you cannot tell a retrieval change from a retrieval regression. Extract gold sets
straight from MongoDB tags (§8), cover ~10 questions of mixed shape (enumerative, single-fact,
person-centred, date-ranged, multilingual), and report precision/recall per question. Cheap
to build, and it makes every later phase measurable.

**Phase 2 — Retrieval precision and honesty.** Fix 6.1 (subject flooding *and* the
qualified-variant under-match), 6.3 (`MIN_SCORE`), 6.4 (`sources` vs context), 6.5
(synthetic-regest flag). Pull `uebergeordnet` and `alternativen` into the corpus (§3.6) —
that is the enabling step for 6.1 and it makes Phase 3 mostly free. Requires re-running
`build:corpus` but **not** `build:index`, since the subject index is built at server startup.
Immediate, measurable gain.

**Phase 3 — Cross-lingual subject matching.** Fix 6.2. Largely falls out of Phase 2 if you
take the embed-the-subject-labels route, which also retires the substring matching entirely.
Unblocks the non-German audience the system prompt already promises to serve.

**Phase 4 — Index the real text.** Fix 6.6: ingest `transkription`, `erlaeuterung`,
`incipit`; introduce chunking; re-embed (budget the full ~2.5 h rebuild). Biggest quality
win, biggest blast radius — hence after the harness exists.

**Phase 5 — Deterministic path for enumerative questions.** Fix 6.7. Needs Phase 2's
subject-matching to be trustworthy first.

**Phase 6 — Productionisation, only if this goes beyond one laptop.** Real vector index;
authentication before any `intern` record is reachable; decide whether cloud generation is
acceptable at all (§9); request logging for reproducibility of published claims.

Worth raising with the HAdW team rather than deciding alone: whether `intern` records should
be in the corpus file at all, and whether sending any archive text to a third-party API is
acceptable under their agreements.

### Open decisions (for Zonghan / the team — not resolved, as of 2026-09-25)

- **Rerank sidecar (`rerank/`, `BAAI/bge-reranker-v2-m3`) is deliberately not running.** It is
  an optional precision layer; the server probes it at startup and skips it when absent. Running
  it needs `uv` (not installed on this machine), torch + sentence-transformers and a ~2 GB model
  download, and the machine has **8 GB RAM** — a second model next to Ollama/bge-m3 risks the swap
  thrashing already recorded in §4. Whether to add it here, or run it elsewhere, needs deliberate
  planning first. Until decided, evals run **without rerank**; `test/baseline.json` (2026-09-11)
  may have been recorded with it, so comparisons against it are not like-for-like.
- **Letter 81172 (`gen_sache_5b9508`, "Kost und Logis") privacy status.** The generated-question
  fixture lists it as `intern`; the 2026-09-18 corpus and the live server have it as `offen`. Do
  not regenerate fixtures or treat either side as correct until the HAdW team confirms.
- **Chunk index (`build:chunks`) is built and on, with `CHUNK_MIN_SCORE = 0.6`** (was 0.5).
  Rebuilt 2026-09-25: 16,569 chunks from 3,854 public letters (~35 min). At 0.5 the small-talk
  question "Hallo, wie geht es dir?" returned 10 letters through commentary passages (top chunk
  cosine 0.576) instead of refusing; at 0.6 `smalltalk_de` and `offtopic_de` are empty again.
  Real content questions top out at 0.59–0.64, so the margin is thin and the layer now adds
  chunks only for strong matches. Env-overridable (`CHUNK_MIN_SCORE`); re-measure if the
  chunk index or embedding model changes.
- **Open: chunks did not improve `gen_inhalt_traum` (recall 21.1%) or `gen_inhalt_gicht` (61.5%).**
  Recall and untagged recall were identical with and without the chunk layer, so the gap is not
  a missing-transcription problem. Cause not investigated.

### Agent routing: two classify_letters triggers (proposed, not yet applied — 2026-09-28)

`server/agent.js` gets two new routing clauses, drafted in `docs/ausland-routing.patch`:

- **`search_letters` defers to `classify_letters`** when a question needs interpretation
  beyond keyword, tag, or embedding-similarity matches (sinngemäße Bedeutung, whether an event
  is meant even if the term is absent from the Regest) — `search_letters` can only match what's
  written, not what's implied.
- **"Ausland" leg (c), conditional.** Legs (a) tag-based and (b) place-classification stay as
  they are. A third leg — `classify_letters` over the whole archive, criterion "erwähnt der
  Brief politische Nachrichten oder Ereignisse aus dem Ausland, auch wenn das Wort
  'Nachrichten' nicht vorkommt?" — runs only when the question's own wording suggests (a)/(b)
  could miss the answer (e.g. "auch wenn das Wort ... nicht vorkommt", "sinngemäß",
  "inhaltlich", or a war/uprising-abroad topic). A plain "Nachrichten aus dem Ausland" question
  still runs only (a) and (b); if (c) runs, its count is reported separately from (a)/(b).
  New agent-eval questions `q7_ausland_deutung` and `q8_ausland_krieg` exercise this leg.

---

## 8. Regression fixture: the Heidelberg Catechism gold set

Ground truth, derived from the editors' own subject tags on 2026-08-14:
**47 letters** (45 `offen`, 2 `intern` → **45 retrievable**), 46 with a real regest.

The relevant `saches` ObjectIds (there are ten — a naive single-tag query under-counts):

```
5c18e349b8b1730eeb705868  Heidelberger Katechismus                      45 letters
63c64adf7273b7053c255f9d  Bullinger, Apologie des HK, 1563 (verloren)    3
5d4bdec6cd94087f51d218ca  Heidelberger Katechismus, Frage 80             2
5f2bfbe9a1584d546a137183  Heidelberger Katechismus, 1573 (VD16 ZV 24459) 1
659d556695945bb3d1fd7ba6  Verteidigung des Heidelberger Katechismus      1
65c37040a4fb14a196741c02  Bullinger, [Beurteilung ...Schmähschrift] 1563  1
66fd0a3cf1bf32731a17255a  Heidelberger Katechismus, Frage 60             1
67e5262a61b3ac7dbf364f72  Heidelberger Katechismus, Frage 37             1
5c18e337b8b1730eeb7052e8  De erroribus Catechismi Palatinatus, 1565      1
5eecde96bbf934303597df04  Kleiner Heidelberger Katechismus (1576)        0
```

Regenerate the gold set:

```js
// mongosh letters
const ids = ["5c18e349b8b1730eeb705868","5d4bdec6cd94087f51d218ca","5f2bfbe9a1584d546a137183",
             "5eecde96bbf934303597df04","63c64adf7273b7053c255f9d","659d556695945bb3d1fd7ba6",
             "65c37040a4fb14a196741c02","66fd0a3cf1bf32731a17255a","67e5262a61b3ac7dbf364f72",
             "5c18e337b8b1730eeb7052e8"].map(k => ObjectId(k));
db.briefs.find({ "schlagworte.sachen.v": { $in: ids } }, { "short.v":1, "sichtbar.v":1 })
  .toArray().map(d => d.short.v).sort();
```

The 45 public letter IDs:

```
10368 12211 18494 18495 18529 18549 18556 18570 18598 18615 18674 18678 18695 18699 18711
18735 18769 18855 19050 19248 19287 19561 19939 19988 20866 21368 21415 21680 21862 25851
25903 26057 28159 31293 42954 43044 49362 49669 49791 53666 63439 69764 74873 80071 94644
```
(plus `18776` and `49806`, both `intern` — these must **never** appear in output.)

**Baseline to beat (measured 2026-08-14):**

| Query | Sources returned | Correct | Recall | Precision |
|---|---|---|---|---|
| `Which letters mention the Heidelberg Catechism?` | 30 | 12 | 26.7% | 40.0% |
| `Welche Briefe erwähnen den Heidelberger Katechismus?` | 558 | 44 | 97.8% | 7.9% |

Two different failure modes on the same question, which is why both language variants belong
in the harness. Also assert on every run: **no `intern` letter ever appears in `sources`**.

Useful ad-hoc check — find letters whose *text* mentions something, independent of tagging
(note it will also surface the `literatur` false positives of §6.8):

```js
db.briefs.countDocuments({ "regest.text.v": /Heidelberg\w*[\s-]{0,3}(Kat|Cat)ech/i })   // 33
```

Only 33 of the 47 name the catechism in their regest, and just 5 in an available
transcription. **14 of the 47 contain the phrase in neither** — they are tagged on the
editors' reading of the manuscript, not on any string present in the database:

```
18529 18570 18711 18735 18776 19287 19561 20866 21368 21680 49362 49791 69764 94644
```

That gap is the whole argument for treating the `sachen` tags as ground truth over any text
search, and for not assuming that a full-text index (§6.6) would make the tag index
redundant. No amount of retrieval sophistication recovers those 14 from text alone.

---

## 9. Security, credentials and privacy

- **`dataset/mount_and_restore_mac.sh` contains a plaintext SMB password** for the HAdW
  share (host `147.142.113.233`, user `hiwithbw`). It is a shared institutional credential.
  Before sharing this project: get the credential out of the file (macOS Keychain — the
  script's own trailing comment explains how), and consider it exposed / worth rotating
  since it has been sitting in cleartext on disk. Do not commit that file anywhere.
- **`.env` holds `DEEPSEEK_API_KEY`** and is gitignored. It is not shared — use your own key.
- **Cloud egress:** retrieved letter text is sent to the DeepSeek API on every question.
  Retrieval currently excludes `intern` records, so what leaves the machine is public
  material — but that guarantee lives in one filter in `loadIndex()`. If you touch
  retrieval, re-verify it (the harness assertion in §8 covers this).
- **`data/corpus.jsonl` contains all 14,004 `intern` records** in cleartext. It is
  gitignored, but it is on disk unencrypted — do not copy it around casually.

---

## 10. Working conventions

- ES modules throughout (`"type": "module"`), Node ≥ 20.12 (uses `process.loadEnvFile`).
  No TypeScript, no build step, no framework in the UI. Keep it that way unless there is a
  reason — the point of this prototype is that a non-JS-specialist can read all of it.
- Deps are deliberately minimal: `express`, `cors`, `mongodb`, `openai` (the last one only
  as an OpenAI-compatible client pointed at `api.deepseek.com`).
- The existing code comments explain *why*, not *what*, and are unusually load-bearing here
  (they record hard-won facts about the schema and the hardware limits). Match that style.
- **Never write to the `letters` database.** Every access is a read. If you need derived
  state, put it in `data/`.
- When a claim about the data matters, verify it with `mongosh` rather than trusting the
  docs — including this file. The README's false "no full text exists" claim silently capped
  this project's quality for weeks (§4, §6.6).
