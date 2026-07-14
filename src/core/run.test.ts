import { test, expect } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Plan 07: the loop streams every provider, so models are driven via doStream. `./mock-model` is a
// MockLanguageModelV3 that auto-streams a doGenerate script (still recording doGenerateCalls).
import { MockLanguageModelV3, mockValues, simulateReadableStream } from "./mock-model";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { ensureWorkspace, paths } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, loadIndex, loadAgent, createAgent, updateAgent, serializeAgent } from "../store/roster";
import { AgentDef } from "../schemas/agent";
import { makeDeps, executeRun } from "./run";
import { runChecker } from "./verification";
import { makeSpendLedger, readSpendTotals } from "../store/spend-ledger";
import { rollupCosts } from "./costs";
import { readTrace } from "../store/trace";
import { writePolicy, listPolicies } from "../store/policy";
import { PolicyNote } from "../schemas/policy";
import { writeNode } from "../store/knowledge";
import { KbNode } from "../schemas/knowledge";
import { writeSkill } from "../store/skills";
import { Skill } from "../schemas/skill";
import { saveArtifact, readArtifact } from "../store/artifacts";
import { annotateArtifact, listAnnotations } from "../store/annotations";
import { createTeam, loadTeam, teamExists, membersOf } from "../store/teams";
import { foldPlan, latestVersion, readPlanEvents, writePlan, appendPlanEvent } from "../store/plans";
import { toolsForAgent } from "./tools";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;
const text = (t: string) =>
  ({ content: [{ type: "text", text: t }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
const call = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;
// doStream variant for the subscription (Codex) path, which streams instead of doGenerate.
const textStream = (t: string) => (async () => ({
  stream: simulateReadableStream({
    initialDelayInMs: 0, chunkDelayInMs: 0,
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "1" },
      { type: "text-delta", id: "1", delta: t },
      { type: "text-end", id: "1" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ],
  }),
})) as any;

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "taicho-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  return { ws, db };
}

test("worker run writes an immutable artifact and a completed trace", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "write a hello doc" }], triggeredBy: "user" });
  expect(res.text).toBe("done");
  expect(res.trace.outcome).toBe("completed");
  expect(res.trace.artifacts.length).toBe(1);
  // the trace records a resolvable HANDLE (id@vN), not an un-resolvable absolute path
  expect(res.trace.artifacts[0]).toBe("hello@v1");
  expect(readArtifact(ws, res.trace.artifacts[0])!.id).toBe("hello");
  expect(existsSync(join(ws, "runs", "writer", `${res.runId.split("/")[1]}.json`))).toBe(true);
});

test("auto-injects squad knowledge for an agent with `recall` and records it in the trace ledger", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "seeker", role: "seeks", identity: "You seek.", tools: ["recall"] }, "root");
  writeNode(ws, db, KbNode.parse({ id: "kb_seed", title: "Deploy target", content: "we deploy to fly.io", created: new Date().toISOString() }));
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("ok")) as any });
  const deps = makeDeps({ ws, db, model });
  const seeker = await loadAgent(ws, "seeker");
  const res = await executeRun(deps, { agent: seeker, messages: [{ role: "user", content: "how do we deploy the app" }], triggeredBy: "user" });
  expect(res.trace.ledger.knowledge).toContain("kb_seed");                                        // auto-recall recorded it
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(JSON.stringify((model as any).doGenerateCalls[0].prompt)).toContain("Deploy target");    // ...and it reached the model's prompt
});

test("auto-injects an active skill for any agent and records it in the trace ledger", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  writeSkill(ws, db, Skill.parse({
    id: "skill_deploy", name: "deploy-app", description: "how to deploy the app to production",
    tags: ["ops"], status: "active", body: "1. build\n2. push", created: new Date().toISOString(),
  }));
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("ok")) as any });
  const deps = makeDeps({ ws, db, model });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "how do we deploy the app" }], triggeredBy: "user" });
  expect(res.trace.ledger.skills).toContain("skill_deploy");                                         // auto-inject recorded it
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(JSON.stringify((model as any).doGenerateCalls[0].prompt)).toContain("deploy-app");          // ...and it reached the model's prompt
});

test("injects the FULL skill inventory (with a count) even when the query matches none", async () => {
  const { ws, db } = await boot();
  writeSkill(ws, db, Skill.parse({ id: "skill_a", name: "write-clean-artifact", description: "produce a clean document", tags: [], status: "active", body: "x", created: new Date().toISOString() }));
  writeSkill(ws, db, Skill.parse({ id: "skill_b", name: "delegate-well", description: "hand a goal to another agent", tags: [], status: "active", body: "y", created: new Date().toISOString() }));
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("ok")) as any });
  const root = await loadAgent(ws, "root");
  // A meta question with ZERO keyword overlap with either skill — the old keyword-gated inject
  // showed nothing here, so "how many skills do we have" was unanswerable / reported 0.
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: root, messages: [{ role: "user", content: "how many skills do we have?" }], triggeredBy: "user" });
  expect(res.trace.ledger.skills.sort()).toEqual(["skill_a", "skill_b"]); // BOTH injected, not keyword-gated
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prompt = JSON.stringify((model as any).doGenerateCalls[0].prompt);
  expect(prompt).toContain("write-clean-artifact");
  expect(prompt).toContain("delegate-well");
  expect(prompt).toContain("Your skills (2)"); // the count is stated so the agent can answer accurately
});

test("use_skill executes inside a run and the run completes", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  writeSkill(ws, db, Skill.parse({
    id: "skill_deploy", name: "deploy-app", description: "how to deploy the app to production",
    tags: ["ops"], status: "active", body: "1. build\n2. push", created: new Date().toISOString(),
  }));
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("use_skill", { name: "deploy-app" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "deploy the app" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("completed");                                     // the loop continued past the tool call to a final turn
  expect(res.trace.toolCalls.some((t) => t.tool === "use_skill")).toBe(true);      // and use_skill actually executed in the loop
});

test("root create_agent tool persists a worker when approval resolves approve", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("create_agent", { id: "newbie", role: "does X", identity: "You do X." }), text("created")) as any,
  });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "approve" }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "I need an X agent" }], triggeredBy: "user" });
  expect(loadIndex(db).some((r) => r.id === "newbie")).toBe(true);
  expect(await Bun.file(join(ws, "agents", "newbie", "agent.md")).exists()).toBe(true);
  const loaded = await loadAgent(ws, "newbie");
  expect(loaded.identity).toBe("You do X.");
});

test("root create_agent does NOT mutate the registry when approval rejects", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("create_agent", { id: "newbie", role: "does X", identity: "You do X." }), text("ok")) as any,
  });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "reject" }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "I need an X agent" }], triggeredBy: "user" });
  expect(loadIndex(db).some((r) => r.id === "newbie")).toBe(false);
});

// ── Plan 22: the on-the-fly create_team route (approval-gated) ──

test("root create_team tool creates and staffs a team when approval resolves approve", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "reporter", role: "reports", identity: "i" }, "root");
  await createAgent(ws, db, { id: "editor", role: "edits", identity: "i" }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("create_team", { id: "news", charter: "the brief", members: ["reporter", "editor"], lead: "editor" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "approve" }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make the news team" }], triggeredBy: "user" });
  expect(teamExists(ws, "news")).toBe(true);
  expect(membersOf(db, "news").map((m) => m.id)).toEqual(["editor", "reporter"]);
  expect(loadTeam(ws, "news")!.lead).toBe("editor");
  expect((await loadAgent(ws, "reporter")).teams).toEqual(["news"]); // membership landed on the agent
});

test("root create_team does NOT create the team when approval rejects", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "reporter", role: "reports", identity: "i" }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("create_team", { id: "news", charter: "c", members: ["reporter"] }), text("ok")) as any,
  });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "reject" }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make it" }], triggeredBy: "user" });
  expect(teamExists(ws, "news")).toBe(false);
});

test("root create_team cannot grant a tool it does not hold — blocked BEFORE the captain is asked", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "reporter", role: "r", identity: "i" }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("create_team", { id: "news", charter: "c", members: ["reporter"], grant: ["totally_made_up_tool"] }), text("ok")) as any,
  });
  let approvalCalls = 0;
  const deps = makeDeps({ ws, db, model, requestApproval: async () => { approvalCalls++; return { type: "approve" }; } });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make it" }], triggeredBy: "user" });
  expect(teamExists(ws, "news")).toBe(false); // the escalation ceiling stopped it
  expect(approvalCalls).toBe(0);              // and the captain was never even asked
});

// ── Plan 23: team workflows — the lane a member plays under the team it runs for ──

const promptsOf = (model: MockLanguageModelV3) => (model as unknown as { doGenerateCalls: { prompt: unknown }[] }).doGenerateCalls.map((c) => JSON.stringify(c.prompt));

test("a member delegated THROUGH a team gets its workflow lane injected", async () => {
  const { ws, db } = await boot();
  createTeam(ws, { id: "news", charter: "the brief" }); // leadless → routes straight to the member
  await createAgent(ws, db, { id: "reporter", role: "files stories", identity: "You report.", teams: ["news"] }, "root");
  writeFileSync(paths.teamWorkflowFile(ws, "news"), "## reporter\nWF-REPORTER-LANE: draft 400 words, cite sources.\n");
  await reindex(ws, db);

  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("delegate_task", { to: "news", goal: "cover the story" }), text("drafted"), text("done")) as any,
  });
  await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "cover the story" }], triggeredBy: "user" });

  const prompts = promptsOf(model);
  expect(prompts.some((p) => p.includes("WF-REPORTER-LANE"))).toBe(true);          // the lane reached the member
  expect(prompts.some((p) => p.includes("Your role in the news workflow"))).toBe(true);
});

test("the team LEAD gets the orchestration slice (plus its own lane)", async () => {
  const { ws, db } = await boot();
  createTeam(ws, { id: "news", charter: "c", lead: "editor" });
  await createAgent(ws, db, { id: "editor", role: "edits copy", identity: "You edit.", teams: ["news"] }, "root");
  writeFileSync(paths.teamWorkflowFile(ws, "news"), "## orchestration\nWF-ORCH: reporter then editor.\n\n## editor\nWF-EDITOR-LANE: tighten to 250.\n");
  await reindex(ws, db);

  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("delegate_task", { to: "news", goal: "g" }), text("edited"), text("done")) as any,
  });
  await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "g" }], triggeredBy: "user" });

  const prompts = promptsOf(model);
  expect(prompts.some((p) => p.includes("WF-ORCH"))).toBe(true);        // orchestration → the lead
  expect(prompts.some((p) => p.includes("WF-EDITOR-LANE"))).toBe(true); // and its own lane too
});

