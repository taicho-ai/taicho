import { test, expect } from "bun:test";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTurn, loadThread, clearThread } from "./thread";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-thread-"));

test("append -> load round-trips", () => {
  const w = ws();
  appendTurn(w, "root", { role: "user", content: "hi" });
  appendTurn(w, "root", { role: "assistant", content: "hello" });
  expect(loadThread(w, "root")).toEqual([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
});

test("load is bounded to the last maxTurns", () => {
  const w = ws();
  for (let i = 0; i < 50; i++) appendTurn(w, "root", { role: "user", content: String(i) });
  const out = loadThread(w, "root", 40);
  expect(out.length).toBe(40);
  expect((out[0] as { content: string }).content).toBe("10");
  expect((out[39] as { content: string }).content).toBe("49");
});

test("corrupt lines are skipped", () => {
  const w = ws();
  appendTurn(w, "root", { role: "user", content: "ok" });
  appendFileSync(join(w, "agents", "root", "thread.jsonl"), "{not json\n");
  appendTurn(w, "root", { role: "user", content: "ok2" });
  expect(loadThread(w, "root").length).toBe(2);
});

test("clear empties the thread", () => {
  const w = ws();
  appendTurn(w, "root", { role: "user", content: "x" });
  clearThread(w, "root");
  expect(loadThread(w, "root")).toEqual([]);
});
