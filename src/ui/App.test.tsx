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

async function waitForGone(frame: () => string | undefined, sub: string, timeout = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!(frame() ?? "").includes(sub)) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for "${sub}" to disappear.\nLast frame:\n${frame()}`);
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

test("boot renders the ANSI-shadow figlet banner", async () => {
  const { props } = await setup({ model: mockModel("hi") });
  const { lastFrame } = render(<App {...props} />);
  expect(lastFrame()).toContain("█"); // the block-glyph banner appears at the top on launch
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

test("suggester highlight STAYS put across re-renders (uncontrolled @inkjs/ui onChange must not reset it)", async () => {
  // Regression: @inkjs/ui TextInput fires onChange from an effect keyed on the onChange ref, and its
  // previousValue lags a keystroke — a fresh inline onChange re-fired every render and snapped the
  // highlight back to row 0. With a stable onChange, ↓↓ lands on row 2 and holds.
  const { props } = await setup();
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/");
  await waitFor(lastFrame, "/help");
  await send(stdin, DOWN);
  await waitFor(lastFrame, "› /agents");           // row 1
  await send(stdin, DOWN);
  await waitFor(lastFrame, "› /runs");             // row 2 — proves it advanced twice, not reset
  await sleep(60);                                  // let any stray re-render/onChange fire
  expect(lastFrame()).toContain("› /runs");        // still on row 2, not snapped back to /help
});

test("the input clears after submitting a message (uncontrolled TextInput remounts on submit)", async () => {
  const { props } = await setup({ model: mockModel("ok") });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "hello there", ENTER);
  await waitFor(lastFrame, "ok");                    // the run completed and root replied
  await sleep(60);
  // "hello there" must appear exactly ONCE — as the echoed user line. If the uncontrolled input
  // hadn't cleared on submit it would still hold the typed text too, giving two occurrences.
  const occurrences = (lastFrame() ?? "").split("hello there").length - 1;
  expect(occurrences).toBe(1);
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
  expect(lastFrame()).toMatch(/root\nhello from root/);             // dim "from" label above the rendered text
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
  // "git reset --hard" is deterministic regardless of whether the dev machine has dcg installed:
  // dcg's git pack blocks it, and when dcg is absent the guard's fail-safe blocks everything anyway.
  // It's also harmless to actually run — the test workspace (ws) is a fresh tmpdir, not a git repo,
  // so approving it just errors ("not a git repository") with no side effects.
  const runCall = {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "run_command", input: JSON.stringify({ command: "git reset --hard" }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
  } as unknown as LanguageModelV3GenerateResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(runCall, finalText("ran it")) as any });
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "run git reset --hard for me", ENTER);
  await waitFor(lastFrame, "Run command");        // the approval card rendered (blocked, deterministically)
  expect(lastFrame()).toContain("git reset --hard");
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
  await waitFor(lastFrame, "streamed reply");           // assembled from the streamed deltas, then rendered
  // Rendered as a markdown block under a one-line dim `root` label — NOT the old raw inline
  // "root: …" tail, which no longer exists (the in-progress tail is never shown raw).
  expect(lastFrame()).not.toContain("root: streamed reply");
  expect((lastFrame()!.match(/^root$/gm) ?? []).length).toBe(1);
  // Poll for the completed trace rather than assuming completion the instant the text appears.
  const start = Date.now();
  let done = listTraces(ws, "root").filter((t) => t.outcome === "completed");
  while (done.length === 0 && Date.now() - start < 2000) { await sleep(20); done = listTraces(ws, "root").filter((t) => t.outcome === "completed"); }
  expect(done.length).toBeGreaterThan(0);               // the run completed via the streaming path
});

test("streaming renders completed markdown blocks incrementally and never shows a raw tail", async () => {
  const chunks = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "1" },
    { type: "text-delta", id: "1", delta: "# Plan\n\n" },
    { type: "text-delta", id: "1", delta: "First step done.\n\n" },
    { type: "text-delta", id: "1", delta: "Then do **the thing**." },
    { type: "text-end", id: "1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doStream: (async () => ({ stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: 30, chunks }) })) as any });
  const { props } = await setup({ model, subscription: true });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "go", ENTER);
  // Completed blocks appear as FORMATTED markdown while later blocks are still streaming — the
  // heading renders with its "# " marker stripped (snap-at-end could never show block 1 formatted
  // before the reply finished). The still-growing last block is held back, never shown raw.
  await waitFor(lastFrame, "First step done");
  expect(lastFrame()).toContain("Plan");
  expect(lastFrame()).not.toContain("# Plan");          // block 1 is rendered, not raw
  expect(lastFrame()).not.toContain("**");              // no raw markdown markers on screen, ever
  // After the run finishes, the final block flushes and renders too — bold applied, no "**" markers.
  await waitFor(lastFrame, "the thing");
  await waitForGone(lastFrame, "**the thing**");        // markers are stripped by the markdown render
  expect(lastFrame()).not.toContain("# Plan");
  // The agent label is shown once per reply, not once per block. A plain substring count of "root"
  // is NOT robust here: the empty-squad startup banner ("...root is ready)...") also contains "root",
  // so a bare /root/g count is 2 even after the fix. Match the label as its OWN terminal-row line
  // instead (the dim `from` label renders alone on its line; no other line is ever exactly "root").
  expect((lastFrame()!.match(/^root$/gm) ?? []).length).toBe(1);
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

test("a non-streaming agent reply renders markdown (bold stripped of ** markers)", async () => {
  const { props } = await setup({ model: mockModel("Here is **bold** and a `code` word.") });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "hi", ENTER);
  await waitFor(lastFrame, "bold");
  expect(lastFrame()).toContain("bold");
  expect(lastFrame()).not.toContain("**bold**"); // markdown was rendered, not shown raw
});
