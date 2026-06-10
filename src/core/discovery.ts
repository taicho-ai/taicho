/** Keyword discovery over the registry index — scales to large rosters via one SQL scan upstream.
 *  Semantic embeddings (store/vectors.ts) are a deferred upgrade. */
import type { RegistryRow } from "../store/roster";

export interface AgentHit { id: string; role: string; score: number; }

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export function rankAgents(rows: RegistryRow[], query: string, k: number): AgentHit[] {
  const q = new Set(tokenize(query));
  if (q.size === 0) return [];
  const scored: AgentHit[] = [];
  for (const r of rows) {
    if (r.is_root) continue;
    const terms = tokenize(`${r.id} ${r.role}`);
    let overlap = 0;
    for (const t of terms) if (q.has(t)) overlap++;
    if (overlap > 0) scored.push({ id: r.id, role: r.role, score: overlap });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, k);
}
