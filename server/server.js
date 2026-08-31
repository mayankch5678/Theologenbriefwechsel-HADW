// Hybrid RAG API for the ThBw correspondence archive.
// Retrieval: brute-force cosine similarity over locally computed embeddings
// (embedding model runs locally via Ollama — bge-m3 is small enough for
// 8GB of unified memory).
// Generation: DeepSeek API (deepseek-chat) — the retrieved context and
// question are sent to DeepSeek's cloud endpoint to produce the answer.
// Every answer is grounded in retrieved letters and returns their source
// citations (thbw.hadw-bw.de URL + regest/CMIF excerpt) so a researcher can
// trace back to and cross-check the original archive record.

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const ENV_FILE = path.join(__dirname, "..", ".env");

if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";
const CHAT_MODEL = process.env.CHAT_MODEL || "deepseek-chat";
const TOP_K = Number(process.env.TOP_K || 30); // embedding-only fallback path
// When the keyword path already produced hits (curated tags / names / dates
// answered the question), the embedding path is only a supplement — letting
// it add its full top-30 anyway was the main residual precision drain
// (~28 extras on a 4-letter gold set). With keyword hits present, only this
// many embedding-only extras are considered.
const EMBED_EXTRA_K = Number(process.env.EMBED_EXTRA_K || 10);
// How many of the in-context letters get their transcription excerpt
// included. Caps prompt growth: excerpts are up to 1,500 chars each.
const VOLLTEXT_IN_CONTEXT = Number(process.env.VOLLTEXT_IN_CONTEXT || 8);
// Chunk-level index over transcriptions/commentary (scripts/buildChunkIndex.js).
// Top chunks are mapped back to their letters and join the embedding path;
// the matching passage is what the model then sees as evidence.
const CHUNK_TOP_K = Number(process.env.CHUNK_TOP_K || 20);
const CHUNK_EXTRA_K = Number(process.env.CHUNK_EXTRA_K || 10); // letters chunks may add
const CHUNK_MIN_SCORE = Number(process.env.CHUNK_MIN_SCORE || 0.5);
// Optional cross-encoder rerank sidecar (rerank/server.py). When reachable,
// embedding-only extras are re-scored against the question and those below
// RERANK_MIN are dropped — the residual precision drain after the keyword
// fixes. Keyword-backed hits (curated tags, names, dates) are never dropped.
// Calibrated on the eval set (test/calibrateRerank.js, 2026-08): across 51
// gold questions not one embedding-only extra was a gold letter, and their
// rerank scores had median 0.005 and p90 0.78. 0.3 drops the ~78% that the
// cross-encoder rates irrelevant while keeping the extras it endorses — the
// tag-derived gold cannot see the value of untagged-but-relevant letters,
// so the threshold deliberately stops short of dropping everything.
const RERANK_URL = process.env.RERANK_URL || "http://127.0.0.1:5056";
const RERANK_MIN = Number(process.env.RERANK_MIN || 0.3);
const RERANK_MAX_DOCS = Number(process.env.RERANK_MAX_DOCS || 80);
// The keyword path returns every match, but the prompt can't: a broad subject
// matches thousands of letters and would overflow the chat model's context.
// Only what we send to DeepSeek is capped — the API response stays uncapped.
const CONTEXT_MAX = Number(process.env.CONTEXT_MAX || 60);
const MIN_SUBJECT_LEN = 4; // guards against junk matches on very short subjects
// A matched subject carried by more letters than this is a genus term
// ("Briefe", "Katechismus", "Nachrichten") — unioning its whole bucket is
// what pushed precision to 8% (558 sources for a 45-letter question). Such
// terms are dropped from the keyword path; the embedding path still covers
// the query. Curated enumerable subjects sit well below this line.
const MAX_SUBJECT_BUCKET = Number(process.env.MAX_SUBJECT_BUCKET || 150);
// Relevance floor for *embedding-only* hits. bge-m3 cosine scores live in a
// narrow high band — measured on this corpus: greeting/off-topic queries top
// out at 0.44–0.49 while genuine questions reach 0.59–0.64 — so 0.5 is the
// empirical knee (the old 0.3 admitted 98.8% of the corpus and filtered
// nothing). Keyword hits are exempt: they are deterministic matches against
// the editors' own tags and routinely score 0.30–0.45 on cosine.
const MIN_SCORE = Number(process.env.MIN_SCORE || 0.5);
const PORT = Number(process.env.PORT || 5055);

if (!process.env.DEEPSEEK_API_KEY) {
  console.warn(
    "WARNING: DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add your key, " +
      "or export it in your shell before starting the server."
  );
}

const deepseek = new OpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY,
});

let records = [];
let vectors = null;
let dim = 0;
// Indices of the records that may ever be returned: everything except
// sichtbar === "intern". Retrieval only ever walks this list, so internal
// letters cannot leak into an answer or a citation on any path.
let publicIndices = [];
// Normalized keyword subject -> public record indices carrying it.
let subjectIndex = new Map();
// Normalized sender/recipient name -> public record indices. Person names
// never were in the keyword path — "Welche Briefe schrieb X an Y?" used to
// rely on embeddings alone and scored 0% recall whenever the canonical name
// carries brackets, titles or is a collective ("[Ludwig, Herzog von
// Württemberg]", "Württembergische Theologen").
let senderIndex = new Map();
let recipientIndex = new Map();
// Year (from dateIso) -> public record indices. "Welche Briefe stammen aus
// dem Jahr 1563?" is a database filter, not a similarity search — top-K
// retrieval structurally cannot enumerate 384 letters (§6.7).
let yearIndex = new Map();
// Letter id ("18494") -> public record index, for direct-lookup questions.
let briefIdIndex = new Map();
// Chunk index (optional): chunks[i] <-> chunkVectors[i*chunkDim ...].
let chunks = [];
let chunkVectors = null;
let chunkNorms = null;
let chunkDim = 0;
let rerankEnabled = false;

