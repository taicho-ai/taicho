import type { Database } from "bun:sqlite";

/** v0 recall: embeddings as blobs + brute-force cosine in TS.
 *  At policy-note scale (hundreds) this is microseconds; sqlite-vec is a later optimization. */
export function putVector(db: Database, ref: string, kind: string, vec: Float32Array) {
  db.query("INSERT OR REPLACE INTO embeddings (ref, kind, vec) VALUES (?, ?, ?)")
    .run(ref, kind, new Uint8Array(vec.buffer.slice(0)));
}

export function topK(db: Database, kind: string, query: Float32Array, k: number) {
  const rows = db.query<{ ref: string; vec: Uint8Array }, [string]>(
    "SELECT ref, vec FROM embeddings WHERE kind = ?").all(kind);
  const scored = rows.map((r) => {
    const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
    return { ref: r.ref, score: cosine(query, v) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
