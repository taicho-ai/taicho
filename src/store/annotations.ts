/** Annotations: feedback attached to an artifact VERSION (id@vN). Append-only log per artifact id at
 *  artifacts/<id>/annotations.jsonl — one Annotation JSON per line; the LATEST line per annotation id
 *  wins on read (so resolving/dismissing appends a new record, never rewrites). Same append-only
 *  discipline as the conversation ledger (store/conversation.ts): the file is the truth, reads fold it.
 *
 *  An OPEN annotation is the input to a revision run — run.ts surfaces open annotations under each input
 *  artifact handed to a child; the reviser saves a new version linked back and (optionally) resolves the
 *  annotation against it. A verification verdict (Plan 06) is written here like any other annotation. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Annotation, mkAnnotationId, type AnnotationKind, type AnnotationStatus } from "../schemas/annotation";
import type { VerificationVerdict } from "../schemas/trace";
import { parseHandle, artifactHandle } from "../schemas/artifact";
import { paths } from "./files";
import { readArtifact } from "./artifacts";

function annotationsFile(ws: string, id: string): string {
  return join(paths.artifactDir(ws), id, "annotations.jsonl");
}

/** Resolve a handle to its CONCRETE version handle "id@vN" (bare "id" ⇒ latest); null if absent. */
function pinHandle(ws: string, handle: string): string | null {
  const a = readArtifact(ws, handle);
  return a ? artifactHandle(a) : null;
}

export interface AnnotateInput {
  target: string;                 // artifact handle ("id" ⇒ latest version, or "id@vN")
  author: string;                 // "human" | agentId | "checker"
  body: string;
  kind?: AnnotationKind;
  verdict?: VerificationVerdict;  // Plan 06 hook: a verification verdict IS an annotation
}

/** Attach an annotation to an artifact version. A bare id pins to its LATEST version so the feedback is
 *  anchored to the immutable content it was written about. Throws if the artifact doesn't exist. When a
 *  `verdict` is supplied and no explicit kind is given, the annotation is a `verification`. */
export function annotateArtifact(ws: string, input: AnnotateInput): Annotation {
  const pinned = pinHandle(ws, input.target);
  if (!pinned) throw new Error(`no artifact "${input.target}" to annotate`);
  const { id } = parseHandle(pinned);
  const annotation = Annotation.parse({
    id: mkAnnotationId(),
    target: pinned,
    author: input.author,
    kind: input.kind ?? (input.verdict ? "verification" : "feedback"),
    body: input.body,
    verdict: input.verdict,
    status: "open",
    created: new Date().toISOString(),
  });
  mkdirSync(join(paths.artifactDir(ws), id), { recursive: true });
  appendFileSync(annotationsFile(ws, id), JSON.stringify(annotation) + "\n");
  return annotation;
}

export interface AnnotationFilter {
  status?: AnnotationStatus;
  version?: number;   // restrict to annotations targeting a specific version (also implied by an "id@vN" handle)
}

/** Annotations for an artifact, folded latest-per-annotation-id. A bare `id` returns annotations across
 *  EVERY version; an "id@vN" handle restricts to that version. Newest first. */
export function listAnnotations(ws: string, handle: string, filter: AnnotationFilter = {}): Annotation[] {
  const { id, version } = parseHandle(handle);
  const f = annotationsFile(ws, id);
  if (!existsSync(f)) return [];
  const byId = new Map<string, Annotation>();
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const a = Annotation.parse(JSON.parse(line)); byId.set(a.id, a); } catch { /* skip corrupt audit line */ }
  }
  const wantVersion = version ?? filter.version;
  return [...byId.values()]
    .filter((a) => !filter.status || a.status === filter.status)
    .filter((a) => wantVersion === undefined || parseHandle(a.target).version === wantVersion)
    .sort((x, y) => y.created.localeCompare(x.created));
}

/** One annotation by id (searches across all versions of the artifact). */
export function readAnnotation(ws: string, artifactId: string, annId: string): Annotation | null {
  const { id } = parseHandle(artifactId);
  return listAnnotations(ws, id).find((a) => a.id === annId) ?? null;
}

/** Mark an annotation `addressed` (by a revision handle) or `dismissed`. Appends an updated record —
 *  the append-only log never rewrites, so the original open record is preserved as history. */
export function resolveAnnotation(
  ws: string, artifactId: string, annId: string,
  opts: { status?: "addressed" | "dismissed"; resolvedBy?: string } = {},
): Annotation | null {
  const { id } = parseHandle(artifactId);
  const cur = readAnnotation(ws, id, annId);
  if (!cur) return null;
  const updated = Annotation.parse({ ...cur, status: opts.status ?? "addressed", resolvedBy: opts.resolvedBy ?? cur.resolvedBy });
  appendFileSync(annotationsFile(ws, id), JSON.stringify(updated) + "\n");
  return updated;
}
