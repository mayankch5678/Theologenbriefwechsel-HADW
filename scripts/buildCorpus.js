// Read-only ETL: pulls letters ("Briefe") out of the local `letters` MongoDB
// database (already restored by the project's own mount_and_restore script)
// and flattens them into a clean JSONL corpus for retrieval.
//
// This script only ever *reads* from MongoDB. It never writes to the ThBw
// database or touches any file under ThBw/ or dataset/.
//
// Every ThBw field is wrapped as { m: <edit metadata>, v: <actual value> }.
// unwrap() strips that envelope down to the plain value.

import { MongoClient } from "mongodb";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = "letters";
const BASE_URL = "https://thbw.hadw-bw.de/brief/";

function unwrap(field) {
  if (field && typeof field === "object" && "v" in field) return field.v;
  return field ?? null;
}

function unwrapArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(unwrap).filter((v) => v !== null && v !== undefined && v !== "");
}

// Roughly 17k of the 36.5k letters carry no scholarly summary (regest) at all.
// Embedding those on `long` alone leaves them hard to reach with natural-language
// questions, so we synthesise a one-line German abstract out of the structured
// metadata instead. Records built this way are flagged with regestSynthetic:true
// so downstream code can tell them apart from editorial prose.
function synthesizeRegest({
  textsorte,
  senders,
  recipients,
  placesSent,
  placesReceived,
  dateDisplay,
  dateIso,
  keywordSubjects,
}) {
  const kind = textsorte || "Brief";

  const head = [kind];
  if (senders.length) head.push(`von ${senders.join(" und ")}`);
  if (recipients.length) head.push(`an ${recipients.join(" und ")}`);

  const context = [];
  if (placesSent.length) context.push(placesSent.join(" / "));
  else if (placesReceived.length) context.push(`Zielort ${placesReceived.join(" / ")}`);
  const date = dateDisplay || dateIso;
  if (date) context.push(date);

  let sentence = [head.join(" "), ...context].join(", ") + ".";
  if (keywordSubjects.length) sentence += ` Themen: ${keywordSubjects.join(", ")}.`;
  return sentence;
}

