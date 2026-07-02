# Agent skills — reusable procedures for repeatable operations

**Date:** 2026-07-02
**Status:** approved (direction — user goal) — driving autonomously
**Topic:** Give taicho's squad agents a library of reviewed, discoverable **procedure documents
("skills")** they can find and follow, so repeatable operations run with intelligence and the fewest
possible mistakes.

## 1. Background & problem

taicho agents currently improvise every task from their identity + tools. For **repeatable
operations** (e.g. producing an artifact to a standard, ingesting a source doc, delegating well),
improvising re-derives the procedure each time and re-makes the same mistakes. There is no shared,
curated "here is the correct way to do X" that an agent can load and follow.

The codebase already has every pattern a skills system needs — this is a sibling subsystem, not new
machinery:
- **Coaching policies** (`agents/<id>/policies/<id>.md`, YAML frontmatter + body; `store/policy.ts`
  write/list/read/delete; injected into the prompt's volatile tier; created via approval): the
  file-canon + retrieval + prompt-injection shape.
- **The KB** (`kb/nodes/<id>.md` canon + `kb_nodes` SQLite index + boot `reindexKnowledge` +
  auto-injected "relevant knowledge" block + `recall`/`/kb`): the exact retrieval + inject + reindex
  + command-surface pattern this design mirrors.
- **Discovery** (`core/discovery.ts` `rankAgents` — keyword tokenizer overlap): the v1 matcher.
- **Prompt assembly** (`core/prompt.ts` — stable/context/volatile tiers): where a "skills" block slots in.

## 2. Goals & non-goals

**Goals**
- A **skill** is a deck-wide, versioned procedure document: `skills/<id>.md` (frontmatter + a
  markdown body of steps/checklist). Files are canon; a `skills` SQLite table is a rebuildable index.
- **Every agent** can discover relevant skills (`find_skills`) and load a skill's full procedure on
  demand (`use_skill`); the most relevant skills auto-inject (name + when-to-use) into each run's
  prompt, exactly like the KB "relevant knowledge" block.
- Admin curates skills as files and via a **`/skills list|show|remove|reindex`** command surface.
- Ship a few **seeded starter skills** so the system is useful immediately ("add them in this repo").
- Unit-tested (schema/store/retrieval) **and** Ink Layer-1 tested (`/skills` + `use_skill` in a run),
  per `TESTING.md`.

**Non-goals (this spec)**
- **Executable/code skills.** A skill is a procedure the LLM *follows*, not a script it runs. (Future.)
- **Agent-authored skills** (`propose_skill` with approval). v1 is admin-curated; the "least
  mistakes" value comes from reviewed procedures. (v1.1.)
- **Semantic skill search.** v1 uses the keyword tokenizer (mirrors discovery); reusing the KB
  embeddings for skills is a later drop-in.
- **Per-agent skill ACLs.** Skills are a universal capability; every agent can find/use every skill.
- **A conversation-view/UI redesign.**

## 3. Data model

New schema `src/schemas/skill.ts`:
```ts
export const Skill = z.object({
  id: z.string(),                                 // skill_xxxx
  name: z.string(),                               // short, human/kebab (used by use_skill + display)
  description: z.string(),                         // WHEN to use it — drives discovery + injection
  tags: z.array(z.string()).default([]),           // optional discovery aids
  status: z.enum(["active", "draft"]).default("active"), // only `active` are injected/usable
  body: z.string(),                                // the procedure (markdown steps/checklist)
  created: z.string().datetime(),
  updated: z.string().datetime().optional(),
});
```
- Files: `skills/<id>.md` — YAML frontmatter = the skill minus `body`; markdown body = `body`.
  Mirrors `store/policy.ts` / `store/knowledge.ts`.
- Table (v4 migration in `store/migrate.ts`):
  ```sql
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
    tags TEXT, status TEXT NOT NULL DEFAULT 'active', body TEXT NOT NULL,
    created INTEGER DEFAULT (unixepoch()), updated INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS skills_status ON skills(status);
  ```

## 4. Store (`src/store/skills.ts`)

Mirrors `store/knowledge.ts`: `serializeSkill`/`parseSkill`, `mkSkillId()`, `writeSkill(ws, db,
skill)` (writes the file + `indexSkill`), `readSkill(ws, id)`, `listSkills(ws)` (from files),
`deleteSkill(ws, db, id)` (removes file + row), `indexSkill(db, skill)` (upsert row),
`reindexSkills(ws, db)` (`DELETE FROM skills` then re-index from files — files-are-canon), and a
`getActiveSkills(db): SkillRow[]` reader. Paths in `store/files.ts`: `skillsDir(ws) = join(ws,
"skills")`, `skillFile(ws, id) = join(ws, "skills", <id>.md)`; `ensureWorkspace` creates `skills/`.

## 5. Retrieval (`src/skills/retrieval.ts`)

Keyword overlap, mirroring `core/discovery.ts`:
```ts
export interface SkillHit { id: string; name: string; description: string; score: number }
export function rankSkills(rows: SkillRow[], query: string, k: number): SkillHit[]
```
Tokenizes `name + description + tags`, scores by query-term overlap, returns top `k` `active`
skills. Semantic search (KB embeddings) is a deferred upgrade behind this same interface.

## 6. Tools (`src/core/tools.ts`)

Granted to **every agent unconditionally** (a universal capability — like the MCP-tools grant added
in the KB work), so any worker can follow procedures:
- `find_skills({ query, k=6 })` → `{ matches: [{ id, name, description }] }`.
- `use_skill({ name })` → resolves by `name` (fallback `id`) among `active` skills → `{ name, body }`,
  or `{ error }` if unknown. The body enters the agent's context so it follows the procedure.

Built-ins still win over MCP tools (first-wins), consistent with the existing merge.

## 7. Auto-injection (`src/core/run.ts` + `src/core/prompt.ts`)

Each run, rank `getActiveSkills(db)` against the task (`brief.goal` else last user turn — same source
the KB auto-inject uses) and inject a compact block for **every** agent:
```
## Skills available (call use_skill(name) to load the full procedure before you act)
- <name>: <description>
```
Added as a `skills` section in `prompt.ts` (volatile tier, next to `knowledge`). The run trace's
ledger records the injected skill ids (`ledger.skills`), mirroring `ledger.knowledge`.

## 8. Command surface (`src/ui/slash.ts` + `src/ui/App.tsx`)

Deterministic admin surface, mirroring `/kb`: a `parseSkillCommand(arg)` union +
`{ name: "skills", … }` in `COMMANDS`, interpreted in `App.tsx`:
- `/skills list` — id, name, status, description.
- `/skills show <id|name>` — full skill incl. body.
- `/skills remove <id>` — delete file + row (cascade is trivial — no edges).
- `/skills reindex` — rebuild the index from files (after hand-edits).
Authoring is **file-canon**: create/edit `skills/<id>.md` in an editor, then `/skills reindex` (or
reboot). (Interactive `/skills add` and agent `propose_skill` are deferred.)

## 9. Seeded starter skills

`seedSkills(ws)` (mirrors `seedRoot`): if `skills/` has no `*.md`, write a few starter skills, then
they're indexed on boot. Starters (real, useful for taicho agents; exact bodies in the plan):
- **`write-a-clear-artifact`** — structure, be concrete, self-check before `write_artifact`.
- **`delegate-a-task-well`** — scope the goal, pass context, pick the right agent via `find_agents`.
- **`use-the-knowledgebase`** — `recall` before acting; `remember` durable facts with typed edges.

## 10. Boot wiring (`src/index.tsx`)

After `seedLibrarian`: `await seedSkills(ws)`; after `reindexKnowledge`: `reindexSkills(ws, db)`.
Pass the skills reader into the run pipeline so auto-injection works (a `RunDeps` seam, like `embed`).
`ensureWorkspace` already creates `skills/` (§4). Register `skills` in `COMMANDS`.

## 11. Testing (`bun:test`, no network)

- **Schema/store** (`store/skills.test.ts`): serialize/parse round-trip; `writeSkill` persists file +
  row; `reindexSkills` rebuilds from files; `deleteSkill` removes both.
- **Retrieval** (`skills/retrieval.test.ts`): `rankSkills` ranks by name/description/tag overlap,
  excludes `draft`, respects `k`.
- **Tools** (`core/tools.test.ts`): `find_skills` returns matches; `use_skill` returns the body for a
  known name and `{error}` for an unknown one; both present for a bare agent (universal grant).
- **Ink Layer-1** (`ui/App.test.tsx`, per `TESTING.md`): `/skills list` shows a seeded skill;
  `/skills show <name>` prints its body; and a run where the mocked model calls `use_skill` and the
  procedure body flows into the tool result.
- **Migration** (`store/migrate.test.ts`): v4 creates `skills`; `SCHEMA_VERSION === 4`.
- Build: `bun run typecheck` + `bun test` green; `bun run build` compiles.

## 12. File structure

- Create: `src/schemas/skill.ts`, `src/store/skills.ts`, `src/skills/retrieval.ts`, seed content in
  `src/store/seed-skills.ts` (the starter bodies) or inline in `seedSkills`; colocated `*.test.ts`.
- Modify: `src/store/migrate.ts` (v4), `src/store/files.ts` (paths + `ensureWorkspace`),
  `src/core/tools.ts` (2 tools), `src/core/run.ts` (inject + `RunDeps`/`RunContext` seam + trace
  ledger), `src/core/prompt.ts` (skills section), `src/schemas/trace.ts` (`ledger.skills`),
  `src/index.tsx` (seed + reindex + wire), `src/ui/slash.ts` (`parseSkillCommand` + `COMMANDS`),
  `src/ui/App.tsx` (`/skills` branch), `README.md`.

## 13. Risks & open questions

- **Prompt bloat**: only inject skill *names + descriptions* (not bodies); the body loads via
  `use_skill` on demand — keeps the per-run prompt small (same discipline as KB recall).
- **Universal tool grant**: granting `find_skills`/`use_skill` to every agent (not gated by
  `agent.tools`) departs slightly from the gated built-ins but matches the MCP-grant precedent and
  the goal (every agent can follow procedures). Built-ins still shadow MCP tools.
- **Skill quality = the whole value.** Garbage skills teach mistakes. Mitigation: admin-curated
  (file-canon + `/skills`), `active`/`draft` status so a WIP skill isn't injected, and the seeded
  starters set the quality bar. Agent-proposed skills stay deferred until an approval gate exists.
- **Naming collisions**: `use_skill` resolves by `name`; enforce unique `name` at seed time and warn
  on duplicate names during `reindexSkills`.
