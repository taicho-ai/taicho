/** Addressable, versioned, IMMUTABLE-PER-VERSION artifact store over artifacts/. Files are canon;
 *  artifacts/_index.json is a rebuildable manifest for enumeration. A revision is a NEW version,
 *  never an overwrite — v<N>.json is written exclusively (flag "wx"), like reserveRunId. The store
 *  is PAYLOAD-AGNOSTIC: the body is opaque bytes (or an external ref) and it never interprets it.
 *  Mirrors store/skills.ts (files canon + a rebuildable index).
 *
 *  Layout:  artifacts/<id>/v<N>.json   — the envelope (metadata + summary + location)
 *           artifacts/<id>/v<N>.<ext>  — the body bytes (local-file artifacts only)
 *           artifacts/_index.json      — manifest: the latest version of every id (rebuildable) */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join, basename } from "node:path";
import { Artifact, type ArtifactLocation, parseHandle } from "../schemas/artifact";
import { paths } from "./files";

// underscore prefix ⇒ can never collide with a valid artifact id dir (ids start with [a-z0-9]).
const MANIFEST = "_index.json";

function idDir(ws: string, id: string): string { return join(paths.artifactDir(ws), id); }
function envelopeFile(ws: string, id: string, version: number): string { return join(idDir(ws, id), `v${version}.json`); }
function bodyFile(ws: string, id: string, version: number, ext: string): string { return join(idDir(ws, id), `v${version}.${ext}`); }
function manifestPath(ws: string): string { return join(paths.artifactDir(ws), MANIFEST); }

function slugify(s: string): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "artifact";
}

/** A caller-supplied id, normalized to the store's id shape; null if it reduces to nothing. */
function normalizeId(raw?: string): string | null {
  if (!raw) return null;
  const id = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return id || null;
}

/** Versions present for an id, ascending. */
export function artifactVersions(ws: string, id: string): number[] {
  const dir = idDir(ws, id);
  if (!existsSync(dir)) return [];
  const vs: number[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(/^v(\d+)\.json$/);
    if (m) vs.push(Number(m[1]));
  }
  return vs.sort((a, b) => a - b);
}

export interface SaveArtifactInput {
  id?: string;                 // stable logical id/slug; omit to derive from the title
  title: string;
  type?: string;               // free-form tag
  role?: "output" | "input" | "resource";
  producer: string;            // agentId (provenance — from ctx in the tool)
  runId: string;               // run id (provenance — from ctx in the tool)
  parents?: string[];          // parent artifact handles (lineage)
  summary?: string;
  body?: string | Uint8Array;  // local bytes to store; omit when using `external`
  external?: string;           // external ref URI (instead of local body)
  ext?: string;                // body file extension (default md)
}

/** Save a NEW immutable version. Reusing an existing id bumps to the next version (never overwrites);
 *  a fresh id starts at v1. Provenance/lineage come from the caller. */
export function saveArtifact(ws: string, input: SaveArtifactInput): Artifact {
  if (input.body === undefined && !input.external) throw new Error("save_artifact needs a body or an external location");
  const id = normalizeId(input.id) ?? slugify(input.title);
  mkdirSync(idDir(ws, id), { recursive: true });
  const ext = (input.ext ?? "md").replace(/[^a-z0-9]/gi, "").slice(0, 12) || "md";

  // exclusive-create the envelope so a concurrent save can never clobber a version — retry the next.
  for (let version = (artifactVersions(ws, id).at(-1) ?? 0) + 1; ; version++) {
    const location: ArtifactLocation = input.external
      ? { kind: "external", uri: input.external }
      : { kind: "file", path: bodyFile(ws, id, version, ext) };
    const artifact = Artifact.parse({
      id, version, title: input.title, type: input.type ?? "document",
      role: input.role ?? "output", producer: input.producer, runId: input.runId,
      parents: input.parents ?? [], summary: input.summary, location,
      created: new Date().toISOString(),
    });
    try {
      writeFileSync(envelopeFile(ws, id, version), JSON.stringify(artifact, null, 2), { flag: "wx" });
      if (location.kind === "file") writeFileSync(location.path, input.body ?? "");
      upsertManifest(ws, artifact);
      return artifact;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") continue; // lost a race for this version
      throw e;
    }
  }
}

/** The envelope for a handle ("id" ⇒ latest, "id@vN" ⇒ that version); null if absent. */
export function readArtifact(ws: string, handle: string): Artifact | null {
  const { id, version } = parseHandle(handle);
  const v = version ?? artifactVersions(ws, id).at(-1);
  if (!v) return null;
  const file = envelopeFile(ws, id, v);
  if (!existsSync(file)) return null;
  try { return Artifact.parse(JSON.parse(readFileSync(file, "utf8"))); } catch { return null; }
}

