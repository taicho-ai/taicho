import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../store/db";
import { ensureWorkspace } from "../store/files";
import { seedRoot, reindex, createAgent } from "../store/roster";
import { createTeam, createTeamWithMembers, seedDefaultTeam } from "../store/teams";
import { teamRows, agentRows, isProtectedAgent, isProtectedTeam, clampSel } from "./org-browser-model";

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-org-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  seedDefaultTeam(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  await createAgent(ws, db, { id: "editor", role: "edits", identity: "i" }, "root");
  await createAgent(ws, db, { id: "reporter", role: "reports", identity: "i" }, "root");
  return { ws, db };
}

test("teamRows lists every team (default included) with its resolved members", async () => {
  const { ws, db } = await boot();
  await createTeamWithMembers(ws, db, { id: "news", charter: "the brief", lead: "editor" }, ["editor", "reporter"]);
  const rows = teamRows(ws, db);
  const news = rows.find((r) => r.id === "news")!;
  expect(news.members).toEqual(["editor", "reporter"]);
  expect(news.lead).toBe("editor");
  const def = rows.find((r) => r.id === "default")!;
  expect(def.members.sort()).toEqual(["editor", "reporter", "root"]); // everyone
});

test("agentRows lists agents with their EXPLICIT teams (default dropped), sorted by id", async () => {
  const { ws, db } = await boot();
  createTeam(ws, { id: "news", charter: "c" });
  await createAgent(ws, db, { id: "anchor", role: "anchors", identity: "i", teams: ["news"] }, "root");
  const rows = agentRows(db);
  expect(rows.map((r) => r.id)).toEqual(["anchor", "editor", "reporter", "root"]); // sorted
  expect(rows.find((r) => r.id === "anchor")!.teams).toEqual(["news"]); // default not shown per-row
  expect(rows.find((r) => r.id === "root")!.teams).toEqual([]);         // default-only reads as no explicit team
  expect(rows.find((r) => r.id === "root")!.isRoot).toBe(true);
});

test("the guards protect root/librarian and the default team", () => {
  expect(isProtectedAgent("root")).toBe(true);
  expect(isProtectedAgent("librarian")).toBe(true);
  expect(isProtectedAgent("editor")).toBe(false);
  expect(isProtectedTeam("default")).toBe(true);
  expect(isProtectedTeam("news")).toBe(false);
});

test("clampSel keeps a selection in range", () => {
  expect(clampSel(-1, 3)).toBe(0);
  expect(clampSel(5, 3)).toBe(2);
  expect(clampSel(1, 3)).toBe(1);
  expect(clampSel(0, 0)).toBe(0);
});
