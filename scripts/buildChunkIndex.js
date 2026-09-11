// Chunk-level index over the primary-source text: verbatim transcriptions
// (transkription.volltext) and editorial commentary (erlaeuterung) from
// data/fulltext.jsonl, written by buildCorpus.js.
//
// This is a SECOND index next to the letter-level one (embeddings.bin ↔
// corpus.jsonl line i). Letters run to 127k chars and bge-m3 caps at ~8k
// tokens, so whole-letter vectors would silently truncate; chunks of 800
// chars with 150 overlap (the parameters the parallel rag/ v1 pipeline
// settled on) keep every passage reachable and let the server show the
// *matching* passage as evidence instead of the first 1,500 chars.
//
// Public letters only — internal transcriptions never get a vector.
//
// Output: data/chunks.jsonl (chunk i ↔ vector i in data/chunk_embeddings.bin)
// + data/chunk_embeddings.meta.json. Resumable like buildIndex.js; a changed
// chunks.jsonl (different sha1) invalidates the partial vector file.

import { open, stat, writeFile, truncate, readFile, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 800);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP || 150);
const BATCH_SIZE = Number(process.env.EMBED_BATCH_SIZE || 32);
const CONCURRENCY = Number(process.env.EMBED_CONCURRENCY || 8);
const FLUSH_EVERY = BATCH_SIZE * CONCURRENCY;

const DATA_DIR = path.join(__dirname, "..", "data");
const FULLTEXT_FILE = path.join(DATA_DIR, "fulltext.jsonl");
const CHUNKS_FILE = path.join(DATA_DIR, "chunks.jsonl");
const VEC_FILE = path.join(DATA_DIR, "chunk_embeddings.bin");
const META_FILE = path.join(DATA_DIR, "chunk_embeddings.meta.json");

// Fixed-size windows with overlap, snapped back to the last whitespace so a
// chunk never ends mid-word. Early-modern transcriptions have no reliable
// paragraph structure to split on, so windows are the honest choice.
function chunkText(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= CHUNK_SIZE) return clean ? [clean] : [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      const ws = clean.lastIndexOf(" ", end);
      if (ws > start + CHUNK_SIZE / 2) end = ws;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

async function embedBatch(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new Error(`Ollama returned ${data.embeddings?.length} embeddings for ${texts.length} inputs`);
  }
  return data.embeddings;
}

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

async function sha1(file) {
  return createHash("sha1").update(await readFile(file)).digest("hex");
}

async function buildChunksFile() {
  const rl = createInterface({ input: createReadStream(FULLTEXT_FILE), crlfDelay: Infinity });
  const lines = [];
  let letters = 0;
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.sichtbar !== "offen") continue;
    letters++;
    for (const [kind, text] of [
      ["volltext", r.volltext],
      ["erlaeuterung", r.erlaeuterung],
    ]) {
      if (!text) continue;
      chunkText(text).forEach((chunk, seq) => {
        lines.push(JSON.stringify({ chunkId: `${r.id}__${kind}__${String(seq).padStart(3, "0")}`, letterId: r.id, kind, seq, text: chunk }));
      });
    }
  }
  await writeFile(CHUNKS_FILE, lines.join("\n") + "\n", "utf8");
  console.log(`Chunked ${letters} public letters into ${lines.length} chunks -> ${CHUNKS_FILE}`);
  return lines.length;
}

async function main() {
  const total = await buildChunksFile();
  const chunksHash = await sha1(CHUNKS_FILE);

  const dim = (await embedBatch(["dimension probe"]))[0].length;
  const recordBytes = dim * 4;

  // A partial vector file is only resumable if it was built from exactly
  // this chunks.jsonl.
  let size = await fileSize(VEC_FILE);
  if (size > 0) {
    let prevHash = null;
    try {
      prevHash = JSON.parse(await readFile(META_FILE, "utf8")).chunksSha1;
    } catch {
      /* no meta */
    }
    if (prevHash !== chunksHash) {
      console.log("chunks.jsonl changed since the last run — discarding partial chunk_embeddings.bin.");
      await unlink(VEC_FILE);
      size = 0;
    }
  }
  if (size % recordBytes !== 0) {
    const aligned = Math.floor(size / recordBytes) * recordBytes;
    console.log(`chunk_embeddings.bin had ${size - aligned} trailing bytes from a partial write; truncating.`);
    await truncate(VEC_FILE, aligned);
    size = aligned;
  }
  const recordsDone = size / recordBytes;
  const writeMeta = (done) =>
    writeFile(
      META_FILE,
      JSON.stringify({ model: EMBED_MODEL, dim, count: done, total, chunksSha1: chunksHash, chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, updatedAt: new Date().toISOString() })
    );

  if (recordsDone === total) {
    await writeMeta(total);
    console.log(`All ${total} chunks already embedded — nothing to do.`);
    return;
  }
  console.log(recordsDone ? `Resuming: ${recordsDone}/${total} chunks done.` : `Embedding ${total} chunks with "${EMBED_MODEL}" (${dim}-dim)...`);

  const handle = await open(VEC_FILE, "a");
  let done = recordsDone;
  const startedAt = Date.now();
  const flush = async (chunk) => {
    const batches = [];
    for (let i = 0; i < chunk.length; i += BATCH_SIZE) batches.push(chunk.slice(i, i + BATCH_SIZE));
    const results = await Promise.all(batches.map((b) => embedBatch(b.map((r) => r.text))));
    const flat = new Float32Array(chunk.length * dim);
    let offset = 0;
    for (const vecs of results) {
      for (const vec of vecs) {
        if (vec.length !== dim) throw new Error(`Expected ${dim}-dim vector, got ${vec.length}`);
        flat.set(vec, offset * dim);
        offset++;
      }
    }
    await handle.write(Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));
    done += chunk.length;
    await writeMeta(done);
    const rate = (done - recordsDone) / ((Date.now() - startedAt) / 1000);
    console.log(`  ${done}/${total} (${rate.toFixed(1)}/s, ~${((total - done) / rate).toFixed(0)}s remaining)`);
  };

  try {
    const rl = createInterface({ input: createReadStream(CHUNKS_FILE), crlfDelay: Infinity });
    let lineNo = 0;
    let pending = [];
    for await (const line of rl) {
      if (!line) continue;
      if (lineNo++ < recordsDone) continue;
      pending.push(JSON.parse(line));
      if (pending.length === FLUSH_EVERY) {
        await flush(pending);
        pending = [];
      }
    }
    if (pending.length) await flush(pending);
  } finally {
    await handle.close();
  }
  console.log(`\nWrote ${done} x ${dim} chunk embeddings to ${VEC_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