/** Raw body bytes for a local-file artifact; null if external or missing. Payload-agnostic (Buffer).
 *  RELOCATABLE addressing: the body path is recomputed from the CURRENT ws + the artifact's id + the
 *  stored filename (v<N>.<ext>), exactly as envelopeFile recomputes the envelope path. The absolute
 *  path baked into the envelope goes stale the moment the workspace dir is renamed/moved, but the
 *  bytes still live at ws/artifacts/<id>/v<N>.<ext> — so we address them by ws, not by the baked path. */
export function readArtifactBody(ws: string, handle: string): Buffer | null {
  const a = readArtifact(ws, handle);
  if (!a || a.location.kind !== "file") return null;
  const file = join(idDir(ws, a.id), basename(a.location.path));
  if (!existsSync(file)) return null;
  return readFileSync(file);
}

export interface ArtifactFilter {
  producer?: string;
  type?: string;
  role?: "output" | "input" | "resource";
  q?: string;   // substring over id/title/summary
}

/** The latest version of each artifact, filtered, newest first. Reads the manifest (rebuilds it from
 *  the canonical envelopes if it's missing). */
export function listArtifacts(ws: string, filter: ArtifactFilter = {}): Artifact[] {
  const ql = filter.q?.toLowerCase();
  return readManifest(ws).filter((a) =>
    (!filter.producer || a.producer === filter.producer) &&
    (!filter.type || a.type === filter.type) &&
    (!filter.role || a.role === filter.role) &&
    (!ql || `${a.id} ${a.title} ${a.summary ?? ""}`.toLowerCase().includes(ql)),
  ).sort((x, y) => y.created.localeCompare(x.created));
}

// ── manifest (rebuildable index) ─────────────────────────────────────────────

function readManifestRaw(ws: string): Artifact[] {
  const f = manifestPath(ws);
  if (!existsSync(f)) return [];
  try {
    const arr = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(arr) ? arr.map((x) => Artifact.parse(x)) : [];
  } catch { return []; }
}

/** The manifest (latest version per id). _index.json is a REBUILDABLE cache, never authoritative:
 *  rebuilt from the canonical envelopes when it's missing/empty, and RECONCILED against a cheap dir
 *  scan so a valid-but-stale manifest (an id dropped by a cross-process last-writer-wins upsert)
 *  self-heals — we union in any on-disk id the manifest is missing. The common case is a single
 *  readdir + set-membership check (no file reads); recovery only touches ids the manifest lacks. */
export function readManifest(ws: string): Artifact[] {
  const raw = readManifestRaw(ws);
  if (!raw.length) return rebuildArtifactIndex(ws);
  const dir = paths.artifactDir(ws);
  if (!existsSync(dir)) return raw;
  const known = new Set(raw.map((a) => a.id));
  const recovered: Artifact[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || known.has(entry.name)) continue;
    const top = artifactVersions(ws, entry.name).at(-1);
    if (!top) continue;
    const a = readArtifact(ws, `${entry.name}@v${top}`);
    if (a) recovered.push(a);
  }
  if (!recovered.length) return raw;
  const healed = [...raw, ...recovered];
  writeManifest(ws, healed);   // make the heal durable
  return healed;
}

function writeManifest(ws: string, arr: Artifact[]): void {
  mkdirSync(paths.artifactDir(ws), { recursive: true });
  // atomic publish (temp + rename) so a concurrent reader never observes a half-written manifest.
  const dest = manifestPath(ws);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(arr, null, 2));
  renameSync(tmp, dest);
}

/** `a` is always the newest version of its id (saveArtifact only ever appends), so it replaces any
 *  prior manifest entry for that id. Seeds from the canonical scan so a deleted manifest self-heals. */
function upsertManifest(ws: string, a: Artifact): void {
  const cur = readManifest(ws).filter((x) => x.id !== a.id);
  cur.push(a);
  writeManifest(ws, cur);
}

/** Rebuild the manifest by scanning every id dir's latest envelope (files are canon). */
export function rebuildArtifactIndex(ws: string): Artifact[] {
  const dir = paths.artifactDir(ws);
  if (!existsSync(dir)) return [];
  const latest: Artifact[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const top = artifactVersions(ws, entry.name).at(-1);
    if (!top) continue;
    const a = readArtifact(ws, `${entry.name}@v${top}`);
    if (a) latest.push(a);
  }
  writeManifest(ws, latest);
  return latest;
}
