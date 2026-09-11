// Evaluation of the agent path (POST /api/agent).
//
// The retrieval eval (eval.js) scores a source list against gold sets. An
// agent answer is different: the model decides what to look at, and the
// answer text — not a ranked list — is the deliverable. So this harness
// checks, per question, what can be checked deterministically:
//
//   goldFixture   cited ids must lie inside the fixture's offen list
//                 (citation precision); recall of the gold set is reported
//   mustCite      ids that must appear in the answer
//   mustMention   strings that must appear in the answer (a count, a name)
//   mustNotMention strings that must not appear ("keine Informationen" …)
//   expectTools   at least one of these tools must have been called
//   maxSteps      loop must finish within N steps
//
// Hard assertions (exit 1): no source or cited id with sichtbar "intern";
// every cited id came from a tool result (citationRetry must not be needed
// twice — the server already retried once; a remaining invented id fails).
//
//   npm run eval:agent            all questions (~5 min, DeepSeek calls)
//   npm run eval:agent -- --only=q4_frauen

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:5055";
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
const RESULTS_FILE = path.join(__dirname, "agent-results-latest.json");
const REVIEW_FILE = path.join(__dirname, "agent-review-latest.md");

const QUESTIONS = [
  // --- Daniel Degen, 2026-09-04 -------------------------------------------
  {
    id: "q2_ereignis",
    text: "Welches Ereignis wird in den Briefen am häufigsten thematisiert?",
    expectTools: ["count_by"],
    mustMention: ["Konzil von Trient"],
    maxSteps: 3,
  },
  {
    id: "q3_bibelstelle_abendmahl",
    text: "Welche Bibelstelle wird am Häufigsten im Zusammenhang mit dem Abendmahl erwähnt?",
    expectTools: ["count_by"],
    mustMention: ["1 Kor 10,16"],
    maxSteps: 4,
  },
  {
    id: "q4_frauen",
    text: "Suche Briefe, die von Frauen geschrieben wurden",
    expectTools: ["filter_letters"],
    mustMention: ["136"],
    mustCite: ["14022", "40335"], // Katharina Zell — first page, chronological
    minCited: 20,
    maxSteps: 3,
  },
  {
    id: "q5_regest_unvollstaendig",
    text: "Suche Briefe, deren Regesten unvollständige Sätze enthalten",
    expectTools: ["regest_issues"],
    mustNotMention: ["Soll ich"],
    maxSteps: 4,
  },
  {
    id: "q1_ausland",
    text: "Welche Briefe behandeln Nachrichten aus dem Ausland (von Deutschland aus gesehen)?",
    expectTools: ["filter_letters", "count_by", "list_values"],
    mustMention: ["Nachrichten aus Frankreich"],
    minCited: 6, // examples, not the full list (83 letters)
  },
  {
    id: "q6_versoehnung",
    text: "Welche Briefautoren sind mehr auf konfessionelle (religiöse) Versöhnung und Ausgleich bedacht als auf Abgrenzung?",
    // Must read, not count tags: classify_letters over the archive (cached
    // after the first full run; a fresh cache makes this an interim answer).
    expectTools: ["classify_letters"],
    mustNotMention: ["Soll ich"],
  },
  // --- the retrieval eval's handwritten set, on the agent path --------------
  {
    id: "a_heidelberg",
    text: "Welche Briefe erwähnen den Heidelberger Katechismus?",
    goldFixture: "heidelberg_katechismus",
    minCited: 15,
  },
  {
    id: "a_olevian_bullinger",
    text: "Welche Briefe schrieb Kaspar Olevian an Heinrich Bullinger?",
    goldFixture: "olevian_an_bullinger",
    expectTools: ["filter_letters"],
  },
  {
    id: "a_jahr_1563",
    text: "Wie viele Briefe stammen aus dem Jahr 1563, und von wem stammen die meisten?",
    goldFixture: "jahr_1563",
    expectTools: ["count_by", "filter_letters"],
  },
  {
    id: "a_lookup_18494",
    text: "Fasse den Brief 18494 zusammen.",
    expectTools: ["read_letter"],
    mustCite: ["18494"],
    maxSteps: 2,
  },
  {
    id: "a_lookup_99999",
    text: "Fasse den Brief 99999 zusammen.",
    mustNotCite: ["99999"],
    mustNotMention: ["Regest:"], // must not pretend to have read it
  },
  {
    id: "a_offtopic",
    text: "Was ist das beste Rezept für Pizza?",
    maxCited: 0,
  },
];

async function loadFixtures() {
  const out = {};
  for (const name of ["heidelberg_katechismus", "olevian_an_bullinger", "jahr_1563"]) {
    try {
      out[name] = JSON.parse(await readFile(path.join(__dirname, "fixtures", `${name}.json`), "utf8"));
    } catch {
      /* fixture missing — goldFixture checks are skipped */
    }
  }
  return out;
}

// Letter ids are five digits — but so are VD16 print numbers ("VD16 ZV 24459")
// and the odd page count; a bare number counts only when nothing marks it as
// something else, "Brief 12345" always counts.
const idsIn = (text) => {
  const ids = new Set([...text.matchAll(/Brief\s+(?:Nr\.?\s*)?(\d{5})\b/gi)].map((m) => m[1]));
  for (const m of text.matchAll(/(?<!VD16[^\n]{0,12})(?<!\b(?:ZV|Nr|S|Bl|fol)\.?\s{0,2})\b(\d{5})\b/g)) ids.add(m[1]);
  return [...ids];
};

