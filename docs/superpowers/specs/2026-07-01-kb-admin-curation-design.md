# Admin-curated knowledge graph — sources, hash-sync, and the `librarian` agent

**Date:** 2026-07-01
**Status:** approved (design) — visualizer phase deferred
**Topic:** Put the system admin in the driver's seat of the deck knowledgebase: author source
documents, have the graph re-derive on change, and prune agent-written memory on command.

## 1. Background & problem

taicho already has a deck-wide knowledge graph (`feat(kb)`): typed `KbNode`s
(`kind: fact|entity|decision|doc`) linked by typed `KbEdge`s, with hybrid retrieval — a semantic
(or keyword) seed then a recursive-CTE walk over edges (`src/knowledge/retrieval.ts`). Nodes are
files at `kb/nodes/<id>.md` (canon); `kb_nodes`/`kb_edges` + the `embeddings` table are a derived
index. Agents populate it by calling `remember` (`src/core/tools.ts:148`) and search with `recall`;
relevant knowledge auto-injects into an agent's prompt (`src/core/run.ts:196`).

**What already works (verified in code):**
- Boot rebuilds the graph index from the canonical files: `index.tsx:28` calls
  `reindexKnowledge(ws, db)` → `DELETE`s `kb_nodes`/`kb_edges` and re-derives them from
  `kb/nodes/*.md` (`src/store/knowledge.ts:106`). Files-as-canon is genuinely plumbed **for graph
  structure**.
- Provenance already exists: `remember` stamps `source: "<agentId>:<runId>"` (`tools.ts:163`).

**The gaps this design closes:**
1. **No source-document layer.** There is no way for the admin to author knowledge as documents and
   have entities extracted from them. Today every node is hand-written by an agent via `remember`.
2. **Embeddings are never re-derived.** `reindexKnowledge` rebuilds nodes/edges but never re-embeds
   (`indexNode` does not touch `embeddings`; vectors are only written at `remember`-time via
   `putVector`, `tools.ts:167`). So an edited or hand-created node is structurally correct after a
   reboot but its vector is stale or missing → semantic recall silently degrades to keyword+graph
   for that node.
3. **No cascade curation.** There is no way to delete a node (let alone a set of nodes by
   kind/source) and have its edges (both directions) and vector removed consistently. `/forget`
   (`slash.ts:79`) removes *coaching notes*, not KB nodes.
4. **Boot-only, no runtime path.** Reindex runs once at boot; mid-session edits/prunes require a
   reboot.

## 2. Goals & non-goals

**Goals**
- Admin authors knowledge as documents in `kb/sources/`; editing a doc and running `/kb sync`
  re-derives exactly that document's subgraph (nodes + edges + vectors), deterministically keyed by
  content hash.
- Extraction (document → entities + typed relations) is performed by a dedicated built-in squad
  agent, **`librarian`**, not a hardcoded pipeline — reusing taicho's model/delegation/tooling.
