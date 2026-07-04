import { z } from "zod";
import { VerificationVerdict } from "./trace";

/** Feedback attached to a SPECIFIC artifact version. Because the store is immutable-per-version, an
 *  annotation always pins to a concrete handle ("id@vN") — the feedback is anchored to the exact bytes
 *  it was written about. The author may be the human captain, a producing/reviewing agent, or the
 *  delegation checker (Plan 06): a verification verdict is an annotation like any other — it rides in
 *  the optional `verdict` field, so machine feedback and human feedback converge on ONE shape and ONE
 *  revision path.
 *
 *  An OPEN annotation is the input to a REVISION run: run.ts surfaces open annotations under each input
 *  artifact handed to a child, the reviser addresses them and saves a NEW version linked back via
 *  `parents`, and (optionally) resolves the annotation against that revision. Mirrors schemas/policy.ts
 *  (a small typed record with a stable id + status lifecycle). */
export const AnnotationKind = z.enum(["feedback", "verification", "approval"]);
export type AnnotationKind = z.infer<typeof AnnotationKind>;

export const AnnotationStatus = z.enum(["open", "addressed", "dismissed"]);
export type AnnotationStatus = z.infer<typeof AnnotationStatus>;

export const Annotation = z.object({
  id: z.string(),                             // ann_xxxx
  target: z.string(),                         // the artifact handle this annotates — always "id@vN" (a concrete version)
  author: z.string(),                         // "human" | agentId | "checker" — provenance of the feedback
  kind: AnnotationKind.default("feedback"),
  body: z.string(),                           // the feedback text (for a verdict: the reasons, human-readable)
  verdict: VerificationVerdict.optional(),    // Plan 06 hook: a verification verdict IS an annotation
  status: AnnotationStatus.default("open"),
  resolvedBy: z.string().optional(),          // the revision handle "id@vN" that addressed this
  created: z.string().datetime(),
});
export type Annotation = z.infer<typeof Annotation>;

/** A short, collision-resistant annotation id. Mirrors coaching's `pol_`/`ex_` id shape. */
export function mkAnnotationId(): string {
  return `ann_${crypto.randomUUID().slice(0, 8)}`;
}
