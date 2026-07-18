/** Plan 15 — gather all artifacts produced by a conversation's run tree (root + delegated children).
 *  Walks the delegation subtree, collects artifact handles from each run's trace.artifacts and
 *  trace.outputArtifacts, de-dups by id (keep latest version), and returns them ordered by created
 *  desc (latest first). Returns the artifact envelopes (resolved via readArtifact), not the bodies.
 *
 *  (Extracted from the retired trace-tree.ts when the /trace waterfall was removed — Plan 17. This is
 *  the artifact BROWSER's data source, not tracing; trace visualization is OpenTelemetry's job now.) */
import { readTrace } from "../store/trace";
import { readArtifact } from "../store/artifacts";
import { artifactHandle, type Artifact } from "@taicho/contracts/artifact";

export function gatherConversationArtifacts(ws: string, rootRunId: string): Artifact[] {
  const handles = new Set<string>();
  const seen = new Set<string>();

  function walk(runId: string) {
    if (seen.has(runId)) return;
    seen.add(runId);
    const trace = readTrace(ws, runId);
    if (!trace) return;
    // Collect from both artifacts (produced) and outputArtifacts (handed up).
    for (const h of trace.artifacts) handles.add(typeof h === "string" ? h : artifactHandle(h));
    for (const h of trace.outputArtifacts) handles.add(typeof h === "string" ? h : artifactHandle(h));
    // Recurse into delegated children.
    for (const childId of trace.delegatedOut) walk(childId);
  }

  walk(rootRunId);

  // Resolve handles to envelopes, de-dup by id (keep latest version), order by created desc.
  const byId = new Map<string, Artifact>();
  for (const h of handles) {
    const a = readArtifact(ws, h);
    if (!a) continue;
    const existing = byId.get(a.id);
    if (!existing || a.version > existing.version) byId.set(a.id, a);
  }

  return [...byId.values()].sort((x, y) => y.created.localeCompare(x.created));
}
