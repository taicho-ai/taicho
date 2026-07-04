import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import {
  estimateTokens,
  estimateMessagesTokens,
  estimateContextTokens,
  modelWindow,
  compactionThreshold,
  compactMessages,
  DEFAULT_WINDOW,
  DEFAULT_COMPACT_AT,
} from "./compaction";

// ── estimator (chars/4 — a gate, not a bill) ──────────────────────────────────────────────────
test("estimateTokens is chars/4, rounded up", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("abcd")).toBe(1);
  expect(estimateTokens("abcde")).toBe(2); // ceil(5/4)
  expect(estimateTokens("x".repeat(400))).toBe(100);
});

test("estimateMessagesTokens sums over serialized content (string + parts)", () => {
  const msgs: ModelMessage[] = [
    { role: "user", content: "abcd" }, // 1
    { role: "assistant", content: [{ type: "text", text: "abcd" }] }, // JSON longer than 4 chars → ≥ 1
  ];
  const n = estimateMessagesTokens(msgs);
  expect(n).toBeGreaterThanOrEqual(2);
});

test("estimateContextTokens adds the system prompt to the messages estimate", () => {
  const msgs: ModelMessage[] = [{ role: "user", content: "abcd" }];
  const withSys = estimateContextTokens("x".repeat(400), msgs); // 100 + 1
  expect(withSys).toBe(100 + estimateMessagesTokens(msgs));
});

// ── per-model window table + threshold (config-disposed) ──────────────────────────────────────
test("modelWindow resolves known models, an OpenRouter slug by substring, and an unknown default", () => {
  expect(modelWindow("claude-sonnet-4-6")).toBe(200_000);
  expect(modelWindow("gpt-5.5")).toBe(400_000);
  expect(modelWindow("anthropic/claude-sonnet-4-6")).toBe(200_000); // vendor/model slug → base model
  expect(modelWindow("some-unknown-model")).toBe(DEFAULT_WINDOW);
  expect(modelWindow(undefined)).toBe(DEFAULT_WINDOW);
});

test("compactionThreshold uses the ~70% default and honors a valid override, clamping bad input", () => {
  expect(compactionThreshold("claude-sonnet-4-6")).toBe(Math.floor(200_000 * DEFAULT_COMPACT_AT));
  expect(compactionThreshold("claude-sonnet-4-6", 0.5)).toBe(100_000);
  expect(compactionThreshold("claude-sonnet-4-6", 0)).toBe(Math.floor(200_000 * DEFAULT_COMPACT_AT));   // invalid → default
  expect(compactionThreshold("claude-sonnet-4-6", 2)).toBe(Math.floor(200_000 * DEFAULT_COMPACT_AT));   // >1 → default
});

test("the unknown-model default window is CONSERVATIVE so it bounds a genuinely-small model", () => {
  // A generous 128k default would let a real 32k model overflow long before its threshold ever tripped.
  // The fallback must be small enough that an unknown model folds BEFORE a plausibly-small real window.
  expect(DEFAULT_WINDOW).toBeLessThanOrEqual(32_000);
  // …and the derived threshold sits below that window, i.e. compaction actually fires first.
  expect(compactionThreshold("some-unknown-32k-slug")).toBeLessThan(DEFAULT_WINDOW);
  // first-party windows are UNCHANGED (the small default is only a fallback, never a downgrade).
  expect(modelWindow("claude-sonnet-4-6")).toBe(200_000);
  expect(modelWindow("gpt-5.5")).toBe(400_000);
});

// ── fold correctness ──────────────────────────────────────────────────────────────────────────
/** One tool round-trip: an assistant message that calls `tool`, then its tool-result message. */
function roundTrip(id: string, tool: string, result: string): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: tool, input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: tool, output: { type: "text", value: result } }] },
  ] as ModelMessage[];
}

const brief: ModelMessage = { role: "user", content: "ORIGINAL_BRIEF: do the thing" };

test("returns null when there is nothing beyond the kept tail to fold", () => {
  const messages = [brief, ...roundTrip("c1", "read_url", "R1"), ...roundTrip("c2", "read_url", "R2")];
  // 2 round-trips, keepTail 2 → nothing to fold
  expect(compactMessages({ messages, keepHead: 1, keepTailRoundTrips: 2 })).toBeNull();
});

