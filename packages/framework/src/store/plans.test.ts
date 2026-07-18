import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { paths } from "./files";
import {
  writePlan, appendPlanEvent, readPlan, readPlanEvents, foldPlan, latestVersion,
  reconcilePlans, reindexPlans, listPlanRows, currentPlanId, findPlanItemByBoundRun, renderPlan,
} from "./plans";
import { planIdForGoal, parsePlanHandle, planHandle } from "@taicho/contracts/plan";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-plans-"));
const items = (...t: string[]) => t.map((x, i) => ({ id: `it_${i}`, text: x }));
const draft = (over: Partial<Parameters<typeof writePlan>[1]> = {}) => ({
  owner: "root", goal: "ship the notifier", items: items("survey", "design", "ship"),
  producer: "root", runId: "root/r1", ...over,
});

// --- structure: versions are immutable and minted only when the SHAPE changes ----------------------

test("writePlan mints v1, and a byte-identical rewrite mints nothing", () => {
  const w = ws();
  const a = writePlan(w, draft());
  expect(a.minted).toBe(true);
  expect(a.plan.version).toBe(1);
  expect(existsSync(join(paths.plansDir(w), a.plan.id, "v1.json"))).toBe(true);

  // The guard against version churn: a model that re-states its plan every iteration must not mint 30
  // versions of an object whose shape never changed.
  const b = writePlan(w, draft());
  expect(b.minted).toBe(false);
  expect(b.plan.version).toBe(1);
  expect(latestVersion(w, a.plan.id)).toBe(1);
});

test("a CHANGED item set is a replan: v2, with v1 as its parent", () => {
  const w = ws();
  const a = writePlan(w, draft());
  const b = writePlan(w, draft({ items: items("survey", "design", "ship", "announce") }));
  expect(b.minted).toBe(true);
  expect(b.plan.version).toBe(2);
  expect(b.plan.parents).toEqual([planHandle(a.plan)]);
  // v1 is immutable — it still says what it said
  expect(readPlan(w, `${a.plan.id}@v1`)!.items).toHaveLength(3);
  expect(readPlan(w, a.plan.id)!.items).toHaveLength(4); // bare id resolves to latest
});

test("reworded or reordered items are a NEW shape; assignee changes too", () => {
  const w = ws();
  const id = writePlan(w, draft()).plan.id;
  expect(writePlan(w, draft({ items: items("survey", "design", "SHIP IT") })).plan.version).toBe(2);
  expect(writePlan(w, draft({ items: items("design", "survey", "SHIP IT") })).plan.version).toBe(3);
  const withAssignee = [{ id: "it_0", text: "design" }, { id: "it_1", text: "survey" }, { id: "it_2", text: "SHIP IT", assignee: "news" }];
  expect(writePlan(w, draft({ items: withAssignee })).plan.version).toBe(4);
  expect(latestVersion(w, id)).toBe(4);
});

test("planIdForGoal is deterministic, so re-stating a goal continues the plan instead of forking one", () => {
  expect(planIdForGoal("Ship the notifier!")).toBe("p_ship-the-notifier");
  expect(planIdForGoal("Ship the notifier!")).toBe(planIdForGoal("ship  the   notifier"));
  expect(planIdForGoal("")).toBe("p_plan");
  expect(planIdForGoal("!!!")).toBe("p_plan");
});

test("parsePlanHandle: bare id, id@vN, and a malformed suffix", () => {
  expect(parsePlanHandle("p_ship")).toEqual({ id: "p_ship" });
  expect(parsePlanHandle("p_ship@v3")).toEqual({ id: "p_ship", version: 3 });
  expect(parsePlanHandle("p_ship@vX")).toEqual({ id: "p_ship@vX" }); // not a version ⇒ treat whole as id
});

// --- state: transitions are an append-only log, never a new version -------------------------------

test("ticking a box appends an event and mints NO version", () => {
  const w = ws();
  const { plan } = writePlan(w, draft());
  appendPlanEvent(w, plan.id, { item: "it_0", status: "done", by: "model", runId: "root/r1" });
  appendPlanEvent(w, plan.id, { item: "it_1", status: "in_progress", by: "engine", runId: "root/r1", boundRunId: "news/r2" });

  expect(latestVersion(w, plan.id)).toBe(1); // still v1 — structure never changed
  expect(readPlanEvents(w, plan.id)).toHaveLength(2);

  const s = foldPlan(w, plan.id)!;
  expect(s.items.map((i) => i.status)).toEqual(["done", "in_progress", "pending"]);
  expect(s.items[1]!.boundRunId).toBe("news/r2");
  expect(s.counts).toEqual({ total: 3, done: 1, open: 2, failed: 0 });
});

test("the LAST event per item wins the fold", () => {
  const w = ws();
  const { plan } = writePlan(w, draft());
  appendPlanEvent(w, plan.id, { item: "it_0", status: "in_progress", by: "engine", runId: "r" });
  appendPlanEvent(w, plan.id, { item: "it_0", status: "failed", by: "engine", runId: "r", note: "verdict failed" });
  appendPlanEvent(w, plan.id, { item: "it_0", status: "done", by: "engine", runId: "r" });
  const s = foldPlan(w, plan.id)!;
  expect(s.items[0]!.status).toBe("done");
  expect(readPlanEvents(w, plan.id)).toHaveLength(3); // history is kept, never rewritten
});

