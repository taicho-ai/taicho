import { z } from "zod";

/** A typed, directed edge from one knowledge node to another (stored in the source node's frontmatter). */
export const KbEdge = z.object({
  to: z.string(),                                   // target node id
  rel: z.string().default("relates_to"),            // relates_to|depends_on|part_of|contradicts|derived_from|<free>
  weight: z.number().default(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type KbEdge = z.infer<typeof KbEdge>;

/** Plan 19: the squad-wide scope was spelled "deck" through Plan 18. Accept the legacy value when
 *  parsing an existing kb/nodes/*.md and normalize it to "squad", so a workspace written by an older
 *  taicho still loads. `reconcileKbScope` (store/knowledge.ts, called at boot) rewrites those files
 *  once; this preprocess is what keeps them readable until it does. Ph8 adds "team" to the enum. */
export const KbScope = z
  .preprocess((v) => (v === "deck" ? "squad" : v), z.enum(["squad"]))
  .default("squad");

/** A squad-shared knowledge node — one file per node at kb/nodes/<kb_id>.md
 *  (YAML frontmatter = the node minus `content`, body = the content). Mirrors schemas/policy.ts. */
export const KbNode = z.object({
  id: z.string(),                                   // kb_xxxx
  kind: z.string().default("fact"),                 // fact|entity|decision|doc|... (open vocab)
  title: z.string(),
  summary: z.string().optional(),
  content: z.string(),                              // body of the .md
  source: z.string().optional(),                    // provenance: "agentId:runId" / url
  scope: KbScope,
  edges: z.array(KbEdge).default([]),               // outgoing typed edges
  metadata: z.record(z.string(), z.unknown()).optional(),
  created: z.string().datetime(),
  updated: z.string().datetime().optional(),
});
export type KbNode = z.infer<typeof KbNode>;
