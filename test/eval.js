// Retrieval + answer evaluation harness (handoff doc §7 Phase 1).
//
// Asks the running server a fixed set of German questions and scores the
// returned sources against gold answer lists derived from the editors' own
// curated data (subject tags, canonical names, dates — regenerate with
// `npm run build:gold` and `npm run build:questions` after every mongorestore).
//
//   npm run eval        retrieval only (POST /api/retrieve) — fast, free,
//                       deterministic; the everyday regression check
//   npm run eval:full   end-to-end (POST /api/chat) — adds generation-side
//                       checks (answer language, citation integrity, refusal)
//                       and writes test/review-latest.md, a human review
//                       sheet with every question, answer and source list
//
// The question set is German-only by design: the current target audience is
// German-speaking researchers (decided 2026-08-21; multilingual support and
// its evaluation are explicitly out of scope for now).
//
// Two question tiers:
//   - handwritten (below): realistic phrasings, reported per question
//   - generated (fixtures/generated_questions.json): ~30 template questions
//     sampled from the DB for breadth, reported in aggregate + worst cases
//
// Exit code 1 iff a hard assertion fails. Metrics never fail the run — they
// are compared against test/baseline.json and regressions are reported.
// Delete baseline.json to re-baseline after an intended change.
//
// Hard assertions:
//   - no source with sichtbar === "intern" (the privacy boundary, §3.5)
//   - no source whose id is in any gold set's intern list (belt and braces:
//     catches the leak even if the sichtbar field itself were mangled)
//   - [full mode] every Brief id cited in the answer text appears in sources
//     (an answer must not invent citations)

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:5055";
const FULL = process.argv.includes("--full");
const BASELINE_FILE = path.join(__dirname, "baseline.json");
const RESULTS_FILE = path.join(__dirname, "results-latest.json");
const REVIEW_FILE = path.join(__dirname, "review-latest.md");

// ---------------------------------------------------------------------------
// Handwritten questions.
//
// gold        name of a fixture whose offen list is the full correct answer
// goldIds     inline correct-answer list (generated questions use this)
// mustInclude ids that must be present for the retrieval to count as usable
// expectEmpty true where the only correct source list is empty (small talk /
//             out of domain) — every returned source is noise
const QUESTIONS = [
  {
    id: "de_enum_heidelberg",
    lang: "de",
    text: "Welche Briefe erwähnen den Heidelberger Katechismus?",
    gold: "heidelberg_katechismus",
  },
  {
    // Letter 25851 is tagged only with the comma-qualified variant
    // "Heidelberger Katechismus, Frage 60" and is the known victim of the
    // substring under-match (§6.1) — this question asks for it by name.
    id: "de_variant_frage60",
    lang: "de",
    text: "Welche Briefe betreffen Frage 60 des Heidelberger Katechismus?",
    mustInclude: ["25851"],
  },
  {
    id: "de_person_olevian_bullinger",
    lang: "de",
    text: "Welche Briefe schrieb Kaspar Olevian an Heinrich Bullinger?",
    gold: "olevian_an_bullinger",
  },
  {
    // Structurally unanswerable by top-K retrieval (§6.7) — kept in the set
    // to quantify that gap, not because current recall could be good.
    id: "de_date_1563",
    lang: "de",
    text: "Welche Briefe stammen aus dem Jahr 1563?",
    gold: "jahr_1563",
  },
  {
    // Single fact: Olevian sent Calvin/Beza the Latin translation of the
    // catechism — regest of 18495. The letter must be retrievable.
    id: "de_fact_latein",
    lang: "de",
    text: "Wer schickte Calvin die lateinische Übersetzung des Heidelberger Katechismus?",
    mustInclude: ["18495"],
  },
  { id: "smalltalk_de", lang: "de", text: "Hallo, wie geht es dir?", expectEmpty: true },
  { id: "offtopic_de", lang: "de", text: "Was ist das beste Rezept für Pizza?", expectEmpty: true },
  {
    // Corpus-level statistics cannot be answered from retrieved letters —
    // the model must refuse rather than count what it was handed (the v2
    // prototype's G-class hallucination failure).
    id: "de_adv_stats",
    lang: "de",
    text: "Wie viele Briefe enthält das Archiv insgesamt?",
    expectRefusal: true,
  },
  {
    // Asking for a letter that does not exist: the answer must not pretend
    // to have read it. Mentioning the asked-for id in the refusal is fine,
    // so it is exempt from the invented-citation assertion.
    id: "de_adv_nonexistent",
    lang: "de",
    text: "Fasse den Brief 99999 zusammen.",
    expectEmpty: true, // explicit-lookup short-circuit: no such letter -> no sources
    expectRefusal: true,
    exemptCitations: ["99999"],
  },
];

