// Generates a bulk set of template-based German test questions straight from
// the database, each with its own gold answer list (the letters the editors
// themselves tagged/attributed — same ground-truth logic as buildGoldSets.js).
//
// Handwritten questions (in eval.js) cover realistic phrasings; this file adds
// breadth: many subjects and correspondent pairs the handwritten set will
// never mention. Sampling is seeded, so reruns on the same dump produce the
// same questions — and the output is committed anyway, so the eval set only
// changes when someone deliberately regenerates it.
//
// Filters: subjects carrying 3–60 public letters (below 3 the question is
// trivia, above 60 it is a generic catch-all like "Briefe" that no single
// question should legitimately enumerate), correspondent pairs with >= 3
// public letters. Writes test/fixtures/generated_questions.json.

import { MongoClient } from "mongodb";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const N_SUBJECTS = Number(process.env.GEN_SUBJECTS || 20);
const N_PAIRS = Number(process.env.GEN_PAIRS || 10);
const SEED = 20260821;

// Small deterministic PRNG (mulberry32) — Math.random would make every
// regeneration a different exam, which defeats baseline comparison.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(arr, n, rand) {
  const pool = [...arr];
  const out = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

function splitByVisibility(docs) {
  const offen = [];
  const intern = [];
  for (const d of docs) {
    const id = d.short?.v;
    if (!id) continue;
    (d.sichtbar?.v === "offen" ? offen : intern).push(id);
  }
  const num = (a, b) => Number(a) - Number(b);
  return { offen: offen.sort(num), intern: intern.sort(num) };
}

async function main() {
  const client = new MongoClient(MONGO_URI, { readPreference: "primary" });
  await client.connect();
  const db = client.db("letters");
  const briefs = db.collection("briefs");
  const projection = { "short.v": 1, "sichtbar.v": 1 };
  const rand = mulberry32(SEED);
  const questions = [];

  // --- subject questions: "Welche Briefe erwähnen X?" ------------------------
  // Candidate subjects by how many *public* letters carry the tag.
  const subjectCounts = await briefs
    .aggregate([
      { $match: { "sichtbar.v": "offen" } },
      { $unwind: "$schlagworte.sachen" },
      { $group: { _id: "$schlagworte.sachen.v", n: { $sum: 1 } } },
      { $match: { n: { $gte: 3, $lte: 60 } } },
    ])
    .toArray();
  const chosenSubjects = sample(subjectCounts, N_SUBJECTS, rand);

  const labels = await db
    .collection("saches")
    .find({ _id: { $in: chosenSubjects.map((s) => s._id) } }, { projection: { "short.v": 1 } })
    .toArray();
  const labelById = new Map(labels.map((l) => [String(l._id), l.short?.v]));

  for (const s of chosenSubjects) {
    const label = labelById.get(String(s._id));
    if (!label || label.length < 5) continue; // dropped/short labels make no question
    const docs = await briefs.find({ "schlagworte.sachen.v": s._id }, { projection }).toArray();
    const { offen, intern } = splitByVisibility(docs);
    questions.push({
      id: `gen_sache_${offen[0] || String(s._id).slice(-6)}`,
      template: "sache",
      lang: "de",
      text: `Welche Briefe erwähnen ${label}?`,
      subject: label,
      offen,
      intern,
    });
  }

  // --- correspondent-pair questions: "Welche Briefe schrieb X an Y?" ---------
  // Uses the first sender/recipient's canonical embedded name — the
  // verfasser[].person.v reference ids do not resolve in this dump (see
  // buildGoldSets.js), the denormalised name is the reliable path.
  const pairCounts = await briefs
    .aggregate([
      { $match: { "sichtbar.v": "offen" } },
      {
        $project: {
          s: { $arrayElemAt: ["$verfasser.nameMitAmt.combi", 0] },
          r: { $arrayElemAt: ["$adressat.nameMitAmt.combi", 0] },
        },
      },
      { $match: { s: { $type: "string", $ne: "" }, r: { $type: "string", $ne: "" } } },
      { $group: { _id: { s: "$s", r: "$r" }, n: { $sum: 1 } } },
      { $match: { n: { $gte: 3 } } },
    ])
    .toArray();
  const chosenPairs = sample(pairCounts, N_PAIRS, rand);

  for (const p of chosenPairs) {
    const { s, r } = p._id;
    const docs = await briefs
      .find({ "verfasser.nameMitAmt.combi": s, "adressat.nameMitAmt.combi": r }, { projection })
      .toArray();
    const { offen, intern } = splitByVisibility(docs);
    questions.push({
      id: `gen_person_${offen[0] || "x"}`,
      template: "person",
      lang: "de",
      text: `Welche Briefe schrieb ${s} an ${r}?`,
      sender: s,
      recipient: r,
      offen,
      intern,
    });
  }

  await client.close();

  await mkdir(FIXTURES_DIR, { recursive: true });
  const out = {
    generatedAt: new Date().toISOString(),
    seed: SEED,
    questions,
  };
  const file = path.join(FIXTURES_DIR, "generated_questions.json");
  await writeFile(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(
    `Wrote ${questions.length} generated questions ` +
      `(${questions.filter((q) => q.template === "sache").length} subject, ` +
      `${questions.filter((q) => q.template === "person").length} person) -> ${file}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
