/** End-to-end REPL tests: render the real <App> into a virtual terminal (ink-testing-library),
 *  script keystrokes, and assert on rendered frames. The model is mocked (ai/test) and the MCP
 *  manager is a fake — so these exercise the actual submit → runSlash → executeRun → runLoop wiring
 *  with no real terminal, LLM, or MCP server.
 *
 *  Interaction note: each keystroke chunk is written as its OWN stdin event (ink parses a single
 *  multi-char chunk as literal input, so "text\r" would NOT submit). Arrow keys are ANSI escapes. */
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { MockLanguageModelV3, mockValues } from "ai/test";
import { simulateReadableStream } from "ai";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./App";
import { ensureWorkspace, paths } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, loadIndex, seedLibrarian } from "../store/roster";
import { listTraces } from "../store/trace";
import { readMcpStore } from "../store/mcp-store";
import { writeNode, resolveNodeIds } from "../store/knowledge";
import { KbNode } from "../schemas/knowledge";
import type { AuthSource } from "../store/config";
import type { McpManager, McpServerStatus } from "../core/mcp/manager";

const ENTER = "\r";
const DOWN = "[B";

const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } } as const;
const finalText = (text: string) =>
  ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockModel = (text: string) => new MockLanguageModelV3({ doGenerate: mockValues(finalText(text)) as any });