async function main() {
  const client = new MongoClient(MONGO_URI, { readPreference: "primary" });
  await client.connect();
  const db = client.db(DB_NAME);
  console.log("Connected (read-only) to MongoDB database:", DB_NAME);

  // Pre-load small reference collections into id -> label maps so we can
  // resolve schlagworte/textsorte ObjectId references without N+1 queries.
  console.log("Loading reference collections (people, orts, saches, sachgruppes, textsortes)...");
  const [people, orts, saches, sachgruppes, textsortes] = await Promise.all([
    db.collection("people").find({}, { projection: { short: 1, weiblich: 1, namen: 1, kollektiv: 1 } }).toArray(),
    db.collection("orts").find({}, { projection: { short: 1 } }).toArray(),
    db.collection("saches").find({}, { projection: { short: 1, alternativen: 1, typ: 1 } }).toArray(),
    db.collection("sachgruppes").find({}, { projection: { short: 1 } }).toArray(),
    db.collection("textsortes").find({}, { projection: { short: 1 } }).toArray(),
  ]);
  const nameMap = new Map();
  for (const coll of [people, orts, saches, textsortes]) {
    for (const doc of coll) {
      nameMap.set(String(doc._id), unwrap(doc.short));
    }
  }
  // Letters do not reference people directly: verfasser[].person.v and
  // schlagworte.personen[] hold ids from the `zitiernames` collection (a
  // person's citation-name variants), and each person lists its variants in
  // people.namen[]. Invert that so a citation-name id resolves to the person
  // record — which is where gender (weiblich) and the stable person id live.
  // (Before this map existed, keywordPeople was silently empty on every
  // letter: the ids never matched anything in `people`.)
  const personByZitiername = new Map();
  for (const doc of people) {
    for (const z of doc.namen || []) personByZitiername.set(String(z), doc);
  }
  // Subject thesaurus entries carry a category (typ -> sachgruppes: Ereignis,
  // Bibelstelle, Drucktitel, ...). Carried per subject so archive-level
  // questions ("which event is discussed most often", "which Bible passage
  // is cited most with the Eucharist") can be answered by counting tags of
  // one category instead of guessing from a top-K sample.
  const sachgruppeName = new Map(sachgruppes.map((g) => [String(g._id), unwrap(g.short)]));
  const subjectGroup = new Map();
  for (const doc of saches) {
    const typ = unwrap(doc.typ);
    subjectGroup.set(String(doc._id), typ ? sachgruppeName.get(String(typ)) || null : null);
  }
  // The subject thesaurus carries a hand-curated synonym ring per subject
  // (alternativen[].text.v — Latin and early-modern German variant labels,
  // e.g. "Catechesis Palatina" for "Heidelberger Katechismus"). The keyword
  // retriever indexes these alongside the display label, so a question using
  // a period form still hits the letters tagged with the modern label.
  const subjectAltMap = new Map();
  for (const doc of saches) {
    const variants = (doc.alternativen || [])
      .map((a) => unwrap(a?.text))
      .filter((v) => typeof v === "string" && v.trim());
    if (variants.length) subjectAltMap.set(String(doc._id), variants);
  }
  console.log(`Loaded ${nameMap.size} reference labels, ${subjectAltMap.size} subjects with synonym variants.`);

  const resolveRefs = (arr) =>
    unwrapArray(arr)
      .map((id) => nameMap.get(String(id)))
      .filter(Boolean);
  // Correspondent side (verfasser / adressat): display name as before, plus
  // the resolved person record for id and gender.
  const resolveSide = (arr) => {
    const entries = unwrapArray(arr);
    const names = entries.map((v) => v?.nameMitAmt?.combi).filter(Boolean);
    const persons = entries
      .map((v) => personByZitiername.get(String(unwrap(v?.person) ?? "")))
      .filter(Boolean);
    return {
      names,
      ids: [...new Set(persons.map((p) => String(p._id)))],
      female: persons.some((p) => unwrap(p.weiblich) === true),
    };
  };

  const cursor = db.collection("briefs").find({});
  const total = await db.collection("briefs").countDocuments();
  console.log(`Processing ${total} letters...`);

  const records = [];
  // Full primary-source text goes to a sidecar file consumed by
  // buildChunkIndex.js — keeping corpus.jsonl (loaded whole into server
  // memory) free of 9.4M chars of transcription.
  const fulltext = [];
  let i = 0;
  let withRegest = 0;
  let synthesized = 0;

  for await (const doc of cursor) {
    i++;
    if (i % 5000 === 0) console.log(`  ${i}/${total}`);

    const shortId = unwrap(doc.short);
    if (!shortId) continue;

    const sichtbar = unwrap(doc.sichtbar) || "unbekannt";
    const long = unwrap(doc.long) || "";
    const rawRegest = (unwrap(doc.regest?.text) || "").trim() || null;
    const dateIso = doc.datierung?.iso?.v ? new Date(doc.datierung.iso.v).toISOString().slice(0, 10) : null;
    const dateDisplay = unwrap(doc.datierung?.schoen) || null;

    const senderSide = resolveSide(doc.verfasser);
    const recipientSide = resolveSide(doc.adressat);
    const senders = senderSide.names;
    const recipients = recipientSide.names;
    const placesSent = unwrapArray(doc.absendeort).map((v) => unwrap(v?.name)).filter(Boolean);
    const placesReceived = unwrapArray(doc.zielortName);

    const keywordPeople = unwrapArray(doc.schlagworte?.personen)
      .map((id) => unwrap(personByZitiername.get(String(id))?.short))
      .filter(Boolean);
    const keywordPlaces = resolveRefs(doc.schlagworte?.orte);
    const keywordSubjectIds = unwrapArray(doc.schlagworte?.sachen).filter((id) => nameMap.has(String(id)));
    const keywordSubjects = keywordSubjectIds.map((id) => nameMap.get(String(id)));
    // Parallel to keywordSubjects: the subject category or null.
    const keywordSubjectGroups = keywordSubjectIds.map((id) => subjectGroup.get(String(id)) ?? null);
    // Synonym-ring labels for this letter's subjects. Kept out of `text` so
    // existing embeddings stay valid — only the keyword index reads them.
    const subjectVariants = [
      ...new Set(
        unwrapArray(doc.schlagworte?.sachen).flatMap((id) => subjectAltMap.get(String(id)) || [])
      ),
    ];

    const textsorte = doc.textsorte?.v ? nameMap.get(String(doc.textsorte.v)) : null;
    const cmif = unwrap(doc.cmif) || null;
    const url = BASE_URL + shortId;

    // Primary-source text. 2,215 letters have a verbatim transcription and
    // 31k an incipit — previously discarded entirely (the old "empty across
    // the whole DB" claim was wrong). They are NOT mixed into the embedded
    // `text`: early-modern German/Latin dilutes the modern-German regest
    // signal (a lesson the parallel rag/ project learned the hard way).
    // Instead they ride along on the record so the answer context can show
    // the model actual primary-source evidence for its citations.
    // Some records carry non-string values in these fields — guard the type.
    const asString = (x) => (typeof x === "string" ? x.trim() : "");
    const incipit = asString(unwrap(doc.incipit)) || null;
    const erlaeuterung = asString(unwrap(doc.erlaeuterung)) || null;
    const volltextFull = asString(unwrap(doc.transkription?.volltext));
    const volltext = volltextFull ? volltextFull.slice(0, 1500) : null;
    if (volltextFull || erlaeuterung) {
      fulltext.push({ id: shortId, sichtbar, volltext: volltextFull || null, erlaeuterung });
    }

    // Every record gets a regest: the editorial one where it exists, otherwise
    // a synthetic metadata abstract, so no letter ends up without searchable text.
    const regestSynthetic = !rawRegest;
    const regest = rawRegest
      ? rawRegest
      : synthesizeRegest({
          textsorte,
          senders,
          recipients,
          placesSent,
          placesReceived,
          dateDisplay,
          dateIso,
          keywordSubjects,
        });
    if (rawRegest) withRegest++;
    else synthesized++;

    // The text actually embedded/searched.
    const textParts = [long, regest];
    if (keywordSubjects.length) textParts.push("Schlagworte: " + keywordSubjects.join(", "));
    // keywordPeople is deliberately NOT part of `text`: it only started
    // resolving with the zitiername map, and adding it would change the
    // embedded text of ~14k letters and force a full re-embed. Revisit
    // together with the next build:index run.
    if (keywordPlaces.length) textParts.push("Erwähnte Orte: " + keywordPlaces.join(", "));

    records.push({
      id: shortId,
      url,
      sichtbar,
      long,
      textsorte,
      dateIso,
      dateDisplay,
      senders,
      recipients,
      senderIds: senderSide.ids,
      recipientIds: recipientSide.ids,
      senderFemale: senderSide.female,
      recipientFemale: recipientSide.female,
      placesSent,
      placesReceived,
      regest,
      regestSynthetic,
      keywordPeople,
      keywordPlaces,
      keywordSubjects,
      keywordSubjectGroups,
      subjectVariants,
      cmif,
      incipit,
      erlaeuterung,
      volltext, // first 1500 chars of the verbatim transcription
      volltextLength: volltextFull.length || 0,
      hasFullText: Boolean(volltextFull),
      text: textParts.join("\n"),
    });
  }

  await client.close();

  const outDir = path.join(__dirname, "..", "data");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "corpus.jsonl");
  await writeFile(outFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const fulltextFile = path.join(outDir, "fulltext.jsonl");
  await writeFile(fulltextFile, fulltext.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  console.log(`\nWrote ${records.length} letters to ${outFile}`);
  console.log(`Wrote ${fulltext.length} letters with transcription/commentary to ${fulltextFile}`);
  console.log(`  with regest (scholarly summary): ${withRegest}`);
  console.log(`  with synthetic metadata abstract: ${synthesized}`);
  const offen = records.filter((r) => r.sichtbar === "offen").length;
  console.log(`  offen (public): ${offen}, intern: ${records.length - offen}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
