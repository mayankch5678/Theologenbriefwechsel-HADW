// Agentic layer over the same in-memory indexes that /api/chat uses.
//
// /api/chat is one shot: retrieve once, hand the model a fixed context,
// generate. That cannot answer archive-level questions ("which event is
// discussed most often", "letters written by women", "Bible passages cited
// with the Eucharist") — no top-K sample stands in for the whole archive.
// Here the model drives: it calls deterministic tools (metadata filter,
// group-by count, value lookup, full-letter read) and the existing hybrid
// search, sees the results, and decides the next step. Every tool walks
// publicIndices only, so `intern` letters can no more leak here than in
// /api/chat. The citation guard is the same: an answer may cite only ids
// that some tool result actually contained.
//
// Kept out of server.js on purpose: the one-shot path and its eval stay
// untouched; this module receives the loaded indexes at startup.

import { readFile, appendFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 8);
const TOOL_RESULT_MAX_CHARS = 24000; // hard cap per tool message
const REGEST_SNIPPET = 260;
const VOLLTEXT_MAX = 8000;
const PAGE_MAX = 50;
const GROUPS_MAX = 50;
const SOURCES_MAX = 80;

const SUBJECT_GROUPS = [
  "Ereignis", "Bibelstelle", "Drucktitel", "Werktitel/zitat",
  "Werktitel/zitat (Antike/Mittelalter)", "Menschengruppe", "Handlung",
  "Institution", "Amtsbezeichnung", "Eigenschaft", "Theol. Locus",
  "Qualifizierung", "Rechtskorpus(zitat)", "Vertrag", "Einzelwesen", "Streit",
  "Disziplin", "Denkrichtung", "Bündnis", "Stamm",
];

