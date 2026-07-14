/** Minimal versioned schema migrator for the derived SQLite cache. The DB holds derived state only
 *  (files are canon — deleting the DB and re-indexing must always work), so migrations just create
 *  tables/indexes; a `meta` row tracks the applied version. Run once in openDb after the baseline. */
import type { Database } from "bun:sqlite";

export function getMeta(db: Database, key: string): string | null {
  const r = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return r?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

interface Migration { version: number; up: (db: Database) => void; }

const MIGRATIONS: Migration[] = [
  // v1: baseline — registry/embeddings/task_ledger already created by openDb's `CREATE TABLE IF NOT EXISTS`.
  { version: 1, up: () => {} },
  // v2: knowledgebase graph — typed nodes + typed edges. Embeddings reuse the existing table (kind='kb').
  {
    version: 2,
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS kb_nodes (
          id       TEXT PRIMARY KEY,
          kind     TEXT NOT NULL,
          title    TEXT NOT NULL,
          summary  TEXT,
          content  TEXT NOT NULL,
          source   TEXT,
          scope    TEXT NOT NULL DEFAULT 'deck',
          metadata TEXT,
          created  INTEGER DEFAULT (unixepoch()),
          updated  INTEGER DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS kb_edges (
          from_id  TEXT NOT NULL,
          to_id    TEXT NOT NULL,
          rel      TEXT NOT NULL,
          weight   REAL DEFAULT 1.0,
          metadata TEXT,
          created  INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (from_id, to_id, rel)
        );
        CREATE INDEX IF NOT EXISTS kb_edges_from ON kb_edges(from_id);
        CREATE INDEX IF NOT EXISTS kb_edges_to   ON kb_edges(to_id);
        CREATE INDEX IF NOT EXISTS kb_nodes_kind ON kb_nodes(kind);
      `),
  },
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
          updated     INTEGER DEFAULT (unixepoch())
        );
        CREATE INDEX IF NOT EXISTS skills_status ON skills(status);
      `),
  },
  // v5: task queue index (Plan 04). Files (tasks/*.json) are canon; this is a rebuildable index so
  // `/tasks` can list/query fast and background tasks survive restarts. reindexTasks() rebuilds it.
  {
    version: 5,
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id          TEXT PRIMARY KEY,
          agent       TEXT,
          goal        TEXT,
          status      TEXT NOT NULL,
          kind        TEXT NOT NULL DEFAULT 'chat',   -- 'chat' (a watched turn) | 'background' (dispatched)
          root_run_id TEXT,
          result_ref  TEXT,
          summary     TEXT,
          created     TEXT,
          updated     TEXT
        );
        CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS tasks_kind   ON tasks(kind);
      `),
  },
  // v6: deck spend counters (Plan 09). Rolling per-period totals keyed by UTC day / ISO week so
  // deck-wide budget ceilings span sessions. An enforcement counter, not a ledger of record — traces
  // stay canon for /costs reporting; this just answers "how much has the deck spent this day/week".
  // (v7 renames this table to squad_spend. Migrations are history — this DDL stays as it shipped.)
  {
    version: 6,
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS deck_spend (
          period_kind TEXT NOT NULL,           -- 'day' | 'week'
          period_key  TEXT NOT NULL,           -- 'YYYY-MM-DD' | 'YYYY-Www'
          tokens      INTEGER NOT NULL DEFAULT 0,
          cost_usd    REAL NOT NULL DEFAULT 0, -- priced runs only; subscription/unpriced commit 0
          updated     INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (period_kind, period_key)
        );
      `),
  },
  // v7: Plan 19 — "deck" retires in favour of "squad" (every agent in the workspace; taicho is 隊長,
  // squad leader). Unlike the DeckLedger→SpendLedger rename this touches PERSISTED values, so it is a
  // real migration, not a find-and-replace:
  //   · kb_nodes.scope rows 'deck' → 'squad'. The column DEFAULT stays 'deck' because SQLite cannot
  //     alter a default without rebuilding the table — and it is inert, since store/knowledge.ts always
  //     supplies scope explicitly. Node FILES are canon; reconcileKbScope() rewrites their frontmatter
  //     at boot and reindexKnowledge() then refreshes these rows anyway. This UPDATE covers the window
  //     before that runs, and any DB whose canonical files were removed.
  //   · deck_spend → squad_spend. Rows carry forward: silently resetting a user's running weekly total
  //     would be rude, and the counter is cheap to move.
  {
    version: 7,
    up: (db) => {
      db.exec("UPDATE kb_nodes SET scope = 'squad' WHERE scope = 'deck'");
      const legacy = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deck_spend'").get();
      if (legacy) db.exec("ALTER TABLE deck_spend RENAME TO squad_spend");
      else
        db.exec(`
          CREATE TABLE IF NOT EXISTS squad_spend (
            period_kind TEXT NOT NULL,
            period_key  TEXT NOT NULL,
            tokens      INTEGER NOT NULL DEFAULT 0,
            cost_usd    REAL NOT NULL DEFAULT 0,
            updated     INTEGER DEFAULT (unixepoch()),
            PRIMARY KEY (period_kind, period_key)
          );
        `);
    },
  },
  // v8: Plan 19 — team membership on the registry index. `registry` is created by openDb's BASELINE
  // `CREATE TABLE IF NOT EXISTS` (db.ts), not by a migration, and IF NOT EXISTS cannot add a column to a
  // table that already exists. So the column is declared in BOTH places and both are idempotent:
  //   · baseline db.ts  — gives a FRESH workspace the column at creation
  //   · this ALTER      — gives every EXISTING workspace the column on upgrade
  // Either one alone is a bug (baseline alone silently skips existing DBs; ALTER alone throws
  // "duplicate column" on fresh ones), which is why the guard below is a check and not a try/catch.
  // Membership is canon in agents/<id>/agent.md (`team:`); this column is the derived index that makes
  // "who is on team news" one query instead of a full roster scan.
  {
    version: 8,
    up: (db) => {
      // migrate() also runs standalone over a bare Database in unit tests, where the baseline never ran.
      if (!tableExists(db, "registry")) return;
      if (!columnExists(db, "registry", "team")) db.exec("ALTER TABLE registry ADD COLUMN team TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS registry_team ON registry(team)");
    },
  },
  // v9: Plan 19 — per-team spend ceilings. The counter gains a `scope` dimension ('squad' | 'team:<id>')
  // and it belongs in the primary key: a team's daily total and the squad's must accumulate separately.
  // SQLite cannot alter a primary key, so the table is recreated and its rows copied forward as 'squad'
  // spend. It is only a counter, not a ledger of record (traces stay canon for /costs) — but silently
  // resetting someone's running weekly total would be rude, so we carry it.
  {
    version: 9,
    up: (db) => {
      if (!tableExists(db, "squad_spend")) return; // bare migrate() over a Database with no baseline
      if (columnExists(db, "squad_spend", "scope")) return; // already reshaped
      db.exec(`
        CREATE TABLE squad_spend_v9 (
          scope       TEXT NOT NULL,           -- 'squad' | 'team:<id>'
          period_kind TEXT NOT NULL,           -- 'day' | 'week'
          period_key  TEXT NOT NULL,           -- 'YYYY-MM-DD' | 'YYYY-Www'
          tokens      INTEGER NOT NULL DEFAULT 0,
          cost_usd    REAL NOT NULL DEFAULT 0, -- priced runs only; subscription/unpriced commit 0
          updated     INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (scope, period_kind, period_key)
        );
        INSERT INTO squad_spend_v9 (scope, period_kind, period_key, tokens, cost_usd, updated)
          SELECT 'squad', period_kind, period_key, tokens, cost_usd, updated FROM squad_spend;
        DROP TABLE squad_spend;
        ALTER TABLE squad_spend_v9 RENAME TO squad_spend;
      `);
    },
  },
  // v10: Plan 18 — the plan index. Files are canon (plans/<id>/v<N>.json + events.jsonl); this table
  // stores only the FOLDED counters, so the panel and /plan never walk the event log to answer "how many
  // are open". reindexPlans() rebuilds it from the files, which is what makes the DB throwaway.
  {
    version: 10,
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS plans (
          id          TEXT PRIMARY KEY,
          version     INTEGER NOT NULL,
          owner       TEXT NOT NULL,
          goal        TEXT,
          total       INTEGER NOT NULL DEFAULT 0,
          done        INTEGER NOT NULL DEFAULT 0,
          open        INTEGER NOT NULL DEFAULT 0,
          failed      INTEGER NOT NULL DEFAULT 0,
          root_run_id TEXT,
          created     TEXT,
          updated     TEXT
        );
        CREATE INDEX IF NOT EXISTS plans_owner ON plans(owner);
        CREATE INDEX IF NOT EXISTS plans_open  ON plans(open);
      `),
  },
  // v11: Plan 22 — many-to-many team membership. An agent may sit on several teams, so the single
  // `registry.team` column can no longer hold membership. `agent_teams` is the join (agent × team), and
  // — unlike v8's `team` COLUMN, which needed a baseline + a guarded ALTER because IF NOT EXISTS can't
  // add a column — a NEW TABLE is created idempotently by the migration alone, for fresh and existing
  // DBs both. Membership is canon in agents/<id>/agent.md (`teams:`); this is the derived index, and
  // reindex() rebuilds it every boot (adding the implicit `default` membership). The one-time carry
  // below only bridges the window before that first reindex (and unit tests that migrate but never
  // reindex): it lifts any pre-Plan-22 single-team rows into the join so nothing is lost.
  {
    version: 11,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_teams (
          agent_id TEXT NOT NULL,
          team_id  TEXT NOT NULL,
          ord      INTEGER NOT NULL DEFAULT 0,   -- declaration order, for deterministic model resolution
          PRIMARY KEY (agent_id, team_id)
        );
        CREATE INDEX IF NOT EXISTS agent_teams_team ON agent_teams(team_id);
      `);
      if (!tableExists(db, "registry") || !columnExists(db, "registry", "team")) return;
      const rows = db.query("SELECT id, team FROM registry WHERE team IS NOT NULL AND team <> ''").all() as { id: string; team: string }[];
      const ins = db.query("INSERT OR IGNORE INTO agent_teams (agent_id, team_id, ord) VALUES (?, ?, 0)");
      for (const r of rows) ins.run(r.id, r.team);
    },
  },
];

function tableExists(db: Database, table: string): boolean {
  return !!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnExists(db: Database, table: string, column: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const cur = Number(getMeta(db, "schema_version") ?? "0");
  for (const m of MIGRATIONS) {
    if (m.version > cur) {
      db.transaction(() => m.up(db))();
      setMeta(db, "schema_version", String(m.version));
    }
  }
}

/** Guard against mixing embedding models/dimensions: if the active embedder changed, wipe stale kb
 *  vectors so cosine never compares incompatible spaces. Safe — embeddings are a derived cache that
 *  re-fills lazily on the next remember/recall. */
export function ensureEmbedSpace(db: Database, model: string, dim: number): void {
  const pm = getMeta(db, "embed_model");
  const pd = Number(getMeta(db, "embed_dim") ?? "0");
  if (pm !== model || pd !== dim) {
    db.query("DELETE FROM embeddings WHERE kind = 'kb'").run();
    setMeta(db, "embed_model", model);
    setMeta(db, "embed_dim", String(dim));
  }
}
