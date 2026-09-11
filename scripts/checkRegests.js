// Offline quality pass over the editorial regests (Daniel Degen's question 5,
// 2026-09-04: "Briefe, deren Regesten unvollständige Sätze enthalten").
//
// That is not a retrieval question — no search finds "a broken sentence".
// It is a batch job: every public letter with a real regest is checked once,
// by cheap heuristics and by the chat model, and the findings are written to
// data/regest-check.jsonl. The agent's `regest_issues` tool then answers
// from that file. Resumable: letters already in the output file are skipped.
//
//   node scripts/checkRegests.js                 # full run (~18k letters)
//   node scripts/checkRegests.js --limit 20      # smoke test
//   node scripts/checkRegests.js --heuristic-only
//   CONCURRENCY=10 node scripts/checkRegests.js

import { createLlm, createBatchPool } from "../server/llm.js";
import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const ENV_FILE = path.join(__dirname, "..", ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const OUT = path.join(DATA_DIR, "regest-check.jsonl");
const llm = createLlm({ role: "batch" });
const MODEL = llm.model;
// DeepSeek throttles by request count (~1 req/s sustained), so regests are
// packed: one request carries BATCH regests and takes as long as one.
const CONCURRENCY = Number(process.env.CONCURRENCY || 20);
const BATCH = Number(process.env.BATCH || 10);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const LIMIT = Number(arg("limit") || 0);
const HEURISTIC_ONLY = process.argv.includes("--heuristic-only");

const SYSTEM = `Du prüfst Regesten (editorische Zusammenfassungen frühneuzeitlicher Briefe, 16./17. Jh.) auf FORMALE Mängel.
Regesten sind bewusst knapp und ohne Subjekt formuliert ("Bittet um Rat.", "Bewundert P.s Bildung.", "Grüße an N.") — dieser Stil ist KEIN Mangel. Historische Namensformen, lateinische Wörter, Abkürzungen (d. Ä., d. J., s. BCor, Hzg., Kf.) und eckige Klammern der Editoren sind ebenfalls KEIN Mangel.
Melde ausschließlich:
- "unvollstaendig": ein Satz bricht ab oder ist grammatisch unvollständig (fehlendes Verb/Objekt, Satz endet mitten im Gedanken, Satz ohne Schlusspunkt am Ende des Regests).
- "wortfehler": doppeltes Wort ("die die"), offensichtlich fehlendes Wort, falsche Wortstellung.
- "tippfehler": eindeutiger Tippfehler in einem deutschen Wort (nicht: Namen, Latein, alte Schreibungen).
Du erhältst mehrere Regesten, jedes mit seiner Brief-Nummer; prüfe jedes für sich. Antworte NUR mit JSON: {"briefe":[{"id":"<Brief-Nummer>","maengel":[{"art":"unvollstaendig"|"wortfehler"|"tippfehler","stelle":"<wörtliches Zitat, höchstens 12 Wörter>","hinweis":"<kurz>"}]}, …]} — genau ein Eintrag pro Brief-Nummer, leere Liste, wenn nichts zu beanstanden ist. Im Zweifel nichts melden.`;

function heuristics(text) {
  const t = text.trim();
  const out = [];
  if (!/[.!?)\]"“”']$/.test(t) && !/\bBCor\b\s*$/.test(t)) out.push({ art: "kein_satzende", stelle: t.slice(-60) });
  if (t.split("(").length !== t.split(")").length || t.split("[").length !== t.split("]").length)
    out.push({ art: "klammer_unausgeglichen" });
  // Doubled word — only for words that are not plausible as a legitimate
  // repetition (German "die die" / "sie sie" / "der der" occur in valid
  // relative constructions, so those are left to the model).
  for (const m of t.matchAll(/\b(\p{L}{4,})\s+\1\b/giu)) {
    if (!/^(die|der|das|sie|sich|dass|sein)$/i.test(m[1])) out.push({ art: "wortdopplung", stelle: m[0] });
  }
  return out;
}

async function main() {
  const raw = await readFile(path.join(DATA_DIR, "corpus.jsonl"), "utf8");
  const letters = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.sichtbar !== "intern" && !r.regestSynthetic && r.regest);
  const done = new Set();
  if (existsSync(OUT)) {
    for (const line of (await readFile(OUT, "utf8")).split("\n")) {
      if (line) done.add(JSON.parse(line).id);
    }
  }
  let todo = letters.filter((r) => !done.has(String(r.id)));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log(`${letters.length} public letters with a regest, ${done.size} already checked, ${todo.length} to do (model: ${HEURISTIC_ONLY ? "none" : MODEL}, concurrency ${CONCURRENCY}).`);

  const client = HEURISTIC_ONLY ? null : llm.client;

  // One request, several regests -> Map id -> maengel[] (missing ids are
  // retried in a smaller batch by the caller).
  const pool = client ? createBatchPool() : [];
  async function checkMany(rs, llmIdx = 0) {
    if (!client) return new Map(rs.map((r) => [String(r.id), []]));
    const llm = pool[llmIdx % pool.length];
    const user = rs.map((r) => `### Brief ${r.id}\n${r.regest}`).join("\n\n");
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const completion = await llm.client.chat.completions.create({
          ...llm.extra,
          model: llm.model,
          temperature: 0,
          max_tokens: 250 * rs.length + 200,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: user },
          ],
        });
        const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
        const out = new Map();
        for (const b of Array.isArray(parsed.briefe) ? parsed.briefe : []) {
          const id = String(b?.id ?? "").trim();
          if (rs.some((r) => String(r.id) === id) && !out.has(id)) out.set(id, Array.isArray(b.maengel) ? b.maengel.slice(0, 10) : []);
        }
        return out;
      } catch (err) {
        lastErr = err;
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  let n = 0;
  let flagged = 0;
  const started = Date.now();
  const groups = [];
  for (let k = 0; k < todo.length; k += BATCH) groups.push(todo.slice(k, k + BATCH));
  let g = 0;
  const handle = async (rs, llmIdx = 0) => {
    let got;
    try {
      got = await checkMany(rs, llmIdx);
    } catch (err) {
      console.error(`  batch of ${rs.length}: ${String(err?.message || err)}`);
      n += rs.length;
      return; // not written: retried on the next run
    }
    const lines = [];
    for (const r of rs) {
      if (!got.has(String(r.id))) continue;
      const result = { id: String(r.id), heuristik: heuristics(r.regest), maengel: got.get(String(r.id)), model: client ? pool[llmIdx % pool.length].model : null, at: new Date().toISOString() };
      if (result.heuristik.length || result.maengel.length) flagged++;
      lines.push(JSON.stringify(result));
    }
    if (lines.length) await appendFile(OUT, lines.join("\n") + "\n");
    n += lines.length;
    const missing = rs.filter((r) => !got.has(String(r.id)));
    if (missing.length && rs.length > 1) {
      const half = Math.ceil(missing.length / 2);
      await handle(missing.slice(0, half), llmIdx);
      if (missing.length > half) await handle(missing.slice(half), llmIdx);
    } else if (missing.length) n += missing.length;
    if (Math.floor(n / 200) !== Math.floor((n - rs.length) / 200) || n >= todo.length) {
      const rate = n / ((Date.now() - started) / 1000);
      console.log(`  ${n}/${todo.length} (${flagged} flagged, ${rate.toFixed(1)}/s, ~${Math.round((todo.length - n) / rate / 60)} min left)`);
    }
  };
  const worker = async (k) => {
    while (g < groups.length) await handle(groups[g++], k);
  };
  await Promise.all(Array.from({ length: client ? Math.min(CONCURRENCY, groups.length) : 1 }, (_, k) => worker(k)));
  console.log(`Done. ${flagged} of ${todo.length} letters flagged. Results in ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
