import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { compactReplay, buildReplayMessages, rebuildReplayCache } from "./conversation-replay";
import { appendLedgerTurn, recordContextDecision, newTurnId } from "../store/conversation";
import { loadThread } from "../store/thread";
import { saveArtifact } from "../store/artifacts";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-replay-"));

// A conversation is user/assistant pairs; helper builds N verbatim turns.
function turns(n: number): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({ role: "user", content: `user turn ${i}` });
    out.push({ role: "assistant", content: `assistant reply ${i}` });
  }
  return out;
}

test("compactReplay keeps the recent-K turns verbatim and folds older turns into ONE summary", () => {
  const c = compactReplay(turns(5), 2);
  // 5 turns, keep 2 ⇒ fold 3; result = [summary] + turns 4,5 (4 messages) = 5 messages
  expect(c.foldedTurns).toBe(3);
  expect(c.messages.length).toBe(5);
  const summary = c.messages[0];
  expect(summary.role).toBe("user");
  expect(String(summary.content)).toContain("[CONVERSATION COMPACTION]");
  expect(String(summary.content)).toContain("Folded 3 earlier turns");
  // the recent 2 turns are verbatim, in order
  expect(c.messages.slice(1)).toEqual([
    { role: "user", content: "user turn 4" },
    { role: "assistant", content: "assistant reply 4" },
    { role: "user", content: "user turn 5" },
    { role: "assistant", content: "assistant reply 5" },
  ]);
  // the folded turns are represented in the summary (gist), the kept ones are NOT re-summarized
  expect(String(summary.content)).toContain("user turn 1");
  expect(String(summary.content)).not.toContain("user turn 4");
});

test("compactReplay leaves a short conversation untouched (turns <= keep)", () => {
  const input = turns(2);
  const c = compactReplay(input, 2);
  expect(c.foldedTurns).toBe(0);
  expect(c.summaryText).toBeUndefined();
  expect(c.messages).toEqual(input);
});

test("buildReplayMessages reconstructs ONLY the ledger's INCLUDED turns", () => {
  const w = ws();
  const uid = newTurnId("root", "root/r1", "user");
  const aid = newTurnId("root", "root/r1", "assistant");
  const badUid = newTurnId("root", "root/r2", "user");
  appendLedgerTurn(w, "root", { turnId: uid, runId: "root/r1", timestamp: "t", agent: "root", role: "user", content: "keep me", status: "submitted" });
  appendLedgerTurn(w, "root", { turnId: aid, runId: "root/r1", timestamp: "t", agent: "root", role: "assistant", content: "kept reply", status: "completed" });
  appendLedgerTurn(w, "root", { turnId: badUid, runId: "root/r2", timestamp: "t", agent: "root", role: "user", content: "drop me", status: "submitted" });
  recordContextDecision(w, "root", { include: true, turnId: uid, runId: "root/r1", reason: "completed_turn" });
  recordContextDecision(w, "root", { include: true, turnId: aid, runId: "root/r1", reason: "completed_turn" });
  recordContextDecision(w, "root", { include: false, turnId: badUid, runId: "root/r2", reason: "failed_run_not_safe_as_context" });

  const msgs = buildReplayMessages(w, "root");
  expect(msgs).toEqual([
    { role: "user", content: "keep me" },
    { role: "assistant", content: "kept reply" },
  ]);
});

test("replay carries artifact HANDLES + summaries, never the body (Plan 01 Ph5)", () => {
  const w = ws();
  // an assistant turn produced an artifact with a heavy body + a short summary
  saveArtifact(w, { id: "dossier", title: "The Dossier", summary: "a one-line dossier summary", body: "SECRET_BODY_PAYLOAD_MARKER".repeat(50), producer: "root", runId: "root/r1" });
  const uid = newTurnId("root", "root/r1", "user");
  const aid = newTurnId("root", "root/r1", "assistant");
  appendLedgerTurn(w, "root", { turnId: uid, runId: "root/r1", timestamp: "t", agent: "root", role: "user", content: "write the dossier", status: "submitted" });
  appendLedgerTurn(w, "root", { turnId: aid, runId: "root/r1", timestamp: "t", agent: "root", role: "assistant", content: "done, see the handle", status: "completed", artifacts: ["dossier@v1"] });
  recordContextDecision(w, "root", { include: true, turnId: uid, runId: "root/r1", reason: "completed_turn" });
  recordContextDecision(w, "root", { include: true, turnId: aid, runId: "root/r1", reason: "completed_turn" });

  const msgs = buildReplayMessages(w, "root");
  const assistant = String(msgs[1].content);
  expect(assistant).toContain("dossier@v1");                 // the HANDLE rides the replay
  expect(assistant).toContain("a one-line dossier summary"); // ...with its summary
  expect(assistant).not.toContain("SECRET_BODY_PAYLOAD_MARKER"); // ...but NEVER the body
});

test("rebuildReplayCache writes the compacted replay to thread.jsonl (the boot-replay source)", () => {
  const w = ws();
  for (let i = 1; i <= 4; i++) {
    const uid = newTurnId("root", `root/r${i}`, "user");
    const aid = newTurnId("root", `root/r${i}`, "assistant");
    appendLedgerTurn(w, "root", { turnId: uid, runId: `root/r${i}`, timestamp: "t", agent: "root", role: "user", content: `ask ${i}`, status: "submitted" });
    appendLedgerTurn(w, "root", { turnId: aid, runId: `root/r${i}`, timestamp: "t", agent: "root", role: "assistant", content: `reply ${i}`, status: "completed" });
    recordContextDecision(w, "root", { include: true, turnId: uid, runId: `root/r${i}`, reason: "completed_turn" });
    recordContextDecision(w, "root", { include: true, turnId: aid, runId: `root/r${i}`, reason: "completed_turn" });
  }
  const c = rebuildReplayCache(w, "root", { keepRecentTurns: 2 });
  expect(c.foldedTurns).toBe(2);
  const replayed = loadThread(w, "root");        // what boot would replay
  expect(replayed.length).toBe(5);               // [summary] + 2 recent turns verbatim
  expect(String(replayed[0].content)).toContain("[CONVERSATION COMPACTION]");
  expect(String(replayed.at(-1)!.content)).toBe("reply 4");
});