function fakeMcp(over: Partial<McpManager> = {}): McpManager {
  const ok = (name: string): McpServerStatus => ({ name, kind: "stdio", status: "connected", toolCount: 0 });
  return {
    toolsForRef: () => ({}),
    allTools: () => ({}),
    list: () => [],
    addServer: async (n) => ok(n),
    removeServer: async () => true,
    login: async (n) => ok(n),
    reconnect: async (n) => ok(n),
    closeAll: async () => {},
    ...over,
  } as McpManager;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function setup(opts: { model?: any; mcp?: McpManager; authKind?: "env" | "none"; subscription?: boolean } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "taicho-app-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  const db = openDb(ws);
  if (loadIndex(db).length === 0) await reindex(ws, db);
  const roster = loadIndex(db);
  const model = opts.model ?? null;
  const authSource: AuthSource = opts.authKind === "none" ? { kind: "none" } : { kind: "env", provider: "openai", model: "gpt-5.5" };
  const props = {
    ws, db, roster, model,
    cfg: { provider: "openai", model: "gpt-5.5" },
    resolveModel: model ? () => ({ model, modelId: "mock", subscription: opts.subscription === true }) : undefined,
    authSource,
    buildFromAuth: () => ({ model }),
    onLogin: async () => authSource,
    onLogout: () => true,
    mcp: opts.mcp,
    mcpYamlServers: [] as string[],
  };
  return { ws, db, props };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function send(stdin: any, ...chunks: string[]): Promise<void> {
  for (const c of chunks) { stdin.write(c); await sleep(20); }
}

async function waitFor(frame: () => string | undefined, sub: string, timeout = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if ((frame() ?? "").includes(sub)) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for "${sub}".\nLast frame:\n${frame()}`);
    await sleep(15);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mkNode = (over: object) =>
  KbNode.parse({ id: "kb_" + Math.random().toString(36).slice(2, 8), title: "t", content: "c", created: new Date().toISOString(), ...over });

test("boots to a banner mentioning taicho", async () => {
  const { props } = await setup({ model: mockModel("hi") });
  const { lastFrame } = render(<App {...props} />);
  expect(lastFrame()).toContain("taicho");
});

test("/help lists the command grammar", async () => {
  const { props } = await setup();
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/help", ENTER);
  await waitFor(lastFrame, "/agents");
  expect(lastFrame()).toContain("/mcp");
});

test("/agents lists the seeded root", async () => {
  const { props } = await setup();
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/agents", ENTER);
  await waitFor(lastFrame, "root");
});

test("/status shows the env auth source", async () => {
  const { props } = await setup();
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/status", ENTER);
  await waitFor(lastFrame, "openai");
});

test("suggester: ↓ moves the › highlight and Enter runs the highlighted no-arg command", async () => {
  const { props } = await setup();
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/");
  await waitFor(lastFrame, "/help");
  expect(lastFrame()).toContain("› /help");      // first row highlighted
  await send(stdin, DOWN);
  await waitFor(lastFrame, "› /agents");          // highlight moved
  await send(stdin, ENTER);                        // /agents takes no arg → runs immediately
  await waitFor(lastFrame, "* root");
});

test("/mcp list renders the manager's servers", async () => {
  const mcp = fakeMcp({ list: () => [{ name: "web", kind: "stdio", status: "connected", toolCount: 3 }] });
  const { props } = await setup({ mcp });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/mcp list", ENTER);
  await waitFor(lastFrame, "web");
  expect(lastFrame()).toContain("3 tool(s)");
});

test("/mcp add connects via the manager AND persists to the store", async () => {
  const added: Array<[string, unknown]> = [];
  const mcp = fakeMcp({ addServer: async (n, s) => { added.push([n, s]); return { name: n, kind: "stdio", status: "connected", toolCount: 2 }; } });
  const { ws, props } = await setup({ mcp });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/mcp add web npx -y tavily-mcp", ENTER);
  await waitFor(lastFrame, "connected");
  expect(added).toEqual([["web", { command: "npx", args: ["-y", "tavily-mcp"] }]]);
  expect(readMcpStore(ws).web).toEqual({ command: "npx", args: ["-y", "tavily-mcp"] });
});

test("/mcp with no manager reports disabled", async () => {
  const { props } = await setup({ mcp: undefined });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/mcp list", ENTER);
  await waitFor(lastFrame, "MCP is disabled");
});

test("/mcp add with a bad name is rejected before touching the manager", async () => {
  const added: string[] = [];
  const mcp = fakeMcp({ addServer: async (n) => { added.push(n); return { name: n, kind: "stdio", status: "connected", toolCount: 0 }; } });
  const { props } = await setup({ mcp });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/mcp add a/b npx x", ENTER);
  await waitFor(lastFrame, "invalid server name");
  expect(added).toEqual([]);
});

test("a chat message runs end-to-end: renders the reply and persists a completed trace", async () => {
  const { ws, props } = await setup({ model: mockModel("hello from root") });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "say hi", ENTER);
  await waitFor(lastFrame, "hello from root");
  expect(lastFrame()).toContain("root: hello from root");           // rendered as an agent line
  const done = listTraces(ws, "root").filter((t) => t.outcome === "completed");
  expect(done.length).toBeGreaterThan(0);                            // the run actually executed…
  expect(done.at(-1)!.tokens).toBeGreaterThan(0);                    // …and metered tokens
});

test("shows the animated run status (spinner + activity + elapsed + hint) while a run is in flight", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slow = new MockLanguageModelV3({ doGenerate: (async () => { await sleep(250); return finalText("done"); }) as any });
  const { props } = await setup({ model: slow });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "go", ENTER);
  await waitFor(lastFrame, "thinking…");                          // live activity label
  expect(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(lastFrame() ?? "")).toBe(true);    // a braille spinner frame
  expect(lastFrame()).toContain("esc to cancel");                 // controls hint
  await waitFor(lastFrame, "done");                               // run finishes → reply shows
});

test("@agent addressing routes a task to a specific agent", async () => {
  const { props } = await setup({ model: mockModel("root acknowledges") });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "@root ping", ENTER);
  await waitFor(lastFrame, "root acknowledges");
});

test("ask_human end-to-end: agent asks, the card renders, captain picks, the run resumes with the answer", async () => {
  const askCall = {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "ask_human", input: JSON.stringify({ question: "Which body?", options: ["Moon", "Mars"] }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
  } as unknown as LanguageModelV3GenerateResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(askCall, finalText("Got it — Moon")) as any });
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "research a planet", ENTER);
  await waitFor(lastFrame, "Which body?");          // the QuestionCard rendered the agent's question
  expect(lastFrame()).toContain("1. Moon");
  expect(lastFrame()).toContain("2. Mars");
  await send(stdin, "1");                             // captain picks option 1
  await waitFor(lastFrame, "Got it — Moon");         // answer flowed back; run resumed and replied
});

test("create_agent end-to-end: agent proposes, the card renders, captain approves, the run resumes", async () => {
  const createCall = {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "create_agent", input: JSON.stringify({ id: "scout", role: "Scouts terrain", identity: "A careful scout" }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
  } as unknown as LanguageModelV3GenerateResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(createCall, finalText("Created scout")) as any });
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "make a scout", ENTER);
  await waitFor(lastFrame, "New agent");             // the ProposalCard rendered the proposal
  expect(lastFrame()).toContain("scout");
  await send(stdin, "y");                             // captain approves
  await waitFor(lastFrame, "Created scout");         // approval flowed back; run resumed and replied
});

test("run_command end-to-end: agent runs a command, the guard blocks, the card renders, captain approves", async () => {
  const runCall = {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "run_command", input: JSON.stringify({ command: "echo taicho-e2e" }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
  } as unknown as LanguageModelV3GenerateResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(runCall, finalText("ran it")) as any });
  const { db, props } = await setup({ model });
  // grant root run_command in this workspace (seedRoot reconciles built-ins, but be explicit for the test)
  const { loadAgent } = await import("../store/roster");
  const root = await loadAgent(props.ws, "root");
  if (!root.tools.includes("run_command")) { /* reconciled at boot; setup seeds root so it's present */ }
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "run echo for me", ENTER);
  await waitFor(lastFrame, "Run command");        // the approval card rendered (dcg absent → blocked)
  expect(lastFrame()).toContain("echo taicho-e2e");
  await send(stdin, "y");                           // captain approves
  await waitFor(lastFrame, "ran it");               // command ran, run resumed and replied
});

test("subscription path streams the reply live: deltas assemble into the rendered response", async () => {
  const chunks = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: "stream" },
    { type: "text-delta", id: "1", delta: "ed " },
    { type: "text-delta", id: "1", delta: "reply" },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doStream: (async () => ({ stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 15, chunks }) })) as any });
  const { ws, props } = await setup({ model, subscription: true });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "go", ENTER);
  await waitFor(lastFrame, "streamed reply");           // assembled live from the streamed deltas
  expect(lastFrame()).toContain("root: streamed reply");
  // The reply renders LIVE (before the run finishes), so poll for the completed trace rather than
  // assuming completion the instant the text appears.
  const start = Date.now();
  let done = listTraces(ws, "root").filter((t) => t.outcome === "completed");
  while (done.length === 0 && Date.now() - start < 2000) { await sleep(20); done = listTraces(ws, "root").filter((t) => t.outcome === "completed"); }
  expect(done.length).toBeGreaterThan(0);               // the run completed via the streaming path
});

test("no credentials: a chat message is refused without burning tokens", async () => {
  const { props } = await setup({ model: null });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "hello", ENTER);
  await waitFor(lastFrame, "No credentials");
});

test("add_mcp end-to-end: agent proposes a server, the card renders, captain approves, run resumes", async () => {
  const addCall = {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "add_mcp_server", input: JSON.stringify({ name: "tavily", url: "https://api.tavily.com/mcp", auth: "oauth" }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
  } as unknown as LanguageModelV3GenerateResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(addCall, finalText("Connected tavily (3 tools)")) as any });
  const connected: string[] = [];
  const mcp = fakeMcp({ addServer: async (n) => { connected.push(n); return { name: n, kind: "http", status: "connected", toolCount: 3 }; } });
  const { props } = await setup({ model, mcp });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "add the tavily mcp from its docs", ENTER);
  await waitFor(lastFrame, "Add MCP server");          // the ProposalCard rendered the proposal
  expect(lastFrame()).toContain("tavily");
  expect(lastFrame()).toContain("https://api.tavily.com/mcp"); // transport field
  expect(lastFrame()).toContain("oauth");                       // env field
  await send(stdin, "y");                               // captain approves
  await waitFor(lastFrame, "Connected tavily");         // connect ran, run resumed
  expect(connected).toEqual(["tavily"]);
});

test("/kb list on an empty KB reports no matches", async () => {
  const { props } = await setup();
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/kb list", ENTER);
  await waitFor(lastFrame, "no matching nodes");
});

test("/kb list shows a stored node", async () => {
  const { ws, db, props } = await setup();
  writeNode(ws, db, mkNode({ id: "kb_a", title: "Alpha", kind: "fact" }));
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/kb list", ENTER);
  await waitFor(lastFrame, "Alpha");
});

test("/kb forget kind=… actually deletes (asserted against the DB)", async () => {
  const { ws, db, props } = await setup();
  writeNode(ws, db, mkNode({ id: "kb_dec", kind: "decision", title: "D" }));
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/kb forget kind=decision", ENTER);
  await waitFor(lastFrame, "forgot 1 node");
  expect(resolveNodeIds(db, { kind: "decision" })).toEqual([]);
});

test("/kb forget with no filter is refused by the parser", async () => {
  const { props } = await setup();
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/kb forget", ENTER);
  await waitFor(lastFrame, "at least one");
});

test("/kb reindex rebuilds from files", async () => {
  const { ws, db, props } = await setup();
  writeNode(ws, db, mkNode({ id: "kb_r", title: "R" }));
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/kb reindex", ENTER);
  await waitFor(lastFrame, "reindexed from files");
});

test("/kb sync with no model is refused", async () => {
  const { props } = await setup({});
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/kb sync", ENTER);
  await waitFor(lastFrame, "needs a model");
});

test("/kb sync drives the librarian to ingest a source doc (mocked model, real wiring)", async () => {
  const rememberCall = {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "remember",
      input: JSON.stringify({ title: "Deploy pipeline", content: "pushes to prod", kind: "entity", edges: [] }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
  } as unknown as LanguageModelV3GenerateResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(rememberCall, finalText("ingested deploy.md")) as any });
  const { ws, db, props } = await setup({ model });
  await seedLibrarian(ws);
  mkdirSync(paths.kbSourceDir(ws), { recursive: true });
  writeFileSync(paths.kbSourceFile(ws, "deploy.md"), "# Deploy\nThe deploy pipeline pushes to prod.\n");
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/kb sync", ENTER);
  await waitFor(lastFrame, "1 doc(s) ingested", 8000);
  expect(resolveNodeIds(db, { sourcePrefix: "sources/deploy.md@" }).length).toBeGreaterThan(0);
});

test("/skills list and /skills show render seeded skills", async () => {
  const { db, props } = await setup();
  const { writeSkill } = await import("../store/skills");
  const { Skill } = await import("../schemas/skill");
  writeSkill(props.ws, db, Skill.parse({ id: "skill_dep", name: "deploy", description: "ship to prod", body: "1. build\n2. ship", created: new Date().toISOString() }));
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/skills list", ENTER);
  await waitFor(lastFrame, "deploy");
  expect(lastFrame()).toContain("ship to prod");
  await send(stdin, "/skills show deploy", ENTER);
  await waitFor(lastFrame, "1. build");
});
