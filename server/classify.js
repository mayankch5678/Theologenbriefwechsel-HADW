// classify_letters — map-reduce reading of regests with a criterion the
// agent defines at question time.
//
// Questions like "which authors lean towards reconciliation rather than
// demarcation" cannot be answered from a retrieved sample: the answer lives
// in every letter. Tag counting measures the topic, not the stance (a
// letter tagged "Versöhnung" can be a letter mocking reconciliation), and
// a sample of 30 letters without the relevant tags still showed a stance in
// 4 of them — so a tag pre-filter misses roughly 40% of the evidence
// (measured 2026-09-11). Hence: read every regest in scope, one model call
// per letter (map), then aggregate per author (reduce).
//
// - Labels come from the agent (2–5 names + descriptions); the model may
//   also answer "nicht_bestimmbar" and must quote the regest for any other
//   label — no quote, no label. Only editorial regests are read; letters
//   with a synthesised abstract are reported as not classifiable.
// - Results are cached per (criterion, labels, model) in data/classify/,
//   append-only, so a repeated or narrowed question is instant.
// - Up to SYNC_MAX letters are classified within the call; larger sets run
//   as a background job in this process (progress via jobs()), and the call
//   returns the partial aggregate with the coverage stated.

import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const SYNC_MAX = Number(process.env.CLASSIFY_SYNC_MAX || 300);
const CONCURRENCY = Number(process.env.CLASSIFY_CONCURRENCY || 20);
const REGEST_MAX_CHARS = 3000;
const GROUPS_MAX = 40;
const EXAMPLES_PER_LABEL = 3;
const NO_LABEL = "nicht_bestimmbar";

