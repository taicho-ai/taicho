/** Plan 18: the plan store.
 *
 *  On disk, mirroring artifacts/ and artifacts/<id>/annotations.jsonl:
 *
 *    plans/<id>/v1.json        immutable envelope — the item set (the intent)
 *    plans/<id>/v2.json        a replan; parents: ["<id>@v1"]
 *    plans/<id>/events.jsonl   append-only item transitions, across ALL versions
 *
 *  Files are canon. The `plans` table is a rebuildable index of the FOLDED counters, so the panel and
 *  /plan never walk the event log to answer "how many are open". reindexPlans rebuilds it from the files.
 *
 *  Crash recovery falls out of the shape: the event log is append-only, so a process that dies mid-run
 *  leaves a legible tail, and reconcilePlans appends `interrupted` for items whose bound run never
 *  settled — without touching the versioned intent. */
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { Plan, PlanEvent, PlanItem, PlanItemStatus, TERMINAL_ITEM_STATUS, planHandle, parsePlanHandle, type FoldedItem, type PlanState } from "../schemas/plan";
import { paths } from "./files";
import { log } from "../core/logger";

const planDir = (ws: string, id: string) => join(paths.plansDir(ws), id);
const versionFile = (ws: string, id: string, v: number) => join(planDir(ws, id), `v${v}.json`);
const eventsFile = (ws: string, id: string) => join(planDir(ws, id), "events.jsonl");

