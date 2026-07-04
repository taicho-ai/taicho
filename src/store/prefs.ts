/** Plan 10 Phase 4 — durable UI preferences, per workspace at <ws>/agents/.prefs.json (under the
 *  gitignored agents/ dir). Mirrors the mcp-store pattern: a tiny JSON file the REPL reads on boot
 *  and rewrites when the captain changes a setting. Today it holds only the live view mode
 *  (bar/panes/both); the shape is open so future prefs layer on without a migration. */
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../core/logger";

/** The live-view surfaces: the status bar (summary), the split panes (per-agent detail), both, the
 *  live waterfall (Plan 02 Phase 6 — the redrawing span tree of the in-flight run), or the rolling
 *  stream (Plan 13 — a fixed-height per-agent tail of the live reply/work stream). */
export const VIEW_MODES = ["bar", "panes", "both", "waterfall", "stream"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];
export const DEFAULT_VIEW_MODE: ViewMode = "both";

export function isViewMode(s: string): s is ViewMode {
  return (VIEW_MODES as readonly string[]).includes(s);
}

const PrefsSchema = z.object({ viewMode: z.enum(VIEW_MODES).optional() }).passthrough();
export type Prefs = z.infer<typeof PrefsSchema>;

function prefsPath(ws: string): string { return join(ws, "agents", ".prefs.json"); }

export function readPrefs(ws: string): Prefs {
  const f = prefsPath(ws);
  if (!existsSync(f)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(f, "utf8")); } catch { return {}; }
  const parsed = PrefsSchema.safeParse(raw);
  if (!parsed.success) { log.warn("ignoring malformed .prefs.json"); return {}; }
  return parsed.data;
}

function write(ws: string, prefs: Prefs): void {
  const f = prefsPath(ws);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(prefs, null, 2));
}

/** The persisted view mode, defaulting to `both` (bar + panes) when unset or unreadable. */
export function getViewMode(ws: string): ViewMode {
  return readPrefs(ws).viewMode ?? DEFAULT_VIEW_MODE;
}

/** Persist the chosen view mode (leaving any other prefs intact). */
export function setViewMode(ws: string, mode: ViewMode): void {
  const prefs = readPrefs(ws);
  prefs.viewMode = mode;
  write(ws, prefs);
}