export function createClassifier({ records, publicIndices, dataDir, client, model, extra = {}, fieldValues }) {
  const dir = path.join(dataDir, "classify");
  const jobs = new Map(); // key -> { key, criterion, total, done, started, finished, error }
  const byId = new Map();
  for (const i of publicIndices) byId.set(String(records[i].id), i);

  const keyOf = (criterion, labels) =>
    createHash("sha1").update(JSON.stringify({ criterion, labels: labels.map((l) => [l.name, l.description]), model })).digest("hex").slice(0, 16);

  async function readCache(key) {
    const file = path.join(dir, `${key}.jsonl`);
    const out = new Map();
    if (!existsSync(file)) return out;
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        out.set(d.id, d);
      } catch {
        /* partial line from a crash — ignored, re-classified */
      }
    }
    return out;
  }

  function prompt(criterion, labels) {
    const list = [...labels.map((l) => `- "${l.name}": ${l.description}`), `- "${NO_LABEL}": das Regest gibt dazu nichts her (berichtet nur Inhalte/Ereignisse, oder der Brief betrifft die Frage gar nicht).`].join("\n");
    return (
      `Du liest das editorische Regest (Zusammenfassung der Editoren) eines Briefs aus dem Briefarchiv der Theologenbriefwechsel (Südwesten des Reichs, 1550–1620). ` +
      `Beurteile AUSSCHLIESSLICH anhand des Regest-Wortlauts — kein eigenes historisches Wissen, keine Vermutung über den Absender.\n\n` +
      `Kriterium: ${criterion}\n\nMögliche Labels:\n${list}\n\n` +
      `Jedes Label außer "${NO_LABEL}" muss mit einem wörtlichen Zitat aus dem Regest belegt werden (höchstens 15 Wörter). ` +
      `Ohne belegendes Zitat: "${NO_LABEL}". Im Zweifel "${NO_LABEL}".\n` +
      `Antworte NUR mit JSON: {"label":"<Label>","zitat":"<wörtlich aus dem Regest oder leer>","begruendung":"<ein Satz>"}`
    );
  }

  async function classifyOne(r, system, allowed) {
    const user =
      `Brief ${r.id}: ${r.long}\n` +
      (r.keywordSubjects?.length ? `Schlagworte der Editoren: ${r.keywordSubjects.slice(0, 15).join("; ")}\n` : "") +
      `\nRegest:\n${r.regest.slice(0, REGEST_MAX_CHARS)}`;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const completion = await client.chat.completions.create({
          ...extra,
          model,
          temperature: 0,
          max_tokens: 400,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        });
        const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
        let label = typeof parsed.label === "string" ? parsed.label.trim() : NO_LABEL;
        if (!allowed.has(label)) label = NO_LABEL;
        const zitat = typeof parsed.zitat === "string" ? parsed.zitat.trim().slice(0, 240) : "";
        if (label !== NO_LABEL && !zitat) label = NO_LABEL;
        return { id: String(r.id), label, zitat, begruendung: typeof parsed.begruendung === "string" ? parsed.begruendung.slice(0, 300) : "" };
      } catch (err) {
        lastErr = err;
        const wait = err?.status === 429 ? 5000 * (attempt + 1) : 1500 * (attempt + 1);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
    throw lastErr;
  }

  // Classifies `todo` (record indices) into the cache file; shared by the
  // synchronous path and the background job.
  async function runBatch(key, todo, criterion, labels, job) {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${key}.jsonl`);
    const system = prompt(criterion, labels);
    const allowed = new Set([...labels.map((l) => l.name), NO_LABEL]);
    let i = 0;
    let failures = 0;
    const worker = async () => {
      while (i < todo.length) {
        const r = records[todo[i++]];
        try {
          const res = await classifyOne(r, system, allowed);
          await appendFile(file, JSON.stringify(res) + "\n");
        } catch (err) {
          failures++;
          if (failures > 50 && failures > i * 0.2) throw err; // the provider is down, not one bad letter
        }
        if (job) job.done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
    return failures;
  }

  function aggregate(cache, indices, labels, groupBy, minLetters) {
    const labelNames = [...labels.map((l) => l.name), NO_LABEL];
    const totals = Object.fromEntries(labelNames.map((n) => [n, 0]));
    const groups = new Map();
    let classified = 0;
    for (const i of indices) {
      const r = records[i];
      const c = cache.get(String(r.id));
      if (!c) continue;
      classified++;
      totals[c.label] = (totals[c.label] || 0) + 1;
      for (const g of new Set(fieldValues(r, groupBy))) {
        let entry = groups.get(g);
        if (!entry) groups.set(g, (entry = { wert: g, briefe: 0, bestimmbar: 0, labels: Object.fromEntries(labelNames.map((n) => [n, 0])), beispiele: {} }));
        entry.briefe++;
        entry.labels[c.label]++;
        if (c.label !== NO_LABEL) {
          entry.bestimmbar++;
          const ex = (entry.beispiele[c.label] ||= []);
          if (ex.length < EXAMPLES_PER_LABEL) ex.push({ id: String(r.id), datum: r.dateDisplay || r.dateIso, zitat: c.zitat });
        }
      }
    }
    const rows = [...groups.values()]
      .filter((g) => g.bestimmbar >= minLetters)
      .map((g) => ({
        ...g,
        anteile: Object.fromEntries(labels.map((l) => [l.name, g.bestimmbar ? Number((g.labels[l.name] / g.bestimmbar).toFixed(2)) : 0])),
      }))
      .sort((a, b) => b.bestimmbar - a.bestimmbar);
    return { classified, totals, gruppen_gesamt: rows.length, gruppen: rows.slice(0, GROUPS_MAX) };
  }

  async function classify({ criterion, labels, indices, group_by = "sender", min_letters = 5, wait = true }) {
    if (!criterion || typeof criterion !== "string") return { error: "criterion fehlt" };
    if (!Array.isArray(labels) || labels.length < 2 || labels.length > 5 || !labels.every((l) => l && typeof l.name === "string" && typeof l.description === "string")) {
      return { error: "labels: 2–5 Einträge mit name und description nötig" };
    }
    labels = labels
      .map((l) => ({ name: l.name.trim().replace(/\s+/g, "_").toLowerCase(), description: l.description.trim() }))
      .filter((l) => l.name !== NO_LABEL && !/^(neutral|unklar|unbestimmt|keine)$/.test(l.name)); // always present implicitly
    if (labels.length < 2) return { error: "mindestens 2 inhaltliche Labels nötig (nicht_bestimmbar gibt es immer zusätzlich)" };
    const key = keyOf(criterion, labels);
    const scope = indices.filter((i) => !records[i].regestSynthetic);
    const withoutRegest = indices.length - scope.length;
    const cache = await readCache(key);
    const todo = scope.filter((i) => !cache.has(String(records[i].id)));

    let job = jobs.get(key);
    let status = "fertig";
    if (todo.length && !(job && !job.finished)) {
      if (todo.length <= SYNC_MAX && wait) {
        const failures = await runBatch(key, todo, criterion, labels, null);
        if (failures) status = `fertig (${failures} Briefe wegen API-Fehlern nicht klassifiziert)`;
      } else {
        job = { key, criterion, total: todo.length, done: 0, started: new Date().toISOString(), finished: null, error: null };
        jobs.set(key, job);
        runBatch(key, todo, criterion, labels, job)
          .then(() => { job.finished = new Date().toISOString(); })
          .catch((err) => { job.finished = new Date().toISOString(); job.error = String(err?.message || err); });
        await writeFile(path.join(dir, `${key}.meta.json`), JSON.stringify({ key, criterion, labels, model, group_by, started: job.started }, null, 1));
      }
    }
    const fresh = todo.length && (!job || !job.finished) ? await readCache(key) : cache;
    if (job && !job.finished) status = "laeuft";
    const agg = aggregate(fresh, scope, labels, group_by, min_letters);
    const remaining = scope.length - agg.classified;
    const rate = job && job.done ? job.done / ((Date.now() - Date.parse(job.started)) / 1000) : 0;
    return {
      status,
      kriterium: criterion,
      labels,
      gruppiert_nach: group_by,
      briefe_im_umfang: indices.length,
      ohne_regest_nicht_klassifizierbar: withoutRegest,
      klassifiziert: agg.classified,
      ausstehend: remaining,
      ...(status === "laeuft"
        ? { hinweis: `Hintergrundauftrag läuft (${job.done}/${job.total}${rate ? `, ~${Math.max(1, Math.round(remaining / rate / 60))} min`: ""}). Die Zahlen unten sind ein ZWISCHENSTAND über ${agg.classified} Briefe — das in der Antwort sagen; dieselbe Frage später erneut stellen liefert das vollständige Ergebnis.` }
        : { hinweis: "Labels beruhen ausschließlich auf dem Regest-Wortlaut; jedes Label ist mit einem Zitat belegt. Anteile beziehen sich auf die bestimmbaren Briefe der Gruppe." }),
      verteilung_gesamt: agg.totals,
      mindestens_bestimmbare_briefe_pro_gruppe: min_letters,
      gruppen_gesamt: agg.gruppen_gesamt,
      gruppen: agg.gruppen,
    };
  }

  const list = () => [...jobs.values()].map((j) => ({ ...j, rate: j.done && !j.finished ? Number((j.done / ((Date.now() - Date.parse(j.started)) / 1000)).toFixed(1)) : undefined }));

  return { classify, jobs: list, SYNC_MAX };
}
