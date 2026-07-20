/** One JSON file per run under runs/<agent>/<date>-run<n>.json. Files are canon. */
import { mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./files";
import { RunTrace } from "@taicho-ai/contracts/trace";

function dateStamp(): string { return new Date().toISOString().slice(0, 10); }
function fileName(id: string): string {
  const i = id.indexOf("/");
  if (i < 0) throw new Error("bad run id: " + id);
  return id.slice(i + 1) + ".json";
}

export function nextRunId(ws: string, agentId: string): string {
  const date = dateStamp();
  const dir = paths.runDir(ws, agentId);
  let max = 0;
  if (existsSync(dir)) {
    const prefix = `${date}-run`;
    for (const f of readdirSync(dir)) {
      if (f.startsWith(prefix)) {
        const n = parseInt(f.slice(prefix.length), 10);
        if (Number.isFinite(n)) max = Math.max(max, n);
      }
    }
  }
  return `${agentId}/${date}-run${max + 1}`;
}

export function writeTrace(ws: string, trace: RunTrace): string {
  const dir = paths.runDir(ws, trace.agent);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName(trace.id));
  writeFileSync(file, JSON.stringify(trace, null, 2));
  return file;
}

export function readTrace(ws: string, id: string): RunTrace {
  const file = join(paths.runDir(ws, id.split("/")[0]), fileName(id));
  return RunTrace.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function listTraces(ws: string, agentId?: string): RunTrace[] {
  const root = join(ws, "runs");
  if (!existsSync(root)) return [];
  const agents = agentId
    ? [agentId]
    : readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  const out: RunTrace[] = [];
  for (const a of agents) {
    const dir = paths.runDir(ws, a);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(RunTrace.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))));
      } catch {
        // skip unparseable / in-progress placeholder files so listing never breaks
      }
    }
  }
  return out.sort((x, y) => x.started.localeCompare(y.started));
}

/** Atomically reserve a unique run id by exclusively creating its trace file as an
 *  `interrupted` placeholder. Concurrent reservations for the same agent never collide. */
export function reserveRunId(ws: string, agentId: string): string {
  const date = dateStamp();
  const dir = paths.runDir(ws, agentId);
  mkdirSync(dir, { recursive: true });
  let n = 1;
  const prefix = `${date}-run`;
  for (const f of readdirSync(dir)) {
    if (f.startsWith(prefix)) {
      const m = parseInt(f.slice(prefix.length), 10);
      if (Number.isFinite(m)) n = Math.max(n, m + 1);
    }
  }
  for (;;) {
    const id = `${agentId}/${date}-run${n}`;
    try {
      writeFileSync(join(dir, `${date}-run${n}.json`), JSON.stringify(placeholderTrace(id, agentId), null, 2), { flag: "wx" });
      return id;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") { n++; continue; }
      throw e;
    }
  }
}

function placeholderTrace(id: string, agent: string): RunTrace {
  return RunTrace.parse({
    id, agent, task: "(running)", triggeredBy: "",
    ledger: { retrieved: [], applied: [], skipped: [] },
    toolCalls: [], artifacts: [], delegatedOut: [], outcome: "interrupted",
    tokens: 0, durationMs: 0, started: new Date().toISOString(),
  });
}
