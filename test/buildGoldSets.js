// Regenerates the evaluation gold sets straight from MongoDB.
//
// Gold sets are derived from the editors' own curated data (subject tags,
// canonical sender/recipient names, dates) — not from any text search — so
// they are ground truth independent of every retrieval mechanism under test.
// Rerun this after every mongorestore: letters get added and flip between
// offen/intern over time, so a hardcoded ID list silently rots. The 2026-08
// dump already differs from the 2026-08-14 handoff figures (47 -> 48 letters
// in the Heidelberg set).
//
// Read-only against MongoDB, same as buildCorpus.js. Writes test/fixtures/*.json.

import { MongoClient } from "mongodb";
import { ObjectId } from "mongodb";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const FIXTURES_DIR = path.join(__dirname, "fixtures");

// The ten Heidelberg-Catechism-related subject ids from the 2026-08-14 audit
// (handoff doc §8). The subject *ids* are stable even when letters change;
// labels are re-read from the DB below so a renamed/merged subject is noticed.
const HEIDELBERG_SACHE_IDS = [
  "5c18e349b8b1730eeb705868", // Heidelberger Katechismus
  "5d4bdec6cd94087f51d218ca", // Frage 80
  "5f2bfbe9a1584d546a137183", // 1573 (VD16 ZV 24459)
  "5eecde96bbf934303597df04", // Kleiner Heidelberger Katechismus (1576)
  "63c64adf7273b7053c255f9d", // Bullinger, Apologie des HK, 1563 (verloren)
  "659d556695945bb3d1fd7ba6", // Verteidigung des Heidelberger Katechismus
  "65c37040a4fb14a196741c02", // Bullinger, [Beurteilung ... Schmähschrift] 1563
  "66fd0a3cf1bf32731a17255a", // Frage 60
  "67e5262a61b3ac7dbf364f72", // Frage 37
  "5c18e337b8b1730eeb7052e8", // De erroribus Catechismi Palatinatus, 1565
];

// Splits matched briefs into offen (retrievable — recall is measured against
// these) and intern (must never appear in any result — the leak assertion).
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
  const generatedAt = new Date().toISOString();
  await mkdir(FIXTURES_DIR, { recursive: true });

  const sets = [];

  // 1. Heidelberg Catechism — enumerative, tag-derived. The editors tag
  //    letters on their reading of the manuscript, so ~14 of these letters
  //    never contain the word "Katechismus" in any stored text — that is
  //    exactly why tags, not text search, are the ground truth here.
  {
    const ids = HEIDELBERG_SACHE_IDS.map((k) => new ObjectId(k));
    const labels = await db
      .collection("saches")
      .find({ _id: { $in: ids } }, { projection: { "short.v": 1 } })
      .toArray();
    if (labels.length !== ids.length) {
      console.warn(
        `WARNING: only ${labels.length}/${ids.length} Heidelberg subject ids still exist — ` +
          `a subject was deleted or merged. Review HEIDELBERG_SACHE_IDS.`
      );
    }
    const docs = await briefs.find({ "schlagworte.sachen.v": { $in: ids } }, { projection }).toArray();
    sets.push({
      name: "heidelberg_katechismus",
      description: "Letters tagged with any of the 10 Heidelberg-Catechism-related subjects",
      derivedFrom: { field: "schlagworte.sachen.v", subjects: labels.map((l) => l.short.v) },
      generatedAt,
      ...splitByVisibility(docs),
    });
  }

  // 2. Olevian -> Bullinger — person-centred. Uses the denormalised canonical
  //    name embedded in each brief (verfasser[].nameMitAmt.combi); the
  //    verfasser[].person.v reference ids do not resolve against people._id
  //    in this dump, so the name field is the reliable path.
  {
    const docs = await briefs
      .find(
        { "verfasser.nameMitAmt.combi": /Olevian/, "adressat.nameMitAmt.combi": /Bullinger/ },
        { projection }
      )
      .toArray();
    sets.push({
      name: "olevian_an_bullinger",
      description: "Letters sent by (any) Olevian to (any) Bullinger",
      derivedFrom: { field: "verfasser/adressat nameMitAmt.combi", pattern: "Olevian -> Bullinger" },
      generatedAt,
      ...splitByVisibility(docs),
    });
  }

  // 3. Year 1563 — date-ranged. Deliberately large (hundreds of letters):
  //    documents the structural limit of top-K retrieval on enumerative
  //    date questions (handoff §6.7), it is not expected to be "passed".
  {
    const docs = await briefs.find({ "datierung.am.j.v": 1563 }, { projection }).toArray();
    sets.push({
      name: "jahr_1563",
      description: "Letters dated to the year 1563",
      derivedFrom: { field: "datierung.am.j.v", value: 1563 },
      generatedAt,
      ...splitByVisibility(docs),
    });
  }

  for (const set of sets) {
    const file = path.join(FIXTURES_DIR, `${set.name}.json`);
    await writeFile(file, JSON.stringify(set, null, 2) + "\n", "utf8");
    console.log(`${set.name}: ${set.offen.length} offen + ${set.intern.length} intern -> ${file}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
