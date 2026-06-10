/** One JSON file per run under runs/<agent>/<date>-run<n>.json. Files are canon. */
import { mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./files";
import { RunTrace } from "../schemas/trace";

function dateStamp(): string { return new Date().toISOString().slice(0, 10); }
function fileName(id: string): string { return `${id.split("/")[1]}.json`; }

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
  const agents = agentId ? [agentId] : readdirSync(root);
  const out: RunTrace[] = [];
  for (const a of agents) {
    const dir = paths.runDir(ws, a);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json")) out.push(RunTrace.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))));
    }
  }
  return out.sort((x, y) => x.started.localeCompare(y.started));
}