test("a lead's hand-off to a member by id carries the team context (member gets its lane by inheritance)", async () => {
  const { ws, db } = await boot();
  createTeam(ws, { id: "news", charter: "c", lead: "editor" });
  await createAgent(ws, db, { id: "editor", role: "edits", identity: "You edit.", teams: ["news"], tools: ["delegate_task"] }, "root");
  await createAgent(ws, db, { id: "reporter", role: "reports", identity: "You report.", teams: ["news"] }, "root");
  await updateAgent(ws, db, "editor", { canDelegateTo: ["team:news"] }); // a lead may reach its own people
  writeFileSync(paths.teamWorkflowFile(ws, "news"), "## reporter\nWF-INHERITED-LANE: draft it.\n");
  await reindex(ws, db);

  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("delegate_task", { to: "news", goal: "g" }),        // root → team → editor (the lead)
      call("delegate_task", { to: "reporter", goal: "draft" }), // editor → reporter, a member, BY ID
      text("drafted"),                                          // reporter
      text("edited"),                                           // editor
      text("done"),                                             // root
    ) as any,
  });
  await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "g" }], triggeredBy: "user" });

  // reporter was delegated by id (not through the team) yet still got its lane — viaTeam inherited from the lead.
  expect(promptsOf(model).some((p) => p.includes("WF-INHERITED-LANE"))).toBe(true);
});

test("no workflow file → delegated members run exactly as before (no injection)", async () => {
  const { ws, db } = await boot();
  createTeam(ws, { id: "news", charter: "c" });
  await createAgent(ws, db, { id: "reporter", role: "reports", identity: "You report.", teams: ["news"] }, "root");
  await reindex(ws, db);
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("delegate_task", { to: "news", goal: "g" }), text("drafted"), text("done")) as any,
  });
  await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "g" }], triggeredBy: "user" });
  expect(promptsOf(model).some((p) => p.includes("workflow"))).toBe(false); // nothing workflow-shaped in any prompt
});

test("root's read_workflow returns a team's workflow (read-only) so it can brief the captain", async () => {
  const { ws, db } = await boot();
  createTeam(ws, { id: "news", charter: "c" });
  writeFileSync(paths.teamWorkflowFile(ws, "news"), "## orchestration\nreporter then editor.\n\n## reporter\ndraft it.\n");
  const root = await loadAgent(ws, "root");
  expect(root.tools).toContain("read_workflow"); // root holds it
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = toolsForAgent(root, { ws } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (set.read_workflow as any).execute({ team: "news" });
  expect(res.seats).toContain("reporter");
  expect(res.hasOrchestration).toBe(true);
  expect(res.workflow).toContain("draft it.");
  // a team with no workflow reports so, honestly
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const none = await (set.read_workflow as any).execute({ team: "trading" });
  expect(none.workflow).toBeNull();
  expect(none.note).toContain("no workflow");
});

test("root delegate_task spawns a child run that produces its own trace", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("delegate_task", { to: "writer", goal: "write hello" }), // root step 1
      call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), // child step 1
      text("child done"), // child step 2
      text("root done"),  // root step 2
    ) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make a hello doc" }], triggeredBy: "user" });
  expect(res.text).toBe("root done");
  expect(res.trace.delegatedOut.length).toBe(1);
  const childId = res.trace.delegatedOut[0];
  const child = readTrace(ws, childId);
  expect(child.agent).toBe("writer");
  expect(child.triggeredBy).toBe(res.runId);
  expect(child.artifacts.length).toBe(1);
  // the child's trace hands the parent a resolvable HANDLE (id@vN), not an absolute path
  expect(child.artifacts[0]).toBe("hello@v1");
  expect(readArtifact(ws, child.artifacts[0])!.id).toBe("hello");
});

test("Plan 08 injection guard: a child spawned by a TAINTED parent starts pre-armed (brief-laundering defense)", async () => {
  // Cross-run defense-in-depth: the parent ingests untrusted content (read_artifact), then delegates.
  // The brief it hands down is therefore untrusted, so the child must start with its injection guard
  // ARMED — a run_command in the child is forced to human approval even though the child itself never
  // touched an ingestion tool. We prove it by the approval reason citing the `parent-brief` taint.
  const { ws, db } = await boot();
  saveArtifact(ws, { id: "doc", title: "Doc", type: "report", body: "attacker-controlled body", producer: "x", runId: "x/1" });
  await createAgent(ws, db, { id: "writer", role: "runs", identity: "You run commands.", tools: ["run_command"] }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("read_artifact", { id: "doc", includeBody: true }),        // root step 1: ingest → arms root's guard
      call("delegate_task", { to: "writer", goal: "run a command" }), // root step 2: hand a (now-tainted) brief down
      call("run_command", { command: "echo hi" }),                    // child step 1: gated because pre-armed
      text("child done"),                                             // child step 2
      text("root done"),                                              // root step 3
    ) as any,
  });
  const approvals: Array<{ kind: string; reason?: string }> = [];
  const deps = makeDeps({ ws, db, model, requestApproval: async (r) => { approvals.push(r as { kind: string; reason?: string }); return { type: "reject" }; } });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "read the doc then have writer run a command" }], triggeredBy: "user" });
  const cmdApproval = approvals.find((a) => a.kind === "run_command");
  expect(cmdApproval).toBeDefined();
  expect(cmdApproval!.reason).toMatch(/parent-brief/);        // the child inherited the parent's taint
  expect(cmdApproval!.reason).toMatch(/untrusted content.*injection/i);
});

test("Plan 08 injection guard: a child of an UNtainted parent is NOT pre-armed (control)", async () => {
  // Same shape, but the parent ingests nothing before delegating — so the child's run_command approval
  // (forced here only because dcg is unavailable in tests) must NOT cite the parent-brief taint.
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "runs", identity: "You run commands.", tools: ["run_command"] }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("delegate_task", { to: "writer", goal: "run a command" }), // root: no ingestion first
      call("run_command", { command: "echo hi" }),                    // child
      text("child done"),
      text("root done"),
    ) as any,
  });
  const approvals: Array<{ kind: string; reason?: string }> = [];
  const deps = makeDeps({ ws, db, model, requestApproval: async (r) => { approvals.push(r as { kind: string; reason?: string }); return { type: "reject" }; } });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "have writer run a command" }], triggeredBy: "user" });
  const cmdApproval = approvals.find((a) => a.kind === "run_command");
  expect(cmdApproval).toBeDefined();                        // still asks (dcg unavailable in tests)
  expect(cmdApproval!.reason ?? "").not.toMatch(/parent-brief/); // …but NOT because of an inherited taint
});

test("an agent whose iteration budget is exhausted yields a blocked-outcome trace", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const loopy = await loadAgent(ws, "writer");
  loopy.budgets.maxIterationsPerRun = 2;
  const model = new MockLanguageModelV3({
    doGenerate: (async () => call("write_artifact", { topicSlug: "x", markdown: "y" })) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const res = await executeRun(deps, { agent: loopy, messages: [{ role: "user", content: "loop forever" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("blocked");
});

test("a thrown model error yields a failed-outcome trace", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({ doGenerate: (() => { throw new Error("boom"); }) as any });
  const deps = makeDeps({ ws, db, model });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("failed");
  expect(res.text).toContain("boom");
  const dir = paths.runRecordDir(ws, res.runId);
  expect(existsSync(join(dir, "input.json"))).toBe(true);
  expect(readFileSync(join(dir, "failure.md"), "utf8")).toContain("boom");
  expect(readFileSync(join(dir, "transcript.jsonl"), "utf8")).toContain("model_error");
});

test("delegate_task is denied when the caller's ACL forbids the target", async () => {
  const { ws, db } = await boot();
  // worker seeded with canDelegateTo:[] (default) but given the delegate_task tool
  await createAgent(ws, db, { id: "limited", role: "limited", identity: "You delegate.", tools: ["delegate_task"] }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("delegate_task", { to: "root", goal: "x" }), text("ok")) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const limited = await loadAgent(ws, "limited");
  const res = await executeRun(deps, { agent: limited, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut.length).toBe(0); // ACL blocked the delegation
  expect(res.text).toBe("ok");
});

test("records real tokens + cost on a completed run", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.tokens).toBeGreaterThan(0);
  expect(res.trace.costUsd).toBeGreaterThan(0);
});

test("a token-capped run ends blocked with non-zero tokens", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const loopy = await loadAgent(ws, "writer");
  loopy.budgets.maxTokensPerRun = 1;
  const model = new MockLanguageModelV3({ doGenerate: (async () => call("write_artifact", { topicSlug: "x", markdown: "y" })) as any });
  const deps = makeDeps({ ws, db, model });
  const res = await executeRun(deps, { agent: loopy, messages: [{ role: "user", content: "loop" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("blocked");
  expect(res.trace.tokens).toBeGreaterThan(0);
  expect((model as any).doGenerateCalls.length).toBe(1); // token cap stopped it after 1 call, not the 30-iteration cap
});

test("an aborted run is interrupted with partial tokens recorded", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const controller = new AbortController();
  controller.abort();
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const deps = makeDeps({ ws, db, model, signal: controller.signal });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("interrupted");
});

test("a model error is failed with partial tokens, not tokens:0", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  let n = 0;
  const model = new MockLanguageModelV3({ doGenerate: (async () => { if (n++ === 0) return call("write_artifact", { topicSlug: "x", markdown: "y" }); throw new Error("boom"); }) as any });
  const deps = makeDeps({ ws, db, model });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("failed");
  expect(res.text).toContain("boom");
  expect(res.trace.tokens).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Phase 1 Task 4: delegation safety guards
// ---------------------------------------------------------------------------

function putAgent(ws: string, db: import("bun:sqlite").Database, def: Record<string, unknown>) {
  const agent = AgentDef.parse({ created: new Date().toISOString(), ...def });
  mkdirSync(paths.agentDir(ws, agent.id), { recursive: true });
  writeFileSync(paths.agentFile(ws, agent.id), serializeAgent(agent));
  db.query("INSERT OR REPLACE INTO registry (id, role, is_root) VALUES (?, ?, ?)").run(agent.id, agent.role, agent.isRoot ? 1 : 0);
  return agent;
}

test("self-delegation terminates at the depth cap (no stack blowup) and the run completes", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "loopy", role: "loops", identity: "Delegate to loopy.", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 1, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: (async () => call("delegate_task", { to: "loopy", goal: "again" })) as any });
  const deps = makeDeps({ ws, db, model });
  const loopy = await loadAgent(ws, "loopy");
  const res = await executeRun(deps, { agent: loopy, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.runId).toBeTruthy(); // terminates
});

test("a direct cycle (a already in ancestry) is refused with a note", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "a", role: "a", identity: "x", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("delegate_task", { to: "a", goal: "self" }), text("ok")) as any });
  const deps = makeDeps({ ws, db, model });
  const a = await loadAgent(ws, "a");
  const res = await executeRun(deps, { agent: a, messages: [{ role: "user", content: "go" }], triggeredBy: "user", ancestry: ["a"] });
  expect(res.trace.delegatedOut.length).toBe(0);
  expect(res.trace.notes.some((n) => /cycle|depth|delegat/i.test(n))).toBe(true);
});

