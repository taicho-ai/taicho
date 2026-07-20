import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { serializeAgent, parseAgent, seedRoot, seedLibrarian, LIBRARIAN_ID, LIBRARIAN_TOOLS, reindex, loadIndex, loadAgent, createAgent, updateAgent, setAgentTeams, deleteAgent, reconcileWorkerTools, workerTools, DEFAULT_WORKER_TOOLS, type RegistryRow } from "./roster";
import { createTeam, membersOf } from "./teams";
import { AgentDef } from "@taicho-ai/contracts/agent";
import { openDb } from "./db";
import { ensureWorkspace, paths } from "./files";

const sample = AgentDef.parse({
  id: "researcher", role: "Covers geopolitics with web search",
  identity: "You are a careful researcher.\nCite sources.",
  tools: ["write_artifact"], canSee: ["*"], canDelegateTo: [], isRoot: false,
  created: "2026-06-11T00:00:00.000Z",
});

test("serialize -> parse round-trips an AgentDef", () => {
  const round = parseAgent(serializeAgent(sample));
  expect(round).toEqual(sample);
});

test("parse rejects a file with no frontmatter", () => {
  expect(() => parseAgent("just text")).toThrow();
});

test("seedRoot writes an isRoot agent.md once and is idempotent", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-"));
  await seedRoot(ws);
  const first = await Bun.file(join(ws, "agents", "root", "agent.md")).text();
  const root = parseAgent(first);
  expect(root.isRoot).toBe(true);
  expect(root.id).toBe("root");
  expect(root.tools).toContain("create_agent");
  await seedRoot(ws); // must not throw or change the file
  expect(await Bun.file(join(ws, "agents", "root", "agent.md")).text()).toBe(first);
});

async function freshWs() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  return { ws, db };
}

test("reindex scans agent.md files into the registry", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  const rows = loadIndex(db);
  expect(rows.find((r) => r.id === "root")?.is_root).toBe(1);
});

test("createAgent writes a file, a registry row, and is discoverable immediately", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  const a = await createAgent(ws, db, { id: "writer", role: "Drafts prose", identity: "You write." }, "root");
  expect(a.id).toBe("writer");
  expect(loadIndex(db).some((r) => r.id === "writer")).toBe(true);
  const loaded = await loadAgent(ws, "writer");
  expect(loaded.identity).toBe("You write.");
  expect(loaded.tools).toEqual(["write_artifact", "save_artifact", "read_artifact", "list_artifacts", "annotate_artifact", "list_annotations"]); // default worker grant (Plan 01: produce + hand off + consume + annotate/revise)
});

// ── Plan 14: workers must never be born toolless ──

test("workerTools: baseline is the artifact grant; extras ADD on top; deduped, baseline-first", () => {
  expect(workerTools()).toEqual(DEFAULT_WORKER_TOOLS);            // no request → the baseline
  expect(workerTools([])).toEqual(DEFAULT_WORKER_TOOLS);         // explicit [] → still the baseline (the bug fix)
  expect(workerTools(["delegate_task", "run_command"])).toEqual([...DEFAULT_WORKER_TOOLS, "delegate_task", "run_command"]);
  // a request that re-lists a baseline tool doesn't duplicate it
  expect(workerTools(["save_artifact", "mcp:web"])).toEqual([...DEFAULT_WORKER_TOOLS, "mcp:web"]);
});

test("createAgent with NO tools field binds the artifact baseline", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  const a = await createAgent(ws, db, { id: "no-tools", role: "x", identity: "y" }, "root");
  for (const t of ["save_artifact", "read_artifact", "list_artifacts", "annotate_artifact", "list_annotations"])
    expect(a.tools).toContain(t);
  expect((await loadAgent(ws, "no-tools")).tools).toEqual(DEFAULT_WORKER_TOOLS); // persisted, not empty
});

test("createAgent with explicit tools:[] STILL binds the artifact baseline (the root/2026-07-04-run6 bug)", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  const a = await createAgent(ws, db, { id: "empty-tools", role: "x", identity: "y", tools: [] }, "root");
  // Before Plan 14, `draft.tools ?? [defaults]` let `[]` sail through → a toolless worker. Now baseline-merged.
  expect(a.tools).toEqual(DEFAULT_WORKER_TOOLS);
  for (const t of DEFAULT_WORKER_TOOLS) expect((await loadAgent(ws, "empty-tools")).tools).toContain(t);
});

