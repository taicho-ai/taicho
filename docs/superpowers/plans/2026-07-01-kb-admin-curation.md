# Admin-curated knowledge graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin author source documents in `kb/sources/`, re-derive their graph subgraph on change via a built-in `librarian` agent, and prune agent-written memory on command — all with a correct cascade over nodes, edges, and vectors.

**Architecture:** Deterministic hash-diff detects changed source files; extraction is delegated to a new built-in `librarian` agent that reads a doc and `remember`s entities with typed edges (stamped with source provenance so a doc's subgraph is replaceable atomically). A single cascade-correct `forgetNodes` powers both source re-sync and admin prune. A `/kb` command surface is the deterministic backstop. Files stay canon; SQLite is the rebuildable index.

**Tech Stack:** Bun + TypeScript (ESM), `bun:sqlite`, `bun:test`, React 19 / Ink 7 (TUI), zod, AI SDK (`ai`), `MockLanguageModelV3` from `ai/test` for model mocking.

## Global Constraints

- **Runtime:** Bun. Run tests with `bun test` (no `test` npm script). Typecheck: `bun run typecheck`. Bundle check: `bun run build`.
- **No network in tests.** Model calls mocked with `MockLanguageModelV3` (`ai/test`); embedders stubbed.
- **Files are canon; DB is a rebuildable index.** Every mutation writes the `kb/**` file and updates SQLite consistently.
- **Never break the single binary.** Do not statically import the embedder (`@huggingface/transformers` / `@ai-sdk/openai` embeddings) anywhere new; they load via runtime dynamic import in `src/core/embed.ts` only.
- **zod for all schemas.** Colocated `*.test.ts`.
- **Provenance formats (verbatim):** source-derived `sources/<file>@<hash>`; agent-derived `<agentId>:<runId>`.
- **Migrator pattern:** new tables go in `src/store/migrate.ts` as a new versioned `Migration`; bump nothing by hand — `SCHEMA_VERSION` is derived from the last entry.

---

### Task 1: `kb/sources/` directory + `kb_sources` table (v3 migration)

**Files:**
- Modify: `src/store/files.ts` (add `kbSourceDir`/`kbSourceFile`, create dir in `ensureWorkspace`)
- Modify: `src/store/migrate.ts` (append v3 migration)
- Test: `src/store/migrate.test.ts` (extend)

**Interfaces:**
- Produces: `paths.kbSourceDir(ws): string`, `paths.kbSourceFile(ws, name): string`; a `kb_sources(path PRIMARY KEY, hash, updated)` table; `SCHEMA_VERSION === 3`.

- [ ] **Step 1: Write the failing test** — append to `src/store/migrate.test.ts`:

```ts
test("v3 creates kb_sources and bumps SCHEMA_VERSION to 3", () => {
  const db = openDb(ws());
  expect(SCHEMA_VERSION).toBe(3);
  expect(getMeta(db, "schema_version")).toBe("3");
  expect(() => db.query("SELECT path, hash, updated FROM kb_sources").all()).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/store/migrate.test.ts`
Expected: FAIL — `SCHEMA_VERSION` is `2`; `no such table: kb_sources`.

- [ ] **Step 3: Add the v3 migration** — in `src/store/migrate.ts`, append to the `MIGRATIONS` array (after the v2 entry, before the closing `]`):

```ts
  // v3: source-document tracking — one row per file in kb/sources/, holds its last-synced hash.
  {
    version: 3,
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS kb_sources (
          path     TEXT PRIMARY KEY,   -- relative, e.g. "sources/architecture.md"
          hash     TEXT NOT NULL,      -- content hash last synced
          updated  INTEGER DEFAULT (unixepoch())
        );
      `),
  },
```

- [ ] **Step 4: Add source paths + workspace dir** — in `src/store/files.ts`, add to the `paths` object (after `kbNodeFile`):

```ts
  kbSourceDir: (ws: string) => join(ws, "kb", "sources"),
  kbSourceFile: (ws: string, name: string) => join(ws, "kb", "sources", name),
```

and add to `ensureWorkspace` (after the `kb/nodes` mkdir):

```ts
  await mkdir(join(ws, "kb", "sources"), { recursive: true });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/store/migrate.test.ts`
Expected: PASS (all migrate tests, including the existing idempotency one).

- [ ] **Step 6: Commit**

```bash
git add src/store/migrate.ts src/store/migrate.test.ts src/store/files.ts
git commit -m "feat(kb): kb_sources table (v3 migration) + kb/sources workspace dir"
```

---

### Task 2: Source discovery, hashing & diff (`src/store/sources.ts`)

**Files:**
- Create: `src/store/sources.ts`
- Test: `src/store/sources.test.ts`

**Interfaces:**
- Consumes: `paths.kbSourceDir` (Task 1); `openDb` (`./db`).
- Produces:
  - `hashContent(text: string): string` — first 12 hex of sha256.
  - `interface DiscoveredSource { path: string; content: string; hash: string }` — `path` is `sources/<name>`.
  - `listSourceFiles(ws: string): DiscoveredSource[]`
  - `readTrackedSources(db: Database): Map<string, string>` — path → hash.
  - `upsertSourceHash(db, path, hash): void`; `deleteSourceHash(db, path): void`.
  - `interface SourceDiff { changed: DiscoveredSource[]; deleted: string[] }`
  - `diffSources(ws: string, db: Database): SourceDiff`

- [ ] **Step 1: Write the failing test** — `src/store/sources.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { paths } from "./files";
import { hashContent, listSourceFiles, diffSources, upsertSourceHash, readTrackedSources } from "./sources";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-src-"));
const write = (w: string, name: string, body: string) => {
  mkdirSync(paths.kbSourceDir(w), { recursive: true });
  writeFileSync(paths.kbSourceFile(w, name), body);
};

test("hashContent is stable and content-sensitive", () => {
  expect(hashContent("hello")).toBe(hashContent("hello"));
  expect(hashContent("hello")).not.toBe(hashContent("world"));
  expect(hashContent("hello")).toHaveLength(12);
});

test("listSourceFiles finds .md/.txt with relative sources/<name> paths", () => {
  const w = ws();
  write(w, "a.md", "alpha");
  write(w, "b.txt", "beta");
  write(w, "ignore.png", "x");
  const found = listSourceFiles(w).map((s) => s.path).sort();
  expect(found).toEqual(["sources/a.md", "sources/b.txt"]);
});

