import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeAgent, parseAgent, seedRoot, reindex, loadIndex, loadAgent, createAgent, type RegistryRow } from "./roster";
import { AgentDef } from "../schemas/agent";
import { openDb } from "./db";
import { ensureWorkspace } from "./files";

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
  expect(loaded.tools).toEqual(["write_artifact"]); // default worker tool
});

test("createAgent rejects a duplicate id", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  await createAgent(ws, db, { id: "dup", role: "x", identity: "y" }, "root");
  await expect(createAgent(ws, db, { id: "dup", role: "x", identity: "y" }, "root")).rejects.toThrow();
});