test("work-item budget caps delegate fan-out within one run", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "leaf", role: "leaf", identity: "done", tools: [], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "boss", role: "boss", identity: "delegate a lot", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 10, maxWorkItemsPerRequest: 1 } });
  // boss delegates twice; the 2nd exceeds maxWorkItemsPerRequest=1. leaf just returns text.
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "leaf", goal: "one" }),
    text("leaf one done"),
    call("delegate_task", { to: "leaf", goal: "two" }),
    text("boss done"),
  ) as any });
  const deps = makeDeps({ ws, db, model });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(deps, { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.notes.some((n) => /work item/i.test(n))).toBe(true);
  expect(res.trace.delegatedOut.length).toBe(1); // only the first (allowed) delegation spawned a child
});

test("a delegating run's aggregate includes child spend", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "writer", goal: "write hello" }), // root
    call("write_artifact", { topicSlug: "hello", markdown: "# Hi" }), // child
    text("child done"), // child
    text("root done"),  // root
  ) as any });
  const deps = makeDeps({ ws, db, model, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make a hello doc" }], triggeredBy: "user" });
  const childId = res.trace.delegatedOut[0];
  const child = readTrace(ws, childId);
  expect(res.trace.aggregate).toBeTruthy();
  expect(res.trace.verification.length).toBe(0);                              // no criteria ⇒ no checker call ⇒ zero verifier spend
  expect(res.trace.aggregate!.tokens).toBe(res.trace.tokens + child.tokens); // exact: own loop + child run, no verifier, no double-count
});

test("delegation is refused once the per-request run ceiling is hit", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "a", role: "a", identity: "x", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "b", role: "b", identity: "leaf", tools: [], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  // a tries to delegate to b, but the run counter is already at the 50 ceiling
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("delegate_task", { to: "b", goal: "x" }), text("ok")) as any });
  const deps = makeDeps({ ws, db, model, runCounter: { n: 50 } });
  const a = await loadAgent(ws, "a");
  const res = await executeRun(deps, { agent: a, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut.length).toBe(0);
  expect(res.trace.notes.some((n) => /max runs per request/i.test(n))).toBe(true);
});

test("aborting cancels an in-flight child run too (cascade), both interrupted", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "p", role: "parent", identity: "delegate", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "c", role: "child", identity: "work", tools: ["write_artifact"], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const controller = new AbortController();
  let n = 0;
  const model = new MockLanguageModelV3({ doGenerate: (async () => {
    n++;
    if (n === 1) return call("delegate_task", { to: "c", goal: "x" }); // parent delegates
    if (n === 2) { controller.abort(); return call("write_artifact", { topicSlug: "x", markdown: "y" }); } // child's 1st call; abort now
    return text("unreached");
  }) as any });
  const deps = makeDeps({ ws, db, model, signal: controller.signal });
  const p = await loadAgent(ws, "p");
  const res = await executeRun(deps, { agent: p, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("interrupted");          // parent interrupted
  expect(res.trace.delegatedOut.length).toBe(1);
  const child = readTrace(ws, res.trace.delegatedOut[0]);
  expect(child.outcome).toBe("interrupted");              // child interrupted via the shared signal
});

test("aggregate sums the whole run-tree exactly (root + mid + leaf)", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "r2", role: "root2", identity: "delegate", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "mid", role: "mid", identity: "delegate", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "leaf", role: "leaf", identity: "work", tools: ["write_artifact"], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "mid", goal: "x" }),  // r2 step1
    call("delegate_task", { to: "leaf", goal: "y" }), // mid step1
    call("write_artifact", { topicSlug: "z", markdown: "w" }), // leaf step1
    text("leaf done"),  // leaf step2
    text("mid done"),   // mid step2
    text("root done"),  // r2 step2
  ) as any });
  const deps = makeDeps({ ws, db, model, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  const r2 = await loadAgent(ws, "r2");
  const res = await executeRun(deps, { agent: r2, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  const midId = res.trace.delegatedOut[0];
  const mid = readTrace(ws, midId);
  const leafId = mid.delegatedOut[0];
  const leaf = readTrace(ws, leafId);
  expect(res.trace.verification.length).toBe(0);                                         // no criteria anywhere ⇒ no verifier spend in the tree
  expect(res.trace.aggregate!.tokens).toBe(res.trace.tokens + mid.tokens + leaf.tokens); // exact tree sum, no double-count
});

test("a per-agent resolveModel makes an agent run its own model", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const writerModel = new MockLanguageModelV3({ doGenerate: (async () => text("writer ran")) as any });
  const otherModel = new MockLanguageModelV3({ doGenerate: (async () => text("other ran")) as any });
  const deps = makeDeps({ ws, db, model: otherModel,
    resolveModel: (id: string) => id === "writer" ? { model: writerModel, modelId: "writer-model" } : { model: otherModel, modelId: "other-model" },
  });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.text).toBe("writer ran");
  expect((writerModel as any).doGenerateCalls.length).toBe(1);
  expect((otherModel as any).doGenerateCalls.length).toBe(0);
});

test("per-agent pricer reflects each agent's resolved model price", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "cheap", role: "x", identity: "x" }, "root");
  await createAgent(ws, db, { id: "pricey", role: "x", identity: "x" }, "root");
  const mk = () => new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const resolveModel = (id: string) => id === "pricey"
    ? { model: mk(), modelId: "claude-opus-4-8" }
    : { model: mk(), modelId: "claude-sonnet-4-6" };
  const cheap = await loadAgent(ws, "cheap");
  const pricey = await loadAgent(ws, "pricey");
  const cheapRes = await executeRun(makeDeps({ ws, db, model: mk(), resolveModel }), { agent: cheap, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  const priceyRes = await executeRun(makeDeps({ ws, db, model: mk(), resolveModel }), { agent: pricey, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(cheapRes.trace.costUsd).toBeGreaterThan(0);
  expect(priceyRes.trace.costUsd!).toBeGreaterThan(cheapRes.trace.costUsd!); // opus prices higher than sonnet for identical usage
});

test("a subscription-backed run records costUsd null + costNote, tokens still counted", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "sub", role: "x", identity: "x" }, "root");
  // subscription:true ⇒ Codex backend ⇒ streaming path, so the mock must serve doStream.
  const model = new MockLanguageModelV3({ doStream: textStream("done") });
  const deps = makeDeps({ ws, db, model, resolveModel: () => ({ model, modelId: "gpt-5.5", subscription: true }) });
  const sub = await loadAgent(ws, "sub");
  const res = await executeRun(deps, { agent: sub, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.trace.costUsd).toBeNull();
  expect(res.trace.costNote).toBe("subscription");
  expect(res.trace.tokens).toBeGreaterThan(0);
});

test("create_agent applies an edited draft when approval returns edit", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("create_agent", { id: "newbie", role: "orig role", identity: "orig" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "edit", draft: { role: "edited role" } }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  const created = await loadAgent(ws, "newbie");
  expect(created.role).toBe("edited role");
});

test("a worker's later run sees a recent-runs digest of its earlier runs", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const writer = await loadAgent(ws, "writer");
  const m1 = new MockLanguageModelV3({ doGenerate: mockValues(call("write_artifact", { topicSlug: "rep", markdown: "# r" }), text("done1")) as any });
  await executeRun(makeDeps({ ws, db, model: m1 }), { agent: writer, messages: [{ role: "user", content: "do x" }], triggeredBy: "user" });
  const m2 = new MockLanguageModelV3({ doGenerate: (async () => text("done2")) as any });
  await executeRun(makeDeps({ ws, db, model: m2 }), { agent: writer, messages: [{ role: "user", content: "do y" }], triggeredBy: "user" });
  expect(JSON.stringify((m2 as { doGenerateCalls: unknown[] }).doGenerateCalls[0])).toContain("Your recent runs");
});

const policy = (over: Record<string, unknown>) => PolicyNote.parse({ id: "pol_x", agent: "writer", when: "always", do: "cite your sources", scope: "agent", status: "approved", taughtBy: "user", created: "2026-06-11T00:00:00.000Z", ...over });

test("approved policies are injected into the run prompt and recorded in the ledger", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  writePolicy(ws, policy({ id: "pol_a", do: "cite your sources" }));
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(JSON.stringify((model as { doGenerateCalls: unknown[] }).doGenerateCalls[0])).toContain("cite your sources");
  expect(res.trace.ledger.applied).toContain("pol_a");
});

test("proposed (non-approved) notes are NOT injected", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  writePolicy(ws, policy({ id: "pol_p", do: "DRAFT NOT APPROVED", status: "proposed" }));
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(JSON.stringify((model as { doGenerateCalls: unknown[] }).doGenerateCalls[0])).not.toContain("DRAFT NOT APPROVED");
  expect(res.trace.ledger.applied).not.toContain("pol_p");
});

test("a global-scope note authored on one agent reaches another agent's run", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "a", role: "x", identity: "x" }, "root");
  await createAgent(ws, db, { id: "b", role: "y", identity: "y" }, "root");
  writePolicy(ws, policy({ id: "pol_g", agent: "a", do: "be concise globally", scope: "global" }));
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const b = await loadAgent(ws, "b");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: b, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(JSON.stringify((model as { doGenerateCalls: unknown[] }).doGenerateCalls[0])).toContain("be concise globally");
  expect(res.trace.ledger.applied).toContain("pol_g");
});

// ---------------------------------------------------------------------------
// Plan 01 Phase 3: hand-off by reference (delegate_task inputArtifacts / outputArtifacts)
// ---------------------------------------------------------------------------