test("diffSources reports new/changed/deleted against kb_sources", () => {
  const w = ws();
  const db = openDb(w);
  write(w, "a.md", "alpha");
  write(w, "b.md", "beta");
  // a.md tracked at an OLD hash (changed); b.md untracked (new); c.md tracked but gone (deleted)
  upsertSourceHash(db, "sources/a.md", "oldhash00000");
  upsertSourceHash(db, "sources/c.md", "deadbeef0000");
  const diff = diffSources(w, db);
  expect(diff.changed.map((c) => c.path).sort()).toEqual(["sources/a.md", "sources/b.md"]);
  expect(diff.deleted).toEqual(["sources/c.md"]);
  expect(readTrackedSources(db).get("sources/a.md")).toBe("oldhash00000");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/store/sources.test.ts`
Expected: FAIL — `Cannot find module './sources'`.

- [ ] **Step 3: Implement** — `src/store/sources.ts`:

```ts
/** Source-document discovery + hash tracking. Files in kb/sources/ are admin-authored inputs; each
 *  is hashed so the librarian re-extracts only what changed. Mirrors store/knowledge.ts (files canon,
 *  kb_sources = derived index of last-synced hashes). */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./files";

const SOURCE_EXT = /\.(md|txt)$/i;

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export interface DiscoveredSource { path: string; content: string; hash: string }

export function listSourceFiles(ws: string): DiscoveredSource[] {
  const dir = paths.kbSourceDir(ws);
  if (!existsSync(dir)) return [];
  const out: DiscoveredSource[] = [];
  for (const name of readdirSync(dir)) {
    if (!SOURCE_EXT.test(name)) continue;
    try {
      const content = readFileSync(join(dir, name), "utf8");
      out.push({ path: `sources/${name}`, content, hash: hashContent(content) });
    } catch (e) { console.error(`skipping source ${name}: ${String(e)}`); }
  }
  return out;
}

export function readTrackedSources(db: Database): Map<string, string> {
  const rows = db.query("SELECT path, hash FROM kb_sources").all() as { path: string; hash: string }[];
  return new Map(rows.map((r) => [r.path, r.hash]));
}

export function upsertSourceHash(db: Database, path: string, hash: string): void {
  db.query(
    "INSERT INTO kb_sources (path, hash, updated) VALUES (?, ?, unixepoch()) " +
    "ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, updated = unixepoch()",
  ).run(path, hash);
}

export function deleteSourceHash(db: Database, path: string): void {
  db.query("DELETE FROM kb_sources WHERE path = ?").run(path);
}

export interface SourceDiff { changed: DiscoveredSource[]; deleted: string[] }

export function diffSources(ws: string, db: Database): SourceDiff {
  const tracked = readTrackedSources(db);
  const onDisk = listSourceFiles(ws);
  const seen = new Set(onDisk.map((s) => s.path));
  const changed = onDisk.filter((s) => tracked.get(s.path) !== s.hash);
  const deleted = [...tracked.keys()].filter((p) => !seen.has(p));
  return { changed, deleted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/store/sources.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/sources.ts src/store/sources.test.ts
git commit -m "feat(kb): source discovery, content hashing, and diff against kb_sources"
```

---

### Task 3: Cascade-correct `forgetNodes` + `resolveNodeIds`

**Files:**
- Modify: `src/store/knowledge.ts` (append `NodeFilter`, `resolveNodeIds`, `forgetNodes`)
- Test: `src/store/knowledge.test.ts` (extend)

**Interfaces:**
- Consumes: existing `writeNode`, `paths.kbNodeFile`, `openDb`.
- Produces:
  - `interface NodeFilter { ids?: string[]; kind?: string; sourcePrefix?: string }`
  - `resolveNodeIds(db: Database, filter: NodeFilter): string[]`
  - `forgetNodes(ws: string, db: Database, filter: NodeFilter): { removedNodes: number; removedEdges: number }`

- [ ] **Step 1: Write the failing test** — append to `src/store/knowledge.test.ts` (imports `putVector` and adds `forgetNodes`, `resolveNodeIds` to the existing import from `./knowledge`):

```ts
import { putVector } from "./vectors";
// extend the existing `import { … } from "./knowledge"` with: resolveNodeIds, forgetNodes

test("forgetNodes cascades: removes matched nodes, their edges (both dirs), vectors, and files", () => {
  const w = ws();
  const db = openDb(w);
  writeNode(w, db, mkNode({ id: "kb_keep", kind: "fact", source: "worker-y:r1" }));
  writeNode(w, db, mkNode({ id: "kb_dec", kind: "decision", source: "worker-x:r1", edges: [{ to: "kb_keep", rel: "relates_to" }] }));
  writeNode(w, db, mkNode({ id: "kb_ref", kind: "fact", source: "worker-y:r2", edges: [{ to: "kb_dec", rel: "depends_on" }] })); // edge INTO kb_dec
  putVector(db, "kb_dec", "kb", new Float32Array([1, 0, 0]));

  const res = forgetNodes(w, db, { kind: "decision" });
  expect(res.removedNodes).toBe(1);
  expect(res.removedEdges).toBe(2); // kb_dec->kb_keep (out) AND kb_ref->kb_dec (in)
  expect(nodeExists(db, "kb_dec")).toBe(false);
  expect(existsSync(paths.kbNodeFile(w, "kb_dec"))).toBe(false);
  expect(nodeExists(db, "kb_keep")).toBe(true); // untouched
  expect(count(db, "SELECT COUNT(*) c FROM embeddings WHERE ref='kb_dec'")).toBe(0);
});

test("resolveNodeIds matches by kind, ids, and sourcePrefix", () => {
  const w = ws();
  const db = openDb(w);
  writeNode(w, db, mkNode({ id: "kb_1", kind: "fact", source: "sources/a.md@h1" }));
  writeNode(w, db, mkNode({ id: "kb_2", kind: "fact", source: "worker-x:r1" }));
  expect(resolveNodeIds(db, { kind: "fact" }).sort()).toEqual(["kb_1", "kb_2"]);
  expect(resolveNodeIds(db, { sourcePrefix: "sources/a.md@" })).toEqual(["kb_1"]);
  expect(resolveNodeIds(db, { ids: ["kb_2"] })).toEqual(["kb_2"]);
  expect(resolveNodeIds(db, {})).toEqual([]); // empty filter matches nothing (safety)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/store/knowledge.test.ts`
Expected: FAIL — `forgetNodes`/`resolveNodeIds` not exported.

- [ ] **Step 3: Implement** — append to `src/store/knowledge.ts`:

```ts
export interface NodeFilter { ids?: string[]; kind?: string; sourcePrefix?: string }

/** Node ids matching a filter. An EMPTY filter matches nothing (never "everything") — a safety
 *  guard so a mis-built prune can't wipe the whole graph. Combine clauses with AND. */
export function resolveNodeIds(db: Database, filter: NodeFilter): string[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.ids?.length) { where.push(`id IN (${filter.ids.map(() => "?").join(",")})`); params.push(...filter.ids); }
  if (filter.kind) { where.push("kind = ?"); params.push(filter.kind); }
  if (filter.sourcePrefix) { where.push("source LIKE ? ESCAPE '\\'"); params.push(likePrefix(filter.sourcePrefix)); }
  if (!where.length) return [];
  return (db.query(`SELECT id FROM kb_nodes WHERE ${where.join(" AND ")}`).all(...params) as { id: string }[]).map((r) => r.id);
}

/** Escape LIKE wildcards in a literal prefix, then append `%`. */
function likePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

/** Cascade delete: for the matched nodes, remove their edges (both directions), vectors, node rows,
 *  and canonical files — atomically. The single prune path for /kb forget and source re-sync. */
export function forgetNodes(ws: string, db: Database, filter: NodeFilter): { removedNodes: number; removedEdges: number } {
  const ids = resolveNodeIds(db, filter);
  if (!ids.length) return { removedNodes: 0, removedEdges: 0 };
  const ph = ids.map(() => "?").join(",");
  let removedEdges = 0;
  db.transaction(() => {
    removedEdges = (db.query(`SELECT COUNT(*) c FROM kb_edges WHERE from_id IN (${ph}) OR to_id IN (${ph})`).get(...ids, ...ids) as { c: number }).c;
    db.query(`DELETE FROM kb_edges WHERE from_id IN (${ph}) OR to_id IN (${ph})`).run(...ids, ...ids);
    db.query(`DELETE FROM embeddings WHERE kind = 'kb' AND ref IN (${ph})`).run(...ids);
    db.query(`DELETE FROM kb_nodes WHERE id IN (${ph})`).run(...ids);
  })();
  for (const id of ids) { try { rmSync(paths.kbNodeFile(ws, id)); } catch { /* file already gone */ } }
  return { removedNodes: ids.length, removedEdges };
}
```

Add `rmSync` to the existing `node:fs` import at the top of `src/store/knowledge.ts` (currently `import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/store/knowledge.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/store/knowledge.ts src/store/knowledge.test.ts
git commit -m "feat(kb): cascade-correct forgetNodes + resolveNodeIds (nodes+edges+vectors+files)"
```

---

### Task 4: Re-embed pass (`reembedAll`)

**Files:**
- Modify: `src/store/knowledge.ts` (add `reembedAll`)
- Test: `src/store/knowledge.test.ts` (extend)

**Rationale / deviation from spec §7:** Boot stays fast — we do NOT re-embed every node at boot (the local WASM model would block boot on first-use download + per-node inference). Instead re-embed is an explicit async pass used by `/kb reindex` (Task 10). Structural reindex at boot is unchanged; hand-edited node *content* refreshes its vector on `/kb reindex`.

**Interfaces:**
- Consumes: `putVector` (`./vectors`), existing `KbRow` query.
- Produces: `reembedAll(db: Database, embed: (t: string) => Promise<Float32Array>): Promise<number>` — (re)embeds every kb_node from its `title\nsummary\ncontent`; returns the count embedded. (No `ws` — it reads/writes SQLite only, never the filesystem.)

- [ ] **Step 1: Write the failing test** — append to `src/store/knowledge.test.ts` (add `reembedAll` to the `./knowledge` import):

```ts
test("reembedAll writes a vector per node from a stubbed embedder", async () => {
  const w = ws();
  const db = openDb(w);
  writeNode(w, db, mkNode({ id: "kb_a", title: "Alpha" }));
  writeNode(w, db, mkNode({ id: "kb_b", title: "Beta" }));
  const embed = async (t: string) => new Float32Array([t.length, 0, 0]); // deterministic stub
  const n = await reembedAll(db, embed);
  expect(n).toBe(2);
  expect(count(db, "SELECT COUNT(*) c FROM embeddings WHERE kind='kb'")).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/store/knowledge.test.ts`
Expected: FAIL — `reembedAll` not exported.

- [ ] **Step 3: Implement** — append to `src/store/knowledge.ts` (and add `import { putVector } from "./vectors";` near the top):

```ts
/** (Re)compute a vector for every kb_node from its title/summary/content. Used by /kb reindex to
 *  refresh semantic vectors after hand-edits or a blown-away embeddings table. Best-effort per node:
 *  one failure doesn't abort the pass. */
export async function reembedAll(db: Database, embed: (t: string) => Promise<Float32Array>): Promise<number> {
  const rows = db.query("SELECT id, title, summary, content FROM kb_nodes").all() as KbRow[];
  let n = 0;
  for (const r of rows) {
    try { putVector(db, r.id, "kb", await embed(`${r.title}\n${r.summary ?? ""}\n${r.content}`)); n++; }
    catch (e) { console.error(`reembed ${r.id} failed: ${String(e)}`); }
  }
  return n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/store/knowledge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/knowledge.ts src/store/knowledge.test.ts
git commit -m "feat(kb): reembedAll — refresh node vectors (closes the reindex re-embed gap)"
```

---

### Task 5: Sync orchestration (`src/knowledge/sync.ts`)

**Files:**
- Create: `src/knowledge/sync.ts`
- Test: `src/knowledge/sync.test.ts`

**Interfaces:**
- Consumes: `diffSources`, `upsertSourceHash`, `deleteSourceHash` (Task 2); `forgetNodes` (Task 3).
- Produces:
  - `type IngestFn = (path: string, hash: string) => Promise<void>`
  - `interface SyncSummary { changedDocs: number; deletedDocs: number; removedNodes: number }`
  - `syncKnowledgeSources(opts: { ws: string; db: Database; ingest: IngestFn }): Promise<SyncSummary>`

The `ingest` seam keeps this unit testable with NO model: production passes an `ingest` that drives the librarian (Task 10); tests pass a fake that writes a node.

- [ ] **Step 1: Write the failing test** — `src/knowledge/sync.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../store/db";
import { paths } from "../store/files";
import { KbNode } from "../schemas/knowledge";
import { writeNode, nodeExists, resolveNodeIds } from "../store/knowledge";
import { upsertSourceHash, hashContent } from "../store/sources";
import { syncKnowledgeSources } from "./sync";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-sync-"));
const write = (w: string, name: string, body: string) => {
  mkdirSync(paths.kbSourceDir(w), { recursive: true });
  writeFileSync(paths.kbSourceFile(w, name), body);
};
const mkNode = (over: object) => KbNode.parse({ id: "kb_x", title: "t", content: "c", created: new Date().toISOString(), ...over });

test("sync ingests changed docs, cleans deleted docs, and records hashes; is idempotent", async () => {
  const w = ws();
  const db = openDb(w);
  write(w, "a.md", "alpha v1");
  // stub ingest: each call writes one node stamped with the source provenance for that doc
  let calls = 0;
  const ingest = async (path: string, hash: string) => {
    calls++;
    writeNode(w, db, mkNode({ id: `kb_${calls}`, source: `${path}@${hash}` }));
  };

  const s1 = await syncKnowledgeSources({ ws: w, db, ingest });
  expect(s1.changedDocs).toBe(1);
  expect(resolveNodeIds(db, { sourcePrefix: "sources/a.md@" })).toHaveLength(1);

  // re-sync unchanged → no-op
  const s2 = await syncKnowledgeSources({ ws: w, db, ingest });
  expect(s2.changedDocs).toBe(0);
  expect(calls).toBe(1);

  // edit → old subgraph replaced, not appended
  write(w, "a.md", "alpha v2");
  const s3 = await syncKnowledgeSources({ ws: w, db, ingest });
  expect(s3.changedDocs).toBe(1);
  expect(s3.removedNodes).toBe(1); // the v1 node was forgotten before re-ingest
  expect(resolveNodeIds(db, { sourcePrefix: "sources/a.md@" })).toHaveLength(1);
  expect(resolveNodeIds(db, { sourcePrefix: `sources/a.md@${hashContent("alpha v2")}` })).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/knowledge/sync.test.ts`
Expected: FAIL — `Cannot find module './sync'`.

- [ ] **Step 3: Implement** — `src/knowledge/sync.ts`:

```ts
/** Hash-sync orchestration: detect changed/deleted source docs (deterministic), then for each changed
 *  doc clear its prior subgraph (by provenance) and re-extract via the injected `ingest`. Detection is
 *  plumbing; extraction is an agent (the librarian) supplied as `ingest`. Idempotent. */
import type { Database } from "bun:sqlite";
import { diffSources, upsertSourceHash, deleteSourceHash } from "../store/sources";
import { forgetNodes } from "../store/knowledge";

export type IngestFn = (path: string, hash: string) => Promise<void>;
export interface SyncSummary { changedDocs: number; deletedDocs: number; removedNodes: number }

export async function syncKnowledgeSources(opts: { ws: string; db: Database; ingest: IngestFn }): Promise<SyncSummary> {
  const { ws, db, ingest } = opts;
  const diff = diffSources(ws, db);
  let removedNodes = 0;

  for (const path of diff.deleted) {
    removedNodes += forgetNodes(ws, db, { sourcePrefix: `${path}@` }).removedNodes;
    deleteSourceHash(db, path);
  }

  for (const src of diff.changed) {
    removedNodes += forgetNodes(ws, db, { sourcePrefix: `${src.path}@` }).removedNodes; // drop old subgraph
    await ingest(src.path, src.hash);                                                    // re-extract
    upsertSourceHash(db, src.path, src.hash);
  }

  return { changedDocs: diff.changed.length, deletedDocs: diff.deleted.length, removedNodes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/knowledge/sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/knowledge/sync.ts src/knowledge/sync.test.ts
git commit -m "feat(kb): syncKnowledgeSources — hash-diff → forget-old → ingest (idempotent)"
```

---

### Task 6: Ingestion provenance — `ingestSource` thread + `remember` stamp

**Files:**
- Modify: `src/core/run.ts` (`RunContext.ingestSource`; `executeRun` opt; set on ctx)
- Modify: `src/core/tools.ts` (`remember` uses `ctx.ingestSource`)
- Test: `src/core/tools.test.ts` (extend)

**Interfaces:**
- Produces: `RunContext.ingestSource?: string`; `executeRun(deps, opts)` accepts `opts.ingestSource?: string`.
- Consumes (by Task 10): pass `ingestSource: \`${path}@${hash}\`` when running the librarian for a doc.

- [ ] **Step 1: Write the failing test** — append to `src/core/tools.test.ts`:

```ts
import { readNode } from "../store/knowledge";
import { openDb as openDb2 } from "../store/db"; // if openDb not already imported, reuse existing import instead

test("remember stamps ingestSource provenance when set (else agentId:runId)", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-rem-"));
  const db = openDb(w);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = { ws: w, db, runId: "r1", agentId: "librarian", notes: [] as string[] } as any as RunContext;
  const ingestCtx = { ...base, ingestSource: "sources/a.md@abc123abc123" } as RunContext;

  const set = toolsForAgent(agent(["remember"]), ingestCtx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.remember!.execute!({ title: "Deploy", content: "x", kind: "entity", edges: [] }, { toolCallId: "1", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(readNode(w, (out as any).id)?.source).toBe("sources/a.md@abc123abc123");

  const set2 = toolsForAgent(agent(["remember"]), base);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out2 = await set2.remember!.execute!({ title: "Note", content: "y", kind: "fact", edges: [] }, { toolCallId: "2", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(readNode(w, (out2 as any).id)?.source).toBe("librarian:r1");
});
```

Ensure the test file's top imports include `mkdtempSync` (`node:fs`), `tmpdir` (`node:os`), `join` (`node:path`), and `openDb` (`../store/db`) — several are already present; add only what's missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/tools.test.ts`
Expected: FAIL — remembered node's `source` is `librarian:r1` even when `ingestSource` is set (override not wired).

- [ ] **Step 3: Thread `ingestSource` through the run** — in `src/core/run.ts`:

In the `RunContext` interface (after `embed?: …`):

```ts
  ingestSource?: string; // when set (a source-ingestion run), remember stamps this instead of agentId:runId
```

In `executeRun`'s `opts` type (add to the object after `ancestry?: string[]`):

```ts
    ingestSource?: string;
```

In the `ctx` object literal (after `embed: deps.embed,`):

```ts
    ingestSource: opts.ingestSource,
```

- [ ] **Step 4: Use it in `remember`** — in `src/core/tools.ts`, inside the `remember` `execute`, change the node's `source`:

```ts
          source: ctx.ingestSource ?? `${ctx.agentId}:${ctx.runId}`, edges: valid, created: new Date().toISOString(),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/core/tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/run.ts src/core/tools.ts src/core/tools.test.ts
git commit -m "feat(kb): thread ingestSource so remember stamps source-doc provenance during ingestion"
```

---

### Task 7: Librarian tools — `read_source`, `forget`, `reindex_knowledge`

**Files:**
- Modify: `src/core/tools.ts` (three new gated tools)
- Test: `src/core/tools.test.ts` (extend)

**Interfaces:**
- Consumes: `paths.kbSourceFile` (Task 1); `forgetNodes`, `reindexKnowledge`, `reembedAll` (Tasks 3–4); `ctx.ws/db/embed`.
- Produces (tool contracts):
  - `read_source({ path })` → `{ content }` or `{ error }`. `path` is `sources/<name>` or `<name>`; traversal rejected.
  - `forget({ ids?, kind?, sourcePrefix? })` → `{ removedNodes, removedEdges }` or `{ error }` for an empty filter.
  - `reindex_knowledge({})` → `{ reindexed: true, embedded: number }`.

- [ ] **Step 1: Write the failing test** — append to `src/core/tools.test.ts`:

```ts
test("read_source reads kb/sources files and rejects traversal", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-rs-"));
  mkdirSync(paths.kbSourceDir(w), { recursive: true });
  writeFileSync(paths.kbSourceFile(w, "a.md"), "alpha body");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rctx = { ws: w } as any as RunContext;
  const set = toolsForAgent(agent(["read_source"]), rctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((await set.read_source!.execute!({ path: "sources/a.md" }, { toolCallId: "1", messages: [] } as any) as any).content).toBe("alpha body");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((await set.read_source!.execute!({ path: "../secret" }, { toolCallId: "2", messages: [] } as any) as any).error).toBeDefined();
});

test("forget tool cascades and rejects an empty filter", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-fg-"));
  const db = openDb(w);
  writeNode(w, db, KbNode.parse({ id: "kb_d", kind: "decision", title: "t", content: "c", source: "worker-x:r1", created: new Date().toISOString() }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fctx = { ws: w, db } as any as RunContext;
  const set = toolsForAgent(agent(["forget"]), fctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.forget!.execute!({ kind: "decision" }, { toolCallId: "1", messages: [] } as any);
  expect(out).toMatchObject({ removedNodes: 1 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const empty = await set.forget!.execute!({}, { toolCallId: "2", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((empty as any).error).toBeDefined();
});
```

Add to the test file's imports (top): `mkdirSync`, `writeFileSync` from `node:fs`; `paths` from `../store/files`; `writeNode` and `KbNode` (already importable — `../store/knowledge` and `../schemas/knowledge`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/tools.test.ts`
Expected: FAIL — `read_source`/`forget` tools not defined.

- [ ] **Step 3: Implement** — in `src/core/tools.ts`, add imports at the top:

```ts
import { readFile } from "node:fs/promises";
import { paths } from "../store/files";
import { forgetNodes, reindexKnowledge, reembedAll } from "../store/knowledge";
```

(Extend the existing `../store/knowledge` import rather than duplicating it.) Then add the three tools inside `toolsForAgent`, before the MCP merge block (`if (mcp) for …`):

```ts
  if (agent.tools.includes("read_source"))
    set.read_source = tool({
      description: "Read an admin-authored source document from kb/sources/ so you can extract entities from it. `path` is like \"sources/architecture.md\" or \"architecture.md\".",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const name = path.replace(/^sources\//, "");
        if (name.includes("/") || name.includes("..")) return { error: "path must be a file directly under kb/sources/" };
        try { return { content: await readFile(paths.kbSourceFile(ctx.ws, name), "utf8") }; }
        catch { return { error: `no such source: ${name}` }; }
      },
    });

  if (agent.tools.includes("forget"))
    set.forget = tool({
      description: "Prune the knowledgebase: cascade-delete nodes matching a filter, plus their edges and vectors. Filter by `kind` (e.g. decision), `sourcePrefix` (e.g. \"worker-x:\" for one assistant's memory, or \"sources/foo.md@\" for a doc), and/or explicit `ids`. At least one clause is required.",
      inputSchema: z.object({
        ids: z.array(z.string()).optional(),
        kind: z.string().optional(),
        sourcePrefix: z.string().optional(),
      }),
      execute: async ({ ids, kind, sourcePrefix }) => {
        if (!ids?.length && !kind && !sourcePrefix) return { error: "provide at least one of ids, kind, or sourcePrefix" };
        const r = forgetNodes(ctx.ws, ctx.db, { ids, kind, sourcePrefix });
        ctx.notes.push(`forgot ${r.removedNodes} node(s)`);
        return r;
      },
    });

  if (agent.tools.includes("reindex_knowledge"))
    set.reindex_knowledge = tool({
      description: "Rebuild the knowledge graph index from the canonical node files and refresh semantic vectors. Use after bulk hand-edits.",
      inputSchema: z.object({}),
      execute: async () => {
        reindexKnowledge(ctx.ws, ctx.db);
        const embedded = ctx.embed ? await reembedAll(ctx.db, ctx.embed) : 0;
        return { reindexed: true, embedded };
      },
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools.ts src/core/tools.test.ts
git commit -m "feat(kb): librarian tools — read_source, forget(filter), reindex_knowledge"
```

---

### Task 8: Seed the `librarian` agent

**Files:**
- Modify: `src/store/roster.ts` (`LIBRARIAN_ID`, `LIBRARIAN_TOOLS`, `LIBRARIAN_IDENTITY`, `seedLibrarian`)
- Test: `src/store/roster.test.ts` (extend)

**Interfaces:**
- Consumes: `AgentDef`, `serializeAgent`, `paths`, `loadAgent`.
- Produces: `seedLibrarian(ws: string, defaults?: TaichoConfig["defaults"]): Promise<void>`; exported `LIBRARIAN_ID`, `LIBRARIAN_TOOLS`.

- [ ] **Step 1: Write the failing test** — append to `src/store/roster.test.ts` (match the file's existing workspace-temp idiom; if it opens a temp `ws`, reuse it):

```ts
import { seedLibrarian, LIBRARIAN_ID, LIBRARIAN_TOOLS, loadAgent } from "./roster";

test("seedLibrarian creates the librarian with its toolset; reconciles missing tools", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-lib-"));
  await seedLibrarian(w);
  const lib = await loadAgent(w, LIBRARIAN_ID);
  expect(lib.id).toBe("librarian");
  expect(lib.isRoot).toBe(false);
  for (const t of LIBRARIAN_TOOLS) expect(lib.tools).toContain(t);

  // drop a tool on disk, re-seed → reconciled back
  lib.tools = lib.tools.filter((t) => t !== "forget");
  await writeFile(paths.agentFile(w, LIBRARIAN_ID), serializeAgent(lib));
  await seedLibrarian(w);
  expect((await loadAgent(w, LIBRARIAN_ID)).tools).toContain("forget");
});
```

Ensure the test imports `mkdtempSync` (`node:fs`), `tmpdir` (`node:os`), `join` (`node:path`), `writeFile` (`node:fs/promises`), `paths` (`./files`), `serializeAgent` (`./roster`) — add any missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/store/roster.test.ts`
Expected: FAIL — `seedLibrarian` not exported.

- [ ] **Step 3: Implement** — in `src/store/roster.ts`, after `seedRoot` (and after `ROOT_TOOLS`):

```ts
export const LIBRARIAN_ID = "librarian";
export const LIBRARIAN_TOOLS = ["read_source", "remember", "recall", "forget", "reindex_knowledge"];

const LIBRARIAN_IDENTITY = `You are the librarian of a taicho squad — the keeper of the deck's shared knowledge graph.

Your job is to turn source documents into a clean graph, and to prune memory on command:
- To INGEST a source document: read it with read_source, then extract the ENTITIES and RELATIONSHIPS it asserts — not chunks of prose. remember each entity/fact/decision (choose a fitting kind), and link them with typed edges (relates_to, depends_on, part_of, contradicts, derived_from). recall first to reuse existing node ids when linking. Keep each node atomic and self-contained.
- Prefer a few well-connected nodes over many redundant ones.
- To PRUNE on the captain's request, use forget with the NARROWEST filter that satisfies the intent — by kind (e.g. all decisions), by sourcePrefix (e.g. "worker-x:" for one assistant's memory), or by explicit ids. Report exactly what you removed.
- After bulk hand-edits to node files, call reindex_knowledge to rebuild the index and refresh vectors.
- Keep replies short and factual — you curate; you don't do domain work.`;

/** Seed the built-in librarian next to root. Reconciles an existing librarian's toolset like seedRoot. */
export async function seedLibrarian(ws: string, defaults?: TaichoConfig["defaults"]): Promise<void> {
  const file = paths.agentFile(ws, LIBRARIAN_ID);
  if (await Bun.file(file).exists()) {
    const lib = await loadAgent(ws, LIBRARIAN_ID);
    const missing = LIBRARIAN_TOOLS.filter((t) => !lib.tools.includes(t));
    if (missing.length) {
      lib.tools = [...lib.tools, ...missing];
      await writeFile(file, serializeAgent(lib));
    }
    return;
  }
  const lib = AgentDef.parse({
    id: LIBRARIAN_ID,
    role: "Librarian — extracts entities from source documents, curates and prunes the knowledge graph",
    identity: LIBRARIAN_IDENTITY,
    tools: LIBRARIAN_TOOLS,
    canSee: [], canDelegateTo: [], isRoot: false,
    created: new Date().toISOString(),
    budgets: defaults?.budgets,
  });
  await mkdir(paths.agentDir(ws, LIBRARIAN_ID), { recursive: true });
  await writeFile(file, serializeAgent(lib));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/store/roster.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/roster.ts src/store/roster.test.ts
git commit -m "feat(kb): seed the built-in librarian agent (extract + curate)"
```

---

### Task 9: Boot wiring — seed librarian, source dir, drift notice

**Files:**
- Modify: `src/index.tsx` (seed librarian; compute drift; pass `startupNotice`)
- Modify: `src/ui/App.tsx` (accept `startupNotice?`, surface it once on mount)

**Interfaces:**
- Consumes: `seedLibrarian` (Task 8); `diffSources` (Task 2).
- Produces: App prop `startupNotice?: string`.

**Note:** This is integration wiring; verified by `bun run typecheck` + `bun run build` + a manual smoke, not a unit test (booting Ink + a real model is out of scope for `bun:test`).

- [ ] **Step 1: Seed the librarian at boot** — in `src/index.tsx`, add the import to the existing roster import:

```ts
import { seedRoot, seedLibrarian, reindex, loadIndex } from "./store/roster";
```

and call it right after `await seedRoot(ws, config.defaults);`:

```ts
await seedLibrarian(ws, config.defaults);
```

Also add `LIBRARIAN_ID` to that same `./store/roster` import, and update the registry-reindex guard so an EXISTING workspace registers the newly-added librarian (seeding writes the agent file but not the `registry` row; the old `length === 0` guard would skip reindex on a populated registry, leaving the librarian undiscoverable). Replace `if (loadIndex(db).length === 0) await reindex(ws, db);` with:

```ts
const idx = loadIndex(db);
if (idx.length === 0 || !idx.some((r) => r.id === LIBRARIAN_ID)) await reindex(ws, db);
```

Safe because `reindex` rebuilds from the on-disk agent files and `syncRegistry` uses `INSERT OR REPLACE`.

- [ ] **Step 2: Compute the drift notice** — in `src/index.tsx`, after `reindexKnowledge(ws, db);` (line ~28), add:

```ts
import { diffSources } from "./store/sources";
// …after reindexKnowledge(ws, db):
const kbDrift = diffSources(ws, db);
const startupNotice = (kbDrift.changed.length || kbDrift.deleted.length)
  ? `kb: ${kbDrift.changed.length} changed / ${kbDrift.deleted.length} removed source(s) — run /kb sync`
  : undefined;
```

Put the `import` with the other top-of-file imports.

- [ ] **Step 3: Pass the prop** — in `src/index.tsx`, add to the `<App … />` props (near `embed={embedder?.embed}`):

```tsx
        startupNotice={startupNotice}
```

- [ ] **Step 4: Accept + surface the notice** — in `src/ui/App.tsx`, add to the props type (after `embed?: …`):

```ts
  startupNotice?: string;
```

and add a mount effect after `const say = (l: Line) => …` is defined (place it just below the `say` definition):

```ts
  useEffect(() => {
    if (props.startupNotice) say({ kind: "system", text: `  ${props.startupNotice}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 5: Verify typecheck + build**

Run: `bun run typecheck && bun run build`
Expected: both succeed; `dist/taicho` produced with no import errors (confirms the embedder still isn't bundled).

- [ ] **Step 6: Manual smoke**

Run: `mkdir -p /tmp/kbsmoke/kb/sources && printf '# Deploy\nThe deploy pipeline pushes to prod.\n' > /tmp/kbsmoke/kb/sources/deploy.md && (cd /tmp/kbsmoke && bun run --cwd "$OLDPWD" start </dev/null || true)`
Expected (visual): on boot the REPL shows `kb: 1 changed / 0 removed source(s) — run /kb sync`. (Exit with Esc.) If launching this way is awkward, instead just confirm `diffSources` returns one changed entry via a quick REPL/`bun repl` check — the unit tests already cover the logic.

- [ ] **Step 7: Commit**

```bash
git add src/index.tsx src/ui/App.tsx
git commit -m "feat(kb): boot — seed librarian, ensure kb/sources, show source-drift notice"
```

---

### Task 10: `/kb` command surface

**Files:**
- Modify: `src/ui/slash.ts` (`parseKbCommand`, `KbCommand`, `COMMANDS` entry)
- Modify: `src/ui/App.tsx` (`kb` branch in `runSlash`, driving sync/forget/list/reindex)
- Test: `src/ui/slash.test.ts` (extend — parser only; the App branch is integration)

**Interfaces:**
- Consumes: `syncKnowledgeSources` + `IngestFn` (Task 5); `resolveNodeIds`/`forgetNodes`/`reindexKnowledge`/`reembedAll` (Tasks 3–4); `loadAgent`, `executeRun`, `deps` (App); `LIBRARIAN_ID` (Task 8).
- Produces:
  - `type KbCommand = { kind: "sync" } | { kind: "list"; filter: NodeFilter } | { kind: "forget"; filter: NodeFilter } | { kind: "reindex" } | { kind: "error"; message: string }`
  - `parseKbCommand(arg: string): KbCommand`

- [ ] **Step 1: Write the failing test** — append to `src/ui/slash.test.ts`:

```ts
import { parseKbCommand } from "./slash";

test("parseKbCommand parses subcommands and filters", () => {
  expect(parseKbCommand("sync")).toEqual({ kind: "sync" });
  expect(parseKbCommand("reindex")).toEqual({ kind: "reindex" });
  expect(parseKbCommand("forget kind=decision")).toEqual({ kind: "forget", filter: { kind: "decision" } });
  expect(parseKbCommand("forget source=worker-x:")).toEqual({ kind: "forget", filter: { sourcePrefix: "worker-x:" } });
  expect(parseKbCommand("forget id=kb_a id=kb_b")).toEqual({ kind: "forget", filter: { ids: ["kb_a", "kb_b"] } });
  expect(parseKbCommand("list kind=fact")).toEqual({ kind: "list", filter: { kind: "fact" } });
  expect(parseKbCommand("list")).toEqual({ kind: "list", filter: {} });
  expect(parseKbCommand("forget").kind).toBe("error");   // refuse an empty forget filter
  expect(parseKbCommand("wat").kind).toBe("error");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ui/slash.test.ts`
Expected: FAIL — `parseKbCommand` not exported.

- [ ] **Step 3: Implement the parser** — in `src/ui/slash.ts`, add a `kb` entry to `COMMANDS` (after the `mcp` entry):

```ts
  { name: "kb", summary: "manage the knowledgebase", usage: "sync | list [filter] | forget <filter> | reindex" },
```

and add near the `McpCommand` section:

```ts
export interface KbFilter { ids?: string[]; kind?: string; sourcePrefix?: string }
export type KbCommand =
  | { kind: "sync" }
  | { kind: "reindex" }
  | { kind: "list"; filter: KbFilter }
  | { kind: "forget"; filter: KbFilter }
  | { kind: "error"; message: string };

/** Parse `kind=…`, `source=…` (→ sourcePrefix), and repeatable `id=…` tokens into a filter. */
function parseKbFilter(tokens: string[]): KbFilter {
  const filter: KbFilter = {};
  const ids: string[] = [];
  for (const tok of tokens) {
    const [k, ...rest] = tok.split("=");
    const v = rest.join("=");
    if (!v) continue;
    if (k === "kind") filter.kind = v;
    else if (k === "source") filter.sourcePrefix = v;
    else if (k === "id") ids.push(v);
  }
  if (ids.length) filter.ids = ids;
  return filter;
}

export function parseKbCommand(arg: string): KbCommand {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0];
  const rest = parts.slice(1);
  if (sub === "sync") return { kind: "sync" };
  if (sub === "reindex") return { kind: "reindex" };
  if (sub === "list") return { kind: "list", filter: parseKbFilter(rest) };
  if (sub === "forget") {
    const filter = parseKbFilter(rest);
    if (!filter.ids && !filter.kind && !filter.sourcePrefix)
      return { kind: "error", message: "usage: /kb forget kind=… | source=… | id=… (at least one)" };
    return { kind: "forget", filter };
  }
  return { kind: "error", message: `unknown /kb subcommand "${sub ?? ""}" (try sync, list, forget, reindex)` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/ui/slash.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the App branch** — in `src/ui/App.tsx`, add imports:

```ts
import { parseKbCommand } from "./slash";
import { syncKnowledgeSources } from "../knowledge/sync";
import { resolveNodeIds, forgetNodes, reindexKnowledge, reembedAll } from "../store/knowledge";
import { LIBRARIAN_ID } from "../store/roster";
```

(Extend existing imports where a module is already imported — e.g. add `LIBRARIAN_ID` to the `../store/roster` import, `parseKbCommand` to the `./slash` import.)

Then, inside the `runSlash` async handler, add this branch **before** the `runSlashPure(...)` fallback (mirroring the `if (cmd === "mcp")` block):

```ts
    if (cmd === "kb") {
      const parsed = parseKbCommand(arg);
      if (parsed.kind === "error") { say({ kind: "system", text: `  ${parsed.message}` }); return; }
      if (parsed.kind === "list") {
        const ids = resolveNodeIds(props.db, parsed.filter);
        if (!ids.length) { say({ kind: "system", text: "  (no matching nodes)" }); return; }
        const ph = ids.map(() => "?").join(",");
        const rows = props.db.query(`SELECT id, kind, title, source FROM kb_nodes WHERE id IN (${ph})`).all(...ids) as { id: string; kind: string; title: string; source: string | null }[];
        rows.forEach((r) => say({ kind: "system", text: `  [${r.id}] (${r.kind}) ${r.title} · ${r.source ?? "—"}` }));
        return;
      }
      if (parsed.kind === "forget") {
        const r = forgetNodes(props.ws, props.db, parsed.filter);
        say({ kind: "system", text: `  forgot ${r.removedNodes} node(s), ${r.removedEdges} edge(s)` });
        return;
      }
      if (parsed.kind === "reindex") {
        reindexKnowledge(props.ws, props.db);
        const embedded = props.embed ? await reembedAll(props.db, props.embed) : 0;
        say({ kind: "system", text: `  reindexed from files; re-embedded ${embedded} node(s)` });
        return;
      }
      // sync — drives the librarian per changed doc through the run pipeline
      if (!model) { say({ kind: "system", text: "  /kb sync needs a model — set a key or /login openai." }); return; }
      const activeModel = model;
      setBusy(true);
      setActivity("librarian · syncing…");
      try {
        const ingest = async (path: string, hash: string) => {
          const librarian = await loadAgent(props.ws, LIBRARIAN_ID);
          await executeRun(deps(activeModel), {
            agent: librarian,
            messages: [{ role: "user", content: `Ingest the source document "${path}". Read it with read_source, extract the entities and relationships it asserts, and remember each with typed edges.` }],
            triggeredBy: "user",
            ingestSource: `${path}@${hash}`,
          });
        };
        const s = await syncKnowledgeSources({ ws: props.ws, db: props.db, ingest });
        say({ kind: "system", text: `  sync: ${s.changedDocs} doc(s) ingested, ${s.deletedDocs} removed, ${s.removedNodes} old node(s) cleared` });
      } catch (e) {
        say({ kind: "system", text: `  sync failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally { setBusy(false); }
      return;
    }
```

- [ ] **Step 6: Verify typecheck + full suite + build**

Run: `bun run typecheck && bun test && bun run build`
Expected: typecheck clean; all tests pass; `dist/taicho` builds.

- [ ] **Step 7: Commit**

```bash
git add src/ui/slash.ts src/ui/slash.test.ts src/ui/App.tsx
git commit -m "feat(kb): /kb command surface — sync, list, forget, reindex"
```

---

### Task 11: Documentation — README Knowledge section

**Files:**
- Modify: `README.md` (extend the existing "Knowledge (shared deck memory)" section)

- [ ] **Step 1: Update the README** — under the existing `## Knowledge (shared deck memory)` section (around `README.md:79`), add:

```markdown
### Authoring source documents

Write markdown/text into `kb/sources/`. Run `/kb sync` and the **librarian** agent reads each
changed doc, extracts entities + typed relationships, and files them into the graph (stamped
`sources/<file>@<hash>`). Editing a doc and re-syncing replaces exactly that doc's subgraph — the
content hash drives it. On boot, taicho notes how many sources changed since the last sync.

### Curating

- `/kb list [kind=… | source=…]` — inspect nodes.
- `/kb forget kind=decision` — prune all decisions (cascade: nodes + edges + vectors).
- `/kb forget source=worker-x:` — wipe everything a given assistant remembered.
- `/kb reindex` — rebuild the graph from files and refresh semantic vectors after hand-edits.

You can also just ask root to "clear all X" — it delegates to the librarian, which runs the same
`forget` under the hood. Agent-written memory (`remember`) stays write-through and immediately
recallable; only pruning is admin-driven.
```

- [ ] **Step 2: Verify no broken build**

Run: `bun run typecheck && bun test`
Expected: PASS (docs-only change; sanity re-run).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(kb): document kb/sources authoring, /kb sync, and curation commands"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- §4 data model / `kb_sources` / source dir → **Task 1**.
- §5 hash-sync (detection + forget-old + ingest + hash upsert, idempotent) → **Tasks 2 (diff) + 5 (orchestration)**; driven in **Task 10** (`/kb sync`).
- §6 librarian (seed, identity, tools `read_source`/`forget`/`reindex_knowledge`/`remember`/`recall`) → **Tasks 8 (seed) + 7 (tools)**; reachable via root's `canDelegateTo:["*"]` (no ACL change needed).
- §7 cascade `forgetNodes` + re-embed → **Tasks 3 + 4**; re-embed delivered via `reembedAll` + `/kb reindex` (documented deviation: not at boot, for boot-perf).
- §3 two provenance classes + ingestion stamping → **Task 6** (`ingestSource` thread).
- §8 `/kb` surface (sync/forget/list/reindex) → **Task 10**.
- Boot drift notice (§5) → **Task 9**.
- §9 visualizer → intentionally **out of scope** (deferred).
- §10 testing invariants (forget leaves no orphans; sync idempotent; re-embed; librarian wiring; parseKb) → covered in Tasks 3, 5, 4, 8, 10 respectively.
- Docs → **Task 11**.

**Placeholder scan:** none — every code step has full code; every run step has an exact command + expected result.

**Type consistency:** `NodeFilter`/`KbFilter` share the shape `{ ids?, kind?, sourcePrefix? }` (store uses `NodeFilter`, the parser emits the structurally-identical `KbFilter`; App passes it straight into `forgetNodes`/`resolveNodeIds`). `forgetNodes` returns `{ removedNodes, removedEdges }` used identically in Tasks 3, 7, 10. `reembedAll(db, embed) → Promise<number>` used in Tasks 4, 7, 10. `syncKnowledgeSources({ws,db,ingest}) → Promise<SyncSummary>` with `IngestFn = (path, hash) => Promise<void>` matches the App `ingest` closure and the Task 5 fake. `ingestSource` string is set in `run.ts` (Task 6) and passed by App (Task 10). `LIBRARIAN_ID = "librarian"` and `LIBRARIAN_TOOLS` gate the exact tool names added in Task 7.

**Known accepted limitation** (spec §12): re-extraction assigns fresh random node ids, so cross-document edges *into* a re-synced doc break on sync. v1 accepts this; stable-id keying is a future refinement.