test("events for an item a replan REMOVED are ignored: the version says which items exist", () => {
  const w = ws();
  const { plan } = writePlan(w, draft());
  appendPlanEvent(w, plan.id, { item: "it_2", status: "done", by: "model", runId: "r" });
  writePlan(w, draft({ items: items("survey", "design") })); // it_2 dropped from the shape
  const s = foldPlan(w, plan.id)!;
  expect(s.items.map((i) => i.id)).toEqual(["it_0", "it_1"]);
  expect(s.counts.total).toBe(2);
  // an event survives a replan that KEEPS the item — item ids are stable across versions
  appendPlanEvent(w, plan.id, { item: "it_0", status: "done", by: "model", runId: "r" });
  writePlan(w, draft({ items: items("survey", "design", "extra") }));
  expect(foldPlan(w, plan.id)!.items[0]!.status).toBe("done");
});

test("a malformed event line is skipped, not fatal", () => {
  const w = ws();
  const { plan } = writePlan(w, draft());
  appendPlanEvent(w, plan.id, { item: "it_0", status: "done", by: "model", runId: "r" });
  const f = join(paths.plansDir(w), plan.id, "events.jsonl");
  Bun.write(f, readFileSync(f, "utf8") + "{not json\n");
  expect(foldPlan(w, plan.id)!.items[0]!.status).toBe("done");
});

// --- crash recovery ------------------------------------------------------------------------------

test("reconcilePlans marks in-flight items interrupted, appending rather than rewriting", () => {
  const w = ws();
  const db = openDb(w);
  const { plan } = writePlan(w, draft());
  appendPlanEvent(w, plan.id, { item: "it_0", status: "done", by: "engine", runId: "r" });
  appendPlanEvent(w, plan.id, { item: "it_1", status: "in_progress", by: "engine", runId: "r", boundRunId: "news/r2" });

  const out = reconcilePlans(w, db);
  expect(out).toEqual([{ planId: plan.id, item: "it_1" }]);

  const s = foldPlan(w, plan.id)!;
  expect(s.items[0]!.status).toBe("done");         // settled items untouched
  expect(s.items[1]!.status).toBe("interrupted");
  expect(s.items[1]!.boundRunId).toBe("news/r2");  // the binding is preserved for forensics
  expect(s.items[2]!.status).toBe("pending");      // pending INTENT survives a reboot — unlike a task
  expect(latestVersion(w, plan.id)).toBe(1);       // the intent was never rewritten

  expect(reconcilePlans(w, db)).toEqual([]);       // idempotent: nothing is in flight now
});

// --- the derived index ---------------------------------------------------------------------------

test("reindexPlans rebuilds the counters from the files (the DB is throwaway)", () => {
  const w = ws();
  const db = openDb(w);
  const { plan } = writePlan(w, draft());
  appendPlanEvent(w, plan.id, { item: "it_0", status: "done", by: "model", runId: "r" });
  writePlan(w, draft({ id: "p_other", owner: "editor", goal: "file the story", items: items("draft") }));

  reindexPlans(w, db);
  const rows = listPlanRows(db);
  expect(rows).toHaveLength(2);
  expect(listPlanRows(db, "root")[0]).toMatchObject({ id: plan.id, total: 3, done: 1, open: 2 });
  expect(currentPlanId(db, "editor")).toBe("p_other");
  expect(currentPlanId(db, "ghost")).toBeNull();

  db.exec("DELETE FROM plans");
  expect(listPlanRows(db)).toHaveLength(0);
  reindexPlans(w, db); // proves files-are-canon
  expect(listPlanRows(db)).toHaveLength(2);
});

test("findPlanItemByBoundRun locates the item a background task is bound to", () => {
  const w = ws();
  const { plan } = writePlan(w, draft());
  appendPlanEvent(w, plan.id, { item: "it_1", status: "in_progress", by: "engine", runId: "r", boundRunId: "task_bg_1" });
  expect(findPlanItemByBoundRun(w, "task_bg_1")).toEqual({ planId: plan.id, item: "it_1" });
  expect(findPlanItemByBoundRun(w, "task_bg_missing")).toBeNull();
});

test("renderPlan shows status glyphs, assignee, engine ownership, and the note", () => {
  const w = ws();
  const { plan } = writePlan(w, draft({ items: [{ id: "it_0", text: "survey" }, { id: "it_1", text: "ship", assignee: "news" }] }));
  appendPlanEvent(w, plan.id, { item: "it_0", status: "done", by: "model", runId: "r" });
  appendPlanEvent(w, plan.id, { item: "it_1", status: "failed", by: "engine", runId: "r", boundRunId: "news/r2", note: "no sources" });
  const out = renderPlan(foldPlan(w, plan.id)!);
  expect(out).toContain("GOAL: ship the notifier");
  expect(out).toContain("[x] it_0: survey");
  expect(out).toContain("[!] it_1: ship @news (engine-owned) — no sources");
  expect(out).toContain("(1/2 done, 0 open)");
});
