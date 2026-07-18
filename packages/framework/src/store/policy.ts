/** Coaching policy store: one file per note at agents/<id>/policies/<pol_id>.md
 *  (YAML frontmatter = the note minus `do`, body = the instruction). Mirrors roster.ts. */
import { YAML } from "bun";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PolicyNote } from "@taicho/contracts/policy";
import { paths } from "./files";
import { log } from "../core/logger";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function serializePolicy(n: PolicyNote): string {
  const { do: doText, ...meta } = n;
  return `---\n${YAML.stringify(meta, null, 2)}\n---\n${doText}\n`;
}

export function parsePolicy(text: string): PolicyNote {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("policy file missing YAML frontmatter");
  const meta = YAML.parse(m[1]) as Record<string, unknown>;
  return PolicyNote.parse({ ...meta, do: m[2].trim() });
}

export function writePolicy(ws: string, note: PolicyNote): void {
  const dir = paths.policyDir(ws, note.agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${note.id}.md`), serializePolicy(note));
}

export function listPolicies(ws: string, agentId: string): PolicyNote[] {
  const dir = paths.policyDir(ws, agentId);
  if (!existsSync(dir)) return [];
  const out: PolicyNote[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    try { out.push(parsePolicy(readFileSync(join(dir, f), "utf8"))); }
    catch (e) { log.warn(`skipping policy ${f}`, e); }
  }
  return out;
}

export function readPolicy(ws: string, agentId: string, polId: string): PolicyNote | null {
  const f = join(paths.policyDir(ws, agentId), `${polId}.md`);
  if (!existsSync(f)) return null;
  try { return parsePolicy(readFileSync(f, "utf8")); } catch { return null; }
}

export function deletePolicy(ws: string, agentId: string, polId: string): boolean {
  const f = join(paths.policyDir(ws, agentId), `${polId}.md`);
  if (!existsSync(f)) return false;
  rmSync(f);
  return true;
}

/** The captain's approval gate for a `proposed` note. Flips it to `approved` (the only status run.ts
 *  applies) and persists. Returns the updated note, or null if no such note for that agent. Idempotent:
 *  an already-approved note is returned unchanged. Addressed by (agentId, polId), like deletePolicy —
 *  a repeated-failure coaching proposal (coaching/patterns.ts) is inert until it passes through here. */
export function approvePolicy(ws: string, agentId: string, polId: string): PolicyNote | null {
  const cur = readPolicy(ws, agentId, polId);
  if (!cur) return null;
  if (cur.status === "approved") return cur;
  const updated = PolicyNote.parse({ ...cur, status: "approved" });
  writePolicy(ws, updated);
  return updated;
}