// Case- and punctuation-insensitive form used on both sides of the match.
function normalize(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Crude German stemming, applied identically on both sides of a match:
// fold umlauts, strip one inflectional suffix. "Kometen" -> "komet",
// "Träume" -> "traum". Whole-word matching was inflection-blind: a question
// about "Kometen" found 4 of 24 letters tagged "Komet".
function stemWord(w) {
  let s = w.replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss");
  if (s.length > 5 && /(en|er|em|es)$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 4 && /[ens]$/.test(s)) s = s.slice(0, -1);
  return s;
}
function stemPhrase(s) {
  return normalize(s).split(" ").filter(Boolean).map(stemWord).join(" ");
}

// Question scaffolding and function words that must never become search
// terms for the regest text path.
const STOPWORDS = new Set(
  (
    "welche welcher welches wer was wie wann wo warum briefe brief erwähnen erwähnt erwähnung nennen nennt " +
    "gibt geben zu über von an der die das den dem des ein eine einen einem einer und oder mit in im aus " +
    "jahr jahre jahren schrieb schreibt schrieben betreffen betrifft handeln behandeln thema sind ist " +
    "werden wurde wurden große großen groß alle diese dieser dieses dies etwas nicht auch noch sich " +
    "bei nach vor für durch als auf um wegen zwischen unter ohne gegen seinem seiner seine sein ihrem " +
    "ihrer ihre ihr dass wird hat haben hatte hatten kann können soll sollen will wollen " +
    "viele vielen enthält enthalten insgesamt beste besten gute guten sehr mehr meisten einige welchen"
  ).split(" ")
);

// Subjects are curated strings that often carry a parenthetical qualifier
// ("Augsburger Reichstag (1530)") or comma-separated qualifiers
// ("Heidelberger Katechismus, Frage 60"). Index the stripped form, the
// comma-base and each comma segment too, so a question naming only the base
// subject — or only the qualifier — still reaches the letters tagged with
// the qualified variant. Letter 25851 (tagged *only* "…, Frage 60") was
// unreachable by both "Heidelberger Katechismus" and "Frage 60" questions
// before this. Digit-only segments ("1563") are skipped: they would turn
// every year mention into a subject match.
function subjectForms(subject) {
  const forms = new Set([normalize(subject)]);
  const stripped = subject.replace(/\s*\([^)]*\)/g, "");
  if (stripped.trim()) forms.add(normalize(stripped));
  const segments = stripped.split(",");
  if (segments.length > 1) {
    for (const seg of segments) {
      const form = normalize(seg);
      // Derived segments must be multi-word phrases: a single-word base like
      // "bullinger" (from "Bullinger, Apologie des HK") would fire on every
      // question naming that person and drag the whole genus back in.
      if (/\p{L}/u.test(form) && form.includes(" ")) forms.add(form);
    }
  }
  return [...forms].filter((f) => f.length >= MIN_SUBJECT_LEN);
}

// Canonical names ("Heinrich Weickersreuter, Abt", "[Christoph, Herzog von
// Württemberg]") are indexed under their full normalized form, the part
// before the first comma (name without office/title), and — for multi-word
// names — the last name-word, so "Briefe von Andreae" still matches.
// normalize() already turns brackets and commas into spaces.
function personForms(name) {
  const forms = new Set([normalize(name)]);
  const base = normalize(name.split(",")[0]);
  if (base) forms.add(base);
  const words = base.split(" ").filter(Boolean);
  if (words.length > 1) forms.add(words[words.length - 1]);
  // Stemmed variants of every form so inflected questions still match.
  const out = [...forms].filter((f) => f.length >= MIN_SUBJECT_LEN);
  for (const f of out.slice()) {
    const st = stemPhrase(f);
    if (st && st !== f && st.length >= MIN_SUBJECT_LEN) out.push(st);
  }
  return [...new Set(out)];
}

// Stemmed word -> public record indices whose regest (or editorial
// commentary) contains it. The third deterministic path: for content
// questions ("Welche Briefe erwähnen Gicht?") the answer key is literally
// "the regest mentions it" — embedding cosine on short generic queries
// scored 1% recall on exactly those letters.
let regestIndex = new Map();

// Stemmed regest+commentary text per record, for phrase checks.
let regestStems = [];

function indexRegestWords(i, text) {
  if (!text) return;
  const stemmed = normalize(text).split(" ").filter(Boolean).map(stemWord);
  regestStems[i] = (regestStems[i] || "") + " " + stemmed.join(" ") + " ";
  for (const key of new Set(stemmed.filter((w) => w.length >= 3))) {
    let bucket = regestIndex.get(key);
    if (!bucket) regestIndex.set(key, (bucket = new Set()));
    bucket.add(i);
  }
}

async function loadIndex() {
  const raw = await readFile(path.join(DATA_DIR, "corpus.jsonl"), "utf8");
  records = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));

  publicIndices = [];
  subjectIndex = new Map();
  senderIndex = new Map();
  recipientIndex = new Map();
  const addTo = (index, name, i) => {
    for (const form of personForms(name)) {
      let bucket = index.get(form);
      if (!bucket) index.set(form, (bucket = []));
      bucket.push(i);
    }
  };
  for (let i = 0; i < records.length; i++) {
    if (records[i].sichtbar === "intern") continue;
    publicIndices.push(i);
    // Display labels plus the editors' synonym ring (Latin / early-modern
    // variant labels carried in subjectVariants) — a question phrased in a
    // period form still reaches the letters tagged with the modern label.
    const labels = [...(records[i].keywordSubjects || []), ...(records[i].subjectVariants || [])];
    for (const subject of labels) {
      for (const form of subjectForms(subject)) {
        let bucket = subjectIndex.get(form);
        if (!bucket) subjectIndex.set(form, (bucket = []));
        bucket.push(i);
      }
    }
    for (const name of records[i].senders || []) addTo(senderIndex, name, i);
    for (const name of records[i].recipients || []) addTo(recipientIndex, name, i);
    if (records[i].dateIso) {
      const year = records[i].dateIso.slice(0, 4);
      let bucket = yearIndex.get(year);
      if (!bucket) yearIndex.set(year, (bucket = []));
      bucket.push(i);
    }
    briefIdIndex.set(String(records[i].id), i);
    if (!records[i].regestSynthetic) indexRegestWords(i, records[i].regest);
    indexRegestWords(i, records[i].erlaeuterung);
  }

  const meta = JSON.parse(await readFile(path.join(DATA_DIR, "embeddings.meta.json"), "utf8"));
  dim = meta.dim;
  const buf = await readFile(path.join(DATA_DIR, "embeddings.bin"));
  vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

  if (meta.count !== records.length) {
    console.warn(
      `WARNING: embeddings.meta.json count (${meta.count}) != corpus.jsonl length (${records.length}). ` +
        `Re-run "npm run build:index" after regenerating the corpus.`
    );
  }
  console.log(
    `Loaded ${records.length} letters (${publicIndices.length} retrievable, ` +
      `${records.length - publicIndices.length} internal and excluded), ` +
      `${subjectIndex.size} keyword subjects, ${dim}-dim embeddings (model: ${meta.model}).`
  );
}

