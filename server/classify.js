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

import { readFile, appendFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const SYNC_MAX = Number(process.env.CLASSIFY_SYNC_MAX || 300);
// DeepSeek throttles per account by REQUESTS, not tokens: the first ~50 calls
// answer in ~1.7 s, sustained load queues every call for 30–60 s whatever the
// concurrency (measured 2026-09-11: 1 req/s with 40 in flight). A request
// with 10 regests takes as long as one with 1, so letters are packed.
const CONCURRENCY = Number(process.env.CLASSIFY_CONCURRENCY || 40);
const BATCH = Number(process.env.CLASSIFY_BATCH || 10);
const REGEST_MAX_CHARS = 3000;
const GROUPS_MAX = 40;
const EXAMPLES_PER_LABEL = 3;
const NO_LABEL = "nicht_bestimmbar";
const STOP = new Set("der die das des dem den ein eine einer eines einem einen und oder in im auf zu zur zum von vom mit bei für an am ist sind wird werden ob oder als auch nicht eher mehr bzw zwischen dieser diesem dieses brief absender zeigt zeigen sich eine haltung".split(" "));
const normalizeWords = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.replace(/(en|er|es|em|e|s)$/, ""));

export function createClassifier({ records, publicIndices, dataDir, llms, fieldValues }) {
  // Cache identity: the set of models that may have labelled a letter.
  const model = llms.map((l) => l.model).sort().join("+");
  const dir = path.join(dataDir, "classify");
  const jobs = new Map(); // key -> { key, criterion, total, done, started, finished, error }
  const byId = new Map();
  for (const i of publicIndices) byId.set(String(records[i].id), i);

  const keyOf = (criterion, labels) =>
    createHash("sha1").update(JSON.stringify({ criterion, labels: labels.map((l) => [l.name, l.description]), model })).digest("hex").slice(0, 16);

  // The agent re-phrases the criterion on every question ("Zeigt der Absender
  // eine Haltung …" vs "Ist der Absender … bedacht"), and an exact-text key
  // would start the archive over each time. A cache whose label names are
  // the same and whose criterion shares most content words is the same
  // question: reuse the largest such cache instead of a new key.
  const words = (t) => new Set(normalizeWords(t));
  const jaccard = (a, b) => {
    const inter = [...a].filter((w) => b.has(w)).length;
    return inter / (new Set([...a, ...b]).size || 1);
  };
  // Label names differ between questions too ("versoehnlich" vs
  // "versoehnung_ausgleich"); labels are matched by their descriptions,
  // one-to-one, and the cache's own names are mapped to the new ones.
  function mapLabels(theirs, mine) {
    if (!theirs || theirs.length !== mine.length) return null;
    const map = {};
    const used = new Set();
    for (const m of mine) {
      let best = null;
      for (const t of theirs) {
        if (used.has(t.name)) continue;
        const j = jaccard(words(`${t.name} ${t.description}`), words(`${m.name} ${m.description}`));
        if (!best || j > best.j) best = { name: t.name, j };
      }
      if (!best || best.j < 0.2) return null;
      used.add(best.name);
      map[best.name] = m.name;
    }
    return map;
  }
  async function resolveKey(criterion, labels) {
    const exact = keyOf(criterion, labels);
    if (existsSync(path.join(dir, `${exact}.jsonl`))) return { key: exact, map: null };
    if (!existsSync(dir)) return { key: exact, map: null };
    const mine = words(criterion);
    let best = null;
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".meta.json")) continue;
      let meta;
      try { meta = JSON.parse(await readFile(path.join(dir, f), "utf8")); } catch { continue; }
      if (jaccard(mine, words(meta.criterion || "")) < 0.4) continue;
      const map = mapLabels(meta.labels, labels);
      if (!map) continue;
      const lines = existsSync(path.join(dir, `${meta.key}.jsonl`)) ? (await readFile(path.join(dir, `${meta.key}.jsonl`), "utf8")).split("\n").filter(Boolean).length : 0;
      if (!best || lines > best.lines) best = { key: meta.key, lines, map };
    }
    return best ? { key: best.key, map: best.map } : { key: exact, map: null };
  }

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
      `Jedes Label außer "${NO_LABEL}" muss mit einem wörtlichen Zitat aus dem jeweiligen Regest belegt werden (höchstens 15 Wörter). ` +
      `Ohne belegendes Zitat: "${NO_LABEL}". Im Zweifel "${NO_LABEL}".\n` +
      `Du erhältst mehrere Regesten, jedes mit seiner Brief-Nummer. Beurteile jedes für sich. ` +
      `Antworte NUR mit JSON: {"ergebnisse":[{"id":"<Brief-Nummer>","label":"<Label>","zitat":"<wörtlich aus dem Regest oder leer>"}, …]} — genau ein Eintrag pro Brief-Nummer, keine weiteren Felder.`
    );
  }

  // One request, several letters. Returns a Map id -> result for the letters
  // the model answered; missing ones are retried by the caller in a smaller
  // batch (a truncated JSON answer loses the tail, never the head).
  async function classifyMany(rs, system, allowed, llm) {
    const { client, model, extra } = llm;
    const user = rs
      .map(
        (r) =>
          `### Brief ${r.id}: ${r.long}\n` +
          (r.keywordSubjects?.length ? `Schlagworte der Editoren: ${r.keywordSubjects.slice(0, 12).join("; ")}\n` : "") +
          `Regest: ${r.regest.slice(0, REGEST_MAX_CHARS)}`
      )
      .join("\n\n");
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const completion = await client.chat.completions.create({
          ...extra,
          model,
          temperature: 0,
          max_tokens: 90 * rs.length + 100,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        });
        const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
        const out = new Map();
        for (const e of Array.isArray(parsed.ergebnisse) ? parsed.ergebnisse : []) {
          const id = String(e?.id ?? "").trim();
          if (!rs.some((r) => String(r.id) === id) || out.has(id)) continue;
          let label = typeof e.label === "string" ? e.label.trim() : NO_LABEL;
          if (!allowed.has(label)) label = NO_LABEL;
          const zitat = typeof e.zitat === "string" ? e.zitat.trim().slice(0, 240) : "";
          if (label !== NO_LABEL && !zitat) label = NO_LABEL;
          out.set(id, { id, label, zitat, model });
        }
        return out;
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
  async function runBatch(key, todo, criterion, labels, job, toOld = (x) => x) {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${key}.jsonl`);
    const system = prompt(criterion, labels);
    const allowed = new Set([...labels.map((l) => l.name), NO_LABEL]);
    const groups = [];
    for (let k = 0; k < todo.length; k += BATCH) groups.push(todo.slice(k, k + BATCH).map((i) => records[i]));
    let g = 0;
    let failures = 0;
    const handle = async (rs, llm) => {
      try {
        const got = await classifyMany(rs, system, allowed, llm);
        const lines = rs.filter((r) => got.has(String(r.id))).map((r) => JSON.stringify({ ...got.get(String(r.id)), label: toOld(got.get(String(r.id)).label) }));
        if (lines.length) await appendFile(file, lines.join("\n") + "\n");
        const missing = rs.filter((r) => !got.has(String(r.id)));
        if (job) job.done += rs.length - missing.length;
        // Answer lost some letters (truncated JSON, dropped id): halve and retry.
        if (missing.length && rs.length > 1) {
          const half = Math.ceil(missing.length / 2);
          await handle(missing.slice(0, half), llm);
          if (missing.length > half) await handle(missing.slice(half), llm);
        } else if (missing.length) {
          failures += missing.length;
          if (job) job.done += missing.length;
        }
      } catch (err) {
        failures += rs.length;
        if (job) job.done += rs.length;
        if (failures > 200 && failures > job?.done * 0.3) throw err; // the provider is down, not one bad batch
      }
    };
    // Workers are bound round-robin to the providers in the pool; each
    // provider serialises its own requests, so the pool adds up.
    const worker = async (k) => {
      const llm = llms[k % llms.length];
      while (g < groups.length) await handle(groups[g++], llm);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, (_, k) => worker(k)));
    return failures;
  }

  function aggregate(cache, indices, labels, groupBy, minLetters, toNew = (x) => x) {
    const labelNames = [...labels.map((l) => l.name), NO_LABEL];
    const totals = Object.fromEntries(labelNames.map((n) => [n, 0]));
    const groups = new Map();
    let classified = 0;
    for (const i of indices) {
      const r = records[i];
      const raw = cache.get(String(r.id));
      if (!raw) continue;
      const c = { ...raw, label: labelNames.includes(toNew(raw.label)) ? toNew(raw.label) : NO_LABEL };
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
    const { key, map } = await resolveKey(criterion, labels);
    const toNew = map ? (x) => map[x] ?? x : (x) => x;
    const inverse = map ? Object.fromEntries(Object.entries(map).map(([o, n]) => [n, o])) : null;
    const toOld = inverse ? (x) => inverse[x] ?? x : (x) => x;
    const scope = indices.filter((i) => !records[i].regestSynthetic);
    const withoutRegest = indices.length - scope.length;
    const cache = await readCache(key);
    const todo = scope.filter((i) => !cache.has(String(records[i].id)));

    let job = jobs.get(key);
    let status = "fertig";
    const otherRunning = [...jobs.values()].find((j) => !j.finished && j.key !== key);
    if (todo.length && otherRunning && todo.length > SYNC_MAX) {
      // The account-wide request budget is the bottleneck: a second archive-
      // wide job would only halve both. Report and let the first finish.
      return {
        status: "warte",
        kriterium: criterion,
        hinweis: `Ein anderer Hintergrundauftrag läuft bereits (${otherRunning.done}/${otherRunning.total}: „${otherRunning.criterion.slice(0, 80)}“). Kein zweiter gestartet — nicht mit Varianten des Kriteriums erneut aufrufen; dieselbe Frage später erneut stellen.`,
        briefe_im_umfang: indices.length,
        klassifiziert: 0,
      };
    }
    if (todo.length && !(job && !job.finished)) {
      if (todo.length <= SYNC_MAX && wait) {
        const failures = await runBatch(key, todo, criterion, labels, null, toOld);
        if (failures) status = `fertig (${failures} Briefe wegen API-Fehlern nicht klassifiziert)`;
      } else {
        job = { key, criterion, total: todo.length, done: 0, started: new Date().toISOString(), finished: null, error: null };
        jobs.set(key, job);
        runBatch(key, todo, criterion, labels, job, toOld)
          .then(() => { job.finished = new Date().toISOString(); })
          .catch((err) => { job.finished = new Date().toISOString(); job.error = String(err?.message || err); });
      }
      if (!existsSync(path.join(dir, `${key}.meta.json`))) {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, `${key}.meta.json`), JSON.stringify({ key, criterion, labels, model, group_by, started: new Date().toISOString() }, null, 1));
      }
    }
    const fresh = todo.length && (!job || !job.finished) ? await readCache(key) : cache;
    if (job && !job.finished) status = "laeuft";
    const agg = aggregate(fresh, scope, labels, group_by, min_letters, toNew);
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
