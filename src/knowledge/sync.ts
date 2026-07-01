/** Hash-sync orchestration: detect changed/deleted source docs (deterministic), then for each changed
 *  doc clear its prior subgraph (by provenance) and re-extract via the injected `ingest`. Detection is
 *  plumbing; extraction is an agent (the librarian) supplied as `ingest`. Idempotent. */
import type { Database } from "bun:sqlite";
import { diffSources, upsertSourceHash, deleteSourceHash } from "../store/sources";
import { forgetNodes } from "../store/knowledge";

export type IngestFn = (path: string, hash: string) => Promise<void>;
export interface SyncSummary { changedDocs: number; deletedDocs: number; removedNodes: number }

export async function syncKnowledgeSources(opts: { ws: string; db: Database; ingest: IngestFn }): Promise<SyncSummary> {
  const { ws, db, ingest } = opts;
  const diff = diffSources(ws, db);
  let removedNodes = 0;

  for (const path of diff.deleted) {
    removedNodes += forgetNodes(ws, db, { sourcePrefix: `${path}@` }).removedNodes;
    deleteSourceHash(db, path);
  }

  for (const src of diff.changed) {
    removedNodes += forgetNodes(ws, db, { sourcePrefix: `${src.path}@` }).removedNodes; // drop old subgraph
    await ingest(src.path, src.hash);                                                    // re-extract
    upsertSourceHash(db, src.path, src.hash);
  }

  return { changedDocs: diff.changed.length, deletedDocs: diff.deleted.length, removedNodes };
}
