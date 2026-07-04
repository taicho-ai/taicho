/** Writable store of MCP servers added at runtime via `/mcp add`, per workspace at
 *  <ws>/agents/.mcp/servers.json (under the gitignored agents/ dir). taicho.yaml `mcp.servers`
 *  is read-only canon; this store layers on top — the effective set is yaml ∪ store. */
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { McpServerConfig } from "./config";
import { log } from "../core/logger";

const StoreSchema = z.record(z.string(), McpServerConfig);
export type McpStore = z.infer<typeof StoreSchema>;

function storeDir(ws: string): string { return join(ws, "agents", ".mcp"); }
function storePath(ws: string): string { return join(storeDir(ws), "servers.json"); }

export function readMcpStore(ws: string): McpStore {
  const f = storePath(ws);
  if (!existsSync(f)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(f, "utf8")); } catch { return {}; }
  if (typeof raw !== "object" || raw === null) return {};
  // Validate per entry so one malformed server doesn't silently wipe the whole store.
  const out: McpStore = {};
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = McpServerConfig.safeParse(spec);
    if (parsed.success) out[name] = parsed.data;
    else log.warn(`skipping invalid MCP server "${name}" in mcp-store`);
  }
  return out;
}

function write(ws: string, all: McpStore): void {
  mkdirSync(storeDir(ws), { recursive: true });
  writeFileSync(storePath(ws), JSON.stringify(all, null, 2));
}

export function addMcpServer(ws: string, name: string, spec: McpServerConfig): void {
  const all = readMcpStore(ws);
  all[name] = spec;
  write(ws, all);
}

export function removeMcpServer(ws: string, name: string): boolean {
  const all = readMcpStore(ws);
  if (!(name in all)) return false;
  delete all[name];
  write(ws, all);
  return true;
}