test("delegate_task passes input artifacts to the child BY REFERENCE (handles+summary in prompt, body NOT inlined)", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  // a pre-existing artifact the root will hand down
  saveArtifact(ws, { id: "research-foo", title: "Foo dossier", type: "dossier", summary: "the short summary of foo", body: "THE ENORMOUS RESEARCH BODY", producer: "root", runId: "root/seed" });
  const childModel = new MockLanguageModelV3({ doGenerate: (async () => text("wrote it")) as any });
  const rootModel = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "writer", goal: "write from the dossier", inputArtifacts: ["research-foo"] }),
    text("root done"),
  ) as any });
  // route the child to its own model so we can inspect the child's prompt
  const deps = makeDeps({ ws, db, model: rootModel, resolveModel: (id) => id === "writer" ? { model: childModel, modelId: "m" } : { model: rootModel, modelId: "m" } });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make it" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut.length).toBe(1);
  expect(res.trace.inputArtifacts).toEqual(["research-foo"]); // hand-off graph: handle sent down
  // the CHILD's prompt carries the handle + summary, but NOT the enormous body (that's the whole point)
  const childPrompt = JSON.stringify((childModel as any).doGenerateCalls[0].prompt);
  expect(childPrompt).toContain("research-foo@v1");
  expect(childPrompt).toContain("the short summary of foo");
  expect(childPrompt).not.toContain("THE ENORMOUS RESEARCH BODY");
});

test("a child's produced artifacts flow back to the parent as outputArtifacts (handles, not the body)", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write.", tools: ["save_artifact"] }, "root");
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "writer", goal: "produce a script" }),          // root
    call("save_artifact", { title: "Script", type: "script", summary: "a 30s script", body: "SCENE 1..." }), // child
    text("saved the script"),                                                   // child
    text("root done"),                                                          // root
  ) as any });
  const deps = makeDeps({ ws, db, model });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "make a script" }], triggeredBy: "user" });
  // parent trace records the hand-off graph
  expect(res.trace.outputArtifacts).toEqual(["script@v1"]);
  const child = readTrace(ws, res.trace.delegatedOut[0]);
  expect(child.artifacts).toEqual(["script@v1"]);              // child produced it (handle)
  expect(child.outputArtifacts).toEqual([]);                   // child delegated to no one
  // the artifact really exists in the store with the child's provenance
  const art = readArtifact(ws, "script@v1")!;
  expect(art.producer).toBe("writer");
  expect(art.type).toBe("script");
});

test("delegate_task drops an unknown input artifact handle with a note (never passes a dead ref)", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "writer", goal: "x", inputArtifacts: ["ghost@v1"] }),
    text("root done"),
  ) as any });
  const deps = makeDeps({ ws, db, model });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut.length).toBe(1);               // delegation still happens
  expect(res.trace.inputArtifacts).toEqual([]);                // the dead ref was dropped, not passed
  expect(res.trace.notes.some((n) => /dropped unknown input artifact/i.test(n))).toBe(true);
});

// ---------------------------------------------------------------------------
// Plan 01 Phase 4: feedback & revision — open annotations ride an input artifact into a revision run.
// ---------------------------------------------------------------------------

test("open annotations on an input artifact become a REVISION brief in the child's prompt (annotation → revision path)", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  saveArtifact(ws, { id: "dossier", title: "Dossier", type: "dossier", summary: "the short summary", body: "THE ENORMOUS BODY", producer: "root", runId: "root/seed" });
  // human feedback + a machine verdict (Plan 06) — both are annotations, both must ride along.
  annotateArtifact(ws, { target: "dossier@v1", author: "human", body: "add dates to every source" });
  annotateArtifact(ws, { target: "dossier@v1", author: "checker", body: "verification", verdict: { pass: false, reasons: ["two sources are undated"] } });
  const childModel = new MockLanguageModelV3({ doGenerate: (async () => text("revised")) as any });
  const rootModel = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "writer", goal: "revise the dossier", inputArtifacts: ["dossier@v1"] }),
    text("root done"),
  ) as any });
  const deps = makeDeps({ ws, db, model: rootModel, resolveModel: (id) => id === "writer" ? { model: childModel, modelId: "m" } : { model: rootModel, modelId: "m" } });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "fix it" }], triggeredBy: "user" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const childPrompt = JSON.stringify((childModel as any).doGenerateCalls[0].prompt);
  expect(childPrompt).toContain("add dates to every source");   // human feedback surfaced
  expect(childPrompt).toContain("two sources are undated");      // verdict reasons surfaced
  expect(childPrompt).toContain("REVISION");                     // the child is told this is a revision
  expect(childPrompt).not.toContain("THE ENORMOUS BODY");        // still BY REFERENCE — body never inlined
});

test("create_agent honors an edited identity, not just role", async () => {
  const { ws, db } = await boot();
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("create_agent", { id: "newbie", role: "r", identity: "original soul" }), text("done")) as any });
  const deps = makeDeps({ ws, db, model, requestApproval: async () => ({ type: "edit", draft: { identity: "EDITED SOUL" } }) });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect((await loadAgent(ws, "newbie")).identity).toBe("EDITED SOUL");
});

// ---------------------------------------------------------------------------
// Plan 06 — Delegation verification (acceptance criteria + independent checker + one retry)
// ---------------------------------------------------------------------------

/** boss delegates; worker does the work. Both have generous budgets unless overridden. */
function bossAndWorker(ws: string, db: import("bun:sqlite").Database, over: { workItems?: number } = {}) {
  putAgent(ws, db, { id: "boss", role: "boss", identity: "You delegate.", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 10, maxWorkItemsPerRequest: over.workItems ?? 20 } });
  putAgent(ws, db, { id: "worker", role: "worker", identity: "You work.", tools: [], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
}

test("delegation WITHOUT criteria skips the checker — no extra model call, no verdict recorded", async () => {
  const { ws, db } = await boot();
  bossAndWorker(ws, db);
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "do X" }), // boss step 1 (no criteria)
    text("worker result"),                                  // worker
    text("boss done"),                                      // boss step 2
  ) as any });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.text).toBe("boss done");
  expect(res.trace.delegatedOut.length).toBe(1);
  expect(res.trace.verification.length).toBe(0);                 // no criteria ⇒ no check ⇒ today's behavior
  expect((model as any).doGenerateCalls.length).toBe(3);         // delegate + worker + boss final — NO checker call (zero cost when unused)
});

test("criteria that first fails → one independent retry with the verdict as feedback → passes", async () => {
  const { ws, db } = await boot();
  bossAndWorker(ws, db);
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" }), // boss
    text("attempt one, no Y"),                                    // worker (1st)
    text('{"pass": false, "reasons": ["missing Y"]}'),           // checker (1st) — independent model call
    text("attempt two, mentions Y"),                             // worker (retry)
    text('{"pass": true, "reasons": []}'),                       // checker (2nd)
    text("boss done"),                                           // boss final
  ) as any });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.text).toBe("boss done");
  expect(res.trace.delegatedOut.length).toBe(2);                 // initial + exactly one retry
  expect(res.trace.verification.length).toBe(2);
  expect(res.trace.verification[0]).toMatchObject({ retried: false });
  expect(res.trace.verification[0].verdict.pass).toBe(false);
  expect(res.trace.verification[1]).toMatchObject({ retried: true });
  expect(res.trace.verification[1].verdict.pass).toBe(true);
  // the retry child's brief carried the failed verdict's reasons as feedback
  const retryChildId = res.trace.delegatedOut[1];
  const retryInput = readFileSync(join(paths.runRecordDir(ws, retryChildId), "input.json"), "utf8");
  expect(retryInput).toContain("missing Y");
});

test("criteria that fails twice surfaces the result WITH the failed verdict attached (not a silent lie)", async () => {
  const { ws, db } = await boot();
  bossAndWorker(ws, db);
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" }),
    text("attempt one"),
    text('{"pass": false, "reasons": ["missing Y"]}'),
    text("attempt two"),
    text('{"pass": false, "reasons": ["still missing Y"]}'),
    text("boss done"),
  ) as any });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut.length).toBe(2);                 // one retry, then it stops (no second retry)
  expect(res.trace.verification.length).toBe(2);
  expect(res.trace.verification.every((v) => v.verdict.pass === false)).toBe(true);
  expect(res.trace.verification[1].retried).toBe(true);
  expect(res.trace.verification[1].verdict.reasons.join(" ")).toContain("still missing Y");
  // recorded in the transcript too (the ledger answer to "why did it retry?")
  const tr = readFileSync(join(paths.runRecordDir(ws, res.runId), "transcript.jsonl"), "utf8");
  expect(tr).toContain("verification");
  expect(tr).toContain("still missing Y");
});

test("Plan 20: checker OUTAGE ⇒ no retry, result surfaces UNVERIFIED with checkerError on the record", async () => {
  const { ws, db } = await boot();
  bossAndWorker(ws, db);
  // Content-branching mock (order-independent, survives SDK-level retries of the throwing call):
  // the checker is the only prompt carrying VERIFIER_SYSTEM's "impartial acceptance checker".
  const model = new MockLanguageModelV3({
    doGenerate: (async (opts: { prompt: unknown }) => {
      const prompt = JSON.stringify(opts.prompt);
      if (prompt.includes("impartial acceptance checker")) throw Object.assign(new Error("provider down"), { code: "ECONNREFUSED" });
      if (prompt.includes("You work.")) return text("worker output");            // the child
      if (prompt.includes("checker unavailable")) return text("boss done");      // boss, after the tool result came back
      return call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" });
    }) as any,
  });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.text).toBe("boss done");
  expect(res.trace.delegatedOut.length).toBe(1);                 // the child ran ONCE — no pointless retry against a down judge
  expect(res.trace.verification.length).toBe(1);
  expect(res.trace.verification[0].checkerError).toBe(true);
  expect(res.trace.verification[0].retried).toBe(false);
  expect(res.trace.verification[0].verdict.pass).toBe(false);
  expect(res.trace.verification[0].verdict.reasons.join(" ")).toContain("checker unavailable");
});

