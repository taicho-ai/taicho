/** Plan 01 Ph5 + Plan 05 Ph3 — the engine turn-audit seam, driven through the REAL executeRun.
 *  Proves: the seam fires ONCE per user turn (guarded by triggeredBy === "user", never for children
 *  or ingest runs); boot replay = rolling summary + recent-K tail; the LEDGER stays append-only truth
 *  while the replay shrinks; replay carries handles, not payloads. Models are mocked — NO network. */
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, mockValues } from "./mock-model";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { ensureWorkspace } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, loadAgent, createAgent } from "../store/roster";
import { makeDeps, executeRun } from "./run";
import { loadLedger, loadContext } from "../store/conversation";
import { loadThread } from "../store/thread";
import { readTaskState, taskIdForRun } from "../store/task-state";
import { readArtifact } from "../store/artifacts";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;
const text = (t: string) =>
  ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
const call = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-turnaudit-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  return { ws, db };
}

test("the seam fires once per USER turn — ledger + task, guarded off for children and ingest runs", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("hi")) as any });
  const root = await loadAgent(ws, "root");

  // (1) a user conversation turn ⇒ audited: exactly one user + one assistant ledger turn + a task
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: root, messages: [{ role: "user", content: "hello" }], triggeredBy: "user" });
  const led = loadLedger(ws, "root");
  expect(led.length).toBe(2);
  expect(led[0]).toMatchObject({ role: "user", content: "hello", status: "submitted" });
  expect(led[1]).toMatchObject({ role: "assistant", content: "hi", status: "completed" });
  expect(readTaskState(ws, taskIdForRun(res.runId))?.status).toBe("completed"); // task opened + folded by the seam

  // (2) a DELEGATED child (triggeredBy = a parent run id) is NOT a user turn ⇒ no ledger written
  await executeRun(makeDeps({ ws, db, model }), { agent: root, messages: [{ role: "user", content: "child work" }], triggeredBy: "root/parent-run" });
  expect(loadLedger(ws, "root").length).toBe(2); // unchanged — the child left no ledger turn

  // (3) a /kb-sync ingest run (triggeredBy user but ingestSource set) is maintenance, not a turn
  await executeRun(makeDeps({ ws, db, model }), { agent: root, messages: [{ role: "user", content: "ingest doc" }], triggeredBy: "user", ingestSource: "doc.md@abc" });
  expect(loadLedger(ws, "root").length).toBe(2); // still unchanged — ingest is guarded off
});

test("a failed user turn is recorded in the ledger but EXCLUDED from replay (append-only truth)", async () => {
  const { ws, db } = await boot();
  const failing = new MockLanguageModelV3({ doGenerate: (() => { throw new Error("boom"); }) as any });
  const root = await loadAgent(ws, "root");
  await executeRun(makeDeps({ ws, db, model: failing }), { agent: root, messages: [{ role: "user", content: "do the impossible" }], triggeredBy: "user" });

  const led = loadLedger(ws, "root");
  expect(led.map((t) => t.content)).toContain("do the impossible");           // user turn recorded
  expect(led.some((t) => t.status === "failed" && String(t.content).includes("boom"))).toBe(true); // failed assistant recorded
  const ctx = loadContext(ws, "root");
  expect(ctx.includedTurns).toEqual([]);                                       // nothing safe to replay
  expect(ctx.excludedTurns.length).toBe(2);                                    // both turns excluded
  expect(loadThread(ws, "root")).toEqual([]);                                  // replay cache stays empty
});

test("boot replay = rolling summary + recent-K tail; older turns collapse, the LEDGER is unchanged", async () => {
  const { ws, db } = await boot();
  // deterministic replies per turn; each completed turn is one model call
  const model = new MockLanguageModelV3({ doGenerate: mockValues(text("reply 1"), text("reply 2"), text("reply 3"), text("reply 4")) as any });
  const root = await loadAgent(ws, "root");
  const deps = makeDeps({ ws, db, model, configDefaults: { replayKeepTurns: 2 } });

  for (let i = 1; i <= 4; i++) {
    await executeRun(deps, { agent: root, messages: [{ role: "user", content: `turn ${i}` }], triggeredBy: "user" });
  }

  // LEDGER: append-only truth — all 8 turns (4 user + 4 assistant) survive, uncompacted
  const led = loadLedger(ws, "root");
  expect(led.length).toBe(8);
  expect(led.filter((t) => t.role === "user").map((t) => t.content)).toEqual(["turn 1", "turn 2", "turn 3", "turn 4"]);

  // REPLAY: smaller than the ledger — a rolling summary + only the recent 2 turns verbatim
  const replay = loadThread(ws, "root");
  expect(replay.length).toBe(5);                                     // [summary] + turns 3,4 (4 msgs)
  expect(replay.length).toBeLessThan(led.length);                    // replay shrank; the ledger did not
  expect(String(replay[0].content)).toContain("[CONVERSATION COMPACTION]");
  expect(String(replay[0].content)).toContain("Folded 2 earlier turns"); // turns 1,2 collapsed
  expect(String(replay[0].content)).toContain("turn 1");            // the folded turns live in the summary
  expect(replay.slice(1).map((m) => String(m.content))).toEqual(["turn 3", "reply 3", "turn 4", "reply 4"]);
});

test("the seam writes the summary but the ledger records nothing new — compaction changes replay, not the record", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({ doGenerate: mockValues(text("a"), text("b"), text("c")) as any });
  const root = await loadAgent(ws, "root");
  const deps = makeDeps({ ws, db, model, configDefaults: { replayKeepTurns: 1 } });
  for (let i = 1; i <= 3; i++) await executeRun(deps, { agent: root, messages: [{ role: "user", content: `q${i}` }], triggeredBy: "user" });

  // The summary marker exists ONLY in the derived replay, never in the append-only ledger.
  const ledgerBlob = JSON.stringify(loadLedger(ws, "root"));
  expect(ledgerBlob).not.toContain("[CONVERSATION COMPACTION]");
  expect(String(loadThread(ws, "root")[0].content)).toContain("[CONVERSATION COMPACTION]");
});

test("replayed context carries the artifact HANDLE + summary, never the body", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write.", tools: ["save_artifact"] }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("save_artifact", { id: "dossier", title: "The Dossier", summary: "a short dossier summary", body: "SECRET_BODY_PAYLOAD_MARKER" }),
      text("saved the dossier — see dossier@v1"),
    ) as any,
  });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: writer, messages: [{ role: "user", content: "write me a dossier" }], triggeredBy: "user" });
  expect(res.trace.artifacts).toEqual(["dossier@v1"]);

  const replay = loadThread(ws, "writer");
  const blob = replay.map((m) => String(m.content)).join("\n");
  expect(blob).toContain("dossier@v1");                        // the HANDLE rides replay
  expect(blob).toContain("a short dossier summary");           // ...with its summary
  expect(blob).not.toContain("SECRET_BODY_PAYLOAD_MARKER");    // ...but the body NEVER does
  // the body still lives in the artifact store — replay just references it
  expect(readArtifact(ws, "dossier@v1")).toBeTruthy();
});