// ---------------------------------------------------------------------------

async function loadFixtures() {
  const dir = path.join(__dirname, "fixtures");
  const fixtures = {};
  let generated = [];
  let files;
  try {
    files = await readdir(dir);
  } catch {
    console.error(`No fixtures found in ${dir} — run "npm run build:gold" first (needs MongoDB).`);
    process.exit(1);
  }
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(await readFile(path.join(dir, f), "utf8"));
    if (f === "generated_questions.json") {
      generated = data.questions.map((q) => ({ ...q, goldIds: q.offen, generated: true }));
    } else {
      fixtures[data.name] = data;
    }
  }
  return { fixtures, generated };
}

async function ask(question) {
  const endpoint = FULL ? "/api/chat" : "/api/retrieve";
  const res = await fetch(BASE_URL + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: question }),
  });
  if (!res.ok) throw new Error(`${endpoint} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Crude but sufficient language detection for the alignment check (answers
// must be German). Only compares answer language against question language.
function detectLang(text) {
  if (/[一-鿿]/.test(text)) return "zh";
  const t = ` ${text.toLowerCase()} `;
  const count = (words) => words.reduce((n, w) => n + (t.split(` ${w} `).length - 1), 0);
  const scores = {
    de: count(["der", "die", "das", "und", "nicht", "ein", "eine", "den", "im", "mit", "von", "zu"]),
    en: count(["the", "and", "of", "to", "in", "is", "that", "which", "with", "from"]),
  };
  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

// The refusal the server hardcodes plus the phrasings the system prompt tells
// the model to use when the context does not answer the question.
function looksLikeRefusal(answer) {
  return /kein hinreichend relevanter Brief|keine Informationen|keine relevanten|stelle .*konkrete Frage|spezifische Frage|betrifft das gesamte Archiv|nicht beantwortet werden|nicht in den bereitgestellten|nicht enthalten/i.test(
    answer
  );
}

function pct(x) {
  return (100 * x).toFixed(1) + "%";
}

async function evaluateQuestion(q, fixtures, hardFailures) {
  const started = Date.now();
  const data = await ask(q.text);
  const ms = Date.now() - started;
  const ids = data.sources.map((s) => String(s.id));

  // --- hard assertions: the privacy boundary, checked on every question -----
  const leakByFlag = data.sources.filter((s) => s.sichtbar === "intern").map((s) => String(s.id));
  const internIds = new Set([
    ...Object.values(fixtures).flatMap((f) => f.intern),
    ...(q.intern || []),
  ]);
  const leakById = ids.filter((id) => internIds.has(id));
  for (const id of new Set([...leakByFlag, ...leakById])) {
    hardFailures.push(`${q.id}: intern letter ${id} appeared in sources`);
  }

  // --- metrics --------------------------------------------------------------
  const row = { id: q.id, lang: q.lang, sources: ids.length, ms };
  const goldList = q.goldIds || (q.gold && fixtures[q.gold].offen);
  if (goldList) {
    const gold = new Set(goldList);
    const correct = ids.filter((id) => gold.has(id)).length;
    row.goldSize = gold.size;
    row.recall = gold.size ? correct / gold.size : 0;
    row.precision = ids.length ? correct / ids.length : 0;
  }
  if (q.mustInclude) {
    row.missing = q.mustInclude.filter((id) => !ids.includes(id));
    row.found = row.missing.length === 0;
  }
  if (q.expectEmpty) {
    row.pass = ids.length === 0;
  }

  // --- generation-side checks (full mode only) ------------------------------
  if (FULL && typeof data.answer === "string") {
    row.answer = data.answer;
    row.answerLang = detectLang(data.answer);
    row.langAligned = row.answerLang === q.lang;
    const cited = [...new Set([...data.answer.matchAll(/Brief\s+(\d{3,6})/g)].map((m) => m[1]))];
    const exempt = new Set(q.exemptCitations || []);
    const unsourced = cited.filter((id) => !ids.includes(id) && !exempt.has(id));
    // Regests and CMIF snippets themselves reference other letters; a model
    // echoing such an id from the delivered material is sloppy citation, not
    // fabrication. Only ids that appear nowhere in the source payload count
    // as invented and fail hard.
    const sourceBlob = JSON.stringify(data.sources);
    const echoed = unsourced.filter((id) => sourceBlob.includes(id));
    const invented = unsourced.filter((id) => !sourceBlob.includes(id));
    row.citedCount = cited.length;
    if (echoed.length) row.echoedCitations = echoed;
    if (invented.length) {
      hardFailures.push(`${q.id}: answer cites Brief ${invented.join(", ")} — id appears nowhere in the sources`);
    }
    if (q.expectEmpty || q.expectRefusal) row.refused = looksLikeRefusal(data.answer);
    // Retrieval finding the right letters is necessary, not sufficient: the
    // model can still fail to *use* them. Citation recall = share of gold
    // letters the answer actually cites; a refusal despite gold letters in
    // the sources is the failure signature seen on "Unschuldsbeteuerung"
    // (letters tagged by the editors, regest never spelling the word out).
    if (goldList && goldList.length) {
      const gold = new Set(goldList);
      const citedGold = cited.filter((id) => gold.has(id)).length;
      // The model can only cite what was in its prompt (CONTEXT_MAX letters),
      // so a 384-letter gold set is judged against the 60 it actually saw.
      const inContext = data.retrieval?.inContext ?? ids.length;
      const reachable = Math.min(gold.size, inContext);
      row.citationRecall = reachable ? citedGold / reachable : 0;
      row.falseRefusal = row.recall > 0 && looksLikeRefusal(data.answer) && citedGold === 0;
    }
    // Kept for the review sheet, never for scoring.
    row.topSources = data.sources.slice(0, 10).map((s) => ({ id: s.id, long: s.long, score: s.score }));
  }
  return row;
}

// The human review sheet: everything a reader needs to judge answer quality —
// question, full answer, the letters behind it — plus an empty grading line.
// Automation checks what it can; whether an answer is *good* is judged here.
function reviewSheet(rows, questions) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const lines = [
    "# ThBw RAG — Antwort-Review",
    "",
    `Erzeugt: ${new Date().toISOString()} · Modus: full · ${rows.length} Fragen`,
    "",
    "Bewertung pro Frage eintragen: **gut / brauchbar / falsch** + Kommentar.",
    "",
  ];
  for (const r of rows) {
    if (r.answer === undefined) continue;
    const q = byId.get(r.id);
    const metrics = [];
    if (r.recall !== undefined) metrics.push(`Recall ${pct(r.recall)}, Precision ${pct(r.precision)} (Gold ${r.goldSize})`);
    if (r.found !== undefined) metrics.push(r.found ? "Pflicht-Brief gefunden" : `Pflicht-Brief FEHLT: ${r.missing.join(", ")}`);
    if (r.pass !== undefined) metrics.push(r.pass ? "korrekt leer" : `${r.sources} Quellen statt 0`);
    if (r.citationRecall !== undefined) metrics.push(`zitiert ${pct(r.citationRecall)} der Gold-Briefe`);
    if (r.falseRefusal) metrics.push("**FEHL-ABLEHNUNG** (Gold-Briefe vorhanden, Antwort verweigert)");
    lines.push(
      `---`,
      ``,
      `## ${r.id}${q?.generated ? " (generiert)" : ""}`,
      ``,
      `**Frage:** ${q?.text}`,
      ``,
      `**Metriken:** ${metrics.join(" · ") || "—"} · ${r.sources} Quellen · Antwort auf ${r.answerLang}`,
      ``,
      `**Antwort:**`,
      ``,
      ...r.answer.split("\n").map((l) => `> ${l}`),
      ``,
      `**Top-Quellen:**`,
      ``,
      ...(r.topSources || []).map((s) => `- Brief ${s.id} (${s.score}): ${s.long || ""}`),
      ``,
      `**Bewertung:** _____________________`,
      ``
    );
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const { fixtures, generated } = await loadFixtures();
  const allQuestions = [...QUESTIONS, ...generated];
  const hardFailures = [];
  const rows = [];
  const results = { mode: FULL ? "full" : "retrieval", baseUrl: BASE_URL, questions: {} };

  for (const q of allQuestions) {
    process.stdout.write(`${q.id} ... `);
    const row = await evaluateQuestion(q, fixtures, hardFailures);
    row.generated = Boolean(q.generated);
    results.questions[q.id] = { ...row, answer: undefined, topSources: undefined };
    rows.push(row);
    console.log(`${row.sources} sources, ${row.ms} ms`);
  }

  // --- report: handwritten per question -------------------------------------
  console.log("\n=== Handwritten questions ===");
  for (const r of rows.filter((r) => !r.generated)) {
    const parts = [`sources=${r.sources}`];
    if (r.recall !== undefined) parts.push(`recall=${pct(r.recall)} precision=${pct(r.precision)} (gold ${r.goldSize})`);
    if (r.found !== undefined) parts.push(r.found ? "mustInclude ✓" : `MISSING ${r.missing.join(",")}`);
    if (r.pass !== undefined) parts.push(r.pass ? "empty ✓" : `expected 0 sources, got ${r.sources}`);
    if (FULL && r.langAligned !== undefined)
      parts.push(r.langAligned ? `lang ✓` : `LANG ${r.lang}->${r.answerLang}`);
    if (FULL && r.refused !== undefined) parts.push(r.refused ? "refused ✓" : "DID NOT REFUSE");
    if (FULL && r.echoedCitations) parts.push(`⚠ echoed refs: ${r.echoedCitations.join(",")}`);
    if (FULL && r.citationRecall !== undefined) parts.push(`cites ${pct(r.citationRecall)} of gold`);
    if (FULL && r.falseRefusal) parts.push("✗ FALSE REFUSAL (gold in sources, answer refused)");
    console.log(`  ${r.id.padEnd(28)} ${parts.join("  ")}`);
  }

  // --- report: generated in aggregate ---------------------------------------
  const gen = rows.filter((r) => r.generated && r.recall !== undefined);
  if (gen.length) {
    const mean = (k) => gen.reduce((s, r) => s + r[k], 0) / gen.length;
    console.log(`\n=== Generated questions (${gen.length}) ===`);
    console.log(`  mean recall=${pct(mean("recall"))}  mean precision=${pct(mean("precision"))}`);
    const worst = [...gen].sort((a, b) => a.recall - b.recall).slice(0, 5);
    console.log("  worst by recall:");
    for (const r of worst) {
      console.log(`    ${r.id.padEnd(24)} recall=${pct(r.recall)} precision=${pct(r.precision)} sources=${r.sources} (gold ${r.goldSize})`);
    }
    if (FULL) {
      const misaligned = gen.filter((r) => r.langAligned === false).length;
      if (misaligned) console.log(`  answers not in German: ${misaligned}/${gen.length}`);
      const withCr = gen.filter((r) => r.citationRecall !== undefined);
      if (withCr.length) {
        const meanCr = withCr.reduce((s, r) => s + r.citationRecall, 0) / withCr.length;
        console.log(`  mean citation recall (gold letters actually cited): ${pct(meanCr)}`);
      }
      const falseRefusals = gen.filter((r) => r.falseRefusal);
      if (falseRefusals.length) {
        console.log(`  ✗ false refusals (gold in sources, answer refused): ${falseRefusals.map((r) => r.id).join(", ")}`);
      }
    }
  }

  // --- baseline comparison --------------------------------------------------
  let baseline = null;
  try {
    baseline = JSON.parse(await readFile(BASELINE_FILE, "utf8"));
  } catch {
    /* first run */
  }
  if (baseline && baseline.mode === results.mode) {
    console.log("\n=== vs baseline ===");
    let changes = 0;
    for (const r of rows) {
      const b = baseline.questions[r.id];
      if (!b) continue;
      const deltas = [];
      for (const k of ["recall", "precision"]) {
        if (r[k] !== undefined && b[k] !== undefined && Math.abs(r[k] - b[k]) > 0.005) {
          deltas.push(`${k} ${pct(b[k])} -> ${pct(r[k])}${r[k] < b[k] ? "  ⚠ REGRESSION" : ""}`);
        }
      }
      if (b.sources !== r.sources) deltas.push(`sources ${b.sources} -> ${r.sources}`);
      if (deltas.length) {
        console.log(`  ${r.id.padEnd(28)} ${deltas.join("  ")}`);
        changes++;
      }
    }
    if (!changes) console.log("  no changes");
  } else if (!baseline) {
    await writeFile(BASELINE_FILE, JSON.stringify(results, null, 2) + "\n");
    console.log(`\nNo baseline existed — wrote this run as baseline: ${BASELINE_FILE}`);
  }
  await writeFile(RESULTS_FILE, JSON.stringify(results, null, 2) + "\n");

  if (FULL) {
    await writeFile(REVIEW_FILE, reviewSheet(rows, allQuestions), "utf8");
    console.log(`\nHuman review sheet written: ${REVIEW_FILE}`);
  }

  // --- verdict --------------------------------------------------------------
  if (hardFailures.length) {
    console.error("\n=== HARD FAILURES ===");
    for (const f of hardFailures) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log("\nAll hard assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
