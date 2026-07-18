import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { withPlanSlot, planMarker, PLAN_OPEN, PLAN_CLOSE } from "./plan-inject";
import { compactMessages } from "./compaction";

const convo = (): ModelMessage[] => [
  { role: "user", content: "the original brief" },
  { role: "assistant", content: "on it" },
];

test("no plan ⇒ the message array is returned UNCHANGED (zero tokens, zero overhead)", () => {
  const m = convo();
  expect(withPlanSlot(m, null)).toBe(m);       // identity, not a copy
  expect(withPlanSlot(m, undefined)).toBe(m);
  expect(withPlanSlot(m, "")).toBe(m);         // an empty render is no plan
});

test("the plan is the LAST message the model reads before it acts", () => {
  const out = withPlanSlot(convo(), "[ ] it_0: survey");
  expect(out).toHaveLength(3);
  expect(out[2]!.role).toBe("user");
  expect(out[2]!.content).toContain(PLAN_OPEN);
  expect(out[2]!.content).toContain("[ ] it_0: survey");
  expect(out[2]!.content).toContain(PLAN_CLOSE);
});

test("the slot NEVER enters the caller's message array — context cost is flat, not cumulative", () => {
  const messages = convo();
  // simulate twenty loop iterations, each building its own call messages
  for (let i = 0; i < 20; i++) withPlanSlot(messages, `[ ] it_0: iteration ${i}`);
  expect(messages).toHaveLength(2); // untouched: no growth, no stale plans buried in history
});

test("compaction is orthogonal BY CONSTRUCTION: compactMessages never sees the slot", () => {
  // Build a conversation long enough to fold, exactly as the loop holds it.
  const messages: ModelMessage[] = [{ role: "user", content: "brief" }];
  for (let i = 0; i < 8; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "t", input: {} }] } as ModelMessage);
    messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "t", output: { type: "text", value: "r" } }] } as ModelMessage);
  }
  // The loop compacts `messages`, and separately builds callMessages = withPlanSlot(messages, plan).
  const folded = compactMessages({ messages, keepHead: 1, keepTailRoundTrips: 2 });
  expect(folded).not.toBeNull();
  const all = JSON.stringify(folded!.messages);
  expect(all).not.toContain(PLAN_OPEN); // the plan was never in the array compaction folded

  // and the slot still lands last on the compacted array
  const call = withPlanSlot(folded!.messages, "[ ] it_0: survive");
  expect(call[call.length - 1]!.content).toContain("it_0: survive");
});

test("planMarker delimits the block so the model can tell it from tool output", () => {
  const m = planMarker("body");
  expect(m.startsWith(PLAN_OPEN)).toBe(true);
  expect(m.endsWith(PLAN_CLOSE)).toBe(true);
  expect(m).toContain("engine-owned"); // the marker itself states the rule
});