test("createAgent merges the baseline UNDER model-requested extras (delegate_task + mcp)", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  const a = await createAgent(ws, db, { id: "wired", role: "x", identity: "y", tools: ["delegate_task", "mcp:web"] }, "root");
  for (const t of DEFAULT_WORKER_TOOLS) expect(a.tools).toContain(t); // baseline preserved
  expect(a.tools).toContain("delegate_task");                        // extras added
  expect(a.tools).toContain("mcp:web");
});

test("reconcileWorkerTools backfills a worker born toolless; leaves explicit grants + built-ins alone", async () => {
  const { ws, db } = await freshWs();
  await seedLibrarian(ws);
  // A synthetic worker persisted with tools:[] — exactly the 9 broken squad agents in the live squad.
  const toolless = AgentDef.parse({ id: "content-strategist", role: "x", identity: "y", tools: [], canSee: ["*"], canDelegateTo: [], isRoot: false, created: "2026-07-04T00:00:00.000Z" });
  await mkdir(join(ws, "agents", "content-strategist"), { recursive: true });
  await writeFile(join(ws, "agents", "content-strategist", "agent.md"), serializeAgent(toolless));
  // A worker with a deliberate NON-empty (non-artifact) grant — must be left untouched.
  const narrow = AgentDef.parse({ id: "narrow", role: "x", identity: "y", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: [], isRoot: false, created: "2026-07-04T00:00:00.000Z" });
  await mkdir(join(ws, "agents", "narrow"), { recursive: true });
  await writeFile(join(ws, "agents", "narrow", "agent.md"), serializeAgent(narrow));

  const fixed = await reconcileWorkerTools(ws);
  expect(fixed).toEqual(["content-strategist"]);                 // only the toolless worker
  expect((await loadAgent(ws, "content-strategist")).tools).toEqual(DEFAULT_WORKER_TOOLS);
  expect((await loadAgent(ws, "narrow")).tools).toEqual(["delegate_task"]); // deliberate grant preserved
  expect((await loadAgent(ws, "root")).tools).toContain("create_agent");    // root untouched (isRoot)
  expect((await loadAgent(ws, LIBRARIAN_ID)).tools).toEqual(LIBRARIAN_TOOLS); // librarian untouched
  // idempotent: a second pass finds nothing to fix
  expect(await reconcileWorkerTools(ws)).toEqual([]);
});

// ── Plan 22: the agent lifecycle (updateAgent / setAgentTeams / deleteAgent) ──

test("updateAgent edits fields, keeps the artifact floor, and re-derives a default-shaped canSee", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  createTeam(ws, { id: "news", charter: "c" });
  createTeam(ws, { id: "research", charter: "c" });
  await createAgent(ws, db, { id: "w", role: "old role", identity: "old", tools: ["run_command"] }, "root");

  const up = await updateAgent(ws, db, "w", { role: "new role", identity: "new", teams: ["news", "research"] });
  expect(up.role).toBe("new role");
  expect(up.identity).toBe("new");
  expect(up.teams).toEqual(["news", "research"]);
  expect(up.tools).toContain("run_command");
  for (const t of DEFAULT_WORKER_TOOLS) expect(up.tools).toContain(t); // floor preserved on edit
  expect(up.canSee).toEqual(["team:news", "team:research"]);           // re-derived from the default ["*"]
  expect(loadIndex(db).find((r) => r.id === "w")!.teams).toEqual(["default", "news", "research"]);
});

test("updateAgent rejects a membership on a team that doesn't exist", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  await createAgent(ws, db, { id: "w", role: "r", identity: "i" }, "root");
  await expect(updateAgent(ws, db, "w", { teams: ["ghost"] })).rejects.toThrow('no team "ghost"');
});

