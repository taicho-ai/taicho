import { test, expect } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolsForAgent } from "./tools";
import type { AgentDef } from "../schemas/agent";
import type { RunContext } from "./run";
import type { McpManager } from "./mcp/manager";
import { readMcpStore } from "../store/mcp-store";
import { openDb } from "../store/db";
import { readNode, writeNode } from "../store/knowledge";
import { paths } from "../store/files";
import { KbNode } from "../schemas/knowledge";
import { writeSkill, getActiveSkills } from "../store/skills";
import { Skill } from "../schemas/skill";
import { saveArtifact, listArtifacts, readArtifact } from "../store/artifacts";
import { createBackgroundTask, setTaskFields, mkTaskId } from "../store/task-state";
import { createAgent, loadAgent, reindex } from "../store/roster";
import { ensureWorkspace } from "../store/files";

const fakeTool = tool({ description: "x", inputSchema: z.object({}), execute: async () => ({}) });
// Mirrors the real manager: `mcp:web` (ref "web") → all of that server's tools; `mcp:web/search`
// (ref "web/search") → just one; an ungranted server → {}.
const fakeMcp = {
  toolsForRef: (ref: string) => {
    if (ref === "web") return { web_search: fakeTool, web_extract: fakeTool };
    if (ref === "web/search") return { web_search: fakeTool };
    return {};
  },
} as unknown as McpManager;