- Admin can prune agent-written memory on command ("clear all decisions", "wipe what worker-x
  remembered") with a correct cascade (nodes + edges + vectors), driven either conversationally
  (root → librarian) or via deterministic `/kb` commands.
- Fix the embedding re-derivation gap so hand-edited files and re-synced sources are semantically
  correct, not just structurally.

**Non-goals (this spec)**
- **Browser visualizer** (`/kb view`) — explicitly deferred to a follow-on phase (§9). Design noted
  so the data model doesn't preclude it.
- **External source adapters** (Notion/API). v1 is local files under `kb/sources/`. The sync layer
  is shaped so an adapter can later present as "virtual source files", but no adapter is built now.
- **Changing how agents write.** Agent `remember` stays write-through and immediately recallable. No
  staging, no approval gate on ingestion.
- **Click-to-curate / entity-resolution UI.**

## 3. Provenance model (the spine)

Two provenance forms on the existing `KbNode.source` field distinguish the two classes of knowledge
and make every filter/sync operation a clean predicate:

| Class            | `source` format                | Lifecycle                                   |
|------------------|--------------------------------|---------------------------------------------|
| Source-derived   | `sources/<file>.md@<hash>`     | admin-owned; re-derived on hash change      |
| Agent-derived    | `<agentId>:<runId>`            | write-through; pruned only by admin command |

- `<hash>` is a short content hash (e.g. first 12 hex of SHA-256) of the source file at extraction
  time. Replacing a document's subgraph = "delete nodes whose source starts with `sources/X@`, then
  re-extract".
- "Clear what worker-x remembered" = delete nodes whose source starts with `worker-x:`.
- "Clear all decisions" = delete nodes where `kind = 'decision'`.

## 4. Data model & storage

- **No change to `KbNode`/`KbEdge` schemas** (`src/schemas/knowledge.ts`). `source` already carries
  provenance; `kind` already open-vocab.
- **New directory:** `kb/sources/` — admin-authored markdown/text. `ensureWorkspace`
  (`src/store/files.ts:16`) creates it; add `paths.kbSourceDir` / `paths.kbSourceFile`.
- **New table (v3 migration)** in `src/store/migrate.ts`, mirroring the existing versioned migrator:
  ```sql
  CREATE TABLE IF NOT EXISTS kb_sources (
    path     TEXT PRIMARY KEY,   -- relative, e.g. "sources/architecture.md"
    hash     TEXT NOT NULL,      -- content hash last synced
    updated  INTEGER DEFAULT (unixepoch())
  );
  ```
  This is the *only* new persistent state; it holds each source's last-synced hash for diffing.
  `kb_sources` is derivable (re-hash the files), consistent with "DB is a rebuildable index".

## 5. Hash-sync algorithm

Entry points: `/kb sync` (explicit) and a **boot drift-check** (non-blocking — see below).

```
sync():
  disk    = { relPath -> contentHash for each file in kb/sources/ }
  tracked = rows of kb_sources
  changed = paths where disk.hash != tracked.hash  (incl. new: not in tracked)
  deleted = tracked paths not on disk

  for path in deleted:
    forget({ sourcePrefix: "<path>@" })         # cascade delete that doc's subgraph
    kb_sources.delete(path)

  for path in changed:
    forget({ sourcePrefix: "<path>@" })         # drop the old subgraph (idempotent re-derive)
    run librarian with goal: "ingest <path>"    # via the standard run pipeline (executeRun)
    kb_sources.upsert(path, disk.hash[path])

  return summary { changedDocs, addedNodes, removedNodes, deletedDocs }
```

- **Detection is deterministic** (pure hash diff); **extraction is the librarian's judgment**. This
  is the key separation that makes "boom, graph reacts" reliable while keeping extraction smart.
- **Idempotent:** re-syncing an unchanged file is a no-op; re-syncing a changed file clears-then-
  re-extracts by provenance, so nodes never duplicate across syncs.
- **Boot behavior:** boot must not block on model calls, so boot only *detects* drift and prints a
  one-line notice (`kb: 3 source(s) changed — run /kb sync`). Actual extraction happens on `/kb
  sync`. (An opt-in `kb.autoSync` config can run it automatically later; not v1.)
- **Driving the librarian:** `/kb sync` runs one librarian ingestion run per changed doc through the
  existing `executeRun` pipeline (`src/core/run.ts`), exactly like a delegation. It reuses budgets,
  tracing, and the ledger. The trace records the ingestion (which source, nodes written).

## 6. The `librarian` agent

A second built-in agent, seeded next to `root`.

- **Seeding:** add `seedLibrarian(ws, defaults)` mirroring `seedRoot` (`src/store/roster.ts:41`) and
  call it in `index.tsx` right after `seedRoot` (`index.tsx:25`). Reconcile-on-exists like
  `seedRoot` does (ensure it carries the current built-in toolset if the file predates a tool
  addition).
- **AgentDef** (`src/schemas/agent.ts`): `id: "librarian"`, `role: "Keeper of the deck knowledge
  graph — extracts entities from source documents, curates and prunes memory"`, `isRoot: false`,
  `canSee: []`, `canDelegateTo: []` (it operates on the store, not on other agents),
  `tools: LIBRARIAN_TOOLS`.
- **Reachability:** `root` already has `canDelegateTo: ["*"]` and `canSee: ["*"]`, so root can
  delegate to `librarian` with no ACL change. The admin can also address it directly via `@librarian`.
- **Identity (soul):** frames it as the archivist — read a source, extract the *entities and
  relationships* it asserts (not chunks of prose), `remember` each with typed edges, prefer linking
  to existing nodes (recall first), and stamp provenance. On a prune request, use `forget` with the
  narrowest filter that satisfies the intent and report exactly what was removed.
- **Toolset `LIBRARIAN_TOOLS`:**
  - `remember`, `recall` — existing.
  - `read_source(path)` — read a file under `kb/sources/` (path-confined; rejects traversal).
  - `forget(filter)` — cascade delete (see §7). Filter: `{ ids?, kind?, sourcePrefix? }`.
  - `reindex_knowledge()` — rebuild graph **and re-embed** from files (see §7).

## 7. Cascade-correct curation & re-embed (the correctness core)

New store functions in `src/store/knowledge.ts`, each maintaining the invariant *no orphaned edges
or vectors ever remain*:

- **`resolveNodeIds(db, filter)`** — returns node ids matching `{ ids?, kind?, sourcePrefix? }`
  (`sourcePrefix` via `source LIKE '<prefix>%'`).
- **`forgetNodes(ws, db, filter)`** — for the resolved ids, in one transaction:
  1. `DELETE FROM kb_edges WHERE from_id IN (…) OR to_id IN (…)` (both directions),
  2. `DELETE FROM embeddings WHERE ref IN (…)` (`kind='kb'`),
  3. `DELETE FROM kb_nodes WHERE id IN (…)`,
  4. delete the `kb/nodes/<id>.md` files.
  Returns `{ removedNodes, removedEdges }`. This is the single cascade path the librarian tool and
  `/kb forget` both call.
- **Re-embed on reindex** — extend `reindexKnowledge(ws, db, embedder?)` so that after `indexNode`,
  when an embedder is passed, it (re)computes each node's vector via `putVector` over
  `title\nsummary\ncontent`. Guarded by `ensureEmbedSpace`
  (`migrate.ts:69`) so a model/dim change wipes stale vectors first. This closes gap #2: hand-edited
  files and re-synced sources become semantically correct, not just structurally.
  - Boot wiring: `index.tsx` already calls `reindexKnowledge`; it will pass the built `embedder` so
    boot re-derivation includes vectors. (Re-embedding every node on every boot is acceptable at
    hundreds-of-nodes scale — same reasoning as the brute-force cosine in `vectors.ts`. If it later
    matters, embed only nodes whose content hash changed; out of scope now.)
- **Runtime, no reboot** — `/kb sync` and `forget` mutate the live open DB; the boot reindex remains
  the safety net that proves files are canon.

## 8. `/kb` command surface

Deterministic backstop so destructive actions never depend on the LLM parsing intent. Mirrors the
`/mcp` pattern: a `parseKbCommand(arg): KbCommand` union in `slash.ts`, interpreted in `App.tsx`
(some subcommands are side-effecting/async, like `/mcp add`).

- `/kb sync` — run the hash-sync (§5); print the summary.
- `/kb forget <filter>` — cascade delete via `forgetNodes`; e.g. `/kb forget kind=decision`,
  `/kb forget source=worker-x`, `/kb forget id=kb_abc123`. Print counts removed.
- `/kb list [kind=… | source=…]` — list nodes (id, kind, title, source) for CLI inspection.
- `/kb reindex` — force `reindexKnowledge(ws, db, embedder)`.
- `/kb view` — **deferred** (§9); registered as "coming soon" or omitted until the visualizer phase.

Add `kb` to `COMMANDS` (`slash.ts:13`) so `/help` and the Tab-suggester surface it.

## 9. Deferred: browser visualizer (`/kb view`)

Out of scope for this spec; recorded so the data model doesn't preclude it. Sketch for the follow-on:
`Bun.serve` on a localhost port serves a self-contained page that fetches `/api/graph`
(nodes+edges+provenance serialized from SQLite) and renders a force-directed graph; opens the
browser via `open`. Read-only v1 with change-awareness (color by `kind`, group/badge by `source`,
highlight recently-`updated` nodes and orphans). The `updated` timestamps and `source` provenance
this spec already persists are exactly what that view consumes — no data-model change needed later.

## 10. Testing (bun:test, no network)

- **Hash-diff** produces correct `{changed, new, deleted}` sets vs `kb_sources`.
- **`forgetNodes` invariant:** after any filter delete, zero `kb_edges` reference a removed id (from
  or to) and zero `embeddings` rows reference a removed ref; node files gone. Parametrize over
  `ids` / `kind` / `sourcePrefix`.
- **Sync idempotency:** syncing the same file twice → no duplicate nodes; editing then syncing →
  old subgraph replaced, not appended (assert by `sourcePrefix` count).
- **Re-embed on reindex:** with a stub embedder, every node has a vector after reindex; changing a
  node's content changes its stored vector.
- **Librarian wiring:** `seedLibrarian` creates the agent with `LIBRARIAN_TOOLS`; reconcile adds
  missing tools to a pre-existing file; root can delegate to it (ACL).
- **`parseKbCommand`** parses `sync` / `forget <filter>` / `list` / `reindex`, rejects bad filters.
- **Extraction** is exercised with a `MockLanguageModelV3` (`ai/test`) librarian that emits
  `remember` tool calls over a fixture source doc; assert the resulting subgraph + provenance.

## 11. Build order (for the plan)

1. Store correctness core: `kb_sources` (v3 migration), `resolveNodeIds`, `forgetNodes`,
   `reindexKnowledge(ws, db, embedder?)` re-embed. (Pure, unit-testable; no agent needed.)
2. Sync engine: hash-diff + `sync()` orchestration (detection deterministic; extraction stubbed via
   a passed run-fn so it's testable without a model).
3. `librarian` agent: schema/seed/identity/tools (`read_source`, `forget`, `reindex_knowledge`) +
   `index.tsx` seeding + boot embedder passed to reindex + boot drift-notice.
4. `/kb` command surface: `parseKbCommand`, `App.tsx` wiring (sync drives librarian via
   `executeRun`), `COMMANDS` entry.
5. Docs: README "Knowledge" section — `kb/sources/`, `/kb sync`, `/kb forget`, the librarian.

## 12. Risks & open questions

- **Extraction non-determinism / entity resolution.** Re-extracting a doc yields fresh node ids each
  time (`mkKbId` is random). Because sync clears the doc's whole subgraph before re-extracting,
  correctness holds, but cross-document edges *into* a re-extracted doc's nodes break on every sync
  (the target ids change). v1 accepts this (source→source edges are re-derived each sync; agent
  nodes rarely edge *into* source nodes). A future refinement: stable ids keyed by
  `hash(sourcePath + normalized entity title)` so identity survives re-extraction. Flagged, not
  built.
- **Cost of extraction.** Each changed doc is a model call. Bounded by hash-gating (only changed
  docs) and admin-paced (`/kb sync` is explicit). Acceptable.
- **`forget` blast radius.** A too-broad filter could wipe a lot. Mitigation: `/kb forget` prints a
  count and the resolved filter; consider a confirmation or dry-run (`/kb forget --dry-run`) — decide in
  the plan.
- **Boot re-embed cost** at large node counts — mitigation noted in §7 (embed only changed nodes),
  deferred.
