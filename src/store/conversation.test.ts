import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedgerTurn, loadContext, loadLedger, newTurnId, recordContextDecision } from "./conversation";

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
