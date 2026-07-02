# Agent Skills — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give taicho's agents a library of reviewed procedure documents ("skills") they can discover, auto-see, and load (`use_skill`) so repeatable operations run reliably with fewer mistakes.

**Architecture:** Skills are files (`skills/<id>.md`, YAML frontmatter + markdown body) — canon — indexed into a `skills` SQLite table (rebuilt on boot). A keyword ranker surfaces relevant skills; every agent gets `find_skills`/`use_skill` and an auto-injected "Skills available" prompt block (names + when-to-use), loading full bodies on demand. Admin curates via files + a `/skills` command surface. Mirrors the KB + coaching subsystems.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, zod, React 19 / Ink 7, `bun:test` + `ink-testing-library`.

## Global Constraints

- **Runtime:** Bun. Tests: `bun test` (no `test` npm script). Typecheck: `bun run typecheck`. Build: `bun run build`.
- **Files are canon; SQLite is a rebuildable index** — every mutation writes the `skills/*.md` file and the row consistently; boot `reindexSkills` rebuilds from files.
- **New table via the versioned migrator** (`src/store/migrate.ts`): the skills table is **v4** (`SCHEMA_VERSION` derives from the last entry; never hand-set). Main is at v3.
- **zod for schemas; colocated `*.test.ts`.**
- **`find_skills`/`use_skill` are granted to EVERY agent unconditionally** (a universal capability, like the MCP-tools grant) — NOT gated by `agent.tools.includes`. Built-ins still win over MCP tools (first-wins in the existing merge).
- **Prompt stays lean:** auto-inject only skill *names + descriptions*; full bodies load via `use_skill`.
- **Only `status: "active"` skills are injected/usable** (`draft` are hidden).
- **Testing at the Ink layer is mandatory** (`TESTING.md` Layer 1) for the `/skills` surface and `use_skill`, in addition to unit tests.

---

### Task 1: Skill schema + v4 migration + workspace paths + trace ledger

**Files:**
- Create: `src/schemas/skill.ts`
- Modify: `src/store/migrate.ts` (v4), `src/store/files.ts` (paths + `ensureWorkspace`), `src/schemas/trace.ts` (`ledger.skills`)
- Test: `src/store/migrate.test.ts` (extend)

**Interfaces:**
- Produces: `Skill` zod type; `paths.skillsDir(ws)`, `paths.skillFile(ws, id)`; `skills` table; `SCHEMA_VERSION === 4`; `CoachingLedger.skills: string[]`.

- [ ] **Step 1: Write the failing test** — append to `src/store/migrate.test.ts`:

```ts
test("v4 creates the skills table and bumps SCHEMA_VERSION to 4", () => {
  const db = openDb(ws());
  expect(SCHEMA_VERSION).toBe(4);
  expect(getMeta(db, "schema_version")).toBe("4");
  expect(() => db.query("SELECT id, name, description, tags, status, body FROM skills").all()).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/store/migrate.test.ts`
Expected: FAIL — `SCHEMA_VERSION` is 3; `no such table: skills`.

- [ ] **Step 3: Create the Skill schema** — `src/schemas/skill.ts`:

```ts
import { z } from "zod";

/** A reusable procedure document — one file per skill at skills/<id>.md
 *  (YAML frontmatter = the skill minus `body`, body = the procedure). Mirrors schemas/policy.ts. */
export const Skill = z.object({
  id: z.string(),                                        // skill_xxxx
  name: z.string(),                                      // short, unique; used by use_skill + display
  description: z.string(),                               // WHEN to use it — drives discovery + injection
  tags: z.array(z.string()).default([]),
  status: z.enum(["active", "draft"]).default("active"), // only `active` are injected/usable
  body: z.string(),                                      // the procedure (markdown)
  created: z.string().datetime(),
  updated: z.string().datetime().optional(),
});
export type Skill = z.infer<typeof Skill>;
```

- [ ] **Step 4: Add the v4 migration** — in `src/store/migrate.ts`, append to `MIGRATIONS` after the v3 entry:

