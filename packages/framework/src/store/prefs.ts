/** Plan 10 Phase 4 — durable UI preferences, per workspace at <ws>/agents/.prefs.json (under the
 *  gitignored agents/ dir). Mirrors the mcp-store pattern: a tiny JSON file the REPL reads on boot
 *  and rewrites when the captain changes a setting. Today it holds only the live view mode
 *  (bar/panes/both); the shape is open so future prefs layer on without a migration. */
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../core/logger";

/** The live-view surfaces: the status bar (summary), the split panes (per-agent detail), or both.
 *  Plan 13's consistent-block view is the DEFAULT render (no mode toggle needed). The live waterfall
 *  was retired with the /trace inspector (Plan 17) — trace visualization is OpenTelemetry's job now. */
export const VIEW_MODES = ["bar", "panes", "both"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];
export const DEFAULT_VIEW_MODE: ViewMode = "both";

export function isViewMode(s: string): s is ViewMode {
  return (VIEW_MODES as readonly string[]).includes(s);
}

// Plan 18: whether the pinned plan panel renders. `.passthrough()` means a new key needs no migration.
const PrefsSchema = z.object({ viewMode: z.enum(VIEW_MODES).optional(), planPanel: z.boolean().optional() }).passthrough();
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

/** Plan 18: is the pinned plan panel shown? Default on — a plan you cannot see is a plan you cannot steer. */
export function getPlanPanel(ws: string): boolean {
  return readPrefs(ws).planPanel ?? true;
}

export function setPlanPanel(ws: string, on: boolean): void {
  const prefs = readPrefs(ws);
  prefs.planPanel = on;
  write(ws, prefs);
}
