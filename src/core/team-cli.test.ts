import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTeamCli, runTeamCli } from "./team-cli";
import { openDb } from "../store/db";
import { ensureWorkspace } from "../store/files";
import { seedRoot, reindex, createAgent, loadAgent } from "../store/roster";
import { membersOf, teamExists } from "../store/teams";

test("parseTeamCli understands list / add / remove / member", () => {
  expect(parseTeamCli([])).toEqual({ kind: "list" });
  expect(parseTeamCli(["list"])).toEqual({ kind: "list" });
  expect(parseTeamCli(["add", "news", "--charter", "the brief", "--lead", "editor", "--member", "a", "--member", "b"]))
    .toEqual({ kind: "add", id: "news", charter: "the brief", lead: "editor", members: ["a", "b"] });
  expect(parseTeamCli(["add", "news"])).toEqual({ kind: "add", id: "news", charter: "news", lead: undefined, members: [] });
  expect(parseTeamCli(["remove", "news"])).toEqual({ kind: "remove", id: "news" });
  expect(parseTeamCli(["member", "add", "editor", "news"])).toEqual({ kind: "member", op: "add", agent: "editor", team: "news" });
  expect(parseTeamCli(["add"]).kind).toBe("error");
  expect(parseTeamCli(["member", "sideways", "x", "y"]).kind).toBe("error");
  expect(parseTeamCli(["frobnicate"]).kind).toBe("error");
});

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-team-cli-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  await createAgent(ws, db, { id: "editor", role: "edits", identity: "i" }, "root");
  await createAgent(ws, db, { id: "reporter", role: "reports", identity: "i" }, "root");
  return { ws, db };
}

test("runTeamCli add creates and staffs a team; member add/remove edits it; remove deletes it", async () => {
  const { ws } = await boot();
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);

  expect((await runTeamCli({ ws, out }, ["add", "news", "--charter", "the brief", "--lead", "editor", "--member", "editor", "--member", "reporter"])).ok).toBe(true);
  const db2 = openDb(ws);
  expect(teamExists(ws, "news")).toBe(true);
  expect(membersOf(db2, "news").map((m) => m.id)).toEqual(["editor", "reporter"]);

  expect((await runTeamCli({ ws, out }, ["member", "remove", "reporter", "news"])).ok).toBe(true);
  expect((await loadAgent(ws, "reporter")).teams).toEqual([]);

  expect((await runTeamCli({ ws, out }, ["remove", "news"])).ok).toBe(true);
  expect(teamExists(ws, "news")).toBe(false);
});

test("runTeamCli refuses to touch the default team's membership", async () => {
  const { ws } = await boot();
  const lines: string[] = [];
  const r = await runTeamCli({ ws, out: (l) => lines.push(l) }, ["member", "add", "editor", "default"]);
  expect(r.ok).toBe(false);
  expect(lines.join("\n")).toContain("default team");
});

test("runTeamCli reports a friendly error for an unknown agent or team", async () => {
  const { ws } = await boot();
  await runTeamCli({ ws, out: () => {} }, ["add", "news", "--charter", "c"]);
  const a: string[] = [];
  expect((await runTeamCli({ ws, out: (l) => a.push(l) }, ["member", "add", "nobody", "news"])).ok).toBe(false);
  expect(a.join("\n")).toContain('no agent "nobody"');
  const b: string[] = [];
  expect((await runTeamCli({ ws, out: (l) => b.push(l) }, ["member", "add", "editor", "ghostteam"])).ok).toBe(false);
  expect(b.join("\n")).toContain('no team "ghostteam"');
});
