import { test, expect } from "bun:test";
import { tool } from "ai";
import { z } from "zod";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolsForAgent } from "./tools";
import type { AgentDef } from "../schemas/agent";
import type { RunContext } from "./run";
import type { McpManager } from "./mcp/manager";
import { readMcpStore } from "../store/mcp-store";

const fakeTool = tool({ description: "x", inputSchema: z.object({}), execute: async () => ({}) });
const fakeMcp = {
  toolsForRef: (ref: string) =>
    ref === "web" ? { web_search: fakeTool, web_extract: fakeTool }
    : ref === "web/search" ? { web_search: fakeTool }
    : {},
} as unknown as McpManager;

const agent = (tools: string[]): AgentDef => ({
  id: "a", role: "r", identity: "i", tools, canSee: ["*"], canDelegateTo: [],
  budgets: { maxIterationsPerRun: 5, maxWorkItemsPerRequest: 5 }, isRoot: false,
  created: "2026-06-11T00:00:00.000Z",
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = {} as RunContext;

test("merges all of a server's tools for mcp:<server>", () => {
  const set = toolsForAgent(agent(["write_artifact", "mcp:web"]), ctx, fakeMcp);
  expect(Object.keys(set).sort()).toEqual(["web_extract", "web_search", "write_artifact"]);
});

test("merges a single tool for mcp:<server>/<tool>", () => {
  const set = toolsForAgent(agent(["mcp:web/search"]), ctx, fakeMcp);
  expect(Object.keys(set)).toEqual(["web_search"]);
});

test("unknown mcp ref contributes nothing", () => {
  const set = toolsForAgent(agent(["mcp:nope"]), ctx, fakeMcp);
  expect(Object.keys(set)).toEqual([]);
});

test("without a manager, only built-ins are present", () => {
  const set = toolsForAgent(agent(["write_artifact", "mcp:web"]), ctx);
  expect(Object.keys(set)).toEqual(["write_artifact"]);
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
  // server "create" + tool "agent" namespaces to create_agent — must NOT replace the built-in.
  const shadow = { toolsForRef: (ref: string) => (ref === "create" ? { create_agent: fakeTool } : {}) } as unknown as McpManager;
  const set = toolsForAgent(agent(["create_agent", "mcp:create"]), ctx, shadow);
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
    toolsForRef: () => ({}),
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
    toolsForRef: () => ({}),
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
    toolsForRef: () => ({}),
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