test("updateAgent leaves a hand-customized canSee (exact agent ids) untouched when re-teaming", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  createTeam(ws, { id: "news", charter: "c" });
  await createAgent(ws, db, { id: "w", role: "r", identity: "i" }, "root");
  await updateAgent(ws, db, "w", { canSee: ["root", "librarian"] }); // captain customizes visibility
  const up = await updateAgent(ws, db, "w", { teams: ["news"] });
  expect(up.canSee).toEqual(["root", "librarian"]); // not clobbered by the team change
});

test("setAgentTeams moves an agent between teams; the membership index follows", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  createTeam(ws, { id: "news", charter: "c" });
  createTeam(ws, { id: "trading", charter: "c" });
  await createAgent(ws, db, { id: "w", role: "r", identity: "i", teams: ["news"] }, "root");

  await setAgentTeams(ws, db, "w", ["trading"]);
  expect((await loadAgent(ws, "w")).teams).toEqual(["trading"]);
  expect(membersOf(db, "news")).toEqual([]);
  expect(membersOf(db, "trading").map((m) => m.id)).toEqual(["w"]);
});

test("deleteAgent removes files + derived rows, and protects root and the librarian", async () => {
  const { ws, db } = await freshWs();
  await seedLibrarian(ws);
  await reindex(ws, db);
  createTeam(ws, { id: "news", charter: "c" });
  await createAgent(ws, db, { id: "temp", role: "r", identity: "i", teams: ["news"] }, "root");
  expect(membersOf(db, "news").map((m) => m.id)).toEqual(["temp"]);

  await deleteAgent(ws, db, "temp");
  expect(loadIndex(db).some((r) => r.id === "temp")).toBe(false);
  expect(existsSync(paths.agentDir(ws, "temp"))).toBe(false);
  expect(membersOf(db, "news")).toEqual([]); // its membership row went too

  await expect(deleteAgent(ws, db, "root")).rejects.toThrow();
  await expect(deleteAgent(ws, db, LIBRARIAN_ID)).rejects.toThrow();
});

test("createAgent rejects a duplicate id", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  await createAgent(ws, db, { id: "dup", role: "x", identity: "y" }, "root");
  await expect(createAgent(ws, db, { id: "dup", role: "x", identity: "y" }, "root")).rejects.toThrow();
});

test("createAgent applies config default budgets, schema fills the rest", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  const a = await createAgent(ws, db, { id: "w", role: "writes", identity: "x" }, "root", { budgets: { maxTokensPerRun: 500 } });
  expect(a.budgets.maxTokensPerRun).toBe(500);
  expect(a.budgets.maxIterationsPerRun).toBe(30); // schema default still applies
});

test("seedRoot gives root the MCP tools, and reconciles an older root that lacks them", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-roster-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  let root = await loadAgent(ws, "root");
  expect(root.tools).toContain("read_url");
  expect(root.tools).toContain("add_mcp_server");

  // Simulate an older root missing the new tools, then re-seed (boot) and confirm reconcile.
  root.tools = ["create_agent", "delegate_task", "find_agents"];
  await Bun.write(join(ws, "agents", "root", "agent.md"), (await import("./roster")).serializeAgent(root));
  await seedRoot(ws);
  const reconciled = await loadAgent(ws, "root");
  expect(reconciled.tools).toContain("read_url");
  expect(reconciled.tools).toContain("add_mcp_server");
  expect(reconciled.tools).toContain("create_agent"); // existing tools preserved
});

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

test("Plan 20: reindex removes ghost rows for deleted agent.md files (delete-then-rebuild)", async () => {
  const { rmSync } = await import("node:fs");
  const ws = mkdtempSync(join(tmpdir(), "taicho-roster-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  await createAgent(ws, db, { id: "ghostagent", role: "soon deleted", identity: "You vanish." }, "root");
  expect(loadIndex(db).some((r) => r.id === "ghostagent")).toBe(true);
  // The captain hand-deletes the agent (files are canon) — the derived row must go on the next rebuild.
  rmSync(join(ws, "agents", "ghostagent"), { recursive: true, force: true });
  await reindex(ws, db);
  const ids = loadIndex(db).map((r) => r.id);
  expect(ids).not.toContain("ghostagent");   // upsert-only reindex left this ghost forever
  expect(ids).toContain("root");             // survivors are rebuilt, not lost
});
