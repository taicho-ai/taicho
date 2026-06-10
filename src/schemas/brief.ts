import { z } from "zod";

/** Delegation brief — sender writes goal+context; receiver supplies its own identity & policies. */
export const Brief = z.object({
  to: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  from: z.string(),                        // sending agent id
  fromRun: z.string(),
});
export type Brief = z.infer<typeof Brief>;
