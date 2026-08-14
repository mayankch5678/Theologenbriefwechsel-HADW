// Embeds every letter in data/corpus.jsonl using a local Ollama embedding
// model (bge-m3, chosen for multilingual/German retrieval quality) and
// writes a flat binary vector store + sidecar metadata file.
//
// Pure local computation: no external API calls, no writes back to MongoDB
// or the original ThBw/dataset code.
//
// The run is resumable: embeddings.bin is opened in append mode and the number
// of records already embedded is derived from its size, so an interrupted run
// picks up where it stopped instead of starting over.

import { open, stat, writeFile, truncate } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";
const BATCH_SIZE = Number(process.env.EMBED_BATCH_SIZE || 32); // records per Ollama request
const CONCURRENCY = Number(process.env.EMBED_CONCURRENCY || 8); // requests in flight
const CHUNK = BATCH_SIZE * CONCURRENCY; // records embedded between disk flushes

// One Ollama request for a whole array of inputs. Returns one vector per input,
// in the same order.
async function embedBatch(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const vecs = data.embeddings;
  if (!Array.isArray(vecs) || vecs.length !== texts.length) {
    throw new Error(`Ollama returned ${vecs?.length} embeddings for ${texts.length} inputs`);
  }
  return vecs;
}

async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

// Counts corpus lines up front so progress/ETA and the meta sidecar know the total.
async function countLines(file) {
  let n = 0;
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line) n++;
  return n;
}

async function main() {
  const dataDir = path.join(__dirname, "..", "data");
  const corpusFile = path.join(dataDir, "corpus.jsonl");
  const vecFile = path.join(dataDir, "embeddings.bin");
  const metaFile = path.join(dataDir, "embeddings.meta.json");

  const total = await countLines(corpusFile);

  // Probe the model once to learn the vector width; the byte size of
  // embeddings.bin only translates into a record count once we know it.
  const dim = (await embedBatch(["dimension probe"]))[0].length;
  const recordBytes = dim * 4; // Float32
  console.log(`Model "${EMBED_MODEL}", embedding dimension: ${dim}`);

  let size = await fileSize(vecFile);
  if (size % recordBytes !== 0) {
    // Interrupted mid-write: drop the partial record so appends stay aligned.
    const aligned = Math.floor(size / recordBytes) * recordBytes;
    console.log(`embeddings.bin had ${size - aligned} trailing bytes from a partial write; truncating.`);
    await truncate(vecFile, aligned);
    size = aligned;
  }
  const recordsDone = size / recordBytes;

  if (recordsDone > total) {
    throw new Error(
      `embeddings.bin holds ${recordsDone} vectors but corpus.jsonl has only ${total} lines. ` +
        `The corpus was rebuilt smaller — delete data/embeddings.bin and re-run.`
    );
  }
  if (recordsDone === total) {
    console.log(`All ${total} records already embedded — nothing to do.`);
    await writeFile(metaFile, JSON.stringify({ model: EMBED_MODEL, dim, count: total, total }));
    return;
  }
  if (recordsDone > 0) {
    console.log(`Resuming: ${recordsDone}/${total} records already in embeddings.bin, skipping those lines.`);
  } else {
    console.log(`Embedding ${total} letters with model "${EMBED_MODEL}"...`);
  }

  const handle = await open(vecFile, "a");
  let done = recordsDone;
  const startedAt = Date.now();

  const writeMeta = () =>
    writeFile(metaFile, JSON.stringify({ model: EMBED_MODEL, dim, count: done, total, updatedAt: new Date().toISOString() }));

  // Embeds one chunk of records: BATCH_SIZE per request, CONCURRENCY requests in
  // parallel, then appends the vectors in corpus order so the file stays aligned
  // with corpus.jsonl and remains valid to resume from after every flush.
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
    await writeMeta();

    const rate = (done - recordsDone) / ((Date.now() - startedAt) / 1000);
    const remaining = ((total - done) / rate).toFixed(0);
    console.log(`  ${done}/${total} (${rate.toFixed(1)}/s, ~${remaining}s remaining)`);
  };

  try {
    const rl = createInterface({ input: createReadStream(corpusFile), crlfDelay: Infinity });
    let lineNo = 0;
    let chunk = [];
    for await (const line of rl) {
      if (!line) continue;
      if (lineNo++ < recordsDone) continue; // already embedded on an earlier run
      chunk.push(JSON.parse(line));
      if (chunk.length === CHUNK) {
        await flush(chunk);
        chunk = [];
      }
    }
    if (chunk.length) await flush(chunk);
  } finally {
    await handle.close();
  }

  console.log(`\nWrote ${done} x ${dim} embeddings to ${vecFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
