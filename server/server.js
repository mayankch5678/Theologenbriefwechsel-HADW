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

// Case- and punctuation-insensitive form used on both sides of the match.
function normalize(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

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
  return [...forms].filter((f) => f.length >= MIN_SUBJECT_LEN);
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

  const candidates = [];
  for (const [form, bucket] of subjectIndex) {
    if (padded.includes(` ${form} `) || (q.length >= MIN_SUBJECT_LEN && ` ${form} `.includes(padded))) {
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
  const matched = new Set();
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
    for (const i of c.bucket) matched.add(i);
  }
  return { indices: [...matched], subjects, droppedSubjects };
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
    return { indices, persons };
  }

  const indices = new Set();
  const persons = [];
  for (const c of [...senders, ...recipients]) {
    if (!c.form.includes(" ")) continue;
    if (new Set(c.bucket).size > MAX_SUBJECT_BUCKET) continue;
    persons.push(c.form);
    for (const i of c.bucket) indices.add(i);
  }
  return { indices: [...indices], persons };
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
function retrieve(queryVec, message) {
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
      belowFloor: 0,
    };
  }

  const { indices, subjects, droppedSubjects } = matchSubjects(message);
  const { indices: personIndices, persons } = matchPersons(message);
  const { indices: yearIndices, years } = matchYears(message);
  const ranked = rankByCosine(queryVec, publicIndices);

  const keyword = new Set([...indices, ...personIndices, ...yearIndices, ...briefIds.indices]);
  // With keyword evidence in hand the embedding path is a supplement, not
  // the main course — cap how many embedding-only extras it may add.
  const embedK = keyword.size ? EMBED_EXTRA_K : TOP_K;
  const topK = new Set(ranked.slice(0, embedK).map((h) => h.index));

  // `ranked` is already sorted, so walking it preserves cosine order and keeps
  // the best-scoring copy of any letter that both retrievers returned.
  const seenIds = new Set();
  const hits = [];
  let belowFloor = 0;
  for (const hit of ranked) {
    if (!keyword.has(hit.index) && !topK.has(hit.index)) continue;
    if (seenIds.has(hit.record.id)) continue;
    seenIds.add(hit.record.id);
    // The floor gates only the fuzzy path: a keyword hit is backed by a
    // curated tag and stays in regardless of its cosine score.
    if (!keyword.has(hit.index) && hit.score < MIN_SCORE) {
      belowFloor++;
      continue;
    }
    hits.push(hit);
  }

  return {
    hits,
    subjects,
    droppedSubjects,
    persons,
    years,
    briefIdRefs: briefIds.refs,
    keywordMatches: keyword.size,
    belowFloor,
  };
}

