import { test, expect } from "bun:test";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { loadThread, writeThread, clearThread } from "./thread";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-thread-"));

test("writeThread -> loadThread round-trips", () => {
  const w = ws();
  writeThread(w, "root", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
  expect(loadThread(w, "root")).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
});

test("load is bounded to the last maxTurns", () => {
  const w = ws();
  const msgs: ModelMessage[] = [];
  for (let i = 0; i < 50; i++) msgs.push({ role: "user", content: String(i) });
  writeThread(w, "root", msgs);
  const out = loadThread(w, "root", 40);
  expect(out.length).toBe(40);
  expect((out[0] as { content: string }).content).toBe("10");
  expect((out[39] as { content: string }).content).toBe("49");
});

// Regression (Plan 05 Ph3 follow-up): the DERIVED replay cache leads with a pinned
// `[CONVERSATION COMPACTION]` summary head. A naive `slice(-maxTurns)` dropped it once the tail exceeded
// the cap, silently losing the entire folded-history summary. loadThread must PIN the head and truncate
// the tail instead.
test("loadThread pins the compaction-summary head when truncating a large replay", () => {
  const w = ws();
  const head: ModelMessage = { role: "user", content: "[CONVERSATION COMPACTION] Folded 5 earlier turns …" };
  const tail: ModelMessage[] = [];
  for (let i = 0; i < 60; i++) tail.push({ role: "user", content: `msg ${i}` }); // tail alone exceeds maxTurns
  writeThread(w, "root", [head, ...tail]);

  const out = loadThread(w, "root", 40);
  expect(out.length).toBe(40);
  expect(String(out[0].content)).toContain("[CONVERSATION COMPACTION]"); // head survives truncation
  expect(String(out.at(-1)!.content)).toBe("msg 59");                    // newest tail kept
  // exactly (maxTurns - 1) tail messages ride along with the pinned head — the OLDEST tail is dropped
  expect(String(out[1].content)).toBe("msg 21");
});

// Regression (PR #27 follow-up, Finding 2): the pinned summary head steals a slot, so a RAW-message tail
// cut can land mid-pair when `1 + 2*replayKeepTurns > maxTurns` — orphaning an assistant reply from its
// user turn as the FIRST replayed tail message. loadThread must slice at a turn (user+assistant PAIR)
// boundary so replay opens on a user turn (or the summary), never a dangling assistant reply.
test("loadThread never opens the tail on a dangling assistant reply (pair-boundary slice)", () => {
  const w = ws();
  const head: ModelMessage = { role: "user", content: "[CONVERSATION COMPACTION] Folded 5 earlier turns …" };
  // 20 user+assistant PAIRS ⇒ 40 tail messages; with the head that's 41 lines > maxTurns=40, so a raw cut
  // drops the OLDEST user msg ("ask 0") and would leave its reply ("reply 0") orphaned at the tail head.
  const tail: ModelMessage[] = [];
  for (let i = 0; i < 20; i++) {
    tail.push({ role: "user", content: `ask ${i}` });
    tail.push({ role: "assistant", content: `reply ${i}` });
  }
  writeThread(w, "root", [head, ...tail]);

  const out = loadThread(w, "root", 40);
  expect(String(out[0].content)).toContain("[CONVERSATION COMPACTION]"); // head still pinned
  expect(out[1].role).toBe("user");                                      // first tail message is a USER turn …
  expect(String(out[1].content)).toBe("ask 1");                          // … "ask 0" + its orphaned reply were dropped
  expect(String(out.at(-1)!.content)).toBe("reply 19");                  // newest tail kept
  expect(out.length).toBeLessThanOrEqual(40);                            // still within the cap
});

test("corrupt lines are skipped", () => {
  const w = ws();
  writeThread(w, "root", [{ role: "user", content: "ok" }, { role: "user", content: "ok2" }]);
  appendFileSync(join(w, "agents", "root", "thread.jsonl"), "{not json\n"); // a truncated/garbled tail line
  expect(loadThread(w, "root").length).toBe(2);
});

test("clear empties the thread", () => {
  const w = ws();
  writeThread(w, "root", [{ role: "user", content: "x" }]);
  clearThread(w, "root");
  expect(loadThread(w, "root")).toEqual([]);
});