```ts
  // v4: agent skills — reusable procedure documents. Files (skills/*.md) are canon; this is the index.
  {
    version: 4,
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS skills (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          description TEXT NOT NULL,
          tags        TEXT,
          status      TEXT NOT NULL DEFAULT 'active',
          body        TEXT NOT NULL,
          created     INTEGER DEFAULT (unixepoch()),
          updated     INTEGER DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS skills_status ON skills(status);
      `),
  },
```

- [ ] **Step 5: Add workspace paths** — in `src/store/files.ts`, add to the `paths` object:

```ts
  skillsDir: (ws: string) => join(ws, "skills"),
  skillFile: (ws: string, id: string) => join(ws, "skills", `${id}.md`),
```

and in `ensureWorkspace` (after the `kb/sources` mkdir):

```ts
  await mkdir(join(ws, "skills"), { recursive: true });
```

- [ ] **Step 6: Add `skills` to the coaching ledger** — in `src/schemas/trace.ts`, add to `CoachingLedger` (after the `knowledge` line):

```ts
  skills: z.array(z.string()).default([]), // skill ids injected into context (default keeps old traces parseable)
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bun test src/store/migrate.test.ts && bun run typecheck`
Expected: PASS; typecheck clean (the new `Skill` type + ledger field compile).

- [ ] **Step 8: Commit**

```bash
git add src/schemas/skill.ts src/store/migrate.ts src/store/files.ts src/schemas/trace.ts src/store/migrate.test.ts
git commit -m "feat(skills): Skill schema + skills table (v4) + skills/ workspace dir + ledger.skills"
```

---

### Task 2: Skill store (`src/store/skills.ts`)

**Files:**
- Create: `src/store/skills.ts`
- Test: `src/store/skills.test.ts`

**Interfaces:**
- Consumes: `Skill` (Task 1), `paths.skillsDir`/`paths.skillFile`, `openDb`.
- Produces: `serializeSkill`, `parseSkill`, `mkSkillId(): string`, `writeSkill(ws, db, s)`, `readSkill(ws, id): Skill | null`, `listSkills(ws): Skill[]`, `deleteSkill(ws, db, id): boolean`, `indexSkill(db, s)`, `reindexSkills(ws, db)`, `interface SkillRow { id; name; description; tags: string[]; status: string; body: string }`, `getActiveSkills(db): SkillRow[]`.

- [ ] **Step 1: Write the failing test** — `src/store/skills.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { paths } from "./files";
import { Skill } from "../schemas/skill";
import { serializeSkill, parseSkill, writeSkill, readSkill, listSkills, deleteSkill, reindexSkills, getActiveSkills, mkSkillId } from "./skills";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-skill-"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mk = (over: any = {}) => Skill.parse({ id: mkSkillId(), name: "n", description: "d", body: "step 1", created: new Date().toISOString(), ...over });

test("serialize/parse round-trips a skill", () => {
  const s = mk({ name: "deploy", description: "how to deploy", tags: ["ops"], body: "1. do x" });
  const back = parseSkill(serializeSkill(s));
  expect(back.name).toBe("deploy");
  expect(back.body).toBe("1. do x");
  expect(back.tags).toEqual(["ops"]);
});

test("writeSkill persists the file + row; readSkill reads it back", () => {
  const w = ws(); const db = openDb(w);
  writeSkill(w, db, mk({ id: "skill_a", name: "alpha" }));
  expect(existsSync(paths.skillFile(w, "skill_a"))).toBe(true);
  expect(readSkill(w, "skill_a")?.name).toBe("alpha");
  expect(getActiveSkills(db).map((r) => r.id)).toContain("skill_a");
});

test("getActiveSkills excludes draft skills", () => {
  const w = ws(); const db = openDb(w);
  writeSkill(w, db, mk({ id: "skill_on", status: "active" }));
  writeSkill(w, db, mk({ id: "skill_off", status: "draft" }));
  expect(getActiveSkills(db).map((r) => r.id)).toEqual(["skill_on"]);
});

