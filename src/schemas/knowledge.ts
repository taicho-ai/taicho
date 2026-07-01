import { z } from "zod";

/** A typed, directed edge from one knowledge node to another (stored in the source node's frontmatter). */
export const KbEdge = z.object({
  to: z.string(),                                   // target node id
  rel: z.string().default("relates_to"),            // relates_to|depends_on|part_of|contradicts|derived_from|<free>
  weight: z.number().default(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type KbEdge = z.infer<typeof KbEdge>;

/** A deck (squad-shared) knowledge node — one file per node at kb/nodes/<kb_id>.md
 *  (YAML frontmatter = the node minus `content`, body = the content). Mirrors schemas/policy.ts. */
export const KbNode = z.object({
  id: z.string(),                                   // kb_xxxx
  kind: z.string().default("fact"),                 // fact|entity|decision|doc|... (open vocab)
  title: z.string(),
  summary: z.string().optional(),
  content: z.string(),                              // body of the .md
  source: z.string().optional(),                    // provenance: "agentId:runId" / url
  scope: z.enum(["deck"]).default("deck"),
  edges: z.array(KbEdge).default([]),               // outgoing typed edges
  metadata: z.record(z.string(), z.unknown()).optional(),
  created: z.string().datetime(),
  updated: z.string().datetime().optional(),
});
export type KbNode = z.infer<typeof KbNode>;