// Loads whatever part of the chunk index exists. A build in progress is
// usable up to meta.count (vectors are appended in chunks.jsonl order), so
// the server never has to wait for the full 15-minute embedding run.
async function loadChunkIndex() {
  const chunksFile = path.join(DATA_DIR, "chunks.jsonl");
  const metaFile = path.join(DATA_DIR, "chunk_embeddings.meta.json");
  const vecFile = path.join(DATA_DIR, "chunk_embeddings.bin");
  if (!existsSync(chunksFile) || !existsSync(metaFile) || !existsSync(vecFile)) {
    console.log("Chunk index not built (npm run build:chunks) — transcription passages not searchable.");
    return;
  }
  const meta = JSON.parse(await readFile(metaFile, "utf8"));
  const all = (await readFile(chunksFile, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const buf = await readFile(vecFile);
  const available = Math.min(meta.count, all.length, Math.floor(buf.byteLength / (meta.dim * 4)));
  chunkDim = meta.dim;
  chunks = all.slice(0, available);
  chunkVectors = new Float32Array(buf.buffer, buf.byteOffset, available * chunkDim);
  chunkNorms = new Float32Array(available);
  for (let i = 0; i < available; i++) {
    let s = 0;
    const base = i * chunkDim;
    for (let d = 0; d < chunkDim; d++) s += chunkVectors[base + d] * chunkVectors[base + d];
    chunkNorms[i] = Math.sqrt(s);
  }
  console.log(
    `Loaded chunk index: ${available}/${all.length} chunks embedded` +
      (available < all.length ? " (build in progress — partial)" : "") + "."
  );
}

async function probeRerank() {
  try {
    const res = await fetch(`${RERANK_URL}/health`, { signal: AbortSignal.timeout(2000) });
    rerankEnabled = res.ok;
  } catch {
    rerankEnabled = false;
  }
  console.log(rerankEnabled ? `Rerank sidecar reachable at ${RERANK_URL}.` : "Rerank sidecar not running — skipping rerank.");
}

async function embedQuery(text) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.embeddings[0];
}

// Scores exactly the candidate records handed in and returns them ranked by
// cosine similarity, best first. Candidates always come from publicIndices.
function rankByCosine(queryVec, candidateIndices) {
  let qNorm = 0;
  for (let d = 0; d < dim; d++) qNorm += queryVec[d] * queryVec[d];
  qNorm = Math.sqrt(qNorm);

  const hits = candidateIndices.map((i) => {
    const base = i * dim;
    let dot = 0;
    let vNorm = 0;
    for (let d = 0; d < dim; d++) {
      const v = vectors[base + d];
      dot += v * queryVec[d];
      vNorm += v * v;
    }
    const score = vNorm > 0 && qNorm > 0 ? dot / (Math.sqrt(vNorm) * qNorm) : 0;
    return { index: i, record: records[i], score };
  });

  hits.sort((a, b) => b.score - a.score);
  return hits;
}

// Best-matching transcription/commentary passage per letter among the top
// chunks. Returns Map<record index, {score, text, kind}>.
function rankChunks(queryVec) {
  const best = new Map();
  if (!chunkVectors || !chunks.length) return best;
  let qNorm = 0;
  for (let d = 0; d < chunkDim; d++) qNorm += queryVec[d] * queryVec[d];
  qNorm = Math.sqrt(qNorm);
  const scored = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    const base = i * chunkDim;
    let dot = 0;
    for (let d = 0; d < chunkDim; d++) dot += chunkVectors[base + d] * queryVec[d];
    scored[i] = { i, score: chunkNorms[i] > 0 && qNorm > 0 ? dot / (chunkNorms[i] * qNorm) : 0 };
  }
  scored.sort((a, b) => b.score - a.score);
  for (const { i, score } of scored.slice(0, CHUNK_TOP_K)) {
    const c = chunks[i];
    const idx = briefIdIndex.get(String(c.letterId));
    if (idx === undefined) continue; // not a public letter
    if (!best.has(idx) || best.get(idx).score < score) best.set(idx, { score, text: c.text, kind: c.kind });
  }
  return best;
}

