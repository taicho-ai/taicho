/** Hybrid deck-knowledge recall: a semantic (or keyword) seed, then a typed-edge graph expansion.
 *  Mirrors coaching/retrieval.ts. Degrades to keyword+graph when no embedder is available, so the
 *  KB is fully usable under any provider (incl. subscription/Anthropic with no embeddings endpoint). */
import type { Database } from "bun:sqlite";
import { topK } from "../store/vectors";
import { getNodes, neighbors } from "../store/knowledge";

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const DECAY = 0.5;

export interface KbHit {
  id: string; title: string; summary?: string; kind: string;
  score: number; via: "semantic" | "keyword" | "graph"; depth: number;
}
export interface KbSearchResult { hits: KbHit[]; mode: "semantic" | "keyword"; seeds: string[]; }

export async function searchKnowledge(opts: {
  db: Database;
  query: string;
  embed?: (t: string) => Promise<Float32Array>;
  k?: number;       // seed count
  hops?: number;    // graph expansion depth
  rels?: string[];  // restrict edge types
  limit?: number;   // final cap
}): Promise<KbSearchResult> {
  const { db, query } = opts;
  const k = opts.k ?? 6, hops = opts.hops ?? 1, limit = opts.limit ?? 10;
  const scores = new Map<string, { score: number; via: KbHit["via"]; depth: number }>();
  let mode: "semantic" | "keyword" = "keyword";

  // 1. Seed — semantic when an embedder is present, else keyword token-overlap.
  if (opts.embed) {
    try {
      const q = await opts.embed(query);
      for (const { ref, score } of topK(db, "kb", q, k)) scores.set(ref, { score, via: "semantic", depth: 0 });
      mode = "semantic";
    } catch { /* embedder failed → fall back to keyword below */ }
  }
  if (scores.size === 0) {
    mode = "keyword";
    const qset = new Set(tokenize(query));
    if (qset.size) {
      const rows = db.query("SELECT id, title, summary, content FROM kb_nodes").all() as
        { id: string; title: string; summary: string | null; content: string }[];
      const scored = rows.map((r) => {
        const terms = tokenize(`${r.title} ${r.summary ?? ""} ${r.content}`);
        let overlap = 0; for (const t of terms) if (qset.has(t)) overlap++;
        return { id: r.id, score: overlap };
      }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
      for (const s of scored) scores.set(s.id, { score: s.score, via: "keyword", depth: 0 });
    }
  }

  const seeds = [...scores.keys()];
  const topSeed = Math.max(0, ...seeds.map((s) => scores.get(s)!.score));

  // 2. Expand along typed edges (both directions), decaying by depth.
  for (const { id, depth } of neighbors(db, seeds, hops, opts.rels)) {
    const decayed = topSeed * Math.pow(DECAY, depth);
    const prev = scores.get(id);
    if (!prev || decayed > prev.score) scores.set(id, { score: decayed, via: "graph", depth });
  }

  // 3. Hydrate + rank.
  const rows = getNodes(db, [...scores.keys()]);
  const hits: KbHit[] = [];
  for (const [id, s] of scores) {
    const r = rows.get(id); if (!r) continue;
    hits.push({ id, title: r.title, summary: r.summary ?? undefined, kind: r.kind, score: s.score, via: s.via, depth: s.depth });
  }
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { hits: hits.slice(0, limit), mode, seeds };
}