function buildContext(hits) {
  return hits
    .map(({ record: r }, i) => {
      const n = i + 1;
      const who = [
        r.senders.length ? `Von: ${r.senders.join(", ")}` : null,
        r.recipients.length ? `An: ${r.recipients.join(", ")}` : null,
        r.dateDisplay ? `Datum: ${r.dateDisplay}` : null,
        r.placesSent.length ? `Absendeort: ${r.placesSent.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      // The synthetic flag finally reaches the model: prompt rule 6 asks it
      // to mark auto-generated summaries, which it could never do while the
      // context hid which regests were synthesised (handoff §6.5).
      const parts = [`[${n}] Brief ${r.id} (${r.url})`, who];
      // The editors' subject tags are why most letters are in the context at
      // all — and a tag is assigned on the editors' reading of the manuscript,
      // so the regest often never spells the subject out. Without this line
      // the model saw 14 letters tagged "Unschuldsbeteuerung" and answered
      // that none of them mention it.
      if (r.keywordSubjects?.length) parts.push(`Schlagworte (Editoren): ${r.keywordSubjects.join("; ")}`);
      if (r.incipit) parts.push(`Incipit: "${r.incipit}"`);
      parts.push(
        r.regestSynthetic
          ? `${r.regest}\n(Automatisch aus Metadaten generierte Zusammenfassung — kein editorisches Regest vorhanden.)`
          : r.regest
      );
      // Primary-source evidence for the top hits: the verbatim transcription
      // excerpt (early-modern German/Latin). Limited to the first few letters
      // so 60 excerpts can't blow up the prompt.
      if (r.volltext && i < VOLLTEXT_IN_CONTEXT) {
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
3. Wenn die bereitgestellten Briefe eine Frage nicht beantworten können, sage klar: "Die vorliegenden Briefe enthalten dazu keine Informationen."
4. Unterscheide zwischen dem, was ein Brief explizit sagt (Regest), und Briefen, die nur Metadaten haben — kennzeichne letztere als "(nur Metadaten, kein Regest vorhanden)".
5. Fasse dich kurz und präzise. Keine Spekulationen, keine Hintergrundinformationen aus deinem eigenen Wissen.
6. Wenn ein Brief als automatisch generierte Zusammenfassung markiert ist, weise darauf hin.
7. Wenn die Frage Statistik über das GESAMTE Archiv betrifft (z.B. "Wie viele Briefe gibt es insgesamt?", "Wer schrieb die meisten Briefe?"), antworte: "Diese Frage betrifft das gesamte Archiv und kann aus den bereitgestellten Briefen nicht beantwortet werden."
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
async function generateAnswer(question, context, allowedIds) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Quellenausschnitte:\n\n${context}\n\nFrage: ${question}`,
    },
  ];
  const complete = async (msgs) => {
    const completion = await deepseek.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.3,
      messages: msgs,
    });
    return completion.choices[0]?.message?.content ?? "";
  };

  let answer = await complete(messages);
  const invented = extractCitedIds(answer).filter((id) => !allowedIds.has(id));
  if (!invented.length) return { answer, citationRetry: false };

  answer = await complete([
    ...messages,
    { role: "assistant", content: answer },
    {
      role: "user",
      content:
        `Deine Antwort nennt Brief-Nummern, die NICHT in den Quellenausschnitten vorkommen: ` +
        `${invented.join(", ")}. Formuliere die Antwort neu und nenne ausschließlich ` +
        `Brief-Nummern, die in den Quellenausschnitten stehen. Erwähne keine anderen Nummern.`,
    },
  ]);
  return { answer, citationRetry: true };
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
    const { hits, subjects, droppedSubjects, persons, years, briefIdRefs, keywordMatches, belowFloor } =
      retrieve(queryVec, message);

    // Nothing cleared the relevance floor: answering from an empty source list
    // would only invite invention, so say so instead of prompting the model.
    let answer = "Zu dieser Frage findet sich im Archiv kein hinreichend relevanter Brief.";
    let citationRetry = false;
    if (hits.length) {
      // Every hit is cited back to the caller; only the prompt is trimmed.
      const allowedIds = new Set(hits.map((h) => String(h.record.id)));
      try {
        ({ answer, citationRetry } = await generateAnswer(
          message,
          buildContext(hits.slice(0, CONTEXT_MAX)),
          allowedIds
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
        keywordMatches,
        embeddingTopK: TOP_K,
        minScore: MIN_SCORE,
        belowFloor,
        matches: hits.length,
        inContext: Math.min(hits.length, CONTEXT_MAX),
        citationRetry,
      },
      // inContext marks what the model actually saw (the prompt is trimmed
      // to CONTEXT_MAX) — the UI must not present the rest as evidence for
      // the answer. hasRegest now means what it says: a synthesised
      // metadata abstract is not a scholarly regest.
      sources: hits.map(({ record: r, score }, i) => ({
        id: r.id,
        url: r.url,
        score: Number(score.toFixed(3)),
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
    const { hits, subjects, droppedSubjects, persons, years, briefIdRefs, keywordMatches, belowFloor } =
      retrieve(queryVec, message);
    res.json({
      retrieval: {
        matchedSubjects: subjects,
        droppedSubjects,
        matchedPersons: persons,
        matchedYears: years,
        briefIdRefs,
        keywordMatches,
        embeddingTopK: TOP_K,
        minScore: MIN_SCORE,
        belowFloor,
        matches: hits.length,
        inContext: Math.min(hits.length, CONTEXT_MAX),
      },
      sources: hits.map(({ record: r, score }) => ({
        id: r.id,
        score: Number(score.toFixed(3)),
        sichtbar: r.sichtbar,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    letters: records.length,
    retrievable: publicIndices.length,
    subjects: subjectIndex.size,
    chatModel: CHAT_MODEL,
    embedModel: EMBED_MODEL,
  });
});

await loadIndex();
app.listen(PORT, () => {
  console.log(`ThBw RAG chatbot running at http://localhost:${PORT}`);
});
