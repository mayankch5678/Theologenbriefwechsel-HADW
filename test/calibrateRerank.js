// Calibrates RERANK_MIN empirically: for every gold question, collects the
// rerank scores of the *embedding-only* sources (the only ones the threshold
// can drop) split into gold vs non-gold, and reports how each candidate
// threshold trades recall of gold extras against precision.
//
//   RERANK_MIN=0 npm start          # server with rerank on, threshold off
//   node test/calibrateRerank.js
//
// Chunk-derived letters count as embedding-only too. Keyword-backed hits are
// never subject to the threshold and are ignored here.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:5055";

async function main() {
  const dir = path.join(__dirname, "fixtures");
  const questions = [];
  for (const f of await readdir(dir)) {
    const data = JSON.parse(await readFile(path.join(dir, f), "utf8"));
    if (f === "generated_questions.json") {
      for (const q of data.questions) questions.push({ text: q.text, gold: new Set(q.offen) });
    } else if (data.name === "heidelberg_katechismus") {
      questions.push({ text: "Welche Briefe erwähnen den Heidelberger Katechismus?", gold: new Set(data.offen) });
    } else if (data.name === "olevian_an_bullinger") {
      questions.push({ text: "Welche Briefe schrieb Kaspar Olevian an Heinrich Bullinger?", gold: new Set(data.offen) });
    }
  }

  const goldScores = [];
  const junkScores = [];
  let noRerank = 0;
  for (const q of questions) {
    const res = await fetch(`${BASE_URL}/api/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: q.text }),
    });
    const data = await res.json();
    if (!data.retrieval.reranked) noRerank++;
    for (const s of data.sources) {
      const embeddingOnly = s.reasons?.every((r) => r.startsWith("inhaltlich"));
      if (!embeddingOnly || s.rerank === undefined) continue;
      (q.gold.has(String(s.id)) ? goldScores : junkScores).push(s.rerank);
    }
  }
  if (noRerank) console.warn(`WARNING: ${noRerank}/${questions.length} responses were not reranked — is the sidecar up?`);

  const q = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.floor((arr.length - 1) * p)] : NaN);
  console.log(`embedding-only extras: ${goldScores.length} gold, ${junkScores.length} non-gold`);
  console.log(`gold rerank   p10=${q(goldScores, 0.1).toFixed(3)} median=${q(goldScores, 0.5).toFixed(3)} p90=${q(goldScores, 0.9).toFixed(3)}`);
  console.log(`non-gold      p10=${q(junkScores, 0.1).toFixed(3)} median=${q(junkScores, 0.5).toFixed(3)} p90=${q(junkScores, 0.9).toFixed(3)}`);
  console.log("\nthreshold  keeps gold extras  keeps non-gold extras");
  for (const t of [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5]) {
    const g = goldScores.filter((s) => s >= t).length;
    const j = junkScores.filter((s) => s >= t).length;
    console.log(`  ${String(t).padEnd(6)}   ${String(g).padStart(3)}/${goldScores.length}             ${String(j).padStart(4)}/${junkScores.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
