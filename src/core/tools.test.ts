import { test, expect } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

const fakeTool = tool({ description: "x", inputSchema: z.object({}), execute: async () => ({}) });
const fakeMcp = {
  allTools: () => ({ web_search: fakeTool, web_extract: fakeTool }),
} as unknown as McpManager;

const agent = (tools: string[]): AgentDef => ({
  id: "a", role: "r", identity: "i", tools, canSee: ["*"], canDelegateTo: [],
  budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 5 }, isRoot: false,
  created: "2026-06-11T00:00:00.000Z",
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = {} as RunContext;

test("every agent gets all connected MCP tools (default-grant, no mcp:<server> ref needed)", () => {
  const set = toolsForAgent(agent(["write_artifact"]), ctx, fakeMcp);
  expect(Object.keys(set).sort()).toEqual(["find_skills", "use_skill", "web_extract", "web_search", "write_artifact"]);
});

test("without a manager, only built-ins are present", () => {
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
  // a connected server exposing a tool that namespaces to create_agent must NOT replace the built-in.
  const shadow = { allTools: () => ({ create_agent: fakeTool }) } as unknown as McpManager;
  const set = toolsForAgent(agent(["create_agent"]), ctx, shadow);
  expect(set.create_agent?.description).toContain("Propose"); // the built-in, not fakeTool ("x")
});

test("read_url: present only when granted", () => {
  expect("read_url" in toolsForAgent(agent(["read_url"]), ctx)).toBe(true);
  expect("read_url" in toolsForAgent(agent(["write_artifact"]), ctx)).toBe(false);
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

test("run_command: allow → runs without approval; block → asks then runs on approve; reject → no run", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-rc-"));
  const db = openDb(w);
  const runCalls: Array<{ command: string; cwd: string }> = [];
  const fakeRun = (command: string, cwd: string) => { runCalls.push({ command, cwd }); return { exitCode: 0, stdout: "OUTPUT", stderr: "" }; };

  // allow → runs, no approval requested
  const calls: unknown[] = [];
  const allowCtx = { ws: w, db, notes: [] as string[],
    requestApproval: async (r: unknown) => { calls.push(r); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" as const }), runShell: fakeRun } as unknown as RunContext;
  const set = toolsForAgent(agent(["run_command"]), allowCtx);
  expect(set.run_command).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = await set.run_command!.execute!({ command: "echo hi" }, { toolCallId: "1", messages: [] } as any);
  expect(a).toEqual({ exitCode: 0, stdout: "OUTPUT", stderr: "" });
  expect(calls.length).toBe(0); // allow path never asks
  expect(runCalls[0]).toEqual({ command: "echo hi", cwd: w }); // no cwd passed in → defaults to ctx.ws

  // block → asks; approve → runs
  const blockCtx = { ws: w, db, notes: [] as string[],
    requestApproval: async (r: unknown) => { calls.push(r); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "block" as const, reason: "danger" }), runShell: fakeRun } as unknown as RunContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = await toolsForAgent(agent(["run_command"]), blockCtx).run_command!.execute!({ command: "rm x" }, { toolCallId: "2", messages: [] } as any);
  expect(b).toEqual({ exitCode: 0, stdout: "OUTPUT", stderr: "" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((calls[0] as any).kind).toBe("run_command");

  // block → reject → does not run
  let ran = false;
  const rejectCtx = { ws: w, db, notes: [] as string[],
    requestApproval: async () => ({ type: "reject" }),
    classifyCommand: () => ({ decision: "block" as const, reason: "danger" }),
    runShell: () => { ran = true; return { exitCode: 0, stdout: "", stderr: "" }; } } as unknown as RunContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = await toolsForAgent(agent(["run_command"]), rejectCtx).run_command!.execute!({ command: "rm x" }, { toolCallId: "3", messages: [] } as any);
  expect(c).toEqual({ rejected: true });
  expect(ran).toBe(false);
});