test("reindexSkills rebuilds the table from files; deleteSkill removes file + row", () => {
  const w = ws(); const db = openDb(w);
  writeSkill(w, db, mk({ id: "skill_a", name: "alpha", tags: ["x"] }));
  db.exec("DELETE FROM skills");
  expect(getActiveSkills(db).length).toBe(0);
  reindexSkills(w, db);
  expect(getActiveSkills(db).map((r) => r.id)).toEqual(["skill_a"]);
  expect(getActiveSkills(db)[0]!.tags).toEqual(["x"]); // tags round-trip through the index
  expect(deleteSkill(w, db, "skill_a")).toBe(true);
  expect(existsSync(paths.skillFile(w, "skill_a"))).toBe(false);
  expect(getActiveSkills(db).length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/store/skills.test.ts`
Expected: FAIL — `Cannot find module './skills'`.

- [ ] **Step 3: Implement** — `src/store/skills.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/store/skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/skills.ts src/store/skills.test.ts
git commit -m "feat(skills): skill store (files-canon + skills index, reindex, getActiveSkills)"
```

---

### Task 3: Skill retrieval (`src/skills/retrieval.ts`)

**Files:**
- Create: `src/skills/retrieval.ts`
- Test: `src/skills/retrieval.test.ts`

**Interfaces:**
- Consumes: `SkillRow` (Task 2).
- Produces: `interface SkillHit { id: string; name: string; description: string; score: number }`; `rankSkills(rows: SkillRow[], query: string, k: number): SkillHit[]` — keyword overlap over `name + description + tags`, `active` only, top `k`.

- [ ] **Step 1: Write the failing test** — `src/skills/retrieval.test.ts`:

```ts
import { test, expect } from "bun:test";
import { rankSkills } from "./retrieval";
import type { SkillRow } from "../store/skills";

const row = (over: Partial<SkillRow>): SkillRow => ({ id: "s", name: "n", description: "d", tags: [], status: "active", body: "b", ...over });

test("ranks by name/description/tag overlap and caps at k", () => {
  const rows: SkillRow[] = [
    row({ id: "s1", name: "deploy-service", description: "ship to prod", tags: ["ops"] }),
    row({ id: "s2", name: "write-artifact", description: "produce a clean document", tags: ["writing"] }),
    row({ id: "s3", name: "delegate", description: "hand off a goal to another agent", tags: [] }),
  ];
  const hits = rankSkills(rows, "how do I deploy to prod", 2);
  expect(hits[0]!.id).toBe("s1");
  expect(hits.length).toBeLessThanOrEqual(2);
});

test("excludes draft skills and returns [] for an empty query", () => {
  const rows: SkillRow[] = [row({ id: "s1", name: "deploy", status: "draft" })];
  expect(rankSkills(rows, "deploy", 5)).toEqual([]);
  expect(rankSkills([row({ id: "s2", name: "deploy", status: "active" })], "", 5)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/skills/retrieval.test.ts`
Expected: FAIL — `Cannot find module './retrieval'`.

- [ ] **Step 3: Implement** — `src/skills/retrieval.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/skills/retrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skills/retrieval.ts src/skills/retrieval.test.ts
git commit -m "feat(skills): rankSkills — keyword discovery over active skills"
```

---

### Task 4: `find_skills` + `use_skill` tools (universal grant)

**Files:**
- Modify: `src/core/tools.ts`
- Test: `src/core/tools.test.ts` (extend)

**Interfaces:**
- Consumes: `getActiveSkills` (Task 2), `rankSkills` (Task 3); `ctx.db`.
- Produces (tool contracts): `find_skills({ query, k=6 }) → { matches: [{ id, name, description }] }`; `use_skill({ name }) → { name, body }` or `{ error }`. Both present for EVERY agent.

- [ ] **Step 1: Write the failing test** — append to `src/core/tools.test.ts`:

```ts
import { writeSkill } from "../store/skills";
import { Skill } from "../schemas/skill";

test("find_skills + use_skill are granted to every agent and read active skills", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-sk-"));
  const db = openDb(w);
  writeSkill(w, db, Skill.parse({ id: "skill_dep", name: "deploy", description: "ship to prod", body: "1. build\n2. ship", created: new Date().toISOString() }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sctx = { db } as any as RunContext;
  const set = toolsForAgent(agent(["write_artifact"]), sctx); // NOT granted skills explicitly → still present
  expect(set.find_skills).toBeDefined();
  expect(set.use_skill).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = await set.find_skills!.execute!({ query: "how do I deploy", k: 6 }, { toolCallId: "1", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((found as any).matches.map((m: any) => m.name)).toContain("deploy");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const used = await set.use_skill!.execute!({ name: "deploy" }, { toolCallId: "2", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((used as any).body).toContain("1. build");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const miss = await set.use_skill!.execute!({ name: "nope" }, { toolCallId: "3", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((miss as any).error).toBeDefined();
});
```

Ensure the test file imports `mkdtempSync` (`node:fs`), `tmpdir` (`node:os`), `join` (`node:path`), `openDb` (`../store/db`) — add any missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/tools.test.ts`
Expected: FAIL — `find_skills`/`use_skill` not defined.

- [ ] **Step 3: Implement** — in `src/core/tools.ts`, add imports at the top:

```ts
import { getActiveSkills } from "../store/skills";
import { rankSkills } from "../skills/retrieval";
```

and add the two tools inside `toolsForAgent`, **before** the MCP merge block (`if (mcp) for …`), UNCONDITIONALLY (no `agent.tools.includes` gate — a universal capability):

```ts
  // Skills are a universal agent capability (like the MCP-tools grant): every agent can discover and
  // load reviewed procedures. Not gated by agent.tools; built-ins still win over MCP tools below.
  set.find_skills = tool({
    description: "Search the deck's reusable skills (reviewed procedures for repeatable operations) by what you're trying to do. Returns matching skill names + when to use them; call use_skill to load the full procedure.",
    inputSchema: z.object({ query: z.string(), k: z.number().int().positive().max(20).default(6) }),
    execute: async ({ query, k }) => ({ matches: rankSkills(getActiveSkills(ctx.db), query, k).map((h) => ({ id: h.id, name: h.name, description: h.description })) }),
  });

  set.use_skill = tool({
    description: "Load the full step-by-step procedure for a skill by name, then follow it. Use this for repeatable operations so you do them the reviewed way with fewer mistakes.",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const rows = getActiveSkills(ctx.db);
      const s = rows.find((r) => r.name === name) ?? rows.find((r) => r.id === name);
      return s ? { name: s.name, body: s.body } : { error: `no skill "${name}" — call find_skills to discover available skills` };
    },
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools.ts src/core/tools.test.ts
git commit -m "feat(skills): find_skills + use_skill tools (universal agent grant)"
```

---

### Task 5: Auto-inject relevant skills into the prompt

**Files:**
- Modify: `src/core/prompt.ts` (skills section), `src/core/run.ts` (rank + inject + trace ledger)
- Test: `src/core/prompt.test.ts` (extend)

**Interfaces:**
- Consumes: `getActiveSkills` (Task 2), `rankSkills` (Task 3), `assemble`'s new `skillsBlock` opt.
- Produces: a volatile `skills` prompt section; `trace.ledger.skills` populated with injected ids.

- [ ] **Step 1: Write the failing test** — append to `src/core/prompt.test.ts` (it already imports `assemble`; match its idiom):

```ts
test("assemble includes a skills block in the volatile tier when provided", () => {
  const agent = { id: "a", role: "r", identity: "i", tools: [], canSee: [], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 5 }, isRoot: false, created: "2026-07-02T00:00:00.000Z" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { system, sections } = assemble(agent as any, { visibleAgents: [], policies: [], skillsBlock: "## Skills available (call use_skill(name)…)\n- deploy: ship to prod" });
  expect(system).toContain("Skills available");
  expect(system).toContain("deploy: ship to prod");
  expect(sections.find((s) => s.name === "skills")?.tier).toBe("volatile");
});
```

(If `prompt.test.ts` has a local agent factory, reuse it instead of the inline object.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/prompt.test.ts`
Expected: FAIL — `assemble` ignores `skillsBlock`; no `skills` section.

- [ ] **Step 3: Add the skills section to `assemble`** — in `src/core/prompt.ts`, add `skillsBlock?: string;` to the `opts` type, and add this block in the **volatile** tier (right after the `knowledgeBlock` section):

```ts
  if (opts.skillsBlock)
    s.push({ name: "skills", tier: "volatile", text: opts.skillsBlock });
```

- [ ] **Step 4: Rank + inject in `run.ts`** — in `src/core/run.ts`, add imports:

```ts
import { getActiveSkills } from "../store/skills";
import { rankSkills } from "../skills/retrieval";
```

After the knowledge auto-inject block (which computes `knowledgeBlock`/`knowledgeIds`), add:

```ts
  // Auto-inject relevant skills (names + when-to-use) for EVERY agent; the full procedure loads via
  // use_skill on demand. Keyword-ranked against the task, like the KB block above.
  let skillsBlock: string | undefined;
  let skillIds: string[] = [];
  {
    const sq = opts.brief?.goal ?? lastUserText(opts.messages);
    if (sq.trim()) {
      try {
        const hits = rankSkills(getActiveSkills(deps.db), sq, 5);
        if (hits.length) {
          skillIds = hits.map((h) => h.id);
          skillsBlock = "## Skills available (call use_skill(name) to load the full procedure before you act)\n" +
            hits.map((h) => `- ${h.name}: ${h.description}`).join("\n");
        }
      } catch (e) { console.error(`skill inject failed for ${opts.agent.id}:`, e); }
    }
  }
```

Pass `skillsBlock` into `assemble(...)` (add `skillsBlock,` to the opts object alongside `knowledgeBlock`), and add `skills: skillIds` to the `trace.ledger` object (alongside `knowledge: knowledgeIds`).

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test src/core/prompt.test.ts && bun run typecheck`
Expected: PASS; clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/prompt.ts src/core/run.ts src/core/prompt.test.ts
git commit -m "feat(skills): auto-inject relevant skills into every run's prompt + trace ledger"
```

---

### Task 6: Seed starter skills

**Files:**
- Create: `src/store/seed-skills.ts`
- Test: `src/store/seed-skills.test.ts`

**Interfaces:**
- Consumes: `Skill` (Task 1), `paths.skillsDir`/`skillFile`, `serializeSkill`.
- Produces: `STARTER_SKILLS: Skill[]`; `seedSkills(ws: string): Promise<void>` — writes the starters as `skills/<id>.md` files only when `skills/` has no `*.md` (idempotent; fixed ids). Boot indexes them via `reindexSkills`.

- [ ] **Step 1: Write the failing test** — `src/store/seed-skills.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./files";
import { seedSkills, STARTER_SKILLS } from "./seed-skills";
import { readSkill } from "./skills";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-seed-"));

test("seedSkills writes the starter skills when skills/ is empty", async () => {
  const w = ws();
  await seedSkills(w);
  const files = readdirSync(paths.skillsDir(w)).filter((f) => f.endsWith(".md"));
  expect(files.length).toBe(STARTER_SKILLS.length);
  for (const s of STARTER_SKILLS) expect(readSkill(w, s.id)?.name).toBe(s.name);
});

test("seedSkills is a no-op when skills already exist (doesn't clobber curation)", async () => {
  const w = ws();
  mkdirSync(paths.skillsDir(w), { recursive: true });
  writeFileSync(paths.skillFile(w, "skill_custom"), "---\nid: skill_custom\nname: custom\ndescription: mine\ntags: []\nstatus: active\ncreated: 2026-07-02T00:00:00.000Z\n---\nmy steps\n");
  await seedSkills(w);
  const files = readdirSync(paths.skillsDir(w)).filter((f) => f.endsWith(".md"));
  expect(files).toEqual(["skill_custom.md"]); // starters NOT written
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/store/seed-skills.test.ts`
Expected: FAIL — `Cannot find module './seed-skills'`.

- [ ] **Step 3: Implement** — `src/store/seed-skills.ts`:

```ts
/** Starter skills shipped so the deck is useful out of the box. Written as canonical files on first
 *  boot (only when skills/ is empty), then indexed by reindexSkills. Fixed ids ⇒ idempotent. */
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Skill } from "../schemas/skill";
import { serializeSkill } from "./skills";
import { paths } from "./files";

const SEED_TS = "2026-07-02T00:00:00.000Z";

export const STARTER_SKILLS: Skill[] = [
  Skill.parse({
    id: "skill_write_artifact", name: "write-a-clear-artifact",
    description: "Produce a clean, useful artifact when a task asks you to write or document something.",
    tags: ["writing", "artifact", "documentation"], created: SEED_TS,
    body: [
      "Follow this before calling write_artifact:",
      "1. Put the goal/answer in one line at the top — lead with the conclusion, then the detail.",
      "2. Structure with headings; prefer lists and tables over walls of prose where they aid scanning.",
      "3. Be concrete: real names, paths, commands, numbers. Cut vague filler.",
      "4. Self-check: does it answer the ACTUAL request? Is anything unverified? Cut it or flag it explicitly.",
      "5. Use a lowercase-hyphen topicSlug that names the deliverable.",
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
    id: "skill_use_kb", name: "use-the-knowledgebase",
    description: "Recall shared knowledge before acting and record durable facts so the squad stops re-deriving them.",
    tags: ["knowledge", "memory", "recall", "remember"], created: SEED_TS,
    body: [
      "Use the deck knowledgebase on repeatable work:",
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/store/seed-skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/seed-skills.ts src/store/seed-skills.test.ts
git commit -m "feat(skills): seed starter skills (write-artifact, delegate, use-kb)"
```

---

### Task 7: Boot wiring (seed + reindex skills)

**Files:**
- Modify: `src/index.tsx`

**Note:** integration wiring; verified by `bun run typecheck` + `bun test` + `bun run build` (no unit test — booting Ink is out of scope for `bun:test`).

- [ ] **Step 1: Seed + reindex at boot** — in `src/index.tsx`:

Add imports:
```ts
import { seedSkills } from "./store/seed-skills";
import { reindexSkills } from "./store/skills";
```

Call `seedSkills` right after `await seedLibrarian(ws, config.defaults);`:
```ts
await seedSkills(ws);
```

And reindex right after `reindexKnowledge(ws, db);`:
```ts
reindexSkills(ws, db); // rebuild the skills index from skills/*.md (files are canon)
```

- [ ] **Step 2: Verify typecheck + suite + build**

Run: `bun run typecheck && bun test && bun run build`
Expected: typecheck clean; all tests pass; `dist/taicho` compiles.

- [ ] **Step 3: Manual smoke (optional, not automatable here)**

The seeded skills now exist in a fresh workspace's `skills/` and are indexed; `find_skills`/`use_skill` and the auto-inject block are live. (Full REPL verification is the Ink test in Task 8.)

- [ ] **Step 4: Commit**

```bash
git add src/index.tsx
git commit -m "feat(skills): boot — seed starter skills + reindex the skills index"
```

---

### Task 8: `/skills` command surface

**Files:**
- Modify: `src/ui/slash.ts` (`parseSkillCommand` + `COMMANDS`), `src/ui/App.tsx` (`skills` branch)
- Test: `src/ui/slash.test.ts` (parser), `src/ui/App.test.tsx` (Ink Layer-1)

**Interfaces:**
- Consumes: `listSkills`/`readSkill`/`deleteSkill`/`reindexSkills`/`getActiveSkills` (Task 2), `use_skill` (Task 4).
- Produces: `type SkillCommand = { kind: "list" } | { kind: "show"; arg: string } | { kind: "remove"; id: string } | { kind: "reindex" } | { kind: "error"; message: string }`; `parseSkillCommand(arg): SkillCommand`.

- [ ] **Step 1: Write the failing parser test** — append to `src/ui/slash.test.ts`:

```ts
import { parseSkillCommand } from "./slash";

test("parseSkillCommand parses subcommands", () => {
  expect(parseSkillCommand("list")).toEqual({ kind: "list" });
  expect(parseSkillCommand("")).toEqual({ kind: "list" }); // bare /skills → list
  expect(parseSkillCommand("reindex")).toEqual({ kind: "reindex" });
  expect(parseSkillCommand("show deploy")).toEqual({ kind: "show", arg: "deploy" });
  expect(parseSkillCommand("remove skill_a")).toEqual({ kind: "remove", id: "skill_a" });
  expect(parseSkillCommand("show").kind).toBe("error");   // needs an arg
  expect(parseSkillCommand("wat").kind).toBe("error");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ui/slash.test.ts`
Expected: FAIL — `parseSkillCommand` not exported.

- [ ] **Step 3: Implement the parser** — in `src/ui/slash.ts`, add a `skills` entry to `COMMANDS` (after the `kb` entry):

```ts
  { name: "skills", summary: "manage agent skills", usage: "list | show <id|name> | remove <id> | reindex" },
```

and add near the `parseKbCommand` section:

```ts
export type SkillCommand =
  | { kind: "list" }
  | { kind: "reindex" }
  | { kind: "show"; arg: string }
  | { kind: "remove"; id: string }
  | { kind: "error"; message: string };

export function parseSkillCommand(arg: string): SkillCommand {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0];
  if (!sub || sub === "list") return { kind: "list" };
  if (sub === "reindex") return { kind: "reindex" };
  if (sub === "show") return parts[1] ? { kind: "show", arg: parts[1] } : { kind: "error", message: "usage: /skills show <id|name>" };
  if (sub === "remove") return parts[1] ? { kind: "remove", id: parts[1] } : { kind: "error", message: "usage: /skills remove <id>" };
  return { kind: "error", message: `unknown /skills subcommand "${sub}" (try list, show, remove, reindex)` };
}
```

- [ ] **Step 4: Run the parser test**

Run: `bun test src/ui/slash.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the App branch** — in `src/ui/App.tsx`, add imports:

```ts
import { parseSkillCommand } from "./slash";
import { listSkills, readSkill, deleteSkill, reindexSkills } from "../store/skills";
```

(Extend the existing `./slash` import to include `parseSkillCommand`.) Add this branch inside the async `runSlash` handler, **before** the `runSlashPure(...)` fallback (mirroring the `/kb` branch):

```ts
    if (cmd === "skills") {
      const parsed = parseSkillCommand(arg);
      if (parsed.kind === "error") { say({ kind: "system", text: `  ${parsed.message}` }); return; }
      if (parsed.kind === "list") {
        const skills = listSkills(props.ws);
        if (!skills.length) { say({ kind: "system", text: "  (no skills)" }); return; }
        skills.forEach((s) => say({ kind: "system", text: `  [${s.id}] ${s.name} (${s.status}) — ${s.description}` }));
        return;
      }
      if (parsed.kind === "show") {
        const all = listSkills(props.ws);
        const s = all.find((x) => x.name === parsed.arg) ?? readSkill(props.ws, parsed.arg);
        if (!s) { say({ kind: "system", text: `  no skill "${parsed.arg}"` }); return; }
        say({ kind: "system", text: `  [${s.id}] ${s.name} (${s.status}) — ${s.description}` });
        s.body.split("\n").forEach((ln) => say({ kind: "system", text: `  ${ln}` }));
        return;
      }
      if (parsed.kind === "remove") {
        say({ kind: "system", text: deleteSkill(props.ws, props.db, parsed.id) ? `  removed ${parsed.id}` : `  no skill "${parsed.id}"` });
        return;
      }
      // reindex
      reindexSkills(props.ws, props.db);
      say({ kind: "system", text: `  reindexed ${listSkills(props.ws).length} skill(s) from files` });
      return;
    }
```

- [ ] **Step 6: Write the failing Ink test** — append to `src/ui/App.test.tsx`. The `setup()` helper seeds root but not skills, so seed a skill into the test workspace first (import `writeSkill` + `Skill`):

```ts
test("/skills list and /skills show render seeded skills", async () => {
  const { db, props } = await setup();
  const { writeSkill } = await import("../store/skills");
  const { Skill } = await import("../schemas/skill");
  writeSkill(props.ws, db, Skill.parse({ id: "skill_dep", name: "deploy", description: "ship to prod", body: "1. build\n2. ship", created: new Date().toISOString() }));
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/skills list", ENTER);
  await waitFor(lastFrame, "deploy");
  expect(lastFrame()).toContain("ship to prod");
  await send(stdin, "/skills show deploy", ENTER);
  await waitFor(lastFrame, "1. build");
});
```

- [ ] **Step 7: Run the Ink test + full suite + typecheck + build**

Run: `bun test src/ui/App.test.tsx && bun test && bun run typecheck && bun run build`
Expected: all pass; `dist/taicho` compiles.

- [ ] **Step 8: Commit**

```bash
git add src/ui/slash.ts src/ui/slash.test.ts src/ui/App.tsx src/ui/App.test.tsx
git commit -m "feat(skills): /skills command surface (list/show/remove/reindex)"
```

---

### Task 9: Documentation — README Skills section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Skills section** — add after the existing `## Knowledge (shared deck memory)` section:

```markdown
## Skills (reusable procedures)

Agents share a library of **skills** — reviewed, step-by-step procedures for repeatable operations,
so the squad does common tasks the right way with fewer mistakes. Each skill is a file
(`skills/<id>.md`, YAML frontmatter + a markdown procedure); files are canon and a SQLite table
indexes them. Every agent can `find_skills(query)` and `use_skill(name)` (load the full procedure),
and the most relevant skills auto-inject (name + when-to-use) into each run's prompt.

Author skills by creating/editing `skills/*.md` and running `/skills reindex` (a few starters ship
by default). Manage them with `/skills list`, `/skills show <id|name>`, `/skills remove <id>`. Set a
skill's `status: draft` to keep it out of agents' context while you work on it.
```

- [ ] **Step 2: Verify nothing broke**

Run: `bun run typecheck && bun test`
Expected: PASS (docs-only).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(skills): document the skills library, /skills, and use_skill"
```

---

## Self-Review

**Spec coverage:** §3 schema + v4 → Task 1. §4 store → Task 2. §5 retrieval → Task 3. §6 tools (universal grant) → Task 4. §7 auto-inject + ledger → Task 5 (+ trace field in Task 1). §8 `/skills` surface → Task 8. §9 seeded starters → Task 6. §10 boot wiring → Task 7. §11 testing → unit in Tasks 1–6, Ink Layer-1 in Task 8, build in Tasks 7/8. README (§12) → Task 9. Deferred non-goals (executable/agent-proposed/semantic/ACLs) — none implemented.

**Placeholder scan:** none — every code step has complete code (incl. the three starter skill bodies); every run step has an exact command + expected result.

**Type consistency:** `Skill` (Task 1) used in Tasks 2/4/6. `SkillRow { id, name, description, tags: string[], status, body }` defined in Task 2, consumed by `rankSkills` (Task 3) and `getActiveSkills` (Task 2) and the tools (Task 4). `rankSkills(rows, query, k) → SkillHit[]` used in Tasks 3/5 with matching destructuring. `getActiveSkills(db) → SkillRow[]` used in Tasks 4/5. `assemble`'s `skillsBlock?` (Task 5) matches its injection. `CoachingLedger.skills` (Task 1) populated in Task 5. `parseSkillCommand → SkillCommand` (Task 8) matches the App branch. `seedSkills(ws)`/`STARTER_SKILLS` (Task 6) used in Task 7 boot. `mkSkillId`/`serializeSkill`/`writeSkill`/`readSkill`/`listSkills`/`deleteSkill`/`reindexSkills`/`indexSkill` (Task 2) used consistently downstream.