async function ask(text) {
  const res = await fetch(`${BASE_URL}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function main() {
  const fixtures = await loadFixtures();
  const internAll = new Set(Object.values(fixtures).flatMap((f) => f.intern || []));
  const questions = ONLY ? QUESTIONS.filter((q) => q.id === ONLY) : QUESTIONS;
  const rows = [];
  const hard = [];
  const review = [`# ThBw RAG — Agent-Review\n\nErzeugt: ${new Date().toISOString()} · ${questions.length} Fragen\n`];

  for (const q of questions) {
    const started = Date.now();
    let data;
    try {
      data = await ask(q.text);
    } catch (err) {
      rows.push({ id: q.id, error: String(err.message || err) });
      hard.push(`${q.id}: request failed (${err.message})`);
      console.log(`✗ ${q.id}: ${err.message}`);
      continue;
    }
    const ms = Date.now() - started;
    const a = data.agent || {};
    const cited = a.citedIds || [];
    const mentioned = idsIn(data.answer);
    const tools = [...new Set((a.trace || []).map((t) => t.tool))];
    const fails = [];

    // hard assertions
    for (const s of data.sources || []) if (s.sichtbar === "intern") hard.push(`${q.id}: intern source ${s.id}`);
    for (const id of mentioned) if (internAll.has(id)) hard.push(`${q.id}: intern id ${id} in answer`);
    const seen = new Set((data.sources || []).map((s) => String(s.id)));
    const invented = mentioned.filter((id) => !seen.has(id) && !(q.mustNotCite || []).includes(id));
    if (invented.length) hard.push(`${q.id}: ids not from any tool result: ${invented.join(", ")}`);

    // soft checks
    if (q.expectTools && !q.expectTools.some((t) => tools.includes(t))) fails.push(`expected one of ${q.expectTools.join("/")}, used ${tools.join(",") || "none"}`);
    if (q.maxSteps && a.steps > q.maxSteps) fails.push(`${a.steps} steps > ${q.maxSteps}`);
    for (const s of q.mustMention || []) if (!data.answer.includes(s)) fails.push(`missing "${s}"`);
    for (const s of q.mustNotMention || []) if (data.answer.includes(s)) fails.push(`contains "${s}"`);
    for (const id of q.mustCite || []) if (!mentioned.includes(id)) fails.push(`does not cite ${id}`);
    for (const id of q.mustNotCite || []) if (cited.includes(id)) fails.push(`cites ${id}`);
    if (q.minCited && cited.length < q.minCited) fails.push(`cites ${cited.length} < ${q.minCited}`);
    if (q.maxCited !== undefined && cited.length > q.maxCited) fails.push(`cites ${cited.length} > ${q.maxCited}`);
    let precision, recall;
    if (q.goldFixture && fixtures[q.goldFixture]) {
      const gold = new Set(fixtures[q.goldFixture].offen);
      const inGold = cited.filter((id) => gold.has(id)).length;
      precision = cited.length ? inGold / cited.length : 0;
      recall = gold.size ? inGold / gold.size : 0;
      if (cited.length && precision < 0.9) fails.push(`citation precision ${(precision * 100).toFixed(0)}%`);
    }

    const row = { id: q.id, ms, steps: a.steps, tools, cited: cited.length, citationRetry: a.citationRetry, usage: a.usage, precision, recall, fails };
    rows.push(row);
    const mark = fails.length ? "✗" : "✓";
    console.log(
      `${mark} ${q.id.padEnd(26)} ${String(a.steps).padStart(2)} steps ${String(Math.round(ms / 1000)).padStart(3)} s  cited ${String(cited.length).padStart(3)}` +
        (precision !== undefined ? `  P=${(precision * 100).toFixed(0)}% R=${(recall * 100).toFixed(0)}%` : "") +
        (fails.length ? `  — ${fails.join("; ")}` : "")
    );
    review.push(
      `\n---\n\n## ${q.id}\n\n**Frage:** ${q.text}\n\n**Lauf:** ${a.steps} Schritte, ${Math.round(ms / 1000)} s, ${cited.length} zitierte Briefe` +
        (fails.length ? `, Prüfungen: ${fails.join("; ")}` : ", Prüfungen bestanden") +
        `\n\n**Werkzeuge:**\n${(a.trace || []).map((t) => `- \`${t.tool}(${JSON.stringify(t.args)})\` → ${t.summary}`).join("\n")}\n\n**Antwort:**\n\n${data.answer.split("\n").map((l) => "> " + l).join("\n")}\n`
    );
  }

  await writeFile(RESULTS_FILE, JSON.stringify({ at: new Date().toISOString(), baseUrl: BASE_URL, rows, hard }, null, 2));
  await writeFile(REVIEW_FILE, review.join("\n"));
  const failed = rows.filter((r) => r.fails?.length || r.error).length;
  console.log(`\n${rows.length - failed}/${rows.length} questions passed all checks. Review: ${path.relative(process.cwd(), REVIEW_FILE)}`);
  if (hard.length) {
    console.log(`\nHARD FAILURES:\n  ${hard.join("\n  ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
