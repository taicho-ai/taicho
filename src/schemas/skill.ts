import { z } from "zod";

/** A reusable procedure document — one file per skill at skills/<id>.md
 *  (YAML frontmatter = the skill minus `body`, body = the procedure). Mirrors schemas/policy.ts. */
export const Skill = z.object({
  id: z.string(),                                        // skill_xxxx
  name: z.string(),                                      // short, unique; used by use_skill + display
  description: z.string(),                               // WHEN to use it — drives discovery + injection
  tags: z.array(z.string()).default([]),
  status: z.enum(["active", "draft"]).default("active"), // only `active` are injected/usable
  body: z.string(),                                      // the procedure (markdown)
  created: z.string().datetime(),
  updated: z.string().datetime().optional(),
});
export type Skill = z.infer<typeof Skill>;
