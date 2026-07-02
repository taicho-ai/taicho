/** Skill store: one file per skill at skills/<id>.md (YAML frontmatter = the skill minus `body`,
 *  body = the procedure). Files are canon; the `skills` table is a rebuildable index. Mirrors
 *  store/knowledge.ts + store/policy.ts. */
import { YAML } from "bun";
import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Skill } from "../schemas/skill";
import { paths } from "./files";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function mkSkillId(): string {
  return "skill_" + Math.random().toString(36).slice(2, 10);
}

export function serializeSkill(s: Skill): string {
  const { body, ...meta } = s;
  return `---\n${YAML.stringify(meta, null, 2)}\n---\n${body}\n`;
}

export function parseSkill(text: string): Skill {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("skill file missing YAML frontmatter");
  const meta = YAML.parse(m[1]) as Record<string, unknown>;
  return Skill.parse({ ...meta, body: m[2].trim() });
}

export function writeSkill(ws: string, db: Database, skill: Skill): void {
  mkdirSync(paths.skillsDir(ws), { recursive: true });
  writeFileSync(paths.skillFile(ws, skill.id), serializeSkill(skill));
  indexSkill(db, skill);
}

export function readSkill(ws: string, id: string): Skill | null {
  const f = paths.skillFile(ws, id);
  if (!existsSync(f)) return null;
  try { return parseSkill(readFileSync(f, "utf8")); } catch { return null; }
}

export function listSkills(ws: string): Skill[] {
  const dir = paths.skillsDir(ws);
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try { out.push(parseSkill(readFileSync(join(dir, f), "utf8"))); }
    catch (e) { console.error(`skipping skill ${f}: ${String(e)}`); }
  }
  return out;
}

export function deleteSkill(ws: string, db: Database, id: string): boolean {
  const f = paths.skillFile(ws, id);
  const existed = existsSync(f);
  if (existed) rmSync(f);
  db.query("DELETE FROM skills WHERE id = ?").run(id);
  return existed;
}

export function indexSkill(db: Database, s: Skill): void {
  db.query(
    `INSERT INTO skills (id, name, description, tags, status, body, updated)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, description=excluded.description, tags=excluded.tags,
       status=excluded.status, body=excluded.body, updated=unixepoch()`,
  ).run(s.id, s.name, s.description, JSON.stringify(s.tags), s.status, s.body);
}

export interface SkillRow { id: string; name: string; description: string; tags: string[]; status: string; body: string }

export function getActiveSkills(db: Database): SkillRow[] {
  const rows = db.query("SELECT id, name, description, tags, status, body FROM skills WHERE status = 'active'")
    .all() as { id: string; name: string; description: string; tags: string | null; status: string; body: string }[];
  return rows.map((r) => ({ ...r, tags: r.tags ? (JSON.parse(r.tags) as string[]) : [] }));
}

/** Rebuild the skills index from the canonical files (proves files-are-canon). */
export function reindexSkills(ws: string, db: Database): void {
  db.exec("DELETE FROM skills");
  const seen = new Map<string, string>(); // name -> id, to warn on duplicate names
  for (const s of listSkills(ws)) {
    if (seen.has(s.name)) console.error(`duplicate skill name "${s.name}" (${seen.get(s.name)} and ${s.id}); use_skill resolves the first match`);
    seen.set(s.name, s.id);
    indexSkill(db, s);
  }
}