test("folds the OLDEST round-trips, keeps head + recent tail verbatim, inserts one summary", () => {
  const messages = [
    brief,
    ...roundTrip("c1", "read_url", "OLDEST_ONE"),
    ...roundTrip("c2", "read_url", "OLD_TWO"),
    ...roundTrip("c3", "save_artifact", "SAVED"),
    ...roundTrip("c4", "read_url", "RECENT_FOUR"),
    ...roundTrip("c5", "read_url", "RECENT_FIVE"),
  ];
  const res = compactMessages({ messages, keepHead: 1, keepTailRoundTrips: 2 });
  expect(res).not.toBeNull();
  const r = res!;

  // head kept verbatim
  expect(r.messages[0]).toBe(brief);
  // one summary message, role user, marked
  expect(r.messages[1].role).toBe("user");
  expect(String(r.messages[1].content)).toContain("[CONTEXT COMPACTION]");
  // recent tail (last 2 round-trips = 4 messages) kept verbatim, in order
  expect(r.messages.slice(2)).toEqual(messages.slice(-4));
  // shape: head(1) + summary(1) + tail(4) = 6 (was 11)
  expect(r.messages.length).toBe(6);

  // summary accounting: folded the first 3 round-trips (6 messages)
  expect(r.summary.foldedRoundTrips).toBe(3);
  expect(r.summary.foldedMessages).toBe(6);
  // tool histogram over the folded region: read_url×2, save_artifact×1
  const hist = Object.fromEntries(r.summary.tools.map((t) => [t.name, t.count]));
  expect(hist.read_url).toBe(2);
  expect(hist.save_artifact).toBe(1);

  // the summary body names the folded tools and surfaces a key result snippet
  expect(r.text).toContain("read_url×2");
  expect(r.text).toContain("OLDEST_ONE");
  // the RECENT results are NOT in the summary (they stayed verbatim in the tail)
  expect(r.text).not.toContain("RECENT_FIVE");
});

test("re-compaction folds a prior summary back in (survives repeated folds)", () => {
  const first = compactMessages({
    messages: [
      brief,
      ...roundTrip("c1", "a", "R1"),
      ...roundTrip("c2", "b", "R2"),
      ...roundTrip("c3", "c", "R3"),
    ],
    keepHead: 1,
    keepTailRoundTrips: 1,
  })!;
  expect(first.summary.foldedRoundTrips).toBe(2);

  // grow again, then fold again — the prior summary (a user message) must re-fold cleanly
  const grown = [...first.messages, ...roundTrip("c4", "d", "R4"), ...roundTrip("c5", "e", "R5")];
  const second = compactMessages({ messages: grown, keepHead: 1, keepTailRoundTrips: 1 });
  expect(second).not.toBeNull();
  const s = second!;
  expect(s.messages[0]).toBe(brief);                       // head still verbatim
  expect(s.messages.slice(2)).toEqual(grown.slice(-2));    // most-recent round-trip kept verbatim
  expect(String(s.messages[1].content)).toContain("[CONTEXT COMPACTION]");
  // folded region = prior summary(1) + round-trips c/d(4) = 5 messages / 3 groups
  expect(s.summary.foldedRoundTrips).toBe(3);
  expect(s.summary.foldedMessages).toBe(5);
  expect(s.text).toContain("c×1");                         // new fold's tool histogram (deterministic)
  // the prior summary text is carried into the new summary's notes (nothing lost silently)
  expect(s.text).toContain("Tools called: a×1, b×1");
});

// ── round-trip invariant guard (never orphan a tool-call/tool-result pairing) ──────────────────
/** True iff every tool-call in `messages` has a matching tool-result and vice versa (same toolCallId). */
function roundTripsPaired(messages: ModelMessage[]): boolean {
  const calls = new Set<string>(), results = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<Record<string, unknown>>) {
      if (typeof p?.toolCallId !== "string") continue;
      if (p.type === "tool-call") calls.add(p.toolCallId);
      else if (p.type === "tool-result") results.add(p.toolCallId);
    }
  }
  return [...calls].every((id) => results.has(id)) && [...results].every((id) => calls.has(id));
}

test("a normal fold NEVER emits an orphaned tool-call/tool-result (round-trips stay paired)", () => {
  const messages = [
    brief,
    ...roundTrip("c1", "read_url", "R1"),
    ...roundTrip("c2", "read_url", "R2"),
    ...roundTrip("c3", "read_url", "R3"),
  ];
  const res = compactMessages({ messages, keepHead: 1, keepTailRoundTrips: 1 })!;
  expect(res).not.toBeNull();
  expect(roundTripsPaired(res.messages)).toBe(true); // c3 kept with its result; c1/c2 folded whole
});

test("compactMessages THROWS if keepHead splits a round-trip (a future caller can't orphan a pairing)", () => {
  // keepHead:2 keeps [brief, assistant(tool-call c1)] verbatim but c1's tool-result falls into the
  // folded region → the head would carry a tool-call with no matching result. The guard refuses it.
  const messages = [
    brief,
    ...roundTrip("c1", "a", "R1"),
    ...roundTrip("c2", "b", "R2"),
    ...roundTrip("c3", "c", "R3"),
  ];
  expect(() => compactMessages({ messages, keepHead: 2, keepTailRoundTrips: 1 })).toThrow(/round-trip invariant/);
});
