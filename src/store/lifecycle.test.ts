/** Plan 22 — the team-side service layer (setTeamMembers / createTeamWithMembers / deleteTeam /
 *  updateTeam) over REAL agent + team files. Membership is edited on the agent (the one source of truth),
 *  and the derived index follows. */
import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { ensureWorkspace, paths } from "./files";
import { seedRoot, reindex, createAgent, loadAgent } from "./roster";
import { createTeam, createTeamWithMembers, setTeamMembers, deleteTeam, updateTeam, membersOf, teamExists, loadTeam } from "./teams";

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-lifecycle-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  // three unaffiliated workers to staff teams with
  await createAgent(ws, db, { id: "reporter", role: "files stories", identity: "i" }, "root");
  await createAgent(ws, db, { id: "editor", role: "edits copy", identity: "i" }, "root");
  await createAgent(ws, db, { id: "analyst", role: "deep research", identity: "i" }, "root");
  return { ws, db };
}

test("setTeamMembers staffs a team exactly, adding and removing on re-run", async () => {
  const { ws, db } = await boot();
  createTeam(ws, { id: "news", charter: "c" });

  await setTeamMembers(ws, db, "news", ["reporter", "editor"]);
  expect(membersOf(db, "news").map((m) => m.id)).toEqual(["editor", "reporter"]);
  expect((await loadAgent(ws, "reporter")).teams).toEqual(["news"]);

  // re-run with a different set: analyst joins, reporter leaves, editor stays
  await setTeamMembers(ws, db, "news", ["editor", "analyst"]);
  expect(membersOf(db, "news").map((m) => m.id)).toEqual(["analyst", "editor"]);
  expect((await loadAgent(ws, "reporter")).teams).toEqual([]); // detached
});

test("an agent can belong to several teams at once (the orchestration case)", async () => {
  const { ws, db } = await boot();
  createTeam(ws, { id: "news", charter: "c" });
  createTeam(ws, { id: "research", charter: "c" });

  await setTeamMembers(ws, db, "news", ["editor"]);
  await setTeamMembers(ws, db, "research", ["editor", "analyst"]);
  expect((await loadAgent(ws, "editor")).teams).toEqual(["news", "research"]);
  expect(membersOf(db, "news").map((m) => m.id)).toEqual(["editor"]);
  expect(membersOf(db, "research").map((m) => m.id)).toEqual(["analyst", "editor"]);
});

test("createTeamWithMembers creates the file and staffs it in one call", async () => {
  const { ws, db } = await boot();
  const team = await createTeamWithMembers(ws, db, { id: "news", charter: "the brief", lead: "editor" }, ["reporter", "editor"]);
  expect(team.lead).toBe("editor");
  expect(teamExists(ws, "news")).toBe(true);
  expect(membersOf(db, "news").map((m) => m.id)).toEqual(["editor", "reporter"]);
});

test("deleteTeam strips the team from every member and removes the files", async () => {
  const { ws, db } = await boot();
  await createTeamWithMembers(ws, db, { id: "news", charter: "c" }, ["reporter", "editor"]);

  const detached = await deleteTeam(ws, db, "news");
  expect(detached.sort()).toEqual(["editor", "reporter"]);
  expect(teamExists(ws, "news")).toBe(false);
  expect(existsSync(paths.teamDir(ws, "news"))).toBe(false);
  expect((await loadAgent(ws, "reporter")).teams).toEqual([]); // membership stripped from the agent
  expect(membersOf(db, "news")).toEqual([]);
});

test("the default team cannot be deleted or have its membership set", async () => {
  const { ws, db } = await boot();
  createTeam(ws, { id: "default", charter: "everyone" }); // seedDefaultTeam-equivalent for the test
  await expect(deleteTeam(ws, db, "default")).rejects.toThrow("cannot be deleted");
  await expect(setTeamMembers(ws, db, "default", ["editor"])).rejects.toThrow("always a member");
});

test("updateTeam edits charter, lead, and body; clears the lead with null", async () => {
  const { ws, db } = await boot();
  await createTeamWithMembers(ws, db, { id: "news", charter: "old", lead: "editor" }, ["editor"]);

  const up = updateTeam(ws, "news", { charter: "new charter", charterBody: "Accurate before fast." });
  expect(up.charter).toBe("new charter");
  expect(up.charterBody).toBe("Accurate before fast.");
  expect(up.lead).toBe("editor"); // untouched

  const cleared = updateTeam(ws, "news", { lead: null });
  expect(cleared.lead).toBeUndefined();
  expect(loadTeam(ws, "news")!.lead).toBeUndefined();
});
