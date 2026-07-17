import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, mockValues } from "./mock-model";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { ensureWorkspace, paths } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, createAgent, loadAgent } from "../store/roster";
import { makeDeps, executeRun } from "./run";
import { runTeamWorkflow } from "./workflow-run";
import { readArtifact } from "../store/artifacts";
import { loadWorkflowDef } from "../store/workflows";
import type { ApprovalRequest, ApprovalDecision } from "./run";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;
const text = (t: string) =>
  ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
const call = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;

const WF = `---
workflow: brief
version: 1
brief: "make the morning brief"
steps:
  - id: research
    run: "@researcher"
    produces: sources
    brief: "find the sources"
  - id: draft
    run: "@writer"
    consumes: [sources]
    produces: draft
---
`;

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-wfi-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  return { ws, db };
}

test("runTeamWorkflow drives a real two-step workflow through executeRun, producing artifacts in order", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "researcher", role: "researches", identity: "You research." }, "root");
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  mkdirSync(paths.teamDir(ws, "news"), { recursive: true });
  writeFileSync(paths.teamWorkflowFile(ws, "news"), WF);
  await reindex(ws, db);

  // The mock model sequences both agents' turns: researcher writes sources@v1, writer writes draft@v1.
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("write_artifact", { topicSlug: "sources", markdown: "# sources" }), text("done"),
      call("write_artifact", { topicSlug: "draft", markdown: "# draft" }), text("done"),
    ) as any,
  });
  const deps = makeDeps({ ws, db, model });

  const state = await runTeamWorkflow(deps, "news");
  expect(state).not.toBeNull();
  expect(state!.status).toBe("done");
  expect(state!.steps.map((s) => s.status)).toEqual(["done", "done"]);
  expect(state!.steps.find((s) => s.id === "research")!.produced).toBe("sources@v1");
  expect(state!.steps.find((s) => s.id === "draft")!.produced).toBe("draft@v1");
});

test("runTeamWorkflow returns null for a team with no structured workflow", async () => {
  const { ws, db } = await boot();
  const deps = makeDeps({ ws, db, model: new MockLanguageModelV3({ doGenerate: (async () => text("x")) as any }) });
  expect(await runTeamWorkflow(deps, "ghost")).toBeNull();
});

test("root runs a team's workflow through the run_workflow tool, driving it end to end", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "researcher", role: "researches", identity: "You research." }, "root");
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  mkdirSync(paths.teamDir(ws, "news"), { recursive: true });
  writeFileSync(paths.teamWorkflowFile(ws, "news"), WF);
  await reindex(ws, db);

  // root calls run_workflow; inside, researcher then writer run; root then replies.
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("run_workflow", { team: "news" }),
      call("write_artifact", { topicSlug: "sources", markdown: "# s" }), text("done"),
      call("write_artifact", { topicSlug: "draft", markdown: "# d" }), text("done"),
      text("ran the news workflow"),
    ) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "run the news workflow" }], triggeredBy: "user" });
  expect(res.text).toBe("ran the news workflow");
  expect(readArtifact(ws, "draft@v1")).not.toBeNull(); // the workflow really produced the draft
});

const PROPOSE = {
  team: "news", name: "daily-brief",
  steps: [
    { id: "research", run: "@researcher", produces: "sources" },
    { id: "draft", run: "@writer", consumes: ["sources"], produces: "draft" },
  ],
};

test("root proposes a workflow; on the captain's APPROVAL the engine writes it to the team file", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("propose_workflow", PROPOSE), text("proposed it")) as any });
  const approve = async (req: ApprovalRequest): Promise<ApprovalDecision> =>
    req.kind === "propose_workflow" ? { type: "approve" } : { type: "reject" };
  const deps = makeDeps({ ws, db, model, requestApproval: approve });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "set up a daily brief workflow for news" }], triggeredBy: "user" });
  const def = loadWorkflowDef(ws, "news");
  expect(def).not.toBeNull();
  expect(def).toMatchObject({ id: "daily-brief", team: "news" });
  expect(def!.steps.map((s) => s.id)).toEqual(["research", "draft"]);
});

test("root proposes a workflow; on a DECLINE nothing is written (the model never writes canon)", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("propose_workflow", PROPOSE), text("ok")) as any });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "reject" }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "set up a workflow" }], triggeredBy: "user" });
  expect(loadWorkflowDef(ws, "news")).toBeNull(); // declined → no file
});
