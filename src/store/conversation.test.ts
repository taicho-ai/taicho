import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { appendLedgerTurn, clearConversation, loadContext, loadLedger, newTurnId, recordContextDecision } from "./conversation";
import { loadThread, writeThread } from "./thread";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-conversation-"));

test("ledger persists failed turns independent of context", () => {
  const w = ws();
  const turnId = newTurnId("root", "root/2026-07-02-run22", "user");
  appendLedgerTurn(w, "root", {
    turnId,
    runId: "root/2026-07-02-run22",
    timestamp: "2026-07-02T16:07:58.180Z",
    agent: "root",
    role: "user",
    content: "do the thing",
    status: "submitted",
  });
  recordContextDecision(w, "root", {
    include: false,
    turnId,
    runId: "root/2026-07-02-run22",
    reason: "failed_run_not_safe_as_context",
  });

  expect(loadLedger(w, "root")[0].content).toBe("do the thing");
  expect(loadContext(w, "root").includedTurns).toEqual([]);
  expect(loadContext(w, "root").excludedTurns[0].turnId).toBe(turnId);
});

test("clearConversation archives the ledger (never deletes truth) and wipes the derived cache", () => {
  const w = ws();
  appendLedgerTurn(w, "root", {
    turnId: newTurnId("root", "root/r1", "user"), runId: "root/r1", timestamp: "2026-07-15T00:00:00.000Z",
    agent: "root", role: "user", content: "old secret question", status: "completed",
  });
  writeThread(w, "root", [{ role: "user", content: "old secret question" }, { role: "assistant", content: "old answer" }]);

  const archive = clearConversation(w, "root", 1_700_000_000_000);

  // The live conversation is empty — no rehydration on the next turn or boot.
  expect(loadLedger(w, "root")).toEqual([]);
  expect(loadThread(w, "root")).toEqual([]);
  expect(loadContext(w, "root").includedTurns).toEqual([]);
  // …but the truth was archived, not destroyed.
  expect(archive).toBe(join(w, "conversations", ".archive", "root-1700000000000"));
  expect(existsSync(archive!)).toBe(true);
  expect(existsSync(join(archive!, "ledger.jsonl"))).toBe(true);
});

test("clearConversation on a fresh workspace is a harmless no-op (nothing to archive)", () => {
  const w = ws();
  expect(clearConversation(w, "root")).toBeNull();
  expect(loadLedger(w, "root")).toEqual([]);
});

test("after clearConversation, a new turn starts a fresh ledger (old turns gone)", () => {
  const w = ws();
  appendLedgerTurn(w, "root", {
    turnId: "t_old", runId: "root/r1", timestamp: "2026-07-15T00:00:00.000Z",
    agent: "root", role: "user", content: "before clear", status: "completed",
  });
  clearConversation(w, "root");
  appendLedgerTurn(w, "root", {
    turnId: "t_new", runId: "root/r2", timestamp: "2026-07-15T01:00:00.000Z",
    agent: "root", role: "user", content: "after clear", status: "completed",
  });
  const ledger = loadLedger(w, "root");
  expect(ledger).toHaveLength(1);
  expect(ledger[0].content).toBe("after clear");
  // the archive parent is inert — it is not a loadable conversation
  expect(readdirSync(join(w, "conversations")).includes(".archive")).toBe(true);
});