const FILTER_PROPERTIES = {
  sender: { type: "string", description: "Teilstring des Absendernamens (z.B. 'Brenz', 'Olevian')." },
  recipient: { type: "string", description: "Teilstring des Empfängernamens." },
  correspondent: { type: "string", description: "Teilstring eines Namens auf Absender- ODER Empfängerseite." },
  sender_female: { type: "boolean", description: "true = mindestens ein Absender ist laut Personenregister weiblich." },
  recipient_female: { type: "boolean", description: "true = mindestens ein Empfänger ist weiblich." },
  year_from: { type: "integer", description: "Frühestes Jahr (inklusive)." },
  year_to: { type: "integer", description: "Spätestes Jahr (inklusive)." },
  place_sent: { type: "string", description: "Teilstring des Absendeorts (z.B. 'Genf', 'Straßburg')." },
  place_received: { type: "string", description: "Teilstring des Zielorts." },
  subject: { type: "string", description: "Teilstring eines Sachschlagworts der Editoren (z.B. 'Abendmahl', 'Konzil von Trient'). Genaue Schreibweisen liefert list_values." },
  subject_group: { type: "string", enum: SUBJECT_GROUPS, description: "Kategorie, die mindestens ein Schlagwort des Briefs haben muss." },
  keyword_person: { type: "string", description: "Teilstring einer im Brief erwähnten Person (Schlagwort Personen)." },
  keyword_place: { type: "string", description: "Teilstring eines im Brief erwähnten Orts (Schlagwort Orte)." },
  regest_contains: { type: "string", description: "Wort oder Wortgruppe, die wörtlich im editorischen Regest vorkommt (nur Briefe mit echtem Regest)." },
  has_regest: { type: "boolean", description: "true = nur Briefe mit editorischem Regest; false = nur Briefe ohne (reine Metadaten)." },
  has_volltext: { type: "boolean", description: "true = nur Briefe mit Transkription des Originaltexts." },
  land_sent: { type: "string", description: "Land/Region des Absendeorts (Teilstring, z.B. 'Frankreich', 'Eidgenossenschaft', 'Italien', 'Reich'). Werte via list_values field='land'." },
  land_mentioned: { type: "string", description: "Land/Region eines im Brief erwähnten Orts oder des Zielorts (Teilstring)." },
  mentions_foreign: { type: "boolean", description: "true = der Brief erwähnt (Schlagwort Orte / Zielort) mindestens einen Ort außerhalb des deutschsprachigen Reichs — 'Ausland' aus deutscher Sicht (Eidgenossenschaft, Niederlande, Frankreich, Italien, England, Polen, Ungarn, Osmanisches Reich …)." },
  sent_from_foreign: { type: "boolean", description: "true = der Absendeort liegt außerhalb des deutschsprachigen Reichs." },
  regest_issue: { type: "boolean", description: "true = die Regest-Qualitätsprüfung (Batch, scripts/checkRegests.js) hat für diesen Brief einen formalen Mangel gemeldet (unvollständiger Satz, Wortfehler, Tippfehler)." },
};

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_letters",
      description:
        "Inhaltliche Suche (Schlagworte, Regest-Text, Embedding-Ähnlichkeit) — für Themenfragen in natürlicher Sprache. " +
        "Liefert die relevantesten Briefe mit Trefferbegründung. NICHT für Zählungen oder 'am häufigsten' (dafür count_by) " +
        "und nicht für reine Metadatenfilter (dafür filter_letters).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Suchanfrage auf Deutsch, möglichst konkret (Begriffe, Namen, Ereignisse)." },
          limit: { type: "integer", description: "Max. Treffer (Standard 20, höchstens 40)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "filter_letters",
      description:
        "Deterministischer Metadatenfilter über das GESAMTE öffentliche Archiv (kein Sample). Alle angegebenen Bedingungen gelten zugleich (UND). " +
        "Liefert Gesamtzahl und eine Seite Briefe (chronologisch). Für 'alle Briefe von/an X', Jahresbereiche, Absendeorte, weibliche Absender, Briefe mit bestimmtem Schlagwort.",
      parameters: {
        type: "object",
        properties: {
          ...FILTER_PROPERTIES,
          limit: { type: "integer", description: `Briefe pro Seite (Standard 20, höchstens ${PAGE_MAX}).` },
          offset: { type: "integer", description: "Startposition für weitere Seiten." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "count_by",
      description:
        "Zählt Briefe gruppiert nach einem Feld — über das GESAMTE öffentliche Archiv oder die per Filter eingeschränkte Menge. " +
        "Das ist die einzige verlässliche Quelle für 'am häufigsten', 'wie viele', 'welche Ereignisse/Bibelstellen/Personen kommen am meisten vor'. " +
        "Beispiel: {by:'subject', subject_group:'Ereignis'} = die meistgenannten Ereignisse; " +
        "{by:'subject', subject_group:'Bibelstelle', filter:{subject:'Abendmahl'}} = Bibelstellen in Abendmahlsbriefen.",
      parameters: {
        type: "object",
        properties: {
          by: {
            type: "string",
            enum: ["subject", "subject_group", "sender", "recipient", "year", "decade", "place_sent", "place_received", "keyword_person", "keyword_place", "land_sent", "land_mentioned"],
            description: "Gruppierungsfeld. land_* = Land/Region des Absendeorts bzw. der erwähnten Orte (Ortsklassifikation).",
          },
          subject_group: { type: "string", enum: SUBJECT_GROUPS, description: "Nur bei by='subject': nur Schlagworte dieser Kategorie zählen." },
          filter: { type: "object", properties: FILTER_PROPERTIES, description: "Optionale Einschränkung der gezählten Briefe (wie filter_letters)." },
          top: { type: "integer", description: `Anzahl der häufigsten Gruppen (Standard 20, höchstens ${GROUPS_MAX}).` },
        },
        required: ["by"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_values",
      description:
        "Findet die genauen Schreibweisen von Schlagworten, Personen- oder Ortsnamen im Archiv (mit Anzahl Briefe). " +
        "Nützlich, bevor filter_letters/count_by mit einem Namen aufgerufen wird, oder um alle Varianten eines Begriffs zu sehen (z.B. contains:'Abendmahl').",
      parameters: {
        type: "object",
        properties: {
          field: { type: "string", enum: ["subject", "sender", "recipient", "place_sent", "place_received", "keyword_person", "keyword_place", "land"] },
          contains: { type: "string", description: "Teilstring (Groß-/Kleinschreibung egal)." },
          subject_group: { type: "string", enum: SUBJECT_GROUPS, description: "Nur bei field='subject'." },
          limit: { type: "integer", description: `Max. Werte (Standard 30, höchstens ${GROUPS_MAX}).` },
        },
        required: ["field"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "regest_issues",
      description:
        "Ergebnisse der Regest-Qualitätsprüfung: ein Batch-Lauf hat jedes editorische Regest auf formale Mängel geprüft — unvollständige/abgebrochene Sätze, doppelte oder fehlende Wörter, Tippfehler. " +
        "Liefert die betroffenen Briefe mit der beanstandeten Stelle. Für Fragen wie 'Briefe, deren Regesten unvollständige Sätze enthalten'. Nennt auch, wie viele Regesten bereits geprüft sind.",
      parameters: {
        type: "object",
        properties: {
          art: { type: "string", enum: ["unvollstaendig", "wortfehler", "tippfehler", "alle"], description: "Mangelart (Standard: alle)." },
          limit: { type: "integer", description: `Briefe pro Seite (Standard 25, höchstens ${PAGE_MAX}).` },
          offset: { type: "integer", description: "Startposition für weitere Seiten." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_letter",
      description:
        "Liest EINEN Brief vollständig: alle Metadaten, vollständiges Regest, alle Schlagworte (mit Kategorie), editorische Erläuterung und — falls vorhanden — die Transkription des Originaltexts. " +
        "Für Detailfragen, Zusammenfassungen und um Aussagen vor dem Zitieren zu prüfen.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Brief-Nummer, z.B. '18494'." } },
        required: ["id"],
      },
    },
  },
];

const SYSTEM_PROMPT = `Du bist ein Recherche-Assistent für das Briefarchiv der Theologenbriefwechsel im Südwesten des Reichs (1550–1620), Heidelberger Akademie der Wissenschaften. Du beantwortest Fragen, indem du Werkzeuge aufrufst, die das Archiv durchsuchen, filtern und zählen. Antworte in der Sprache der Frage (Deutsch, Englisch oder Französisch).

ARBEITSWEISE
- Überlege zuerst, welche Werkzeugkette die Frage beantwortet, und rufe dann die Werkzeuge auf. Mehrere Schritte sind normal (z.B. list_values → filter_letters → read_letter).
- Zählfragen ("am häufigsten", "wie viele", "welche ... am meisten") beantwortest du AUSSCHLIESSLICH mit count_by. Die Werkzeuge arbeiten über das gesamte öffentliche Archiv; ihre Zahlen sind vollständig und dürfen als solche genannt werden.
- Metadatenfragen (Absender, Empfänger, Zeitraum, Ort, Geschlecht, Schlagwort) beantwortest du mit filter_letters, nicht mit search_letters.
- Inhaltsfragen in natürlicher Sprache beantwortest du mit search_letters und prüfst wichtige Treffer mit read_letter.
- Schlagworte (Schlagworte der Editoren) sind das Urteil der Editoren über den Inhalt eines Briefs — ein Brief mit passendem Schlagwort behandelt das Thema, auch wenn das Regest den Begriff nicht wörtlich nennt.
- Wenn ein Werkzeug nichts liefert, formuliere um oder probiere einen anderen Weg (andere Schreibweise via list_values, anderes Feld), bevor du aufgibst.
- "Ausland"/"aus dem Ausland": zwei Wege, beide ausführen und beide Zahlen nennen — (a) Schlagworte "Nachrichten aus …" (list_values/filter_letters mit subject) und (b) die Ortsklassifikation: count_by({by:"land_mentioned", filter:{mentions_foreign:true}}) für die Verteilung nach Ländern und filter_letters({mentions_foreign:true}) für Beispiele. Formale Mängel in Regesten (unvollständige Sätze, Tippfehler) beantwortet regest_issues.

STRIKTE REGELN FÜR DIE ANTWORT
1. Jede Aussage über einen Brief wird mit seiner Nummer belegt, immer in der Form "Brief 18495" (auch in Tabellen und Listen: "Brief 18495", nie die nackte Zahl). Nenne AUSSCHLIESSLICH Brief-Nummern, die in den Werkzeugergebnissen vorkamen.
2. Sage nur, was Regest, Schlagworte, Metadaten oder Transkription hergeben. Keine historische Deutung, keine Hintergrundinformationen aus eigenem Wissen, keine Vermutungen über Motive oder Haltungen, die nicht im Regest stehen. Wenn eine Frage eine Deutung verlangt, die über die Quellen hinausgeht, sage das ausdrücklich und beschränke dich auf das Belegbare.
3. Unterscheide editorische Regesten von automatisch generierten Zusammenfassungen (im Werkzeugergebnis als "synthetisch" markiert) — letztere nur als "(nur Metadaten)" kennzeichnen.
4. Nenne bei Listen die Gesamtzahl aus dem Werkzeug und führe dann die Briefe auf (bei mehr als ~25 eine Auswahl mit Hinweis auf die Gesamtzahl). Bei "Welche Briefe ..." ist eine vollständige Aufzählung gewünscht, sofern sie unter ~40 bleibt.
5. Wenn die Daten eine Frage strukturell nicht beantworten können (fehlendes Feld, keine Treffer), sage das klar, statt zu raten. Fehlt etwa nur ein Teil (z.B. Ortszuordnung), erkläre, was du geprüft hast.
6. Kurz, präzise, ohne Floskeln. Beginne direkt mit der Antwort — keine Einleitung wie "Ich habe genug Daten", keine Entschuldigungen, keine Beschreibung deiner Werkzeugaufrufe.
7. Stelle keine Rückfragen und biete keine weiteren Schritte an ("Soll ich …?"). Wenn eine Prüfung sinnvoll ist, führe sie selbst mit den Werkzeugen aus, bevor du antwortest.
8. Schreibe die Antwort erst, wenn alle Werkzeugaufrufe abgeschlossen sind — kein Antworttext in derselben Nachricht wie ein Werkzeugaufruf. Die Antwort ist eine einzige, vollständige Nachricht.`;

export async function createAgent({ records, publicIndices, dataDir, hybridSearch, client, model, extractCitedIds, normalize }) {
  // ---- static lookups over public letters ----------------------------------
  const byId = new Map();
  for (const i of publicIndices) byId.set(String(records[i].id), i);

  // Full transcriptions live in a sidecar (corpus carries only 1,500 chars).
  const fulltextById = new Map();
  const ftFile = path.join(dataDir, "fulltext.jsonl");
  if (existsSync(ftFile)) {
    for (const line of (await readFile(ftFile, "utf8")).split("\n")) {
      if (!line) continue;
      const r = JSON.parse(line);
      if (r.sichtbar !== "intern") fulltextById.set(String(r.id), r);
    }
  }

  // Place classification (scripts/classifyPlaces.js): name -> { land, im_reich, sicher }.
  // Optional, reloaded when the file changes so a running batch shows up.
  const placesFile = path.join(dataDir, "places.json");
  let places = new Map();
  let placesMtime = 0;
  async function loadPlaces() {
    if (!existsSync(placesFile)) return;
    const m = (await stat(placesFile)).mtimeMs;
    if (m === placesMtime) return;
    places = new Map(Object.entries(JSON.parse(await readFile(placesFile, "utf8"))));
    placesMtime = m;
  }
  await loadPlaces();
  const landOf = (name) => places.get(name)?.land || null;
  const foreign = (name) => {
    const p = places.get(name);
    return p ? !p.im_reich : false;
  };
  const mentionedPlaces = (r) => [...new Set([...(r.keywordPlaces || []), ...(r.placesReceived || [])])];

  // Regest quality findings (scripts/checkRegests.js), same lazy reload.
  const regestFile = path.join(dataDir, "regest-check.jsonl");
  let regestIssues = new Map(); // id -> findings (only letters with findings)
  let regestChecked = 0;
  let regestMtime = 0;
  async function loadRegestIssues() {
    if (!existsSync(regestFile)) return;
    const m = (await stat(regestFile)).mtimeMs;
    if (m === regestMtime) return;
    const next = new Map();
    let n = 0;
    for (const line of (await readFile(regestFile, "utf8")).split("\n")) {
      if (!line) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      n++;
      const findings = [...(d.maengel || []), ...(d.heuristik || [])];
      if (findings.length && byId.has(d.id)) next.set(d.id, findings);
    }
    regestIssues = next;
    regestChecked = n;
    regestMtime = m;
  }
  await loadRegestIssues();
  const regestTotal = publicIndices.filter((i) => !records[i].regestSynthetic).length;

  const fieldValues = (r, field) => {
    switch (field) {
      case "subject": return r.keywordSubjects || [];
      case "subject_group": return [...new Set((r.keywordSubjectGroups || []).filter(Boolean))];
      case "sender": return r.senders || [];
      case "recipient": return r.recipients || [];
      case "year": return r.dateIso ? [r.dateIso.slice(0, 4)] : [];
      case "decade": return r.dateIso ? [r.dateIso.slice(0, 3) + "0er"] : [];
      case "place_sent": return r.placesSent || [];
      case "place_received": return r.placesReceived || [];
      case "keyword_person": return r.keywordPeople || [];
      case "keyword_place": return r.keywordPlaces || [];
      case "land_sent": return [...new Set((r.placesSent || []).map(landOf).filter(Boolean))];
      case "land_mentioned": return [...new Set(mentionedPlaces(r).map(landOf).filter(Boolean))];
      case "land": return [...new Set([...(r.placesSent || []), ...mentionedPlaces(r)].map(landOf).filter(Boolean))];
      default: return [];
    }
  };

  const has = (list, needle) => {
    const n = normalize(needle);
    return n ? list.some((v) => normalize(v).includes(n)) : true;
  };

  function matches(r, f) {
    if (!f) return true;
    if (f.sender && !has(r.senders || [], f.sender)) return false;
    if (f.recipient && !has(r.recipients || [], f.recipient)) return false;
    if (f.correspondent && !has([...(r.senders || []), ...(r.recipients || [])], f.correspondent)) return false;
    if (typeof f.sender_female === "boolean" && Boolean(r.senderFemale) !== f.sender_female) return false;
    if (typeof f.recipient_female === "boolean" && Boolean(r.recipientFemale) !== f.recipient_female) return false;
    if (f.year_from || f.year_to) {
      if (!r.dateIso) return false;
      const y = Number(r.dateIso.slice(0, 4));
      if (f.year_from && y < f.year_from) return false;
      if (f.year_to && y > f.year_to) return false;
    }
    if (f.place_sent && !has(r.placesSent || [], f.place_sent)) return false;
    if (f.place_received && !has(r.placesReceived || [], f.place_received)) return false;
    if (f.subject && !has([...(r.keywordSubjects || []), ...(r.subjectVariants || [])], f.subject)) return false;
    if (f.subject_group && !(r.keywordSubjectGroups || []).includes(f.subject_group)) return false;
    if (f.keyword_person && !has(r.keywordPeople || [], f.keyword_person)) return false;
    if (f.keyword_place && !has(r.keywordPlaces || [], f.keyword_place)) return false;
    if (f.regest_contains) {
      if (r.regestSynthetic) return false;
      if (!normalize(r.regest || "").includes(normalize(f.regest_contains))) return false;
    }
    if (typeof f.has_regest === "boolean" && Boolean(!r.regestSynthetic) !== f.has_regest) return false;
    if (typeof f.has_volltext === "boolean" && Boolean(r.hasFullText) !== f.has_volltext) return false;
    if (f.land_sent && !has(fieldValues(r, "land_sent"), f.land_sent)) return false;
    if (f.land_mentioned && !has(fieldValues(r, "land_mentioned"), f.land_mentioned)) return false;
    if (typeof f.mentions_foreign === "boolean" && mentionedPlaces(r).some(foreign) !== f.mentions_foreign) return false;
    if (typeof f.sent_from_foreign === "boolean" && (r.placesSent || []).some(foreign) !== f.sent_from_foreign) return false;
    if (typeof f.regest_issue === "boolean" && regestIssues.has(String(r.id)) !== f.regest_issue) return false;
    return true;
  }

  const filtered = (f) => publicIndices.filter((i) => matches(records[i], f));

  const compact = (r) => ({
    id: String(r.id),
    datum: r.dateDisplay || r.dateIso || null,
    von: (r.senders || []).join("; ") || null,
    an: (r.recipients || []).join("; ") || null,
    absendeort: (r.placesSent || []).join("; ") || null,
    schlagworte: (r.keywordSubjects || []).slice(0, 8),
    regest: r.regestSynthetic
      ? "(synthetisch, nur Metadaten) " + r.regest
      : r.regest.length > REGEST_SNIPPET ? r.regest.slice(0, REGEST_SNIPPET) + " …" : r.regest,
  });

  const clampInt = (v, def, max) => Math.max(0, Math.min(max, Number.isFinite(Number(v)) && v !== undefined ? Number(v) : def));

  // ---- tools -----------------------------------------------------------------
  const tools = {
    async search_letters({ query, limit }) {
      if (!query || typeof query !== "string") return { error: "query fehlt" };
      const cap = clampInt(limit, 20, 40);
      const { hits, retrieved } = await hybridSearch(query);
      return {
        treffer_gesamt: hits.length,
        erkannte_schlagworte: retrieved.subjects || [],
        erkannte_personen: retrieved.persons || [],
        erkannte_jahre: retrieved.years || [],
        briefe: hits.slice(0, cap).map((h) => ({
          ...compact(h.record),
          grund: h.reasons || [],
          passage: h.chunkText ? h.chunkText.slice(0, 300) : undefined,
        })),
      };
    },

    async filter_letters({ limit, offset, ...f }) {
      await Promise.all([loadPlaces(), loadRegestIssues()]);
      const cap = clampInt(limit, 20, PAGE_MAX);
      const off = clampInt(offset, 0, 1e9);
      const idx = filtered(f).sort((a, b) => (records[a].dateIso || "9999").localeCompare(records[b].dateIso || "9999"));
      return {
        filter: f,
        gesamt: idx.length,
        offset: off,
        briefe: idx.slice(off, off + cap).map((i) => compact(records[i])),
      };
    },

    async count_by({ by, subject_group, filter, top }) {
      if (!by) return { error: "by fehlt" };
      await Promise.all([loadPlaces(), loadRegestIssues()]);
      const cap = clampInt(top, 20, GROUPS_MAX);
      const idx = filtered(filter);
      const counts = new Map();
      let carrying = 0;
      for (const i of idx) {
        const r = records[i];
        let values = fieldValues(r, by);
        if (by === "subject" && subject_group) {
          values = (r.keywordSubjects || []).filter((_, k) => (r.keywordSubjectGroups || [])[k] === subject_group);
        }
        const uniq = new Set(values);
        if (uniq.size) carrying++;
        for (const v of uniq) counts.set(v, (counts.get(v) || 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return {
        gruppiert_nach: by,
        ...(subject_group ? { schlagwort_kategorie: subject_group } : {}),
        filter: filter || null,
        hinweis: "briefe_im_filter = alle gezählten Briefe; briefe_mit_wert = davon Briefe, die mindestens einen Wert dieses Felds tragen." +
          (by.startsWith("land") ? ` Ortsklassifikation: ${places.size} Orte zugeordnet.` : ""),
        briefe_im_filter: idx.length,
        briefe_mit_wert: carrying,
        verschiedene_werte: sorted.length,
        gruppen: sorted.slice(0, cap).map(([wert, briefe]) => ({ wert, briefe })),
      };
    },

    async list_values({ field, contains, subject_group, limit }) {
      if (!field) return { error: "field fehlt" };
      await loadPlaces();
      const cap = clampInt(limit, 30, GROUPS_MAX);
      const n = normalize(contains || "");
      const counts = new Map();
      for (const i of publicIndices) {
        const r = records[i];
        let values = fieldValues(r, field);
        if (field === "subject" && subject_group) {
          values = (r.keywordSubjects || []).filter((_, k) => (r.keywordSubjectGroups || [])[k] === subject_group);
        }
        for (const v of new Set(values)) {
          if (n && !normalize(v).includes(n)) continue;
          counts.set(v, (counts.get(v) || 0) + 1);
        }
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return { feld: field, treffer_gesamt: sorted.length, werte: sorted.slice(0, cap).map(([wert, briefe]) => ({ wert, briefe })) };
    },

    async regest_issues({ art, limit, offset }) {
      await loadRegestIssues();
      const cap = clampInt(limit, 25, PAGE_MAX);
      const off = clampInt(offset, 0, 1e9);
      const kind = art && art !== "alle" ? art : null;
      const rows = [];
      for (const [id, findings] of regestIssues) {
        const sel = kind ? findings.filter((x) => x.art === kind) : findings;
        if (sel.length) rows.push({ id, findings: sel });
      }
      rows.sort((a, b) => a.id.localeCompare(b.id));
      return {
        hinweis: "Formale Prüfung der editorischen Regesten (Heuristik + Sprachmodell). Regesten sind bewusst im Telegrammstil ohne Subjekt geschrieben; das gilt nicht als Mangel.",
        regesten_geprueft: regestChecked,
        regesten_gesamt: regestTotal,
        pruefung_vollstaendig: regestChecked >= regestTotal,
        briefe_mit_befund: rows.length,
        offset: off,
        briefe: rows.slice(off, off + cap).map(({ id, findings }) => {
          const r = records[byId.get(id)];
          return { id, zitierzeile: r.long, befunde: findings.map((x) => ({ art: x.art, stelle: x.stelle, hinweis: x.hinweis })) };
        }),
      };
    },

    read_letter({ id }) {
      const i = byId.get(String(id).trim());
      if (i === undefined) return { error: `Brief ${id} ist nicht im öffentlichen Archiv.` };
      const r = records[i];
      const ft = fulltextById.get(String(r.id));
      const volltext = ft?.volltext || r.volltext || null;
      return {
        id: String(r.id),
        url: r.url,
        zitierzeile: r.long,
        textsorte: r.textsorte,
        datum: r.dateDisplay || r.dateIso,
        von: r.senders,
        an: r.recipients,
        absendeort: r.placesSent,
        zielort: r.placesReceived,
        regest: r.regestSynthetic ? null : r.regest,
        regest_hinweis: r.regestSynthetic ? "Kein editorisches Regest vorhanden; nur Metadaten." : undefined,
        schlagworte: (r.keywordSubjects || []).map((s, k) => ({ schlagwort: s, kategorie: (r.keywordSubjectGroups || [])[k] || null })),
        erwaehnte_personen: r.keywordPeople || [],
        erwaehnte_orte: r.keywordPlaces || [],
        incipit: r.incipit || null,
        erlaeuterung: ft?.erlaeuterung || r.erlaeuterung || null,
        transkription: volltext ? volltext.slice(0, VOLLTEXT_MAX) : null,
        transkription_gekuerzt: volltext ? volltext.length > VOLLTEXT_MAX : undefined,
      };
    },
  };

  // ---- the loop --------------------------------------------------------------
  const collectIds = (result, into) => {
    const walk = (x) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") {
        if (typeof x.id === "string" && byId.has(x.id)) into.add(x.id);
        for (const v of Object.values(x)) walk(v);
      }
    };
    walk(result);
  };

  async function complete(messages, opts = {}) {
    const attempt = async (n) => {
      try {
        return await client.chat.completions.create({
          model,
          temperature: 0.2,
          max_tokens: 4096,
          messages,
          tools: TOOLS,
          tool_choice: opts.toolChoice || "auto",
        });
      } catch (err) {
        const transient = !err?.status || err.status >= 500 || err.status === 429;
        if (n < 1 && transient) {
          await new Promise((r) => setTimeout(r, 2000));
          return attempt(n + 1);
        }
        throw err;
      }
    };
    return attempt(0);
  }

  async function run(question, history = []) {
    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: question }];
    const trace = [];
    const seenIds = new Set();
    // Text the model emits in the same message as a tool call. DeepSeek
    // sometimes writes section 1 of the answer, calls tools for section 2,
    // and then returns only section 2 as the final message — so substantial
    // partials are kept and prepended to the final answer.
    const partials = [];
    let answer = "";
    let steps = 0;
    let usage = { prompt_tokens: 0, completion_tokens: 0 };

    for (;;) {
      const exhausted = steps >= MAX_STEPS;
      const completion = await complete(messages, exhausted ? { toolChoice: "none" } : {});
      if (completion.usage) {
        usage.prompt_tokens += completion.usage.prompt_tokens || 0;
        usage.completion_tokens += completion.usage.completion_tokens || 0;
      }
      const msg = completion.choices[0]?.message;
      if (!msg) break;
      if (!msg.tool_calls?.length || exhausted) {
        answer = msg.content ?? "";
        break;
      }
      steps++;
      if (msg.content && msg.content.trim().length >= 200) partials.push(msg.content.trim());
      messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        let args = {};
        let result;
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          result = { error: "Argumente sind kein gültiges JSON." };
        }
        if (!result) {
          const fn = tools[name];
          if (!fn) result = { error: `Unbekanntes Werkzeug ${name}` };
          else {
            try {
              result = await fn(args);
            } catch (err) {
              result = { error: String(err?.message || err) };
            }
          }
        }
        collectIds(result, seenIds);
        let content = JSON.stringify(result);
        if (content.length > TOOL_RESULT_MAX_CHARS) {
          content = content.slice(0, TOOL_RESULT_MAX_CHARS) + ` …" (Ergebnis gekürzt; mit limit/offset oder engerem Filter erneut abfragen)`;
        }
        trace.push({
          step: steps,
          tool: name,
          args,
          summary: summarize(name, result),
        });
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }

    if (partials.length && !partials.every((p) => answer.includes(p.slice(0, 80)))) {
      answer = [...partials.filter((p) => !answer.includes(p.slice(0, 80))), answer].join("\n\n");
    }

    // Citation guard — same contract as /api/chat: a cited id must have been
    // in some tool result. One corrective retry, then the answer stands as
    // produced (the UI shows which ids were actually seen).
    let citationRetry = false;
    const invented = extractCitedIds(answer).filter((id) => !seenIds.has(id));
    if (invented.length) {
      citationRetry = true;
      messages.push({ role: "assistant", content: answer });
      messages.push({
        role: "user",
        content:
          `Deine Antwort nennt Brief-Nummern, die in keinem Werkzeugergebnis vorkamen: ${invented.join(", ")}. ` +
          `Formuliere die Antwort neu und nenne ausschließlich Brief-Nummern aus den Werkzeugergebnissen. ` +
          `Antworte direkt, ohne Bezug auf die vorherige Antwort.`,
      });
      const completion = await complete(messages, { toolChoice: "none" });
      answer = completion.choices[0]?.message?.content ?? answer;
    }

    // Ids are five digits (years are four): a bare number the model put in a
    // table counts as a citation for the source cards if a tool returned it.
    const bare = [...answer.matchAll(/\b(\d{5})\b/g)].map((m) => m[1]);
    const cited = [...new Set([...extractCitedIds(answer), ...bare])].filter((id) => seenIds.has(id));
    const ordered = [...cited, ...[...seenIds].filter((id) => !cited.includes(id))].slice(0, SOURCES_MAX);
    const sources = ordered.map((id) => {
      const r = records[byId.get(id)];
      return {
        id: r.id,
        url: r.url,
        reasons: cited.includes(id) ? ["in der Antwort zitiert"] : ["vom Agenten gesichtet"],
        long: r.long,
        dateDisplay: r.dateDisplay,
        senders: r.senders,
        recipients: r.recipients,
        regest: r.regest,
        regestSynthetic: Boolean(r.regestSynthetic),
        cmif: r.cmif,
        sichtbar: r.sichtbar,
        hasRegest: !r.regestSynthetic,
        hasFullText: Boolean(r.hasFullText),
        inContext: true,
      };
    });

    // Append-only log of every agent run (data/ is gitignored): after the
    // 2026-09-04 demo nobody could reconstruct what had been asked.
    appendFile(
      path.join(dataDir, "agent-log.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), question, steps, usage, citationRetry, cited, trace, answer }) + "\n"
    ).catch(() => {});

    return { answer, trace, steps, usage, citationRetry, citedIds: cited, seenCount: seenIds.size, sources };
  }

  return { run, tools, TOOLS };
}

function summarize(name, result) {
  if (!result || result.error) return `Fehler: ${result?.error || "unbekannt"}`;
  switch (name) {
    case "search_letters":
      return `${result.treffer_gesamt} Treffer` + (result.erkannte_schlagworte?.length ? `, Schlagworte: ${result.erkannte_schlagworte.slice(0, 3).join(", ")}` : "");
    case "filter_letters":
      return `${result.gesamt} Briefe (Seite ab ${result.offset})`;
    case "count_by":
      return `${result.briefe_im_filter} Briefe im Filter, ${result.briefe_mit_wert} mit Wert, ${result.verschiedene_werte} Werte; Top: ` + (result.gruppen || []).slice(0, 3).map((g) => `${g.wert} (${g.briefe})`).join(", ");
    case "list_values":
      return `${result.treffer_gesamt} Werte; Top: ` + (result.werte || []).slice(0, 3).map((g) => `${g.wert} (${g.briefe})`).join(", ");
    case "regest_issues":
      return `${result.briefe_mit_befund} Briefe mit Befund (${result.regesten_geprueft}/${result.regesten_gesamt} Regesten geprüft)`;
    case "read_letter":
      return `Brief ${result.id}: ${result.zitierzeile}`;
    default:
      return "";
  }
}