test("a FAILED verdict annotates only the child's LATEST output version — a same-id multi-save doesn't smear (PR #20)", async () => {
  const { ws, db } = await boot();
  // workItems:1 ⇒ the failing check's retry is refused, so exactly one child run (which saves the same
  // id TWICE → out@v1, out@v2) and one verdict. The FAIL must anchor to out@v2 only, never smear onto v1.
  putAgent(ws, db, { id: "boss", role: "boss", identity: "You delegate.", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 10, maxWorkItemsPerRequest: 1 } });
  putAgent(ws, db, { id: "worker", role: "worker", identity: "You write.", tools: ["save_artifact"], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Z" }), // boss (no retry: workItems=1)
    call("save_artifact", { id: "out", title: "Out", body: "draft one" }),                 // worker → out@v1
    call("save_artifact", { id: "out", title: "Out", body: "draft two" }),                 // worker → out@v2 (SAME id)
    text("worker done"),                                                                    // worker final
    text('{"pass": false, "reasons": ["missing Z"]}'),                                      // checker → FAIL
    text("boss done"),                                                                      // boss final
  ) as any });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.verification.length).toBe(1);
  expect(res.trace.verification[0].verdict.pass).toBe(false);
  // the child produced both out@v1 and out@v2 (proving the multi-save setup is real)…
  const worker = readTrace(ws, res.trace.delegatedOut[0]);
  expect(worker.artifacts).toEqual(["out@v1", "out@v2"]);
  // …but the FAIL lands on the LATEST version ONLY — the checker judged the final output, not the draft.
  const v2 = listAnnotations(ws, "out@v2");
  expect(v2.length).toBe(1);
  expect(v2[0].kind).toBe("verification");
  expect(v2[0].verdict?.pass).toBe(false);
  expect(listAnnotations(ws, "out@v1").length).toBe(0); // NOT smeared onto the superseded version
});

test("the checker judges the child's PRODUCED ARTIFACT BODY, not its hand-off text (workers hand off by reference)", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "boss", role: "boss", identity: "You delegate.", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 10, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "worker", role: "worker", identity: "You write.", tools: ["save_artifact"], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  // The worker produces the deliverable AS AN ARTIFACT (the body mentions Y) and returns only a terse
  // hand-off sentence that does NOT contain Y — exactly how a real worker hands off by reference.
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" }),      // boss
    call("save_artifact", { id: "brief", title: "Brief", body: "FULL BODY CONTENT: this deliverable clearly mentions Y in detail." }), // worker → brief@v1
    text("Saved the brief as brief@v1."),                                                       // worker hand-off (NO "Y")
    text('{"pass": true, "reasons": []}'),                                                      // checker
    text("boss done"),                                                                          // boss final
  ) as any });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.verification.length).toBe(1);
  // The checker's own model call is the one carrying the acceptance-checker framing. Its prompt MUST
  // contain the artifact BODY (so the checker can actually judge the deliverable), not merely the
  // hand-off sentence.
  const calls = (model as any).doGenerateCalls as { prompt: unknown }[];
  const checkerCall = calls.find((c) => JSON.stringify(c.prompt).includes("CANDIDATE OUTPUT"));
  expect(checkerCall).toBeDefined();
  const checkerPrompt = JSON.stringify(checkerCall!.prompt);
  expect(checkerPrompt).toContain("FULL BODY CONTENT: this deliverable clearly mentions Y in detail."); // the body reached the checker
  expect(checkerPrompt).toContain("brief@v1");                                                          // labelled by handle
});

test("the verification retry consumes a work item — a budget-exhausted retry is refused, result surfaced with the failed verdict", async () => {
  const { ws, db } = await boot();
  bossAndWorker(ws, db, { workItems: 1 }); // boss may delegate ONCE; the retry needs a 2nd → refused
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" }),
    text("attempt one"),
    text('{"pass": false, "reasons": ["missing Y"]}'),
    text("boss done"),
  ) as any });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.text).toBe("boss done");
  expect(res.trace.delegatedOut.length).toBe(1);                 // the retry never spawned a 2nd child
  expect(res.trace.verification.length).toBe(1);
  expect(res.trace.verification[0].verdict.pass).toBe(false);
  expect(res.trace.notes.some((n) => /retry refused|work item/i.test(n))).toBe(true);
  expect((model as any).doGenerateCalls.length).toBe(4);         // delegate + worker + checker + boss final — no retry child, no 2nd checker
});

test("aggregate folds checker spend: with criteria it equals own loop + child runs + verifier calls (cost-honesty)", async () => {
  const { ws, db } = await boot();
  bossAndWorker(ws, db);
  // Criteria fails once then passes ⇒ 2 child runs (initial + retry) AND 2 independent checker calls,
  // both real, metered model spend this run caused. The aggregate must include ALL of it.
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" }), // boss
    text("attempt one, no Y"),                                    // worker (1st)
    text('{"pass": false, "reasons": ["missing Y"]}'),           // checker (1st) — independent model call
    text("attempt two, mentions Y"),                             // worker (retry)
    text('{"pass": true, "reasons": []}'),                       // checker (2nd)
    text("boss done"),                                           // boss final
  ) as any });
  const deps = makeDeps({ ws, db, model, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(deps, { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });

  // two child runs and two checker calls happened
  expect(res.trace.delegatedOut.length).toBe(2);
  expect(res.trace.verification.length).toBe(2);
  // child-run spend (workers have no sub-delegation, so trace.tokens == its aggregate.tokens)
  const childTokens = res.trace.delegatedOut.reduce((s, id) => s + readTrace(ws, id).tokens, 0);
  // verifier spend is recorded on the verification records (same numbers folded into the aggregate)
  const verifierTokens = res.trace.verification.reduce((s, v) => s + v.tokens, 0);
  expect(verifierTokens).toBeGreaterThan(0);                     // the checker really spent metered tokens
  // THE INVARIANT (strengthened): aggregate = own loop + child runs + verifier calls — nothing under-reported
  expect(res.trace.aggregate!.tokens).toBe(res.trace.tokens + childTokens + verifierTokens);
  // and it changes the number: dropping verifier spend would under-report by verifierTokens
  expect(res.trace.aggregate!.tokens).toBeGreaterThan(res.trace.tokens + childTokens);

  // cost mirrors tokens under the identity pricer, and verifier cost is really folded in (not just tokens)
  const childCost = res.trace.delegatedOut.reduce((s, id) => s + (readTrace(ws, id).aggregate?.costUsd ?? 0), 0);
  const verifierCost = res.trace.verification.reduce((s, v) => s + (v.costUsd ?? 0), 0);
  expect(verifierCost).toBeGreaterThan(0);
  expect(res.trace.aggregate!.costUsd).toBeCloseTo(res.trace.costUsd! + childCost + verifierCost, 6);
});

test("Plan 09: a criteria delegation commits verifier spend to the squad ceiling AND /costs surfaces it exactly once", async () => {
  const { ws, db } = await boot();
  bossAndWorker(ws, db);
  // boss delegates WITH criteria ⇒ an independent checker call runs on the shared squad ledger.
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" }), // boss iter1
    text("attempt one, mentions Y"),                     // worker (1 call)
    text('{"pass": true, "reasons": []}'),               // checker (1 independent call)
    text("boss done"),                                   // boss final
  ) as any });
  // A squad ceiling IS configured (ceiling high enough not to block) so the ledger is live and enforced.
  const spendLedger = makeSpendLedger(db, { squad: { dailyTokens: 10_000_000 } });
  const deps = makeDeps({ ws, db, model, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens, spendLedger });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(deps, { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });

  expect(res.trace.verification.length).toBe(1);
  expect(res.trace.verification[0].verdict.pass).toBe(true);
  // The verifier's own spend is recorded as its OWN trace field (not folded into trace.tokens).
  expect(res.trace.verifierTokens).toBeGreaterThan(0);
  expect(res.trace.verifierCostUsd).toBeGreaterThan(0);

  const workerTrace = readTrace(ws, res.trace.delegatedOut[0]);
  expect(workerTrace.verifierTokens).toBe(0); // the worker did no criteria delegation ⇒ no verifier spend of its own

  // (1) THE CEILING SEES THE VERIFIER: the deck_spend counter the ceiling reads = boss loop + worker
  // run + verifier call. Before the fix the verifier ran with no ledger, so this would be short by
  // verifierTokens (the under-count the finding flagged) and the daily ceiling could never bound it.
  const squad = readSpendTotals(db);
  expect(squad.dayTokens).toBe(res.trace.tokens + workerTrace.tokens + res.trace.verifierTokens);
  expect(squad.dayCostUsd).toBeCloseTo(res.trace.costUsd! + workerTrace.costUsd! + res.trace.verifierCostUsd, 6);

  // (2) /costs SURFACES IT ONCE: rollup sums each trace's OWN spend (loop + verifier); the verifier
  // writes no child trace, so adding verifierTokens counts it exactly once — never double.
  const rollup = rollupCosts([res.trace, workerTrace]);
  expect(rollup.totals.tokens).toBe(res.trace.tokens + res.trace.verifierTokens + workerTrace.tokens);
  // parity: /costs and the squad ceiling report the SAME comprehensive number — verifier included, no double-count.
  expect(rollup.totals.tokens).toBe(squad.dayTokens);
  expect(rollup.totals.costUsd).toBeCloseTo(squad.dayCostUsd, 6);
});

test("subscription checker is cost-honest: costUsd is 0 (never fabricated) even with a pricer, tokens still metered so they fold", async () => {
  const { ws } = await boot();
  const agent = await loadAgent(ws, "root");
  // subscription:true ⇒ Codex backend ⇒ the checker streams (doStream) and its USD is unpriced.
  const model = new MockLanguageModelV3({ doStream: textStream('{"pass": true, "reasons": []}') });
  const r = await runChecker({
    model, agent, subscription: true,
    priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens, // present, but must be ignored on subscription
    goal: "g", criteria: "must mention Y", output: "mentions Y",
  });
  expect(r.verdict.pass).toBe(true);
  expect(r.costUsd).toBeNull();          // subscription: NO measurable USD — null, never a fabricated 0 (mirrors loop.ts)
  expect(r.costNote).toBe("subscription");
  expect(r.tokens).toBeGreaterThan(0);  // tokens ARE metered — this is what folds into the aggregate honestly
});

test("non-subscription checker prices its real spend: runChecker returns a USD cost the aggregate now folds in", async () => {
  const { ws } = await boot();
  const agent = await loadAgent(ws, "root");
  const model = new MockLanguageModelV3({ doGenerate: (async () => text('{"pass": true, "reasons": []}')) as any });
  const r = await runChecker({
    model, agent, subscription: false,
    priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens,
    goal: "g", criteria: "c", output: "o",
  });
  expect(r.verdict.pass).toBe(true);
  expect(r.costUsd).toBeGreaterThan(0); // a real cost — folding it is exactly what closes the cost-honesty gap
  expect(r.costNote).toBeUndefined();   // priced run ⇒ no subscription note
  expect(r.tokens).toBeGreaterThan(0);
});

