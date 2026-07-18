import { z } from "zod";

/** Where an artifact's bytes live. PAYLOAD-AGNOSTIC — the store never interprets the body:
 *  - `file`   — local bytes on disk under artifacts/<id>/ (path is absolute).
 *  - `external` — a locator into a system an MCP server fronts (a Notion page, a ClickUp task, a
 *    URL). Forcing a copy into artifacts/ would be wrong there; the envelope (provenance, versioning,
 *    summary, handle-based hand-off) works identically either way. See reference §5b. */
export const ArtifactLocation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: z.string() }),
  z.object({ kind: z.literal("external"), uri: z.string() }),
]);
export type ArtifactLocation = z.infer<typeof ArtifactLocation>;

/** A structured hand-off artifact — the ENVELOPE only; the body is opaque bytes (or an external
 *  ref). Addressable by a stable logical `id` (a slug shared across versions), versioned and
 *  IMMUTABLE-PER-VERSION (a revision is a new version, never an overwrite). Provenance (producer
 *  agent + run) and lineage (`parents`) give a hand-off graph. Mirrors schemas/knowledge.ts. */
export const Artifact = z.object({
  id: z.string(),                                                     // stable logical id (slug), shared across versions
  version: z.number().int().positive().default(1),                   // increments per revision; (id,version) is immutable
  title: z.string(),
  type: z.string().default("document"),                              // FREE-FORM tag, never an enforced taxonomy
  role: z.enum(["output", "input", "resource"]).default("output"),   // §3c: one store, role-tagged
  producer: z.string(),                                              // agentId that produced it (provenance)
  runId: z.string(),                                                 // run that produced it (provenance)
  parents: z.array(z.string()).default([]),                          // parent artifact handles (lineage)
  summary: z.string().optional(),                                    // summary-first read; never the whole body
  location: ArtifactLocation,                                        // local file OR external ref (payload-agnostic)
  created: z.string().datetime(),
});
export type Artifact = z.infer<typeof Artifact>;

/** Parse a handle: "id" (⇒ latest version) or "id@vN" (⇒ that version). Malformed suffixes fall
 *  back to treating the whole thing as an id (no version), so a stray "@" never throws. */
export function parseHandle(handle: string): { id: string; version?: number } {
  const at = handle.lastIndexOf("@v");
  if (at <= 0) return { id: handle };
  const v = Number(handle.slice(at + 2));
  if (!Number.isInteger(v) || v <= 0) return { id: handle };
  return { id: handle.slice(0, at), version: v };
}

/** The canonical addressable handle for a specific version: "id@vN". */
export function artifactHandle(a: { id: string; version: number }): string {
  return `${a.id}@v${a.version}`;
}