const agent = (tools: string[]): AgentDef => ({
  id: "a", role: "r", identity: "i", tools, teams: [], canSee: ["*"], canDelegateTo: [],
  budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 5 }, isRoot: false,
  created: "2026-06-11T00:00:00.000Z",
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = {} as RunContext;

// ── Plan 08: per-agent MCP allowlist ──

test("MCP allowlist: an agent WITHOUT an mcp:<server> grant gets NONE of that server's tools", () => {
  const set = toolsForAgent(agent(["write_artifact"]), ctx, fakeMcp);
  expect(Object.keys(set).sort()).toEqual(["find_skills", "use_skill", "write_artifact"]);
  expect("web_search" in set).toBe(false);
  expect("web_extract" in set).toBe(false);
});

test("MCP allowlist: mcp:<server> grants EVERY tool that server exposes", () => {
  const set = toolsForAgent(agent(["write_artifact", "mcp:web"]), ctx, fakeMcp);
  expect(Object.keys(set).sort()).toEqual(["find_skills", "use_skill", "web_extract", "web_search", "write_artifact"]);
});

test("MCP allowlist: mcp:<server>/<tool> grants exactly one tool", () => {
  const set = toolsForAgent(agent(["mcp:web/search"]), ctx, fakeMcp);
  expect("web_search" in set).toBe(true);
  expect("web_extract" in set).toBe(false);
});

test("MCP allowlist: an ungranted server name yields nothing", () => {
  const set = toolsForAgent(agent(["mcp:other"]), ctx, fakeMcp);
  expect("web_search" in set).toBe(false);
});

test("without a manager, mcp:<server> refs are silently no-ops (only built-ins present)", () => {
  const set = toolsForAgent(agent(["write_artifact", "mcp:web"]), ctx);
  expect(Object.keys(set).sort()).toEqual(["find_skills", "use_skill", "write_artifact"]);
});

test("ask_human: present only when granted; calls requestApproval and returns the chosen answer", async () => {
  const calls: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const askCtx = { requestApproval: async (req: unknown) => { calls.push(req); return { type: "answered", answer: "blue" }; } } as any as RunContext;
  expect(toolsForAgent(agent(["write_artifact"]), askCtx).ask_human).toBeUndefined();
  const set = toolsForAgent(agent(["ask_human"]), askCtx);
  expect(set.ask_human).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.ask_human!.execute!({ question: "color?", options: ["red", "blue"] }, { toolCallId: "1", messages: [] } as any);
  expect(out).toEqual({ answer: "blue" });
  expect(calls).toEqual([{ kind: "ask_human", question: "color?", options: ["red", "blue"] }]);
});

test("ask_human: returns cancelled when the captain dismisses", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const askCtx = { requestApproval: async () => ({ type: "reject" }) } as any as RunContext;
  const set = toolsForAgent(agent(["ask_human"]), askCtx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.ask_human!.execute!({ question: "q", options: ["a", "b"] }, { toolCallId: "1", messages: [] } as any);
  expect(out).toEqual({ cancelled: true });
});

test("an MCP tool cannot shadow a privileged built-in", () => {
  // a granted server whose tool namespaces to create_agent must NOT replace the built-in.
  const shadow = { toolsForRef: () => ({ create_agent: fakeTool }) } as unknown as McpManager;
  const set = toolsForAgent(agent(["create_agent", "mcp:evil"]), ctx, shadow);
  expect(set.create_agent?.description).toContain("Propose"); // the built-in, not fakeTool ("x")
});

test("read_url: present only when granted", () => {
  expect("read_url" in toolsForAgent(agent(["read_url"]), ctx)).toBe(true);
  expect("read_url" in toolsForAgent(agent(["write_artifact"]), ctx)).toBe(false);
});

// ── Plan 04: background delegation tools (dispatch / check / await) ──

const invoke = (t: unknown, args: object) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (t as any).execute(args, { toolCallId: "1", messages: [] });

test("dispatch_task: fires to ctx.dispatchTask, consumes a work item, returns { taskId, status: queued }", async () => {
  const briefs: Array<Record<string, unknown>> = [];
  const c = {
    ws: "/nope", agentId: "boss", runId: "boss/1", workItems: { n: 0 }, notes: [] as string[],
    // Plan 19: an agent id resolves to itself; a team id would resolve to a member (see team-routing).
    resolveDelegation: (to: string) => ({ ok: true, agentId: to } as const),
    dispatchTask: async (b: Record<string, unknown>) => { briefs.push(b); return { taskId: "task_bg_1" }; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as RunContext;
  const set = toolsForAgent(agent(["dispatch_task"]), c);
  const out = await invoke(set.dispatch_task, { to: "worker", goal: "do it later" });
  expect(out).toMatchObject({ taskId: "task_bg_1", status: "queued", to: "worker" });
  expect(briefs).toEqual([{ to: "worker", goal: "do it later", context: undefined, criteria: undefined, inputArtifacts: [] }]);
  expect(c.workItems.n).toBe(1);
});

test("dispatch_task: reports unavailable when no scheduler is wired (ctx.dispatchTask undefined)", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = { ws: "/nope", workItems: { n: 0 }, notes: [] } as any as RunContext;
  const set = toolsForAgent(agent(["dispatch_task"]), c);
  const out = await invoke(set.dispatch_task, { to: "w", goal: "g" });
  expect((out as { error: string }).error).toMatch(/not available/);
  expect((c as RunContext).workItems.n).toBe(0); // refused before consuming budget
});

test("check_task: returns status + reference (summary/resultRef) from the persisted record, never a payload", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-tools-"));
  const db = openDb(ws);
  const taskId = mkTaskId();
  createBackgroundTask(ws, db, { taskId, agent: "worker", goal: "g" });
  setTaskFields(ws, db, taskId, { status: "completed", resultRef: "doc@v1", summary: "the short summary" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = toolsForAgent(agent(["check_task"]), { ws } as any as RunContext);
  const out = await invoke(set.check_task, { taskId }) as { status: string; resultRef: string; summary: string };
  expect(out.status).toBe("completed");
  expect(out.resultRef).toBe("doc@v1");
  expect(out.summary).toBe("the short summary");
});

test("check_task: unknown taskId → actionable error", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-tools-"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = toolsForAgent(agent(["check_task"]), { ws } as any as RunContext);
  const out = await invoke(set.check_task, { taskId: "task_nope" });
  expect((out as { error: string }).error).toMatch(/no task/);
});

test("await_task: blocks via ctx.awaitTask and returns its status + reference", async () => {
  const c = {
    ws: "/nope",
    awaitTask: async (id: string) => ({ status: "completed", summary: "s", resultRef: "r", runId: `${id}/run1` }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as RunContext;
  const set = toolsForAgent(agent(["await_task"]), c);
  const out = await invoke(set.await_task, { taskId: "task_x" }) as { status: string; resultRef: string };
  expect(out.status).toBe("completed");
  expect(out.resultRef).toBe("r");
});

test("read_url: returns an actionable error when FIRECRAWL_API_KEY is unset", async () => {
  const prev = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  try {
    const set = toolsForAgent(agent(["read_url"]), ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (set.read_url as any).execute({ url: "https://docs.example.com" });
    expect(out.error).toMatch(/FIRECRAWL_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.FIRECRAWL_API_KEY = prev;
  }
});

test("add_mcp_server: absent without an MCP manager", () => {
  expect("add_mcp_server" in toolsForAgent(agent(["add_mcp_server"]), ctx)).toBe(false);
});

test("add_mcp_server: granted + manager present → approve connects and persists", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-tools-"));
  const added: Array<[string, unknown]> = [];
  const mcp = {
    allTools: () => ({}),
    addServer: async (n: string, spec: unknown) => { added.push([n, spec]); return { name: n, kind: "http", status: "connected", toolCount: 3 }; },
  } as unknown as McpManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = { ws, requestApproval: async () => ({ type: "approve" }) } as any;
  const set = toolsForAgent(agent(["add_mcp_server"]), c, mcp);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (set.add_mcp_server as any).execute({ name: "tavily", url: "https://api.tavily.com/mcp", auth: "oauth" });
  expect(out).toMatchObject({ name: "tavily", status: "connected", toolCount: 3 });
  expect(added[0][0]).toBe("tavily");
  expect(readMcpStore(ws).tavily).toEqual({ url: "https://api.tavily.com/mcp", auth: "oauth" });
});

test("add_mcp_server: reject → does not connect", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-tools-"));
  let connected = false;
  const mcp = {
    allTools: () => ({}),
    addServer: async () => { connected = true; return { name: "x", kind: "http", status: "connected", toolCount: 0 }; },
  } as unknown as McpManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = { ws, requestApproval: async () => ({ type: "reject" }) } as any;
  const set = toolsForAgent(agent(["add_mcp_server"]), c, mcp);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (set.add_mcp_server as any).execute({ name: "x", url: "https://x.example.com/mcp" });
  expect(out).toEqual({ rejected: true });
  expect(connected).toBe(false);
});

test("add_mcp_server: a failed connect is returned (not thrown) so the model can retry", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-tools-"));
  const mcp = {
    allTools: () => ({}),
    addServer: async (n: string) => ({ name: n, kind: "stdio", status: "error", toolCount: 0, error: "npx: package not found" }),
  } as unknown as McpManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = { ws, requestApproval: async () => ({ type: "approve" }) } as any;
  const set = toolsForAgent(agent(["add_mcp_server"]), c, mcp);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (set.add_mcp_server as any).execute({ name: "bad", command: "npx", args: ["-y", "nope"] });
  expect(out).toMatchObject({ name: "bad", status: "error" });
  expect(out.error).toContain("not found");
});

test("remember/recall: present only when granted", () => {
  const set = toolsForAgent(agent(["write_artifact"]), ctx);
  expect("remember" in set).toBe(false);
  expect("recall" in set).toBe(false);
  expect("remember" in toolsForAgent(agent(["remember"]), ctx)).toBe(true);
});

test("remember + recall: agent stores a linked fact and recalls it (keyword+graph)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-tools-kb-"));
  const db = openDb(ws);
  const c = { ws, db, agentId: "root", runId: "root/r1", notes: [] as string[] } as unknown as RunContext;
  const set = toolsForAgent(agent(["remember", "recall"]), c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = await (set.remember as any).execute({ title: "Deploy target", content: "we deploy to fly.io", kind: "decision" });
  expect(a.id).toMatch(/^kb_/);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = await (set.remember as any).execute({ title: "Region", content: "primary region is iad", edges: [{ to: a.id, rel: "part_of" }] });
  expect(b.edgesAdded).toBe(1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (set.recall as any).execute({ query: "deploy fly", k: 5, hops: 1 });
  const ids = out.hits.map((h: { id: string }) => h.id);
  expect(out.mode).toBe("keyword");
  expect(ids).toContain(a.id);                 // keyword hit
  expect(ids).toContain(b.id);                 // graph neighbor (linked to a)
});

test("remember drops dangling edge targets", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-tools-kb-"));
  const db = openDb(ws);
  const c = { ws, db, agentId: "a", runId: "a/1", notes: [] as string[] } as unknown as RunContext;
  const set = toolsForAgent(agent(["remember"]), c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (set.remember as any).execute({ title: "x", content: "y", edges: [{ to: "kb_nope", rel: "relates_to" }] });
  expect(out).toMatchObject({ edgesAdded: 0, edgesDropped: 1 });
});

test("remember stamps ingestSource provenance when set (else agentId:runId)", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-rem-"));
  const db = openDb(w);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = { ws: w, db, runId: "r1", agentId: "librarian", notes: [] as string[] } as any as RunContext;
  const ingestCtx = { ...base, ingestSource: "sources/a.md@abc123abc123" } as RunContext;

  const set = toolsForAgent(agent(["remember"]), ingestCtx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.remember!.execute!({ title: "Deploy", content: "x", kind: "entity", edges: [] }, { toolCallId: "1", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(readNode(w, (out as any).id)?.source).toBe("sources/a.md@abc123abc123");

  const set2 = toolsForAgent(agent(["remember"]), base);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out2 = await set2.remember!.execute!({ title: "Note", content: "y", kind: "fact", edges: [] }, { toolCallId: "2", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(readNode(w, (out2 as any).id)?.source).toBe("librarian:r1");
});

test("read_source reads kb/sources files (incl. benign dotted names) and rejects traversal", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-rs-"));
  mkdirSync(paths.kbSourceDir(w), { recursive: true });
  writeFileSync(paths.kbSourceFile(w, "a.md"), "alpha body");
  writeFileSync(paths.kbSourceFile(w, "foo..md"), "foo body");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rctx = { ws: w } as any as RunContext;
  const set = toolsForAgent(agent(["read_source"]), rctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((await set.read_source!.execute!({ path: "sources/a.md" }, { toolCallId: "1", messages: [] } as any) as any).content).toBe("alpha body");
  // a legitimately-named file containing ".." as a substring (not a traversal) must still be readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((await set.read_source!.execute!({ path: "sources/foo..md" }, { toolCallId: "2", messages: [] } as any) as any).content).toBe("foo body");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((await set.read_source!.execute!({ path: "../secret" }, { toolCallId: "3", messages: [] } as any) as any).error).toBeDefined();
});

test("forget tool cascades and rejects an empty filter", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-fg-"));
  const db = openDb(w);
  writeNode(w, db, KbNode.parse({ id: "kb_d", kind: "decision", title: "t", content: "c", source: "worker-x:r1", created: new Date().toISOString() }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fctx = { ws: w, db, notes: [] as string[] } as any as RunContext;
  const set = toolsForAgent(agent(["forget"]), fctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.forget!.execute!({ kind: "decision" }, { toolCallId: "1", messages: [] } as any);
  expect(out).toMatchObject({ removedNodes: 1 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const empty = await set.forget!.execute!({}, { toolCallId: "2", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((empty as any).error).toBeDefined();
});

test("find_skills + use_skill are granted to every agent and read active skills", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-sk-"));
  const db = openDb(w);
  writeSkill(w, db, Skill.parse({ id: "skill_dep", name: "deploy", description: "ship to prod", body: "1. build\n2. ship", created: new Date().toISOString() }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sctx = { db } as any as RunContext;
  const set = toolsForAgent(agent(["write_artifact"]), sctx); // NOT granted skills explicitly → still present
  expect(set.find_skills).toBeDefined();
  expect(set.use_skill).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = await set.find_skills!.execute!({ query: "how do I deploy", k: 6 }, { toolCallId: "1", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((found as any).matches.map((m: any) => m.name)).toContain("deploy");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const used = await set.use_skill!.execute!({ name: "deploy" }, { toolCallId: "2", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((used as any).body).toContain("1. build");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const miss = await set.use_skill!.execute!({ name: "nope" }, { toolCallId: "3", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((miss as any).error).toBeDefined();
});

test("propose_skill: present only when granted; approve writes an active skill; reject writes nothing", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-ps-"));
  const db = openDb(w);
  const approve = { requestApproval: async () => ({ type: "approve" }) } as unknown as RunContext;
  const ctx = { ...approve, ws: w, db, notes: [] as string[] } as unknown as RunContext;
  expect(toolsForAgent(agent(["write_artifact"]), ctx).propose_skill).toBeUndefined();

  const set = toolsForAgent(agent(["propose_skill"]), ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.propose_skill!.execute!({ name: "deploy", description: "how to deploy", body: "1. build\n2. ship", tags: ["ops"] }, { toolCallId: "1", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((out as any).id).toMatch(/^skill_/);
  expect(getActiveSkills(db).map((s) => s.name)).toContain("deploy");

  const rejectCtx = { requestApproval: async () => ({ type: "reject" }), ws: w, db, notes: [] as string[] } as unknown as RunContext;
  const set2 = toolsForAgent(agent(["propose_skill"]), rejectCtx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out2 = await set2.propose_skill!.execute!({ name: "nope", description: "x", body: "y", tags: [] }, { toolCallId: "2", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((out2 as any).rejected).toBe(true);
  expect(getActiveSkills(db).map((s) => s.name)).not.toContain("nope");
});

// ── artifact tools (Plan 01) ────────────────────────────────────────────────

test("save/read/list_artifacts: present only when granted", () => {
  const set = toolsForAgent(agent(["write_artifact"]), ctx);
  expect("save_artifact" in set).toBe(false);
  expect("read_artifact" in set).toBe(false);
  expect("list_artifacts" in set).toBe(false);
  const granted = toolsForAgent(agent(["save_artifact", "read_artifact", "list_artifacts"]), ctx);
  expect("save_artifact" in granted).toBe(true);
  expect("read_artifact" in granted).toBe(true);
  expect("list_artifacts" in granted).toBe(true);
});

// ── Plan 14: a create_agent'd worker is born WITH the artifact tools and can hand off by reference ──

test("PLAN 14: a worker created with NO tools AND one created with tools:[] BOTH get the artifact tools bound", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-p14-"));
  await ensureWorkspace(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  const artifactTools = ["save_artifact", "read_artifact", "list_artifacts", "annotate_artifact"];
  for (const [id, draft] of [
    ["no-field", { id: "no-field", role: "r", identity: "i" }],
    ["empty-arr", { id: "empty-arr", role: "r", identity: "i", tools: [] as string[] }],
  ] as const) {
    await createAgent(ws, db, draft, "root");
    const def = await loadAgent(ws, id);
    const set = toolsForAgent(def, { ws } as unknown as RunContext);
    for (const t of artifactTools) expect(t in set).toBe(true); // bound, not defeated by tools:[]
  }
});

test("PLAN 14: the created worker actually produces an artifact and hands it off BY REFERENCE (not loose text)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-p14-"));
  await ensureWorkspace(ws);
  const db = openDb(ws);
  await reindex(ws, db);
  const child = await createAgent(ws, db, { id: "researcher", role: "researches", identity: "i", tools: [] }, "root");
  // A delegated child's run ctx: it saves its work product and records the HANDLE for the parent.
  const c = { ws, agentId: child.id, runId: "researcher/2026-07-04-run6", artifacts: [] as string[], notes: [] as string[] } as unknown as RunContext;
  const set = toolsForAgent(child, c);
  const saved = await invoke(set.save_artifact, { title: "Research dossier", type: "dossier", summary: "the findings", body: "THE FULL DOSSIER BODY" }) as { handle: string };
  // Hand-off is BY REFERENCE: the parent receives a handle, and the body lives on disk — not inlined.
  expect(c.artifacts).toEqual([saved.handle]);
  expect(saved.handle).toBe("research-dossier@v1");
  const stored = readArtifact(ws, saved.handle)!;
  expect(stored.producer).toBe("researcher");
  expect(readArtifact(ws, saved.handle)?.summary).toBe("the findings");
});

test("PLAN 14 (regression witness): the OLD toolless state (tools:[]) binds NONE of the artifact tools", () => {
  // This is what every child in root/2026-07-04-run6 was: only the unconditional baseline was bound.
  const set = toolsForAgent(agent([]), ctx);
  expect(Object.keys(set).sort()).toEqual(["find_skills", "use_skill"]);
  for (const t of ["save_artifact", "read_artifact", "list_artifacts", "annotate_artifact"]) expect(t in set).toBe(false);
});

test("save_artifact stamps provenance from ctx (agentId + runId), pushes the handle, returns id@vN", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-sa-"));
  const c = { ws: w, agentId: "researcher", runId: "researcher/2026-07-04-run2", artifacts: [] as string[], notes: [] as string[] } as unknown as RunContext;
  const set = toolsForAgent(agent(["save_artifact"]), c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.save_artifact!.execute!({ title: "Foo dossier", type: "dossier", summary: "on foo", body: "big body" }, { toolCallId: "1", messages: [] } as any) as any;
  expect(out.handle).toBe("foo-dossier@v1");
  const stored = readArtifact(w, out.handle)!;
  expect(stored.producer).toBe("researcher");                    // provenance NOT model-supplied — pulled from ctx
  expect(stored.runId).toBe("researcher/2026-07-04-run2");
  expect(c.artifacts).toEqual(["foo-dossier@v1"]);               // handle recorded for the trace / hand-off
});

test("save_artifact requires a body or an external locator", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-sa-"));
  const c = { ws: w, agentId: "a", runId: "a/1", artifacts: [] as string[], notes: [] as string[] } as unknown as RunContext;
  const set = toolsForAgent(agent(["save_artifact"]), c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.save_artifact!.execute!({ title: "Empty" }, { toolCallId: "1", messages: [] } as any) as any;
  expect(out.error).toMatch(/body.*or.*external/);
});

test("read_artifact is summary-first: metadata + summary by default, NO body", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-ra-"));
  saveArtifact(w, { id: "doc", title: "Doc", type: "report", summary: "the short version", body: "THE FULL BODY", producer: "r", runId: "r/1" });
  const c = { ws: w, agentId: "root", runId: "root/1" } as unknown as RunContext;
  const set = toolsForAgent(agent(["read_artifact"]), c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.read_artifact!.execute!({ id: "doc" }, { toolCallId: "1", messages: [] } as any) as any;
  expect(out.summary).toBe("the short version");
  expect(out.handle).toBe("doc@v1");
  expect(out.bodyOmitted).toBe(true);
  expect(out.body).toBeUndefined();                              // body NOT returned by default
});

test("read_artifact body is size-capped and truncated with a marker when includeBody:true", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-ra-"));
  saveArtifact(w, { id: "big", title: "Big", body: "x".repeat(5000), producer: "r", runId: "r/1" });
  const c = { ws: w, agentId: "root", runId: "root/1" } as unknown as RunContext;
  const set = toolsForAgent(agent(["read_artifact"]), c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.read_artifact!.execute!({ id: "big", includeBody: true, maxChars: 1000 }, { toolCallId: "1", messages: [] } as any) as any;
  expect(out.truncated).toBe(true);
  expect(out.body.length).toBeLessThan(1200);                    // ~1000 + a short marker, NOT the full 5000
  expect(out.body).toContain("truncated");
});

test("read_artifact returns an actionable error for an unknown handle", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-ra-"));
  const c = { ws: w, agentId: "root", runId: "root/1" } as unknown as RunContext;
  const set = toolsForAgent(agent(["read_artifact"]), c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.read_artifact!.execute!({ id: "nope" }, { toolCallId: "1", messages: [] } as any) as any;
  expect(out.error).toMatch(/no artifact/);
});

test("list_artifacts discovers artifacts and filters by producer/type", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-la-"));
  saveArtifact(w, { id: "a", title: "A", type: "report", body: "1", producer: "r1", runId: "r1/1" });
  saveArtifact(w, { id: "b", title: "B", type: "brief", body: "2", producer: "r2", runId: "r2/1" });
  const c = { ws: w, agentId: "root", runId: "root/1" } as unknown as RunContext;
  const set = toolsForAgent(agent(["list_artifacts"]), c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all = await set.list_artifacts!.execute!({}, { toolCallId: "1", messages: [] } as any) as any;
  expect(all.artifacts.map((x: any) => x.id).sort()).toEqual(["a", "b"]);
  expect(all.artifacts[0].handle).toMatch(/@v1$/);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = await set.list_artifacts!.execute!({ type: "brief" }, { toolCallId: "2", messages: [] } as any) as any;
  expect(filtered.artifacts.map((x: any) => x.id)).toEqual(["b"]);
});

test("write_artifact (legacy) routes through the store: versioned + provenance, path still returned", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-wa-"));
  const c = { ws: w, agentId: "writer", runId: "writer/2026-07-04-run1", artifacts: [] as string[], notes: [] as string[] } as unknown as RunContext;
  const set = toolsForAgent(agent(["write_artifact"]), c);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.write_artifact!.execute!({ topicSlug: "hello", markdown: "# Hi" }, { toolCallId: "1", messages: [] } as any) as any;
  expect(existsSync(out.path)).toBe(true);                       // back-compat: the model still gets a real file path
  // hand-off graph records the HANDLE (id@vN) like save_artifact, NOT an un-resolvable absolute path.
  expect(c.artifacts).toEqual(["hello@v1"]);
  const stored = listArtifacts(w);
  expect(stored.length).toBe(1);
  expect(stored[0]).toMatchObject({ id: "hello", version: 1, producer: "writer" });
});

// ── run_command: sandbox-then-escalate + injection guard (Plan 08) ──

const rc = (over: Partial<RunContext>): RunContext =>
  ({ ws: "/ws", notes: [] as string[], untrusted: { entered: false, sources: [] }, ...over } as unknown as RunContext);
const okSandbox = (stdout = "SANDBOXED") => (() => ({ exitCode: 0, stdout, stderr: "", enforced: true })) as RunContext["runSandboxed"];
const deniedSandbox = () => (() => ({ exitCode: 1, stdout: "", stderr: "bash: /etc/x: Operation not permitted", enforced: true })) as RunContext["runSandboxed"];
const benignFailSandbox = () => (() => ({ exitCode: 1, stdout: "", stderr: "", enforced: true })) as RunContext["runSandboxed"]; // e.g. grep no-match — NOT a sandbox denial
const noSandbox = () => (() => ({ exitCode: -1, stdout: "", stderr: "no sandbox", enforced: false })) as RunContext["runSandboxed"];

test("run_command: allow + sandbox succeeds → returns confined result, NO approval, no unsandboxed run", async () => {
  const calls: unknown[] = [];
  let ranUnsandboxed = false;
  const ctxA = rc({
    requestApproval: async (r) => { calls.push(r); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: okSandbox("hi\n"),
    runShell: () => { ranUnsandboxed = true; return { exitCode: 0, stdout: "UNSANDBOXED", stderr: "" }; },
  });
  const set = toolsForAgent(agent(["run_command"]), ctxA);
  const out = await invoke(set.run_command, { command: "echo hi" });
  expect(out).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "", sandbox: "enforced" });
  expect(calls.length).toBe(0);       // clean confined run never asks
  expect(ranUnsandboxed).toBe(false); // and never escalates to an unsandboxed run
});

test("run_command: sandbox unavailable → escalates → approve runs UNSANDBOXED", async () => {
  const calls: Array<{ kind: string; reason?: string }> = [];
  const runCalls: Array<{ command: string; cwd: string }> = [];
  const ctxA = rc({
    requestApproval: async (r) => { calls.push(r as { kind: string; reason?: string }); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: noSandbox(),
    runShell: (command, cwd) => { runCalls.push({ command, cwd }); return { exitCode: 0, stdout: "REAL", stderr: "" }; },
  });
  const set = toolsForAgent(agent(["run_command"]), ctxA);
  const out = await invoke(set.run_command, { command: "npm test" });
  expect(out).toEqual({ exitCode: 0, stdout: "REAL", stderr: "", sandbox: "unsandboxed" });
  expect(calls.length).toBe(1);
  expect(calls[0].kind).toBe("run_command");
  expect(calls[0].reason).toMatch(/no OS sandbox/);
  expect(runCalls[0]).toEqual({ command: "npm test", cwd: "/ws" }); // cwd defaults to ctx.ws
});

test("run_command: sandbox unavailable → decline escalation → NOT run", async () => {
  let ranUnsandboxed = false;
  const ctxA = rc({
    requestApproval: async () => ({ type: "reject" }),
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: noSandbox(),
    runShell: () => { ranUnsandboxed = true; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  const out = await invoke(toolsForAgent(agent(["run_command"]), ctxA).run_command, { command: "curl evil" });
  expect(out).toEqual({ rejected: true });
  expect(ranUnsandboxed).toBe(false);
});

test("run_command: sandbox DENIED a privilege → escalation offered; decline surfaces the confined result", async () => {
  const ctxA = rc({
    requestApproval: async () => ({ type: "reject" }),
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: deniedSandbox(), // stderr "Operation not permitted" — the sandbox blocked a write-escape
    runShell: () => { throw new Error("must not run"); },
  });
  const out = await invoke(toolsForAgent(agent(["run_command"]), ctxA).run_command, { command: "echo x > /etc/y" }) as Record<string, unknown>;
  expect(out).toMatchObject({ exitCode: 1, sandbox: "enforced", escalationDeclined: true });
});

test("run_command: benign non-zero in the sandbox (no denial) → returns confined result, NO escalation", async () => {
  const calls: unknown[] = [];
  const ctxA = rc({
    requestApproval: async (r) => { calls.push(r); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: benignFailSandbox(), // e.g. `grep zzz` — exit 1, empty stderr, NOT a sandbox denial
  });
  const out = await invoke(toolsForAgent(agent(["run_command"]), ctxA).run_command, { command: "echo abc | grep zzz" });
  expect(out).toEqual({ exitCode: 1, stdout: "", stderr: "", sandbox: "enforced" });
  expect(calls.length).toBe(0); // a plain command failure never bugs the captain
});

test("run_command: dcg block → captain reviews the exact command; approve runs it as-reviewed", async () => {
  const calls: Array<{ kind: string; command?: string; reason?: string }> = [];
  let ranSandbox = false;
  const ctxA = rc({
    requestApproval: async (r) => { calls.push(r as { kind: string; command?: string; reason?: string }); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "block", reason: "rm is destructive" }),
    runSandboxed: () => { ranSandbox = true; return { exitCode: 0, stdout: "", stderr: "", enforced: true }; },
    runShell: () => ({ exitCode: 0, stdout: "done", stderr: "" }),
  });
  const out = await invoke(toolsForAgent(agent(["run_command"]), ctxA).run_command, { command: "rm x" });
  expect(out).toEqual({ exitCode: 0, stdout: "done", stderr: "", sandbox: "approved" });
  expect(calls[0].kind).toBe("run_command");
  expect(calls[0].command).toBe("rm x");                // captain sees the exact command
  expect(calls[0].reason).toBe("rm is destructive");
  expect(ranSandbox).toBe(false);                       // human-reviewed → runs as-approved, no sandbox dance
});

test("run_command: dcg block → reject → nothing runs", async () => {
  let ran = false;
  const ctxA = rc({
    requestApproval: async () => ({ type: "reject" }),
    classifyCommand: () => ({ decision: "block", reason: "danger" }),
    runSandboxed: () => { ran = true; return { exitCode: 0, stdout: "", stderr: "", enforced: true }; },
    runShell: () => { ran = true; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  const out = await invoke(toolsForAgent(agent(["run_command"]), ctxA).run_command, { command: "rm x" });
  expect(out).toEqual({ rejected: true });
  expect(ran).toBe(false); // rejected before any execution
});

test("INJECTION GUARD: after untrusted content, a dcg-`allow` run_command STILL forces approval", async () => {
  const calls: Array<{ kind: string; reason?: string }> = [];
  let sandboxUsed = false;
  const ctxA = rc({
    untrusted: { entered: true, sources: ["read_url"] }, // as if read_url already returned this run
    requestApproval: async (r) => { calls.push(r as { kind: string; reason?: string }); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" }),      // dcg says allow — must NOT be enough
    runSandboxed: () => { sandboxUsed = true; return { exitCode: 0, stdout: "", stderr: "", enforced: true }; },
    runShell: () => ({ exitCode: 0, stdout: "out", stderr: "" }),
  });
  const out = await invoke(toolsForAgent(agent(["run_command"]), ctxA).run_command, { command: "echo ok" });
  expect(out).toEqual({ exitCode: 0, stdout: "out", stderr: "", sandbox: "approved" });
  expect(calls.length).toBe(1);                          // the injection guard fired despite dcg allow
  expect(calls[0].kind).toBe("run_command");
  expect(calls[0].reason).toMatch(/untrusted content.*injection/i);
  expect(sandboxUsed).toBe(false);                       // routed to human review, not the auto-run sandbox
});

test("INJECTION GUARD: before any untrusted content, an allow command follows the normal (no Gate-1) path", async () => {
  const calls: unknown[] = [];
  const ctxA = rc({
    requestApproval: async (r) => { calls.push(r); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: okSandbox(),
  });
  await invoke(toolsForAgent(agent(["run_command"]), ctxA).run_command, { command: "ls" });
  expect(calls.length).toBe(0); // untrusted.entered is false → no forced approval
});

test("INJECTION GUARD end-to-end: an MCP tool result arms ctx.untrusted, then run_command forces approval", async () => {
  const calls: Array<{ kind: string; reason?: string }> = [];
  // A granted MCP tool that returns external content (arms the guard via the instrument seam).
  const mcp = { toolsForRef: (ref: string) => (ref === "web" ? { web_search: fakeTool } : {}) } as unknown as McpManager;
  const shared = rc({
    requestApproval: async (r) => { calls.push(r as { kind: string; reason?: string }); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: okSandbox(),
    runShell: () => ({ exitCode: 0, stdout: "ran", stderr: "" }),
  });
  const set = toolsForAgent(agent(["run_command", "mcp:web"]), shared, mcp);
  // 1) the granted MCP tool returns external content → arms ctx.untrusted (via the instrument seam).
  await invoke(set.web_search, {});
  expect(shared.untrusted.entered).toBe(true);
  expect(shared.untrusted.sources).toContain("web_search");
  // 2) now a run_command is forced through approval even though dcg said allow.
  const out = await invoke(set.run_command, { command: "echo pwned" });
  expect(out).toMatchObject({ sandbox: "approved" });
  expect(calls.length).toBe(1);
  expect(calls[0].reason).toMatch(/untrusted content.*injection/i);
});

// ── Fix 1 (PR #13 review): sandbox-escape via a model-supplied cwd ──

test("run_command: a cwd OUTSIDE the workspace is forced to approval and NEVER auto-sandboxed", async () => {
  const calls: Array<{ kind: string; cwd?: string; reason?: string }> = [];
  let sandboxUsed = false;
  const ranAt: string[] = [];
  const ctxA = rc({
    ws: "/ws",
    requestApproval: async (r) => { calls.push(r as { kind: string; cwd?: string; reason?: string }); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" }),                                   // dcg allow — must NOT be enough
    runSandboxed: () => { sandboxUsed = true; return { exitCode: 0, stdout: "", stderr: "", enforced: true }; },
    runShell: (command, cwd) => { ranAt.push(cwd); return { exitCode: 0, stdout: "ran", stderr: "" }; },
  });
  const out = await invoke(toolsForAgent(agent(["run_command"]), ctxA).run_command, { command: "echo hi", cwd: "/etc" });
  expect(out).toMatchObject({ sandbox: "approved" });
  expect(sandboxUsed).toBe(false);              // an out-of-ws cwd is NEVER handed to the sandbox (no silent widening)
  expect(calls.length).toBe(1);
  expect(calls[0].kind).toBe("run_command");
  expect(calls[0].cwd).toBe("/etc");            // the captain SEES where it would run
  expect(calls[0].reason).toMatch(/OUTSIDE the workspace/);
  expect(ranAt).toEqual(["/etc"]);              // approved → runs there, unsandboxed
});

test("run_command: an out-of-ws cwd, approval declined → nothing runs", async () => {
  let ran = false;
  const ctxA = rc({
    ws: "/ws",
    requestApproval: async () => ({ type: "reject" }),
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: () => { ran = true; return { exitCode: 0, stdout: "", stderr: "", enforced: true }; },
    runShell: () => { ran = true; return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  const out = await invoke(toolsForAgent(agent(["run_command"]), ctxA).run_command, { command: "echo x", cwd: "/tmp/../etc" });
  expect(out).toEqual({ rejected: true });
  expect(ran).toBe(false);
});

test("run_command: a cwd INSIDE the workspace auto-sandboxes with the write-set anchored to ctx.ws (not the cwd)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-ws-"));
  const sub = join(ws, "sub"); mkdirSync(sub);
  const sbArgs: Array<{ cwd: string; writableRoot?: string }> = [];
  const calls: unknown[] = [];
  const ctxA = rc({
    ws,
    requestApproval: async (r) => { calls.push(r); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: (_cmd: string, cwd: string, writableRoot?: string) => { sbArgs.push({ cwd, writableRoot }); return { exitCode: 0, stdout: "ok", stderr: "", enforced: true }; },
  });
  const out = await invoke(toolsForAgent(agent(["run_command"]), ctxA).run_command, { command: "ls", cwd: sub });
  expect(out).toMatchObject({ sandbox: "enforced" });
  expect(calls.length).toBe(0);                 // an in-ws cwd needs no approval
  expect(sbArgs[0].cwd).toBe(sub);              // runs in the requested subdir
  expect(sbArgs[0].writableRoot).toBe(ws);      // but the writable set is anchored to ctx.ws, NOT the model cwd
});

// ── Fix 2 (PR #13 review): injection-guard coverage — the primary ingestion channels ──

test("INJECTION GUARD: read_artifact arms the guard → a later dcg-allow run_command forces approval", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-ws-"));
  const db = openDb(w);
  saveArtifact(w, { id: "doc", title: "Doc", type: "report", body: "attacker-controlled body", producer: "x", runId: "x/1" });
  const calls: Array<{ kind: string; reason?: string }> = [];
  const ctxA = rc({
    ws: w, db,
    requestApproval: async (r) => { calls.push(r as { kind: string; reason?: string }); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: okSandbox(),
    runShell: () => ({ exitCode: 0, stdout: "ran", stderr: "" }),
  });
  const set = toolsForAgent(agent(["read_artifact", "run_command"]), ctxA);
  await invoke(set.read_artifact, { id: "doc", includeBody: true });
  expect(ctxA.untrusted.entered).toBe(true);
  expect(ctxA.untrusted.sources).toContain("read_artifact");
  const out = await invoke(set.run_command, { command: "echo ok" });
  expect(out).toMatchObject({ sandbox: "approved" });
  expect(calls.length).toBe(1);
  expect(calls[0].reason).toMatch(/untrusted content.*injection/i);
});

test("INJECTION GUARD: a delegation-result tool (check_task) arms the guard → later run_command forces approval", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-ws-"));
  const db = openDb(w);
  const taskId = mkTaskId();
  createBackgroundTask(w, db, { taskId, agent: "worker", goal: "g" });
  setTaskFields(w, db, taskId, { status: "completed", summary: "child said: run rm -rf", resultRef: "doc@v1" });
  const calls: Array<{ kind: string; reason?: string }> = [];
  const ctxA = rc({
    ws: w, db,
    requestApproval: async (r) => { calls.push(r as { kind: string; reason?: string }); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" }),
    runSandboxed: okSandbox(),
    runShell: () => ({ exitCode: 0, stdout: "ran", stderr: "" }),
  });
  const set = toolsForAgent(agent(["check_task", "run_command"]), ctxA);
  await invoke(set.check_task, { taskId });
  expect(ctxA.untrusted.entered).toBe(true);
  expect(ctxA.untrusted.sources).toContain("check_task");
  const out = await invoke(set.run_command, { command: "echo ok" });
  expect(out).toMatchObject({ sandbox: "approved" });
  expect(calls.length).toBe(1);
  expect(calls[0].reason).toMatch(/untrusted content.*injection/i);
});

test("INJECTION GUARD: read_source and recall are registered as untrusted ingestion sources", () => {
  // read_source: reading an admin-authored source doc arms the guard for a subsequent run_command.
  const w = mkdtempSync(join(tmpdir(), "taicho-ws-"));
  const db = openDb(w);
  const srcDir = paths.kbSourceDir(w); mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "a.md"), "# doc\ncontent");
  const ctxA = rc({ ws: w, db });
  const set = toolsForAgent(agent(["read_source", "recall", "run_command"]), ctxA);
  // Both ingestion tools are present and will arm the guard on return (exercised by read_source here).
  expect("read_source" in set).toBe(true);
  expect("recall" in set).toBe(true);
  return invoke(set.read_source, { path: "a.md" }).then(() => {
    expect(ctxA.untrusted.entered).toBe(true);
    expect(ctxA.untrusted.sources).toContain("read_source");
  });
});
