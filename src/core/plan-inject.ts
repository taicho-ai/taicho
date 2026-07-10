/** Plan 18: getting the live plan in front of the model, every iteration, without lying to it.
 *
 *  The hard constraint: `assemble()` is called exactly ONCE per run, before the loop. The system prompt
 *  is a frozen string. A plan placed there is stale after the first iteration — and worse, once the tail
 *  also carries a live plan, the model reads two contradictory ones.
 *
 *  So the live plan NEVER enters the system prompt. What goes there is static instruction — HOW to plan,
 *  that ticks on delegated items are engine-owned — gated on whether the agent holds the plan tools.
 *  Static text, stable tier, fully cacheable. The live state lives in exactly one place: a slot appended
 *  to the message array FOR THE MODEL CALL ONLY.
 *
 *  `planSlot` builds `[...messages, slot]` and hands it to streamText. The slot is never pushed into the
 *  run's own `messages`, which means:
 *
 *    · context cost is FLAT, not cumulative — one plan render per call, not one per iteration
 *    · compaction is orthogonal BY CONSTRUCTION. compactMessages never sees the slot, so no reasoning
 *      about keepHead or compactKeepRecent is required and no future tuning of either can eat the plan
 *    · the prefix cache is untouched: system prompt and message head never change, and the only mutation
 *      is after the cache boundary
 *    · the checkpoint and transcript record the real conversation, not a synthetic message
 *
 *  Cross-turn survival needs no machinery at all: the plan is on disk, and the next turn's pollPlan
 *  loads it and renders the current fold. */
import type { ModelMessage } from "ai";

export const PLAN_OPEN =
  "[CURRENT PLAN — your live checklist, re-read it before you act. Items marked (engine-owned) are " +
  "ticked from a delegated run's REAL outcome; you cannot mark those done yourself.]";
export const PLAN_CLOSE = "[/CURRENT PLAN]";

export function planMarker(text: string): string {
  return `${PLAN_OPEN}\n${text}\n${PLAN_CLOSE}`;
}

/** The messages for ONE model call: the conversation, plus the plan slot when there is a plan.
 *  Returns `messages` unchanged when there is none — an agent without a plan pays zero tokens, zero
 *  store reads, and zero overhead, the same off-by-default discipline as the OTel export. */
export function withPlanSlot(messages: ModelMessage[], planText: string | null | undefined): ModelMessage[] {
  if (!planText) return messages;
  return [...messages, { role: "user", content: planMarker(planText) }];
}

/** The static how-to-plan instruction. Stable tier, so it is part of the cacheable prefix; it says
 *  nothing about the CURRENT plan, only about how to keep one. */
export const PLAN_OPERATING_NOTE =
  `## Keeping a plan\n` +
  `You hold a plan: a checklist the captain watches while you work.\n` +
  `- Open one with write_plan for any goal that takes more than a couple of steps. Give each item a stable id.\n` +
  `- Revise it with write_plan whenever you genuinely change your mind about the SHAPE of the work. Re-writing an identical list costs nothing and mints nothing, so restating it is never an error — but it is never useful either.\n` +
  `- Tick your OWN work with update_plan_item as you finish it.\n` +
  `- When you hand an item to another agent, pass its id as delegate_task(itemId: …). The engine then ticks that item from the child's REAL outcome — and if you also set criteria, only when an independent check agrees. Do not tick those items yourself; the attempt is refused and recorded.\n` +
  `- Abandoning an item is fine: update_plan_item(status: "dropped") with a note saying why. Silently leaving it pending is not.\n` +
  `- The plan is repeated to you before every step. It is the record the captain reads, so keep it true.`;
