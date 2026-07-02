/** Keyword discovery over active skills — mirrors core/discovery.ts (rankAgents). Semantic search
 *  (reusing the KB embeddings) is a deferred upgrade behind this same interface. */
import type { SkillRow } from "../store/skills";

export interface SkillHit { id: string; name: string; description: string; score: number }

const tokenize = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

export function rankSkills(rows: SkillRow[], query: string, k: number): SkillHit[] {
  const q = new Set(tokenize(query));
  if (q.size === 0) return [];
  const scored: SkillHit[] = [];
  for (const r of rows) {
    if (r.status !== "active") continue;
    const terms = tokenize(`${r.name} ${r.description} ${r.tags.join(" ")}`);
    let overlap = 0;
    for (const t of terms) if (q.has(t)) overlap++;
    if (overlap > 0) scored.push({ id: r.id, name: r.name, description: r.description, score: overlap });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, k);
}