test("Plan 20: a checker refused by BUDGET before any call is not a pass — checkerError verdict (review finding)", async () => {
  const { ws } = await boot();
  const agent = { ...(await loadAgent(ws, "root")), budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20, maxTokensPerRun: 0 } };
  // maxTokensPerRun 0 ⇒ runLoop refuses at iteration 0 with { text: "[budget exhausted]", exhausted: true }
  // — error undefined, aborted false. The first guard shipped only error||aborted, so this parsed to the
  // advisory PASS and ticked plan items done as "independently verified". Exhaustion is a far more
  // routine state than a provider outage (rolling ceilings persist across sessions).
  const model = new MockLanguageModelV3({ doGenerate: (async () => text('{"pass": true, "reasons": []}')) as any });
  const r = await runChecker({ model, agent, subscription: false, goal: "g", criteria: "c", output: "o" });
  expect(r.checkerError).toBe(true);
  expect(r.verdict.pass).toBe(false);
  expect(r.verdict.reasons.join(" ")).toContain("checker unavailable");
  expect((model as any).doGenerateCalls.length).toBe(0);   // the checker truly never ran
});

test("Plan 20: a checker that never RAN (model error) is not a pass — checkerError verdict, pass=false", async () => {
  const { ws } = await boot();
  const agent = await loadAgent(ws, "root");
  // Every attempt throws (the SDK may retry a network-shaped error; the outage outlasts the retries).
  const model = new MockLanguageModelV3({
    doStream: (() => { throw Object.assign(new Error("provider down"), { code: "ECONNREFUSED" }); }) as any,
  });
  const r = await runChecker({ model, agent, subscription: false, goal: "g", criteria: "c", output: "o" });
  expect(r.checkerError).toBe(true);
  expect(r.verdict.pass).toBe(false);   // OLD behavior: "[error]" parsed to a non-blocking advisory PASS
  expect(r.verdict.reasons.join(" ")).toContain("checker unavailable");
});

// ---------------------------------------------------------------------------
// Plan 06 Phase 3 — artifact & coaching tie-in
//   (1) a failed verdict on an artifact hand-off becomes an annotation on the artifact VERSION;
//   (2) a REPEATED (agent, criteria) failure PROPOSES a captain-gated coaching note.
// ---------------------------------------------------------------------------

test("Phase 3: a failed verdict is written as an ANNOTATION on the child's OUTPUT artifact version (id@vN), like human feedback", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "boss", role: "boss", identity: "You delegate.", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 10, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "worker", role: "worker", identity: "You work.", tools: ["save_artifact"], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  // one delegation with criteria; the worker saves an artifact each attempt (out@v1, then out@v2 on retry);
  // both checks FAIL, so the FINAL verdict must land on the artifact version the checker actually judged.
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" }), // boss
    call("save_artifact", { id: "out", title: "Out", body: "attempt one, no Y" }),        // worker (1st)
    text("saved v1"),
    text('{"pass": false, "reasons": ["missing Y"]}'),                                     // checker (1st)
    call("save_artifact", { id: "out", title: "Out", body: "attempt two, still no Y" }),   // worker (retry)
    text("saved v2"),
    text('{"pass": false, "reasons": ["still missing Y"]}'),                               // checker (2nd)
    text("boss done"),                                                                     // boss final
  ) as any });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut.length).toBe(2);              // initial + retry
  // the FINAL failed verdict rode the same annotation path a human review would — pinned to out@v2
  const onV2 = listAnnotations(ws, "out@v2", { status: "open" });
  expect(onV2.length).toBe(1);
  expect(onV2[0].kind).toBe("verification");                  // a machine verdict IS an annotation
  expect(onV2[0].author).toBe("checker");
  expect(onV2[0].target).toBe("out@v2");                      // version-pinned to the exact judged bytes (id@vN)
  expect(onV2[0].verdict?.pass).toBe(false);
  expect(onV2[0].verdict?.reasons.join(" ")).toContain("still missing Y");
  // it is pinned to the version judged, NOT smeared across earlier versions
  expect(listAnnotations(ws, "out@v1", { status: "open" }).length).toBe(0);
  expect(res.trace.notes.some((n) => /annotated on out@v2/.test(n))).toBe(true);
});

test("Phase 3: with no output artifact, the verdict annotates the INPUT the child was revising — and surfaces to the next revision run", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "reviser", role: "revises", identity: "You revise." }, "root");
  putAgent(ws, db, { id: "boss", role: "boss", identity: "You delegate.", tools: ["delegate_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 10, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "worker", role: "worker", identity: "You work.", tools: [], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  saveArtifact(ws, { id: "dossier", title: "Dossier", type: "dossier", summary: "the short summary", body: "THE ENORMOUS BODY", producer: "root", runId: "root/seed" });

  // Phase A: boss hands dossier@v1 down with criteria; the worker produces no new artifact and fails
  // twice ⇒ the failed verdict falls back onto the INPUT handle it was revising.
  const phaseA = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "revise the dossier", criteria: "every source dated", inputArtifacts: ["dossier@v1"] }),
    text("attempt one"),                                                             // worker (1st)
    text('{"pass": false, "reasons": ["missing dates"]}'),                           // checker (1st)
    text("attempt two"),                                                             // worker (retry)
    text('{"pass": false, "reasons": ["dossier still lacks dates"]}'),               // checker (2nd)
    text("boss done"),                                                               // boss final
  ) as any });
  const boss = await loadAgent(ws, "boss");
  await executeRun(makeDeps({ ws, db, model: phaseA }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  const onInput = listAnnotations(ws, "dossier@v1", { status: "open" });
  expect(onInput.length).toBe(1);
  expect(onInput[0].kind).toBe("verification");
  expect(onInput[0].target).toBe("dossier@v1");              // pinned to the input version it was revising
  expect(onInput[0].verdict?.pass).toBe(false);

  // Phase B: a subsequent revision run gets dossier@v1 handed in — the machine verdict must surface in
  // the child's prompt EXACTLY like a human annotation (annotation → revision path, Plan 01 Ph4).
  const reviserModel = new MockLanguageModelV3({ doGenerate: (async () => text("revised")) as any });
  const rootModel = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "reviser", goal: "revise the dossier", inputArtifacts: ["dossier@v1"] }),
    text("root done"),
  ) as any });
  const deps = makeDeps({ ws, db, model: rootModel, resolveModel: (id) => id === "reviser" ? { model: reviserModel, modelId: "m" } : { model: rootModel, modelId: "m" } });
  const root = await loadAgent(ws, "root");
  await executeRun(deps, { agent: root, messages: [{ role: "user", content: "fix it" }], triggeredBy: "user" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const childPrompt = JSON.stringify((reviserModel as any).doGenerateCalls[0].prompt);
  expect(childPrompt).toContain("dossier still lacks dates");  // the verdict reasons surfaced
  expect(childPrompt).toContain("REVISION");                   // told it is a revision, like human feedback
  expect(childPrompt).not.toContain("THE ENORMOUS BODY");      // still BY REFERENCE — body never inlined
});

test("Phase 3: a REPEATED (agent, criteria) verification failure PROPOSES a captain-gated coaching note", async () => {
  const { ws, db } = await boot();
  bossAndWorker(ws, db);
  // boss delegates to worker TWICE with the SAME criteria; each delegation fails verification (twice
  // each ⇒ one terminal failure per delegation). The 2nd failing delegation is the repeat that proposes.
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" }), // boss iter1
    text("attempt one"),                                                                  // worker
    text('{"pass": false, "reasons": ["missing Y"]}'),                                    // checker
    text("attempt two"),                                                                  // worker (retry)
    text('{"pass": false, "reasons": ["still missing Y"]}'),                              // checker (retry)
    call("delegate_task", { to: "worker", goal: "write X again", criteria: "must mention Y" }), // boss iter2
    text("attempt one again"),                                                            // worker
    text('{"pass": false, "reasons": ["missing Y"]}'),                                    // checker
    text("attempt two again"),                                                            // worker (retry)
    text('{"pass": false, "reasons": ["still missing Y"]}'),                              // checker (retry)
    text("boss done"),                                                                    // boss final
  ) as any });
  const boss = await loadAgent(ws, "boss");
  await executeRun(makeDeps({ ws, db, model }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  const notes = listPolicies(ws, "worker");
  expect(notes.length).toBe(1);                    // the repeat produced exactly ONE proposal
  expect(notes[0].status).toBe("proposed");        // captain-gated — inert until approved, never auto-applied
  expect(notes[0].agent).toBe("worker");           // scoped to the failing (producer) agent
  expect(notes[0].taughtBy).toBe("verification");
  expect(notes[0].do).toContain("still missing Y");
});

test("Phase 3: a ONE-OFF failed delegation proposes NO coaching note (one delegation is not a pattern)", async () => {
  const { ws, db } = await boot();
  bossAndWorker(ws, db);
  // a single delegation that fails twice is still ONE delegation ⇒ one terminal failure ⇒ no repeat.
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("delegate_task", { to: "worker", goal: "write X", criteria: "must mention Y" }),
    text("attempt one"),
    text('{"pass": false, "reasons": ["missing Y"]}'),
    text("attempt two"),
    text('{"pass": false, "reasons": ["still missing Y"]}'),
    text("boss done"),
  ) as any });
  const boss = await loadAgent(ws, "boss");
  await executeRun(makeDeps({ ws, db, model }), { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(listPolicies(ws, "worker")).toEqual([]); // no proposal from a single miss
});

// ---------------------------------------------------------------------------
// Plan 04 — Async & parallel: dispatch_task wiring, guards, steer routing, recovery
// ---------------------------------------------------------------------------

/** A single model response carrying MULTIPLE tool calls — the AI SDK runs their execute()s
 *  concurrently (interleaved at await points), which is exactly the shared-mutable seam to audit. */
const calls = (specs: [string, object][]) =>
  ({ content: specs.map(([name, input], i) => ({ type: "tool-call", toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) })),
     finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;

test("dispatch_task hands the resolved child agent to the host scheduler and returns immediately (fire-and-forget, not a blocking child run)", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "boss", role: "boss", identity: "You dispatch.", tools: ["dispatch_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "worker", role: "worker", identity: "You work.", tools: [], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const dispatched: Array<{ agentId: string; goal: string; parentRunId: string }> = [];
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    call("dispatch_task", { to: "worker", goal: "do it later" }),
    text("boss moved on"),
  ) as any });
  const deps = makeDeps({ ws, db, model, dispatch: (o) => { dispatched.push({ agentId: o.agent.id, goal: o.goal, parentRunId: o.parentRunId }); return { taskId: "task_bg_1" }; } });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(deps, { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.text).toBe("boss moved on");            // the parent did NOT block on the child
  expect(res.trace.delegatedOut.length).toBe(0);     // dispatch is not a synchronous delegation edge
  expect(dispatched.length).toBe(1);
  expect(dispatched[0].agentId).toBe("worker");      // the host got the RESOLVED child agent
  expect(dispatched[0].goal).toBe("do it later");
  expect(dispatched[0].parentRunId).toBe(res.runId); // provenance: which run dispatched it
  expect(res.trace.notes.some((n) => /dispatched/i.test(n))).toBe(true);
});

