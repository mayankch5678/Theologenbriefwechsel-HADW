// Classifies every place name in the public corpus (sending place, receiving
// place, mentioned place) by territory as seen from the German-speaking
// Empire 1550–1620 — the field the archive does not have (orts carries
// coordinates and a place type, no country). Needed for "Nachrichten aus
// dem Ausland" (Daniel Degen's question 1, 2026-09-04).
//
// Output: data/places.json  { "<name>": { land, im_reich, sicher } }
// Resumable; names already classified are skipped.
//
//   node scripts/classifyPlaces.js
//   node scripts/classifyPlaces.js --limit 80     # smoke test

import OpenAI from "openai";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const ENV_FILE = path.join(__dirname, "..", ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const OUT = path.join(DATA_DIR, "places.json");
const MODEL = process.env.CHAT_MODEL || "deepseek-chat";
const BATCH = 40;
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const LIMIT = Number(arg("limit") || 0);

const SYSTEM = `Du ordnest Ortsnamen aus einem Briefarchiv (Südwesten des Heiligen Römischen Reichs, 1550–1620) einem Land/Territorium zu — aus der Sicht eines deutschsprachigen Theologen dieser Zeit.
Für jeden Namen: "land" = Land oder Großregion, so wie man es damals aus deutscher Sicht benannt hätte, mit einheitlichen Bezeichnungen aus dieser Liste (oder nach demselben Muster): Reich (deutschsprachig), Österreich/Habsburg. Erblande, Böhmen/Mähren/Schlesien, Eidgenossenschaft, Niederlande, Frankreich, Italien, England/Schottland, Spanien/Portugal, Polen/Litauen, Ungarn/Siebenbürgen, Dänemark/Norwegen, Schweden, Osmanisches Reich, Preußen (Herzogtum), Livland/Baltikum, Russland, Nordafrika/Orient, Amerika, unbekannt.
"im_reich" = true nur für Orte im deutschsprachigen Kern des Reichs einschließlich Elsass, Lothringen (deutschsprachig), Mömpelgard, Österreich, Böhmen/Mähren/Schlesien, Tirol. false für Eidgenossenschaft, Niederlande, Frankreich, Italien usw. (aus deutscher Sicht Ausland, auch wenn formal reichszugehörig). Genf: false. Basel, Zürich, Bern: false. Straßburg, Mömpelgard, Metz: true. Königsberg (Herzogtum Preußen): false.
"sicher" = false, wenn der Name mehrdeutig ist oder du den Ort nicht kennst; dann "land": "unbekannt".
Namen mit Zusatz ("Aalen, St. Johann", "Kloster Hirsau", "Abtei von Liessies") nach dem Ort einordnen. Antworte NUR mit JSON: {"orte": {"<Name exakt wie gegeben>": {"land": "...", "im_reich": true|false, "sicher": true|false}}}.`;

async function main() {
  const raw = await readFile(path.join(DATA_DIR, "corpus.jsonl"), "utf8");
  const names = new Map(); // name -> letter count (for ordering / reporting)
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.sichtbar === "intern") continue;
    for (const k of ["placesSent", "placesReceived", "keywordPlaces"]) {
      for (const p of r[k] || []) names.set(p, (names.get(p) || 0) + 1);
    }
  }
  const existing = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : {};
  let todo = [...names.entries()]
    .filter(([n]) => !existing[n])
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n);
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log(`${names.size} distinct place names, ${Object.keys(existing).length} classified, ${todo.length} to do (${MODEL}).`);

  const client = new OpenAI({ baseURL: "https://api.deepseek.com", apiKey: process.env.DEEPSEEK_API_KEY });
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

  let b = 0;
  let saved = 0;
  const save = async () => {
    const sorted = Object.fromEntries(Object.entries(existing).sort(([a], [c]) => a.localeCompare(c, "de")));
    await writeFile(OUT, JSON.stringify(sorted, null, 1) + "\n");
  };
  const worker = async () => {
    while (b < batches.length) {
      const batch = batches[b++];
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const completion = await client.chat.completions.create({
            model: MODEL,
            temperature: 0,
            max_tokens: 4000,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: batch.map((n) => `- ${n}`).join("\n") },
            ],
          });
          const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
          const orte = parsed.orte || {};
          for (const n of batch) {
            const o = orte[n];
            if (o && typeof o.land === "string") {
              existing[n] = { land: o.land, im_reich: Boolean(o.im_reich), sicher: o.sicher !== false };
              saved++;
            }
          }
          break;
        } catch (err) {
          console.error(`  batch ${b}: ${String(err?.message || err)}`);
          await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
        }
      }
      if (b % 5 === 0 || b === batches.length) {
        await save();
        console.log(`  ${Math.min(b * BATCH, todo.length)}/${todo.length} names (${saved} classified)`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await save();
  const all = Object.values(existing);
  const byLand = new Map();
  for (const o of all) byLand.set(o.land, (byLand.get(o.land) || 0) + 1);
  console.log(`Done: ${all.length} places, ${all.filter((o) => !o.im_reich).length} outside the Empire, ${all.filter((o) => !o.sicher).length} uncertain.`);
  console.log([...byLand.entries()].sort((a, c) => c[1] - a[1]).map(([l, n]) => `  ${n}\t${l}`).join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
