/** Starter skills shipped so the squad is useful out of the box. Written as canonical files on first
 *  boot (only when skills/ is empty), then indexed by reindexSkills. Fixed ids ⇒ idempotent. */
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Skill } from "@taicho-ai/contracts/skill";
import { serializeSkill } from "./skills";
import { paths } from "./files";

const SEED_TS = "2026-07-02T00:00:00.000Z";

export const STARTER_SKILLS: Skill[] = [
  Skill.parse({
    id: "skill_write_artifact", name: "write-a-clear-artifact",
    description: "Produce a clean, useful artifact when a task asks you to write or document something.",
    tags: ["writing", "artifact", "documentation"], created: SEED_TS,
    body: [
      "Follow this before you save_artifact a work product (the structured, always-granted hand-off tool):",
      "1. Put the goal/answer in one line at the top — lead with the conclusion, then the detail.",
      "2. Structure with headings; prefer lists and tables over walls of prose where they aid scanning.",
      "3. Be concrete: real names, paths, commands, numbers. Cut vague filler.",
      "4. Self-check: does it answer the ACTUAL request? Is anything unverified? Cut it or flag it explicitly.",
      "5. Give it a clear title and a lowercase-hyphen id that names the deliverable, plus a short summary readers see before they pull the body; you get back a handle (id@vN) to hand off by reference.",
    ].join("\n"),
  }),
  Skill.parse({
    id: "skill_delegate", name: "delegate-a-task-well",
    description: "Hand a goal to another agent effectively when the work isn't yours to do directly.",
    tags: ["delegation", "coordination", "squad"], created: SEED_TS,
    body: [
      "When delegating with delegate_task:",
      "1. If you're unsure who should do it, call find_agents(capability) first and pick by role match.",
      "2. Hand off a GOAL (the outcome), not step-by-step orders — let the agent apply its judgment.",
      "3. Put the context it needs (constraints, prior decisions, ids/artifacts to build on) in `context`.",
      "4. One clear deliverable per delegation; split unrelated goals into separate delegations.",
      "5. Never delegate to yourself or an ancestor (cycles are refused). Respect the work-item budget.",
      "6. Use the returned result. If it failed, read the error before retrying a different way.",
    ].join("\n"),
  }),
  Skill.parse({
    id: "skill_hand_off_artifacts", name: "hand-off-work-by-reference",
    description: "Move work products between agents (and to the human) by reference — save outputs as artifacts and consume others' by handle instead of pasting content into the conversation.",
    tags: ["artifact", "handoff", "delegation", "context-hygiene"], created: SEED_TS,
    body: [
      "Keep heavy content OUT of the conversation — hand it off by reference:",
      "1. PRODUCE: when you finish a real work product, save_artifact it (give a clear title, a free-form `type` tag, and a short `summary`). You get back a handle like research-foo@v1.",
      "2. HAND OFF: when you delegate_task, pass the handles in `inputArtifacts` — never paste the content into `context`. The child reads what it needs with read_artifact.",
      "3. CONSUME: given an input artifact, call read_artifact(handle) — you get metadata + summary by default; add includeBody:true only when you truly need the (size-capped) body.",
      "4. DISCOVER: list_artifacts (filter by producer/type/role/q) to find what others have produced before re-deriving it.",
      "5. REVISE: to update an artifact, save_artifact with the SAME id — it becomes a new immutable version; nothing is overwritten. Set `parents` to record lineage.",
      "6. EXTERNAL: if the work product lives in a system an MCP server fronts (a Notion page, a ClickUp task), save it with `external` (a locator) instead of a local body.",
    ].join("\n"),
  }),
  Skill.parse({
    id: "skill_use_kb", name: "use-the-knowledgebase",
    description: "Recall shared knowledge before acting and record durable facts so the squad stops re-deriving them.",
    tags: ["knowledge", "memory", "recall", "remember"], created: SEED_TS,
    body: [
      "Use the squad knowledgebase on repeatable work:",
      "1. recall(query) FIRST — reuse existing facts/decisions instead of re-deriving them.",
      "2. When you learn something durable (a decision, entity, or fact), remember it with a clear title and typed edges to related nodes (recall first to get ids to link to).",
      "3. Keep nodes atomic and self-contained; prefer linking over duplicating.",
      "4. When it matters, cite the node ids you relied on in your output.",
    ].join("\n"),
  }),
];

export async function seedSkills(ws: string): Promise<void> {
  const dir = paths.skillsDir(ws);
  await mkdir(dir, { recursive: true });
  if (existsSync(dir)) {
    const has = (await readdir(dir)).some((f) => f.endsWith(".md"));
    if (has) return; // don't clobber existing curation
  }
  for (const s of STARTER_SKILLS) await writeFile(paths.skillFile(ws, s.id), serializeSkill(s));
}