test("two dispatch_task calls in ONE turn each consume a work item; the over-budget one is refused (interleaved check-then-act is safe)", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "boss", role: "boss", identity: "You dispatch.", tools: ["dispatch_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 1 } });
  putAgent(ws, db, { id: "worker", role: "worker", identity: "You work.", tools: [], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  let n = 0;
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    calls([["dispatch_task", { to: "worker", goal: "a" }], ["dispatch_task", { to: "worker", goal: "b" }]]),
    text("done"),
  ) as any });
  const dispatched: string[] = [];
  const deps = makeDeps({ ws, db, model, dispatch: (o) => { dispatched.push(o.goal); return { taskId: `task_${n++}` }; } });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(deps, { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(dispatched.length).toBe(1);                                     // only the first (within budget) fired
  expect(res.trace.notes.some((n) => /work item/i.test(n))).toBe(true); // the 2nd was refused, not silently dropped
});

test("dispatch_task is refused once the per-request run ceiling is hit (same guard as delegate_task)", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "boss", role: "boss", identity: "You dispatch.", tools: ["dispatch_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "worker", role: "worker", identity: "leaf", tools: [], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("dispatch_task", { to: "worker", goal: "x" }), text("ok")) as any });
  let dispatchCalled = 0;
  const deps = makeDeps({ ws, db, model, runCounter: { n: 50 }, dispatch: () => { dispatchCalled++; return { taskId: "t" }; } });
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(deps, { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(dispatchCalled).toBe(0);                                                   // the host was never asked to start a run
  expect(res.trace.notes.some((n) => /max runs per request/i.test(n))).toBe(true);
});

test("dispatch_task cleanly reports when no scheduler is wired (headless/unit context)", async () => {
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "boss", role: "boss", identity: "You dispatch.", tools: ["dispatch_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "worker", role: "w", identity: "w", tools: [], canSee: ["*"], canDelegateTo: [], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("dispatch_task", { to: "worker", goal: "x" }), text("done")) as any });
  const deps = makeDeps({ ws, db, model }); // no `dispatch`
  const boss = await loadAgent(ws, "boss");
  const res = await executeRun(deps, { agent: boss, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("completed"); // the run still finishes; the tool just reported unavailability
});

test("A→B→A dispatch cycle is REFUSED: the detached run's cycle guard spans the dispatch hop (ancestry is threaded)", async () => {
  // Before the fix, a detached dispatch started with a fresh depth/ancestry/runCounter, so delegationGuard's
  // cycle check never saw the parent chain across dispatch hops — two agents with dispatch_task + mutual
  // canDelegateTo could ping-pong A→B→A unboundedly. Threading the dispatching run's ancestry into the
  // detached executeRun makes the cross-agent cycle guard span the hop.
  const { ws, db } = await boot();
  putAgent(ws, db, { id: "a", role: "a", identity: "You are A.", tools: ["dispatch_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  putAgent(ws, db, { id: "b", role: "b", identity: "You are B.", tools: ["dispatch_task"], canSee: ["*"], canDelegateTo: ["*"], budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 20 } });
  // Branch on the GOAL text (unambiguous: it appears only in the run that received it): A dispatches to
  // B (goal GOAL-TO-B); B receives GOAL-TO-B and tries to dispatch back to A; after any dispatch RESULT
  // ("task_bg_") or a refusal ("cycle") the run wraps up.
  const model = new MockLanguageModelV3({ doGenerate: (async ({ prompt }: { prompt: unknown }) => {
    const s = JSON.stringify(prompt);
    if (s.includes("task_bg_") || s.includes("cycle")) return text("wrapped up");
    if (s.includes("GOAL-TO-B")) return call("dispatch_task", { to: "a", goal: "GOAL-TO-A" }); // this is B → back to A
    return call("dispatch_task", { to: "b", goal: "GOAL-TO-B" });                              // this is A → to B
  }) as any });

  const detached: ReturnType<typeof executeRun>[] = [];
  let dispatches = 0;
  let deps: ReturnType<typeof makeDeps>;
  // Mimic App.tsx's real dispatch closure: start a detached executeRun, THREADING the parent ancestry so
  // the cycle guard spans the hop, but keeping budgets (depth/runCounter) reset — a dispatch stays an
  // independent request. A hard cap bounds a would-be-runaway if the fix regresses.
  const dispatch: NonNullable<Parameters<typeof makeDeps>[0]["dispatch"]> = (o) => {
    if (dispatches >= 5) return { error: "test safety cap" };
    dispatches++;
    const taskId = `task_bg_${dispatches}`;
    detached.push(executeRun(deps, {
      agent: o.agent, messages: [{ role: "user", content: o.goal }],
      brief: { from: o.parentAgentId, goal: o.goal, fromRun: o.parentRunId },
      triggeredBy: taskId, ancestry: [...o.parentAncestry, o.parentAgentId],
    }));
    return { taskId };
  };
  deps = makeDeps({ ws, db, model, dispatch });
  const a = await loadAgent(ws, "a");
  const res = await executeRun(deps, { agent: a, messages: [{ role: "user", content: "kickoff" }], triggeredBy: "user" });
  expect(res.trace.notes.some((n) => /dispatched/i.test(n))).toBe(true); // A dispatched to B
  const runs = await Promise.all(detached);
  expect(dispatches).toBe(1);                                            // ONLY A→B fired; B→A was refused BEFORE dispatch
  const bRun = runs.find((r) => r.trace.agent === "b")!;
  expect(bRun.trace.notes.some((n) => /cycle/i.test(n))).toBe(true);     // B→A refused by the cycle guard
});

test("run.ts routes steering per-run: pollSteerFor is called with THIS run's id/agent and its steer reaches the model", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  let seen: { runId: string; agentId: string; triggeredBy: string } | null = null;
  let fired = false;
  const pollSteerFor = (info: { runId: string; agentId: string; triggeredBy: string }) => {
    seen = info;
    if (!fired) { fired = true; return null; }
    return "actually, wrap it up";
  };
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("write_artifact", { topicSlug: "x", markdown: "y" }), text("done")) as any });
  const deps = makeDeps({ ws, db, model, pollSteerFor });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(seen!.runId).toBe(res.runId);        // the loop polled THIS run's queue (not a global one)
  expect(seen!.agentId).toBe("writer");
  expect(seen!.triggeredBy).toBe("user");
  const secondPrompt = JSON.stringify((model as any).doGenerateCalls[1].prompt);
  expect(secondPrompt).toContain("actually, wrap it up"); // the routed steer was injected before the 2nd call
});

test("onRunEnd fires with the run's outcome so the host can clean up its routing table", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const ended: Array<{ runId: string; agent: string; outcome: string }> = [];
  const model = new MockLanguageModelV3({ doGenerate: (async () => text("done")) as any });
  const deps = makeDeps({ ws, db, model, onRunEnd: (i) => ended.push({ runId: i.runId, agent: i.agent, outcome: i.outcome }) });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(ended).toEqual([{ runId: res.runId, agent: "writer", outcome: "completed" }]);
});

test("recovery: run.ts writes an incremental transcript AND a resume checkpoint during the run", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const model = new MockLanguageModelV3({ doGenerate: mockValues(call("write_artifact", { topicSlug: "x", markdown: "y" }), text("done")) as any });
  const deps = makeDeps({ ws, db, model });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  const dir = paths.runRecordDir(ws, res.runId);
  // transcript flushed live (model_request/response/tool_call all present), not just at end
  const tr = readFileSync(join(dir, "transcript.jsonl"), "utf8");
  expect(tr).toContain("model_request");
  expect(tr).toContain("tool_call");
  // checkpoint written with the loop's message array — the resume point
  expect(existsSync(join(dir, "checkpoint.json"))).toBe(true);
  const cp = JSON.parse(readFileSync(join(dir, "checkpoint.json"), "utf8"));
  expect(cp.runId).toBe(res.runId);
  expect(Array.isArray(cp.messages)).toBe(true);
  expect(cp.iteration).toBeGreaterThan(0);
});

// --- Plan 19: delegating to a TEAM, end to end through executeRun ---------------------------------

/** Root, a team, and two members. Root delegates to the TEAM id; the engine resolves it to an agent. */
async function bootTeam(opts: { lead?: string } = {}) {
  const { ws, db } = await boot();
  createTeam(ws, { id: "news", charter: "covers breaking stories", lead: opts.lead });
  await createAgent(ws, db, { id: "reporter", role: "files stories on deadline", identity: "You report.", teams: ["news"] }, "root");
  await createAgent(ws, db, { id: "factchecker", role: "verifies claims and sources", identity: "You verify.", teams: ["news"] }, "root");
  await reindex(ws, db);
  return { ws, db };
}

test("Plan 19: root delegates to a LEADLESS team and the engine routes to the best-ranked member", async () => {
  const { ws, db } = await bootTeam();
  const notes: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("delegate_task", { to: "news", goal: "verify these claims and sources" }),
      text("done"),
      text("checked"), // the child's own reply
    ) as any,
  });
  const deps = makeDeps({ ws, db, model, onStep: (i) => { if (i.note) notes.push(i.note); } });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "check the story" }], triggeredBy: "user" });

  expect(res.trace.outcome).toBe("completed");
  // the CHILD run is the resolved agent, never the team id — a team has no agent.md to load
  expect(res.trace.delegatedOut).toHaveLength(1);
  expect(res.trace.delegatedOut[0]!.startsWith("factchecker/")).toBe(true);
  // the routing decision is surfaced, never silent
  expect(notes.some((n) => n.includes("routed news → factchecker"))).toBe(true);
  expect(res.trace.notes.some((n) => n.includes("routed news → factchecker (ranked"))).toBe(true);
});

test("Plan 19: a team WITH a lead routes to the lead, consuming one delegation level", async () => {
  const { ws, db } = await bootTeam({ lead: "reporter" });
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("delegate_task", { to: "news", goal: "verify these claims and sources" }), // ranker would pick factchecker
      text("done"),
      text("filed"),
    ) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  // the lead wins over the ranker — that is the whole point of naming one
  expect(res.trace.delegatedOut[0]!.startsWith("reporter/")).toBe(true);
  expect(res.trace.notes.some((n) => n === "routed news → reporter (lead)")).toBe(true);
});

