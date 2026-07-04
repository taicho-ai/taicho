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