/** Every version number on disk for a plan, ascending. */
function versions(ws: string, id: string): number[] {
  const dir = planDir(ws, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^v(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

export function latestVersion(ws: string, id: string): number | null {
  const vs = versions(ws, id);
  return vs.length ? vs[vs.length - 1]! : null;
}

export function readPlanVersion(ws: string, id: string, v: number): Plan | null {
  const f = versionFile(ws, id, v);
  if (!existsSync(f)) return null;
  try { return Plan.parse(JSON.parse(readFileSync(f, "utf8"))); }
  catch (e) { log.warn(`unparseable plan ${id}@v${v}`, e); return null; }
}

/** Resolve `p_ship` (latest) or `p_ship@v2` (concrete). */
export function readPlan(ws: string, handle: string): Plan | null {
  const { id, version } = parsePlanHandle(handle);
  const v = version ?? latestVersion(ws, id);
  return v ? readPlanVersion(ws, id, v) : null;
}

export interface PlanDraft {
  id?: string;
  owner: string;
  goal: string;
  items: PlanItem[];
  producer: string;
  runId: string;
}

const sameShape = (a: PlanItem[], b: PlanItem[]): boolean =>
  a.length === b.length &&
  a.every((x, i) => x.id === b[i]!.id && x.text === b[i]!.text && (x.assignee ?? "") === (b[i]!.assignee ?? ""));

/** Mint v1, or vN+1 IF AND ONLY IF the item set differs from the latest version.
 *
 *  The dedup is the guard against version churn from a model that re-states its plan every iteration:
 *  an identical write returns the existing handle and mints nothing. Version history should answer
 *  "when did this agent change its mind", not "how many times did it repeat itself".
 *
 *  Exclusive-create (`flag: "wx"`), retrying the version number on EEXIST — the same race-free idiom as
 *  saveArtifact and reserveRunId. Two concurrent replans cannot collide on a version number. */
export function writePlan(ws: string, draft: PlanDraft): { plan: Plan; minted: boolean } {
  const id = draft.id ?? `p_${draft.owner}`;
  const items = draft.items.map((i) => PlanItem.parse(i));
  const dir = planDir(ws, id);
  mkdirSync(dir, { recursive: true });

  const latest = latestVersion(ws, id);
  if (latest) {
    const prev = readPlanVersion(ws, id, latest);
    if (prev && sameShape(prev.items, items)) return { plan: prev, minted: false };
  }

  for (let v = (latest ?? 0) + 1; v < (latest ?? 0) + 50; v++) {
    const plan = Plan.parse({
      id, version: v, owner: draft.owner, goal: draft.goal, items,
      parents: latest ? [planHandle({ id, version: latest })] : [],
      producer: draft.producer, runId: draft.runId, created: new Date().toISOString(),
    });
    try {
      writeFileSync(versionFile(ws, id, v), JSON.stringify(plan, null, 2), { flag: "wx" });
      return { plan, minted: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // lost the race for this version number — try the next
    }
  }
  throw new Error(`could not mint a new version of plan "${id}" (50 collisions)`);
}

/** Append one transition. A free function, not a RunContext method, because the BACKGROUND task settle
 *  path must write to it long after the run that dispatched it is gone. */
export function appendPlanEvent(ws: string, id: string, event: Omit<PlanEvent, "ts"> & { ts?: string }): PlanEvent {
  const e = PlanEvent.parse({ ...event, ts: event.ts ?? new Date().toISOString() });
  mkdirSync(planDir(ws, id), { recursive: true });
  appendFileSync(eventsFile(ws, id), JSON.stringify(e) + "\n");
  return e;
}

export function readPlanEvents(ws: string, id: string): PlanEvent[] {
  const f = eventsFile(ws, id);
  if (!existsSync(f)) return [];
  const out: PlanEvent[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(PlanEvent.parse(JSON.parse(line))); }
    catch (e) { log.warn(`skipping malformed plan event in ${id}`, e); }
  }
  return out;
}

/** Current state = fold(events) over the latest version's items. The last event per item wins.
 *
 *  Events naming an item that no longer exists (removed by a replan) are ignored — the version is the
 *  authority on WHICH items exist, the log is the authority on what happened to them. */
export function foldPlan(ws: string, handle: string): PlanState | null {
  const plan = readPlan(ws, handle);
  if (!plan) return null;
  const byItem = new Map<string, PlanEvent>();
  // Later lines overwrite earlier. A `rejected` attempt is recorded but must NOT win the fold — that
  // would hand the model exactly the lie the engine-owns rule refuses it.
  for (const e of readPlanEvents(ws, plan.id)) if (!e.rejected) byItem.set(e.item, e);

  const items: FoldedItem[] = plan.items.map((i) => {
    const e = byItem.get(i.id);
    return e
      ? { ...i, status: e.status, boundRunId: e.boundRunId, note: e.note, updated: e.ts }
      : { ...i, status: "pending" as PlanItemStatus };
  });
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "failed" || i.status === "blocked" || i.status === "interrupted").length;
  const open = items.filter((i) => !TERMINAL_ITEM_STATUS.has(i.status)).length;
  return { plan, handle: planHandle(plan), items, counts: { total: items.length, done, open, failed } };
}

/** The item an item is BOUND to — used by the background-task settle path, which knows only a taskId. */
export function findPlanItemByBoundRun(ws: string, boundRunId: string): { planId: string; item: string } | null {
  for (const id of listPlanIds(ws)) {
    for (const e of readPlanEvents(ws, id)) if (e.boundRunId === boundRunId) return { planId: id, item: e.item };
  }
  return null;
}

/** Settle whatever plan item a background task was bound to. Called from the REPL's off-turn settle
 *  path, which knows only a taskId — the run that dispatched it is long gone, which is exactly why
 *  appendPlanEvent is a free function and not a RunContext method. No-op when nothing is bound. */
export function settlePlanItemForTask(
  ws: string,
  db: Database,
  taskId: string,
  status: PlanItemStatus,
  note?: string,
): { planId: string; item: string } | null {
  const found = findPlanItemByBoundRun(ws, taskId);
  if (!found) return null;
  appendPlanEvent(ws, found.planId, { item: found.item, status, by: "engine", runId: taskId, boundRunId: taskId, note });
  const after = foldPlan(ws, found.planId);
  if (after) indexPlan(db, after);
  return found;
}

export function listPlanIds(ws: string): string[] {
  const dir = paths.plansDir(ws);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => existsSync(join(dir, id, "v1.json")))
    .sort();
}

// ---- SQLite index (rebuildable; the files are canon) ----------------------------------------------

export function indexPlan(db: Database, s: PlanState): void {
  db.query(
    `INSERT INTO plans (id, version, owner, goal, total, done, open, failed, root_run_id, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       version=excluded.version, owner=excluded.owner, goal=excluded.goal, total=excluded.total,
       done=excluded.done, open=excluded.open, failed=excluded.failed, updated=excluded.updated`,
  ).run(
    s.plan.id, s.plan.version, s.plan.owner, s.plan.goal,
    s.counts.total, s.counts.done, s.counts.open, s.counts.failed,
    s.plan.runId, s.plan.created, new Date().toISOString(),
  );
}

export interface PlanRow { id: string; version: number; owner: string; goal: string; total: number; done: number; open: number; failed: number; updated: string }

/** The agent's LIVE plan: the most recently updated one it owns. */
export function currentPlanId(db: Database, owner: string): string | null {
  const r = db.query<{ id: string }, [string]>("SELECT id FROM plans WHERE owner = ? ORDER BY updated DESC LIMIT 1").get(owner);
  return r?.id ?? null;
}

export function listPlanRows(db: Database, owner?: string): PlanRow[] {
  return owner
    ? db.query<PlanRow, [string]>("SELECT id, version, owner, goal, total, done, open, failed, updated FROM plans WHERE owner = ? ORDER BY updated DESC").all(owner)
    : db.query<PlanRow, []>("SELECT id, version, owner, goal, total, done, open, failed, updated FROM plans ORDER BY updated DESC").all();
}

export function reindexPlans(ws: string, db: Database): void {
  db.exec("DELETE FROM plans");
  for (const id of listPlanIds(ws)) {
    const s = foldPlan(ws, id);
    if (s) indexPlan(db, s);
  }
}

/** Boot. An item left `in_progress` means the process died while its bound run was in flight — exactly
 *  what reconcileTasks does for a task. Append `interrupted` (never rewrite history) and report it.
 *  The versioned INTENT is untouched: the item is still what the agent meant to do. */
export function reconcilePlans(ws: string, db: Database): { planId: string; item: string }[] {
  const interrupted: { planId: string; item: string }[] = [];
  for (const id of listPlanIds(ws)) {
    const s = foldPlan(ws, id);
    if (!s) continue;
    for (const item of s.items) {
      if (item.status !== "in_progress") continue;
      appendPlanEvent(ws, id, {
        item: item.id, status: "interrupted", by: "engine", runId: "boot",
        boundRunId: item.boundRunId, note: "the process exited while this item was in flight",
      });
      interrupted.push({ planId: id, item: item.id });
    }
    const after = foldPlan(ws, id);
    if (after) indexPlan(db, after);
  }
  return interrupted;
}

/** Render the plan as the model sees it — the tail-slot block (core/plan-inject.ts wraps it). */
export function renderPlan(s: PlanState): string {
  const glyph: Record<PlanItemStatus, string> = {
    pending: "[ ]", in_progress: "[~]", done: "[x]", failed: "[!]",
    blocked: "[!]", interrupted: "[?]", dropped: "[-]",
  };
  const lines = s.items.map((i) => {
    const who = i.assignee ? ` @${i.assignee}` : "";
    const why = i.note ? ` — ${i.note}` : "";
    const owned = i.boundRunId ? " (engine-owned)" : "";
    return `${glyph[i.status]} ${i.id}: ${i.text}${who}${owned}${why}`;
  });
  return `GOAL: ${s.plan.goal}\n${lines.join("\n")}\n(${s.counts.done}/${s.counts.total} done, ${s.counts.open} open)`;
}

export { TERMINAL_ITEM_STATUS };