// Cross-encoder pass over the merged hits (see RERANK_* above). Embedding-
// only extras below RERANK_MIN are dropped and the rest re-ordered by rerank
// score; keyword-backed hits keep their specificity order and are never
// dropped. Any failure of the sidecar degrades to "no rerank", never to an
// error.
async function applyRerank(query, hits) {
  if (!rerankEnabled || !hits.length) return { hits, reranked: false, dropped: 0 };
  // Only the embedding-only extras are scored: keyword-backed hits are never
  // dropped or reordered, so reranking them (up to 80 docs on a 396-source
  // year question) cost 5–10 s per query for nothing.
  const keywordBacked = hits.filter((h) => h.specificity > 0 || !h.reasons?.[0]?.startsWith("inhaltlich"));
  const extras = hits.filter((h) => !keywordBacked.includes(h)).slice(0, RERANK_MAX_DOCS);
  if (!extras.length) return { hits, reranked: true, dropped: 0 };
  const docs = extras.map((h) => ({
    id: String(h.record.id),
    text: [h.record.long, h.record.regest, h.chunkText].filter(Boolean).join("\n").slice(0, 1500),
  }));
  let scores;
  try {
    const res = await fetch(`${RERANK_URL}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, docs }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`rerank ${res.status}`);
    scores = new Map((await res.json()).scores.map((s) => [s.id, s.score]));
  } catch (err) {
    console.warn("Rerank failed, continuing without:", err.message);
    return { hits, reranked: false, dropped: 0 };
  }
  for (const h of extras) h.rerank = scores.get(String(h.record.id));
  const kept = extras.filter((h) => h.rerank === undefined || h.rerank >= RERANK_MIN);
  kept.sort((a, b) => (b.rerank ?? 0) - (a.rerank ?? 0));
  return { hits: [...keywordBacked, ...kept], reranked: true, dropped: extras.length - kept.length };
}

// Keyword pre-filter: a subject counts as a match when it appears inside the
// question, or the question appears inside it (both normalized). Matching in
// both directions catches "Briefe zum Augsburger Reichstag?" as well as a bare
// "Reichstag" query. Returns public record indices plus the subjects that hit.
function matchSubjects(query) {
  const q = normalize(query);
  if (!q) return { indices: [], subjects: [], droppedSubjects: [] };

  // Pad both sides so a subject only matches on whole words: without this,
  // the subject "Hand" matches inside "handeln" and drags in unrelated letters.
  const padded = ` ${q} `;

  const paddedStem = ` ${stemPhrase(query)} `;
  const candidates = [];
  for (const [form, bucket] of subjectIndex) {
    if (
      padded.includes(` ${form} `) ||
      paddedStem.includes(` ${form} `) ||
      (q.length >= MIN_SUBJECT_LEN && ` ${form} `.includes(padded))
    ) {
      candidates.push({ form, bucket });
    }
  }

  // Most-specific-wins: when "heidelberger katechismus" matched, the also-
  // matched "katechismus" (and the unavoidable "briefe" in a German question)
  // adds only its genus bucket — hundreds of unrelated letters. A matched
  // form contained word-for-word in a longer matched form is dropped; what
  // survives is then size-capped (see MAX_SUBJECT_BUCKET).
  const subjects = [];
  const droppedSubjects = [];
  // record index -> number of distinct matched forms it carries. A letter
  // matching both "heidelberger katechismus" and "frage 60" is a more
  // specific answer than one matching only the base subject.
  const matchCount = new Map();
  for (const c of candidates) {
    const covered = candidates.some(
      (o) => o.form !== c.form && ` ${o.form} `.includes(` ${c.form} `)
    );
    if (covered) {
      droppedSubjects.push(`${c.form} (covered by more specific match)`);
      continue;
    }
    const size = new Set(c.bucket).size;
    if (size > MAX_SUBJECT_BUCKET) {
      droppedSubjects.push(`${c.form} (${size} letters, generic)`);
      continue;
    }
    subjects.push(c.form);
    for (const i of new Set(c.bucket)) matchCount.set(i, (matchCount.get(i) || 0) + 1);
  }
  return { indices: [...matchCount.keys()], subjects, droppedSubjects, matchCount };
}

// Matches one side (sender or recipient) of the person index against the
// question, with the same most-specific-wins suppression as subjects.
function matchPersonSide(index, padded) {
  const candidates = [];
  for (const [form, bucket] of index) {
    if (padded.includes(` ${form} `)) candidates.push({ form, bucket });
  }
  return candidates.filter(
    (c) => !candidates.some((o) => o.form !== c.form && ` ${o.form} `.includes(` ${c.form} `))
  );
}

// Person retrieval. When the question names people on *both* sides
// ("Welche Briefe schrieb X an Y?"), the correct letters are exactly the
// intersection of X-as-sender and Y-as-recipient — small and precise, so it
// is taken uncapped (both directions of the correspondence match, since a
// name in the question hits both indexes). With only one side named, each
// matched name is treated like a subject: genus-sized buckets are dropped,
// and bare single-word forms ("beste" could be a surname) are ignored —
// too ambiguous without a second name to intersect with.
function matchPersons(query) {
  const q = normalize(query);
  if (!q) return { indices: [], persons: [] };
  const padded = ` ${q} `;

  const senders = matchPersonSide(senderIndex, padded);
  const recipients = matchPersonSide(recipientIndex, padded);
  const union = (kept) => {
    const s = new Set();
    for (const c of kept) for (const i of c.bucket) s.add(i);
    return s;
  };

  if (senders.length && recipients.length) {
    const s = union(senders);
    const r = union(recipients);
    const indices = [...s].filter((i) => r.has(i));
    const persons = [...new Set([...senders, ...recipients].map((c) => c.form))];
    // exact: both correspondents named — the answer is a closed set.
    return { indices, persons, exact: indices.length > 0 };
  }

  const indices = new Set();
  const persons = [];
  for (const c of [...senders, ...recipients]) {
    if (!c.form.includes(" ")) continue;
    if (new Set(c.bucket).size > MAX_SUBJECT_BUCKET) continue;
    persons.push(c.form);
    for (const i of c.bucket) indices.add(i);
  }
  return { indices: [...indices], persons, exact: false };
}

// Regest text path. Content terms = question words minus scaffolding and
// stopwords, stemmed. All terms must co-occur in a letter's regest (AND); if
// that yields nothing and there were several terms, fall back to any term
// (OR). Buckets larger than MAX_SUBJECT_BUCKET are genus words and are
// dropped, exactly like generic subjects.
function matchRegest(query) {
  const terms = [
    ...new Set(
      normalize(query)
        .split(" ")
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && /\p{L}/u.test(w))
        .map(stemWord)
    ),
  ];
  if (!terms.length) return { indices: [], terms: [], droppedTerms: [] };
  // German compounds hide the head word: "Hexenprozess", "Traumgesicht",
  // "Gichtanfall". A term also matches index keys it is a prefix of (bounded
  // so "traum" does not reach absurd lengths).
  const bucketFor = (t) => {
    const out = new Set(regestIndex.get(t) || []);
    if (t.length >= 4) {
      for (const [key, bucket] of regestIndex) {
        if (key !== t && key.length <= t.length + 12 && key.startsWith(t)) for (const i of bucket) out.add(i);
      }
    }
    return out;
  };
  const buckets = terms.map((t) => ({ t, bucket: bucketFor(t) }));
  const usable = buckets.filter((b) => b.bucket.size > 0);
  if (!usable.length) return { indices: [], terms: [], droppedTerms: [] };

  // AND only. An OR fallback was tried and turned leftover adjectives into
  // hits ("beste" from the pizza question matched 9 regests). If a term is
  // absent from every regest the question simply has no regest-path answer.
  if (usable.length < terms.length) {
    return { indices: [], terms: [], droppedTerms: terms.filter((t) => !usable.some((b) => b.t === t)).map((t) => `${t} (not in any regest)`) };
  }
  const droppedTerms = [];
  let result = [...usable[0].bucket].filter((i) => usable.every((b) => b.bucket.has(i)));
  // Several terms must form a phrase, in order and adjacent (on stems):
  // bag-of-words AND turned "Heidelberger Katechismus" into 14 letters that
  // merely mention Heidelberg and some other catechism.
  if (usable.length > 1) {
    const phrase = ` ${usable.map((b) => b.t).join(" ")} `;
    result = result.filter((i) => (regestStems[i] || "").includes(phrase));
  }
  if (result.length > MAX_SUBJECT_BUCKET) {
    droppedTerms.push(`${usable.map((b) => b.t).join("+")} (${result.length} letters, generic)`);
    result = [];
  }
  return { indices: result, terms: usable.map((b) => b.t), droppedTerms };
}

// Deterministic year filter. Only fires on explicitly date-shaped phrasing
// ("aus dem Jahr 1563", "datiert 1563") — a bare year in a question usually
// qualifies a subject or an edition, not a date filter.
function matchYears(query) {
  if (!/\bjahr\w*\b|\bdatiert\b/i.test(query)) return { indices: [], years: [] };
  const years = [...new Set([...query.matchAll(/\b(1[4-6]\d\d)\b/g)].map((m) => m[1]))];
  const indices = new Set();
  const matched = [];
  for (const y of years) {
    const bucket = yearIndex.get(y);
    if (!bucket) continue;
    matched.push(y);
    for (const i of bucket) indices.add(i);
  }
  return { indices: [...indices], years: matched };
}

// Direct letter lookup: "Fasse den Brief 18494 zusammen." names its target
// exactly, so retrieval is a dictionary lookup, not a search. When the
// question references letter ids and NONE resolve to a public letter, the
// whole retrieval short-circuits to empty — answering a question about a
// nonexistent letter with 30 similar-sounding ones invites the model to
// pretend (the Brief-99999 failure).
function matchBriefIds(query) {
  const refs = [...query.matchAll(/\bbrief\w*\s+(?:nr\.?\s*)?(\d{3,6})\b/gi)].map((m) => m[1]);
  if (!refs.length) return { indices: [], refs: [], unresolved: false };
  const indices = [];
  for (const id of refs) {
    const i = briefIdIndex.get(id);
    if (i !== undefined) indices.push(i);
  }
  return { indices, refs, unresolved: indices.length === 0 };
}

// Hybrid retrieval over public records only. There is no either/or: both
// retrievers always run. Every letter carrying a matched keyword subject
// (uncapped) is unioned with the embedding top-K, deduplicated by letter id,
// and the merged set is ranked by cosine similarity, then cut at MIN_SCORE.
//
// Running both always matters because plenty of ordinary German words are
// themselves curated subjects — "Briefe", "Jahr", "Nachrichten" — so a
// keyword-only path would let one of those replace a good embedding search
// with a handful of unrelated letters.
// Archive-level counting/statistics is not a retrieval question: no set of
// retrieved letters can answer "how many letters are there". Left to the
// model it was flaky — refusing on one run, counting the 40 letters that
// happen to mention "Archiv" on the next. Deterministic short-circuit.
const AGGREGATE_RE = /\b(wie ?viele|wieviel|anzahl|insgesamt|die meisten|am häufigsten|durchschnittlich)\b/i;
const AGGREGATE_ANSWER =
  "Diese Frage betrifft das gesamte Archiv (Zählung oder Statistik) und kann aus einzelnen Briefen nicht beantwortet werden. Für Zahlen über den Gesamtbestand nutzen Sie bitte die Suche und Filter der ThBw-Datenbank.";

function retrieve(queryVec, message) {
  if (AGGREGATE_RE.test(message)) {
    return {
      hits: [],
      aggregate: true,
      subjects: [],
      droppedSubjects: [],
      persons: [],
      years: [],
      briefIdRefs: [],
      regestTerms: [],
      droppedRegestTerms: [],
      keywordMatches: 0,
      chunkMatches: 0,
      belowFloor: 0,
    };
  }
  const briefIds = matchBriefIds(message);
  if (briefIds.unresolved) {
    // The question asked for specific letters that don't (publicly) exist —
    // nothing else can be the right answer.
    return {
      hits: [],
      subjects: [],
      droppedSubjects: [],
      persons: [],
      years: [],
      briefIdRefs: briefIds.refs,
      keywordMatches: 0,
      chunkMatches: 0,
      belowFloor: 0,
    };
  }

  const { indices, subjects, droppedSubjects, matchCount } = matchSubjects(message);
  const { indices: personIndices, persons, exact: exactCorrespondence } = matchPersons(message);
  const { indices: yearIndices, years } = matchYears(message);
  const ranked = rankByCosine(queryVec, publicIndices);

  const keyword = new Set([...indices, ...personIndices, ...yearIndices, ...briefIds.indices]);
  // "Letters from X to Y", "letters of 1563", "Brief 18494" are closed-form
  // database questions — the structured path IS the answer. Fuzzy extras
  // (embedding neighbours, transcription passages that merely mention the
  // names) can only add noise there: with them on, person questions lost
  // 10–20 points of precision to letters whose transcription named X or Y.
  // Subject questions keep the fuzzy paths — an untagged but relevant
  // letter is exactly what they are for.
  const structured = exactCorrespondence || yearIndices.length > 0 || briefIds.indices.length > 0;
  // Regest text terms: a deterministic content path, off for closed-form
  // questions (names in a regest are not the correspondence asked for).
  const regest = structured ? { indices: [], terms: [], droppedTerms: [] } : matchRegest(message);
  for (const i of regest.indices) keyword.add(i);
  // Transcription/commentary passages: the top chunks, mapped to letters.
  // These join the embedding path (they are similarity evidence, not
  // curated matches) and carry the matching passage for the context.
  const chunkBest = rankChunks(queryVec);
  const chunkIndices = structured
    ? []
    : [...chunkBest.entries()]
        .filter(([, c]) => c.score >= CHUNK_MIN_SCORE)
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, CHUNK_EXTRA_K)
        .map(([i]) => i);
  const chunkSet = new Set(chunkIndices);
  // Why each letter is in the result — shown to the model, because a letter
  // buried under 42 tags was denied to carry the asked-for tag at all.
  const reasonByIndex = new Map();
  const addReason = (list, reason) => {
    for (const i of list) {
      if (!reasonByIndex.has(i)) reasonByIndex.set(i, []);
      reasonByIndex.get(i).push(reason);
    }
  };
  addReason(indices, "Schlagwort passt zur Frage");
  addReason(personIndices, "Absender/Empfänger passt zur Frage");
  addReason(yearIndices, `Jahr ${years.join("/")} passt zur Frage`);
  addReason(briefIds.indices, "Brief-Nummer in der Frage genannt");
  if (regest.terms.length) addReason(regest.indices, `Regest nennt: ${regest.terms.join(", ")}`);
  // With keyword evidence in hand the embedding path is a supplement, not
  // the main course — cap how many embedding-only extras it may add.
  const embedK = structured ? 0 : keyword.size ? EMBED_EXTRA_K : TOP_K;
  const topK = new Set(ranked.slice(0, embedK).map((h) => h.index));

  // `ranked` is already sorted, so walking it preserves cosine order and keeps
  // the best-scoring copy of any letter that both retrievers returned.
  const seenIds = new Set();
  const hits = [];
  let belowFloor = 0;
  for (const hit of ranked) {
    if (!keyword.has(hit.index) && !topK.has(hit.index) && !chunkSet.has(hit.index)) continue;
    if (seenIds.has(hit.record.id)) continue;
    seenIds.add(hit.record.id);
    const chunk = chunkBest.get(hit.index);
    // The floor gates only the fuzzy path: a keyword hit is backed by a
    // curated tag and stays in regardless of its cosine score. A letter
    // reached through a passage is judged on the passage score.
    if (!keyword.has(hit.index) && hit.score < MIN_SCORE && !chunkSet.has(hit.index)) {
      belowFloor++;
      continue;
    }
    if (chunk) {
      hit.chunkText = chunk.text;
      hit.chunkKind = chunk.kind;
      hit.chunkScore = chunk.score;
      if (chunk.score > hit.score) hit.score = chunk.score;
    }
    hit.reasons =
      reasonByIndex.get(hit.index) ||
      (chunkSet.has(hit.index)
        ? [`inhaltlich ähnliche Passage in ${chunk.kind === "volltext" ? "der Transkription" : "der Erläuterung"} (Embedding)`]
        : ["inhaltlich ähnlich (Embedding)"]);
    // Curated tag matches outrank regest-text matches: with CONTEXT_MAX
    // letters in the prompt, the editors' judgement goes first.
    hit.specificity =
      2 * (matchCount.get(hit.index) || 0) +
      (personIndices.includes(hit.index) ? 2 : 0) +
      (regest.indices.includes(hit.index) ? 1 : 0);
    hits.push(hit);
  }

  // Context order = evidence order. Letters backed by curated matches come
  // before embedding-only extras, the most specifically matched first;
  // cosine only breaks ties. Letter 25851 — the one letter tagged
  // "…, Frage 60" — sat at position 55 of 57 by cosine and was overlooked
  // by the model in favour of a blanket "none of these mention Frage 60".
  hits.sort((a, b) => {
    const ka = keyword.has(a.index) ? 1 : 0;
    const kb = keyword.has(b.index) ? 1 : 0;
    return kb - ka || b.specificity - a.specificity || b.score - a.score;
  });

  return {
    hits,
    subjects,
    matchedForms: new Set(subjects),
    droppedSubjects,
    persons,
    years,
    briefIdRefs: briefIds.refs,
    regestTerms: regest.terms,
    droppedRegestTerms: regest.droppedTerms,
    keywordMatches: keyword.size,
    chunkMatches: chunkIndices.length,
    belowFloor,
  };
}

const MAX_TAGS_IN_CONTEXT = 12;

function buildContext(hits, matchedForms = new Set()) {
  return hits
    .map(({ record: r, reasons }, i) => {
      const n = i + 1;
      const who = [
        r.senders.length ? `Von: ${r.senders.join(", ")}` : null,
        r.recipients.length ? `An: ${r.recipients.join(", ")}` : null,
        r.dateDisplay ? `Datum: ${r.dateDisplay}` : null,
        r.placesSent.length ? `Absendeort: ${r.placesSent.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      const parts = [`[${n}] Brief ${r.id} (${r.url})`, who];
      if (reasons?.length) parts.push(`Treffer: ${reasons.join("; ")}`);
      // The editors' subject tags are why most letters are in the context at
      // all — and a tag is assigned on the editors' reading of the manuscript,
      // so the regest often never spells the subject out. The tags that
      // matched the question go first and separately: buried among 42 tags,
      // "Falsche Apostel" on letter 33960 and "Heidelberger Katechismus,
      // Frage 60" on 25851 were both overlooked and denied by the model.
      const tags = r.keywordSubjects || [];
      const variants = r.subjectVariants || [];
      const hitTags = [
        ...tags.filter((t) => subjectForms(t).some((f) => matchedForms.has(f))),
        ...variants.filter((v) => subjectForms(v).some((f) => matchedForms.has(f))),
      ];
      const otherTags = tags.filter((t) => !hitTags.includes(t));
      if (hitTags.length) parts.push(`Treffer-Schlagwort (Grund für die Auswahl): ${hitTags.join("; ")}`);
      if (otherTags.length) {
        const shown = otherTags.slice(0, MAX_TAGS_IN_CONTEXT).join("; ");
        const more =
          otherTags.length > MAX_TAGS_IN_CONTEXT ? ` (+${otherTags.length - MAX_TAGS_IN_CONTEXT} weitere)` : "";
        parts.push(`${hitTags.length ? "Weitere Schlagworte" : "Schlagworte (Editoren)"}: ${shown}${more}`);
      }
      if (r.incipit) parts.push(`Incipit: "${r.incipit}"`);
      // The synthetic flag finally reaches the model: prompt rule 6 asks it
      // to mark auto-generated summaries, which it could never do while the
      // context hid which regests were synthesised (handoff §6.5).
      parts.push(
        r.regestSynthetic
          ? `${r.regest}\n(Automatisch aus Metadaten generierte Zusammenfassung — kein editorisches Regest vorhanden.)`
          : r.regest
      );
      // Primary-source evidence for the top hits: the verbatim transcription
      // excerpt (early-modern German/Latin). Limited to the first few letters
      // so 60 excerpts can't blow up the prompt.
      // The passage that matched the question beats the first 1,500 chars.
      if (hits[i].chunkText) {
        const label = hits[i].chunkKind === "volltext" ? "Transkription (Treffer-Passage)" : "Editorische Erläuterung (Treffer-Passage)";
        parts.push(`${label}: ${hits[i].chunkText}`);
      } else if (r.volltext && i < VOLLTEXT_IN_CONTEXT) {
        parts.push(`Transkription (Auszug): ${r.volltext}`);
      }
      if (r.erlaeuterung && i < VOLLTEXT_IN_CONTEXT) {
        parts.push(`Editorische Erläuterung: ${r.erlaeuterung}`);
      }
      return parts.filter(Boolean).join("\n");
    })
    .join("\n\n");
}

const SYSTEM_PROMPT = `Du bist ein Assistent für das Briefarchiv der Theologenbriefwechsel der Kurpfalz (1550–1620). Antworte auf Deutsch, Englisch oder Französisch — in der Sprache, in der die Frage gestellt wurde.

STRIKTE REGELN:
1. Antworte NUR auf Basis der unten bereitgestellten Briefe. Erfinde NICHTS.
2. Jede Aussage MUSS mit einer Brief-ID belegt werden, z.B. [Brief 18495]. Nenne AUSSCHLIESSLICH Brief-IDs, die in den Quellenausschnitten vorkommen — erwähne keine anderen Nummern, auch nicht mit Einschränkung.
3. Nur wenn KEIN bereitgestellter Brief ein zur Frage passendes Treffer-Schlagwort trägt UND auch kein Regest die Frage beantwortet, sage klar: "Die vorliegenden Briefe enthalten dazu keine Informationen." Trägt auch nur ein Brief ein passendes Treffer-Schlagwort, dann IST dieser Brief die Antwort: Beginne mit ihm, nicht mit einer Verneinung. Du darfst anmerken, dass das Regest den Begriff nicht wörtlich nennt.
4. Unterscheide zwischen dem, was ein Brief explizit sagt (Regest), und Briefen, die nur Metadaten haben — kennzeichne letztere als "(nur Metadaten, kein Regest vorhanden)".
5. Fasse dich kurz und präzise. Keine Spekulationen, keine Hintergrundinformationen aus deinem eigenen Wissen.
5a. Dein Einleitungssatz darf der Liste nicht widersprechen: Wenn du Briefe aufführst, die etwas erwähnen, beginne nicht mit "Keiner der Briefe erwähnt …". Einschränkungen und Zweifel gehören HINTER die Liste, nicht davor.
6. Wenn ein Brief als automatisch generierte Zusammenfassung markiert ist, weise darauf hin.
7. Fragen der Form "Welche Briefe ..." (erwähnen X / schrieb X an Y / stammen aus Jahr Z) sind Aufzählungsfragen: Die bereitgestellten Briefe SIND das Suchergebnis aus dem gesamten Archiv. Liste sie VOLLSTÄNDIG auf (jeden passenden Brief, keine Auswahl, keine Kürzung — bei vielen Treffern eine kompakte Zeile pro Brief: Nummer, Absender, Empfänger, Datum, Kurzinhalt) — auch wenn zu einem Brief nur Metadaten vorliegen. Verweigere solche Fragen NICHT. Bei "X an Y" achte auf die Richtung: Absender X, Empfänger Y (siehe "Von:"/"An:"); Briefe der Gegenrichtung ggf. getrennt als solche kennzeichnen.
7b. Die Zeile "Treffer" nennt, warum ein Brief im Suchergebnis steht; "Treffer-Schlagwort" ist das Schlagwort, das zur Frage passt. Ein Brief mit Treffer-Schlagwort behandelt das gefragte Thema laut Editoren — führe ihn auf, auch wenn das Regest den Begriff nicht wörtlich nennt. Nennt die Frage einen speziellen Aspekt (z.B. "Frage 60"), dann prüfe JEDEN Brief auf ein Treffer-Schlagwort mit genau diesem Aspekt und führe diese Briefe zuerst und ausdrücklich auf — sie stehen in der Liste vorne.
7a. Nur bei echter Zahlen-Statistik über das GESAMTE Archiv (z.B. "Wie viele Briefe gibt es insgesamt?", "Wer schrieb die meisten Briefe?") antworte: "Diese Frage betrifft das gesamte Archiv und kann aus den bereitgestellten Briefen nicht beantwortet werden."
8. Wenn die Frage eine umfassende Zusammenfassung des ganzen Archivs oder eines ganzen Themengebiets verlangt, erkläre, dass du nur die bereitgestellten Briefe interpretieren kannst.
9. Wenn nach einem Brief gefragt wird, der nicht in den bereitgestellten Quellen enthalten ist, sage das klar — tu niemals so, als hättest du ihn gelesen.
10. Die Zeile "Schlagworte (Editoren)" enthält die von den Editoren der Edition vergebenen Sachschlagworte. Ein Brief, dessen Schlagwort zum gefragten Thema passt, BEHANDELT dieses Thema laut Editoren — auch wenn das Regest den Begriff nicht wörtlich nennt. Führe solche Briefe auf und stütze dich für den Inhalt auf das Regest.`;

function extractCitedIds(answer) {
  return [...new Set([...answer.matchAll(/Brief\s+(?:Nr\.?\s*)?(\d{3,6})/gi)].map((m) => m[1]))];
}

// Prompt rules alone do not reliably stop the model from citing letter
// numbers that are not in the sources (observed: digit-mutations of real
// ids on metadata-only questions). This is a deterministic guard: validate
// the citations, and on violation retry once with an explicit correction.
// A scholarly answer citing a nonexistent source is worse than no answer.
// The model's own refusal phrasing (rule 3). Checked on the opening of the
// answer only — a caveat later in the text is legitimate.
function opensWithRefusal(answer) {
  // Also catches "Keine der Quellen erwähnt Genf …" openings that then go on
  // to list a letter mentioning Genf — the contradiction the reviewer flagged.
  return /^\W*(die vorliegenden briefe enthalten dazu keine informationen|kein(e|er)?\s+(der|des)?\s*(bereitgestellten|vorliegenden|quellen|brief))/i.test(
    answer.trim().slice(0, 160)
  );
}

// Retry instructions must not leak the retry into the answer: the model
// otherwise opens with "Entschuldigung für den Fehler …" and the end user,
// who never saw a first attempt, is left wondering what went wrong.
const RETRY_STYLE =
  " Antworte direkt und vollständig, ohne Bezug auf deine vorherige Antwort — keine Entschuldigung, keine Erwähnung einer Korrektur.";

// Second deterministic guard, same shape as the citation guard: an answer
// that opens with "no information" although letters backed by a curated
// match (subject tag / correspondent / year / id) were in the context is a
// false refusal — observed on letter 25851 ("…, Frage 60") three prompt
// revisions in a row. Retry once with the evidence named explicitly.
async function generateAnswer(question, context, allowedIds, evidenceIds = []) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Quellenausschnitte:\n\n${context}\n\nFrage: ${question}`,
    },
  ];
  const complete = async (msgs, attempt = 0) => {
    try {
      const completion = await deepseek.chat.completions.create({
        model: CHAT_MODEL,
        temperature: 0.3,
        // Enumerations over 40+ letters were being cut off at ~25 entries.
        max_tokens: 8192,
        messages: msgs,
      });
      return completion.choices[0]?.message?.content ?? "";
    } catch (err) {
      // One backoff retry on transport-level failures (DNS blip, reset,
      // 5xx) — the sort of error that resolves itself in seconds. Auth and
      // 4xx errors are not retried.
      const transient = !err?.status || err.status >= 500 || err.status === 429;
      if (attempt < 1 && transient) {
        await new Promise((r) => setTimeout(r, 2000));
        return complete(msgs, attempt + 1);
      }
      throw err;
    }
  };

  let answer = await complete(messages);
  let citationRetry = false;
  let refusalRetry = false;

  const invented = extractCitedIds(answer).filter((id) => !allowedIds.has(id));
  if (invented.length) {
    citationRetry = true;
    answer = await complete([
      ...messages,
      { role: "assistant", content: answer },
      {
        role: "user",
        content:
          `Deine Antwort nennt Brief-Nummern, die NICHT in den Quellenausschnitten vorkommen: ` +
          `${invented.join(", ")}. Formuliere die Antwort neu und nenne ausschließlich ` +
          `Brief-Nummern, die in den Quellenausschnitten stehen. Erwähne keine anderen Nummern.` +
          RETRY_STYLE,
      },
    ]);
  }

  if (evidenceIds.length && opensWithRefusal(answer)) {
    refusalRetry = true;
    answer = await complete([
      ...messages,
      { role: "assistant", content: answer },
      {
        role: "user",
        content:
          `Deine Antwort beginnt mit einer Verneinung, obwohl folgende Briefe laut Editoren zur Frage passen ` +
          `(siehe ihre Zeile "Treffer" / "Treffer-Schlagwort"): ${evidenceIds.slice(0, 20).join(", ")}` +
          `${evidenceIds.length > 20 ? " u. a." : ""}. Formuliere die Antwort neu: Beginne mit diesen Briefen als ` +
          `Antwort (Nummer, Absender, Empfänger, Datum, Inhalt laut Regest). Verwende NICHT die Formulierung ` +
          `"keine Informationen". Du darfst anmerken, wenn ein Regest den Begriff nicht wörtlich nennt.` +
          RETRY_STYLE,
      },
    ]);
  }
  return { answer, citationRetry, refusalRetry };
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string in request body." });
    }

    const queryVec = await embedQuery(message);
    const retrieved = retrieve(queryVec, message);
    const {
      subjects, matchedForms, droppedSubjects, persons, years, briefIdRefs,
      regestTerms, droppedRegestTerms, keywordMatches, chunkMatches, belowFloor,
    } = retrieved;
    const { hits, reranked, dropped: rerankDropped } = await applyRerank(message, retrieved.hits);

    // Nothing cleared the relevance floor: answering from an empty source list
    // would only invite invention, so say so instead of prompting the model.
    let answer = retrieved.aggregate
      ? AGGREGATE_ANSWER
      : "Zu dieser Frage findet sich im Archiv kein hinreichend relevanter Brief.";
    let citationRetry = false;
    let refusalRetry = false;
    if (hits.length) {
      // Every hit is cited back to the caller; only the prompt is trimmed.
      const allowedIds = new Set(hits.map((h) => String(h.record.id)));
      const inContext = hits.slice(0, CONTEXT_MAX);
      // Letters the curated indexes matched (not embedding-only extras).
      const evidenceIds = inContext.filter((h) => h.specificity > 0 || h.reasons?.some((r) => !r.startsWith("inhaltlich"))).map((h) => String(h.record.id));
      try {
        ({ answer, citationRetry, refusalRetry } = await generateAnswer(
          message,
          buildContext(inContext, matchedForms),
          allowedIds,
          evidenceIds
        ));
      } catch (err) {
        // Retrieval succeeded; only the cloud generation step failed. Say so
        // precisely — "Connection error." gave the user no way to tell
        // whether search, the model, or the network was at fault.
        const cause = err?.cause?.cause?.code || err?.cause?.code || err?.status || err?.message;
        console.error("DeepSeek generation failed:", cause);
        return res.status(503).json({
          error:
            `Die Suche hat ${hits.length} Briefe gefunden, aber der Antwortdienst (DeepSeek) ` +
            `ist derzeit nicht erreichbar (${cause}). Bitte Netzwerk/DNS prüfen und erneut versuchen.`,
          sources: [],
        });
      }
    }

    res.json({
      answer,
      retrieval: {
        matchedSubjects: subjects,
        droppedSubjects,
        matchedPersons: persons,
        matchedYears: years,
        briefIdRefs,
        regestTerms,
        droppedRegestTerms,
        keywordMatches,
        chunkMatches,
        reranked,
        rerankDropped,
        embeddingTopK: TOP_K,
        minScore: MIN_SCORE,
        belowFloor,
        matches: hits.length,
        inContext: Math.min(hits.length, CONTEXT_MAX),
        citationRetry,
        refusalRetry,
      },
      // inContext marks what the model actually saw (the prompt is trimmed
      // to CONTEXT_MAX) — the UI must not present the rest as evidence for
      // the answer. hasRegest now means what it says: a synthesised
      // metadata abstract is not a scholarly regest.
      sources: hits.map(({ record: r, score, reasons, chunkText, chunkKind, rerank }, i) => ({
        id: r.id,
        url: r.url,
        score: Number(score.toFixed(3)),
        rerank: rerank === undefined ? undefined : Number(rerank.toFixed(3)),
        reasons,
        passage: chunkText ? { kind: chunkKind, text: chunkText } : undefined,
        long: r.long,
        dateDisplay: r.dateDisplay,
        senders: r.senders,
        recipients: r.recipients,
        regest: r.regest,
        regestSynthetic: Boolean(r.regestSynthetic),
        cmif: r.cmif,
        sichtbar: r.sichtbar,
        hasRegest: !r.regestSynthetic,
        hasFullText: Boolean(r.hasFullText),
        inContext: i < CONTEXT_MAX,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Retrieval-only endpoint for the evaluation harness (test/). Runs the exact
// same pipeline as /api/chat but stops before generation, so eval runs are
// fast and deterministic — retrieval quality can be measured without the
// latency and nondeterminism of a chat-model call. Not used by the UI.
app.post("/api/retrieve", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string in request body." });
    }
    const queryVec = await embedQuery(message);
    const retrieved = retrieve(queryVec, message);
    const { subjects, droppedSubjects, persons, years, briefIdRefs, regestTerms, droppedRegestTerms, keywordMatches, chunkMatches, belowFloor } = retrieved;
    const { hits, reranked, dropped: rerankDropped } = await applyRerank(message, retrieved.hits);
    res.json({
      retrieval: {
        matchedSubjects: subjects,
        droppedSubjects,
        matchedPersons: persons,
        matchedYears: years,
        briefIdRefs,
        regestTerms,
        droppedRegestTerms,
        keywordMatches,
        chunkMatches,
        reranked,
        rerankDropped,
        embeddingTopK: TOP_K,
        minScore: MIN_SCORE,
        belowFloor,
        matches: hits.length,
        inContext: Math.min(hits.length, CONTEXT_MAX),
      },
      sources: hits.map(({ record: r, score, reasons, rerank, chunkKind }) => ({
        id: r.id,
        score: Number(score.toFixed(3)),
        rerank: rerank === undefined ? undefined : Number(rerank.toFixed(3)),
        reasons,
        passage: chunkKind,
        sichtbar: r.sichtbar,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// The example questions shown in the UI sidebar — the eval question set,
// grouped by the retrieval path that answers it. Read from the test
// fixtures so the sidebar follows the eval set automatically; the small
// curated list below covers the handwritten questions (defined in
// test/eval.js) and stays useful when fixtures are absent.
app.get("/api/questions", async (req, res) => {
  const groups = [
    {
      title: "Demo & Kontrolle",
      questions: [
        "Welche Briefe erwähnen den Heidelberger Katechismus?",
        "Welche Briefe betreffen Frage 60 des Heidelberger Katechismus?",
        "Welche Briefe schrieb Kaspar Olevian an Heinrich Bullinger?",
        "Welche Briefe stammen aus dem Jahr 1563?",
        "Fasse den Brief 18494 zusammen.",
        "Wer schickte Calvin die lateinische Übersetzung des Heidelberger Katechismus?",
        "Wie viele Briefe enthält das Archiv insgesamt?",
        "Fasse den Brief 99999 zusammen.",
        "Was ist das beste Rezept für Pizza?",
      ],
    },
  ];
  try {
    const gen = JSON.parse(
      await readFile(path.join(__dirname, "..", "test", "fixtures", "generated_questions.json"), "utf8")
    );
    const byTemplate = { sache: [], person: [], inhalt: [] };
    for (const q of gen.questions) byTemplate[q.template]?.push(q.text);
    if (byTemplate.sache.length) groups.push({ title: "Themen (Schlagworte)", questions: byTemplate.sache });
    if (byTemplate.person.length) groups.push({ title: "Personen (Absender → Empfänger)", questions: byTemplate.person });
    if (byTemplate.inhalt.length) groups.push({ title: "Inhalt (Regest-Text)", questions: byTemplate.inhalt });
  } catch {
    /* fixtures not built — curated group alone */
  }
  res.json({ groups });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    letters: records.length,
    retrievable: publicIndices.length,
    subjects: subjectIndex.size,
    chunks: chunks.length,
    rerank: rerankEnabled,
    chatModel: CHAT_MODEL,
    embedModel: EMBED_MODEL,
  });
});

await loadIndex();
await loadChunkIndex();
await probeRerank();
app.listen(PORT, () => {
  console.log(`ThBw RAG chatbot running at http://localhost:${PORT}`);
});