test("Plan 19: `team:<id>` addresses a team explicitly, and a bare agent id still works", async () => {
  const { ws, db } = await bootTeam();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("delegate_task", { to: "team:news", goal: "files stories deadline" }),
      text("done"),
      text("filed"),
    ) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut[0]!.startsWith("reporter/")).toBe(true);
});

test("Plan 19: delegating to an unknown name reports agent-or-team, not just agent", async () => {
  const { ws, db } = await bootTeam();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("delegate_task", { to: "ghost", goal: "x" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut).toHaveLength(0);
  expect(res.trace.notes.some((n) => n.includes('no agent or team "ghost"'))).toBe(true);
});

test("Plan 19: a lead delegating to its OWN team is refused, not looped", async () => {
  const { ws, db } = await bootTeam({ lead: "reporter" });
  // reporter needs delegate_task + the right to address its team
  const reporter = await loadAgent(ws, "reporter");
  reporter.tools = [...reporter.tools, "delegate_task"];
  reporter.canDelegateTo = ["team:news"];
  writeFileSync(paths.agentFile(ws, "reporter"), serializeAgent(reporter));
  await reindex(ws, db);

  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("delegate_task", { to: "news", goal: "x" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const res = await executeRun(deps, { agent: await loadAgent(ws, "reporter"), messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut).toHaveLength(0);
  expect(res.trace.notes.some((n) => n.includes("a lead cannot address its own team"))).toBe(true);
});

test("Plan 19: an empty team is refused with an actionable error, not an ENOENT", async () => {
  const { ws, db } = await boot();
  createTeam(ws, { id: "ops", charter: "keeps the lights on" }); // no members
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("delegate_task", { to: "ops", goal: "x" }), text("done")) as any,
  });
  const deps = makeDeps({ ws, db, model });
  const root = await loadAgent(ws, "root");
  const res = await executeRun(deps, { agent: root, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.delegatedOut).toHaveLength(0);
  expect(res.trace.notes.some((n) => n.includes('team "ops" has no members'))).toBe(true);
});

test("Plan 19 Ph5: a team's tool policy reaches the member's real toolset (deny strips, grant adds)", async () => {
  const { ws, db } = await boot();
  // ops denies run_command to its members and grants recall to all of them
  createTeam(ws, { id: "ops", charter: "keeps the lights on", tools: { deny: ["run_command"], grant: ["recall"] } });
  await createAgent(ws, db, { id: "sre", role: "operates", identity: "You operate.", tools: ["run_command"], teams: ["ops"] }, "root");
  await reindex(ws, db);

  // The model tries the denied tool; the SDK never exposes it, so the loop sees an unknown tool.
  const model = new MockLanguageModelV3({ doGenerate: mockValues(text("ok")) as any });
  const deps = makeDeps({ ws, db, model });
  const sre = await loadAgent(ws, "sre");
  const res = await executeRun(deps, { agent: sre, messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("completed");

  // Assert on the toolset the engine actually built for this agent.
  const built = toolsForAgent(sre, {} as never, undefined, loadTeam(ws, "ops")!.tools);
  expect(Object.keys(built)).not.toContain("run_command"); // agent asked for it; the team said no
  expect(Object.keys(built)).toContain("recall");          // agent never asked; the team granted it
  expect(Object.keys(built)).toContain("save_artifact");   // the Plan 14 floor survives untouched
});

// --- Plan 18: plans, and the checkbox that cannot lie ----------------------------------------------

async function bootPlanner() {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "worker", role: "does the thing", identity: "You work." }, "root");
  await reindex(ws, db);
  return { ws, db };
}
const PLAN = { goal: "ship the notifier", items: [{ id: "it_survey", text: "survey" }, { id: "it_ship", text: "ship" }] };

test("Plan 18: write_plan mints v1; an identical rewrite mints nothing", async () => {
  const { ws, db } = await bootPlanner();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(call("write_plan", PLAN), call("write_plan", PLAN), text("done")) as any,
  });
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("completed");
  expect(latestVersion(ws, "p_ship-the-notifier")).toBe(1);
  expect(res.trace.notes.filter((n) => n.includes("unchanged"))).toHaveLength(1);
});

test("Plan 18: the model ticks its OWN item, and the fold reflects it", async () => {
  const { ws, db } = await bootPlanner();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("write_plan", PLAN),
      call("update_plan_item", { itemId: "it_survey", status: "done" }),
      text("done"),
    ) as any,
  });
  await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  const s = foldPlan(ws, "p_ship-the-notifier")!;
  expect(s.items.find((i) => i.id === "it_survey")!.status).toBe("done");
  expect(s.counts).toEqual({ total: 2, done: 1, open: 1, failed: 0 });
});

test("Plan 18: delegate_task(itemId) — the ENGINE ticks the item from the child's real outcome", async () => {
  const { ws, db } = await bootPlanner();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("write_plan", PLAN),
      call("delegate_task", { to: "worker", goal: "ship it", itemId: "it_ship" }),
      text("done"),
      text("shipped"), // the child's reply
    ) as any,
  });
  await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "go" }], triggeredBy: "user" });

  const s = foldPlan(ws, "p_ship-the-notifier")!;
  const ship = s.items.find((i) => i.id === "it_ship")!;
  expect(ship.status).toBe("done");
  expect(ship.boundRunId!.startsWith("worker/")).toBe(true); // bound to the run that actually did it
  // the whole transition history is legible: in_progress (bind) then done (settle)
  const evs = readPlanEvents(ws, "p_ship-the-notifier").filter((e) => e.item === "it_ship");
  expect(evs.map((e) => e.status)).toEqual(["in_progress", "done"]);
  expect(evs.every((e) => e.by === "engine")).toBe(true);
});

test("Plan 18: a model may NOT mark a delegated item done — the attempt is refused AND recorded", async () => {
  const { ws, db } = await bootPlanner();
  // The mock's script is shared by parent AND child, so the child's reply must sit immediately after
  // the delegate_task call that spawns it.
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("write_plan", PLAN),                                        // root
      call("delegate_task", { to: "worker", goal: "ship it", itemId: "it_ship" }), // root
      text("worker shipped it"),                                       // worker
      call("update_plan_item", { itemId: "it_ship", status: "done" }), // root claims the item itself
      text("done"),                                                    // root final
    ) as any,
  });
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.outcome).toBe("completed");

  const evs = readPlanEvents(ws, "p_ship-the-notifier").filter((e) => e.item === "it_ship");
  const attempt = evs.find((e) => e.by === "model");
  expect(attempt).toBeDefined();
  expect(attempt!.rejected).toBe(true);                     // recorded — a model claiming a delegated
  expect(attempt!.note).toContain("refused");               // item is a fact worth having
  expect(res.trace.notes.some((n) => n.includes("engine-owned"))).toBe(true);
  // ...and it did not change the state, which the engine had already set from the child's real outcome
  expect(foldPlan(ws, "p_ship-the-notifier")!.items.find((i) => i.id === "it_ship")!.status).toBe("done");
});

test("Plan 18: a rejected attempt cannot win the fold even when it is the LAST event", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-fold-"));
  const { plan } = writePlan(w, { owner: "root", goal: "g", items: [{ id: "it_0", text: "x" }], producer: "root", runId: "r" });
  appendPlanEvent(w, plan.id, { item: "it_0", status: "failed", by: "engine", runId: "r", boundRunId: "w/r1", note: "verdict failed" });
  appendPlanEvent(w, plan.id, { item: "it_0", status: "done", by: "model", runId: "r", rejected: true });
  // The model's `done` is chronologically last. If the fold honoured it, the engine-owns rule would be
  // decoration. It must lose.
  expect(foldPlan(w, plan.id)!.items[0]!.status).toBe("failed");
});

test("Plan 18 x Plan 06: with criteria, the box goes green only when an INDEPENDENT check agrees", async () => {
  const { ws, db } = await bootPlanner();
  // The checker fails twice, so after the one bounded retry the item must be FAILED, carrying the reasons.
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("write_plan", PLAN),                                                                  // root
      call("delegate_task", { to: "worker", goal: "ship", criteria: "must mention Y", itemId: "it_ship" }),
      text("attempt one, no Y"),                          // worker
      text('{"pass": false, "reasons": ["missing Y"]}'),  // checker
      text("attempt two, still no Y"),                    // worker (retry)
      text('{"pass": false, "reasons": ["still missing Y"]}'), // checker (2nd)
      text("done"),                                        // root final
    ) as any,
  });
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.verification).toHaveLength(2);
  expect(res.trace.verification.every((v) => !v.verdict.pass)).toBe(true);

  const ship = foldPlan(ws, "p_ship-the-notifier")!.items.find((i) => i.id === "it_ship")!;
  expect(ship.status).toBe("failed");            // the child RAN and returned; the CHECK is what failed
  expect(ship.note).toContain("still missing Y"); // the verdict's reasons land on the item
  expect(foldPlan(ws, "p_ship-the-notifier")!.counts.failed).toBe(1);
});

test("Plan 18 x Plan 06: a PASSING check is what turns the box green", async () => {
  const { ws, db } = await bootPlanner();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("write_plan", PLAN),
      call("delegate_task", { to: "worker", goal: "ship", criteria: "must mention Y", itemId: "it_ship" }),
      text("attempt one, mentions Y"),
      text('{"pass": true, "reasons": []}'),
      text("done"),
    ) as any,
  });
  await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(foldPlan(ws, "p_ship-the-notifier")!.items.find((i) => i.id === "it_ship")!.status).toBe("done");
});

test("Plan 18: `dropped` requires a note", async () => {
  const { ws, db } = await bootPlanner();
  const model = new MockLanguageModelV3({
    doGenerate: mockValues(
      call("write_plan", PLAN),
      call("update_plan_item", { itemId: "it_survey", status: "dropped" }),
      text("done"),
    ) as any,
  });
  const res = await executeRun(makeDeps({ ws, db, model }), { agent: await loadAgent(ws, "root"), messages: [{ role: "user", content: "go" }], triggeredBy: "user" });
  expect(res.trace.notes.some((n) => n.includes("requires a note"))).toBe(true);
  expect(foldPlan(ws, "p_ship-the-notifier")!.items[0]!.status).toBe("pending");
});

test("Plan 18: an agent WITHOUT write_plan gets no plan tools and no prompt note (zero overhead)", async () => {
  const { ws, db } = await bootPlanner();
  const worker = await loadAgent(ws, "worker");
  expect(worker.tools).not.toContain("write_plan"); // not in DEFAULT_WORKER_TOOLS
  const built = toolsForAgent(worker, {} as never, undefined);
  expect(Object.keys(built)).not.toContain("write_plan");
  expect(Object.keys(built)).not.toContain("update_plan_item");
});
