/** End-to-end REPL tests: render the real <App> into a virtual terminal (ink-testing-library),
 *  script keystrokes, and assert on rendered frames. The model is mocked (ai/test) and the MCP
 *  manager is a fake — so these exercise the actual submit → runSlash → executeRun → runLoop wiring
 *  with no real terminal, LLM, or MCP server.
 *
 *  Interaction note: each keystroke chunk is written as its OWN stdin event (ink parses a single
 *  multi-char chunk as literal input, so "text\r" would NOT submit). Arrow keys are ANSI escapes. */
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { MockLanguageModelV3, mockValues } from "../core/mock-model"; // Plan 07: auto-streaming mock
import { simulateReadableStream } from "ai";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./App";
import { ensureWorkspace, paths } from "../store/files";
import { openDb } from "../store/db";
import { seedRoot, reindex, loadIndex, seedLibrarian, createAgent } from "../store/roster";
import { listTraces, writeTrace } from "../store/trace";
import { RunTrace } from "../schemas/trace";
import { saveArtifact, listArtifacts, readArtifact } from "../store/artifacts";
import { annotateArtifact, listAnnotations } from "../store/annotations";
import { loadContext, loadLedger } from "../store/conversation";
import { loadThread } from "../store/thread";
import { readTaskState, taskIdForRun, listTaskIndex } from "../store/task-state";
import { listSchedules, createSchedule } from "../store/schedules";
import { readMcpStore } from "../store/mcp-store";
import { writeNode, resolveNodeIds } from "../store/knowledge";
import { getViewMode } from "../store/prefs";
import { createTeam } from "../store/teams";
import { writePlan, reindexPlans, currentPlanId, foldPlan } from "../store/plans";
import { readPrefs } from "../store/prefs";
import { statusReducer } from "../core/agent-status";
import { KbNode } from "../schemas/knowledge";
import type { AuthSource } from "../store/config";
import type { McpManager, McpServerStatus } from "../core/mcp/manager";

const ENTER = "\r";
const DOWN = "[B";

// Arrow keys + Esc as the ANSI escapes ink parses (DOWN above is "[B").
const UP = "[A";
const RIGHT = "[C";
const LEFT = "[D";
const ESC = "";

const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } } as const;
const finalText = (text: string) =>
  ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage }) as unknown as LanguageModelV3GenerateResult;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockModel = (text: string) => new MockLanguageModelV3({ doGenerate: mockValues(finalText(text)) as any });
// Plan 18: a scripted tool-call sequence, for driving the real toolsForAgent wiring from the REPL.
const call = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: `c_${name}`, toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;
const textResult = finalText;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCalls = (...vals: LanguageModelV3GenerateResult[]) => new MockLanguageModelV3({ doGenerate: mockValues(...vals) as any });

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

// Gate on a whole-frame predicate (not just one substring) so an assertion made across SEVERAL live
// surfaces waits until they've ALL rendered — streaming panes settle over multiple frames, so reading
// synchronously right after one label appears is a race under load.
async function waitForPred(frame: () => string | undefined, pred: (f: string) => boolean, label: string, timeout = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const f = frame() ?? "";
    if (pred(f)) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}.\nLast frame:\n${f}`);
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

// Plan 09: /costs is a cross-session rollup over the SAME traces /runs reads. Seed two traces on disk
// — one priced, one subscription (costUsd:null) — and prove the REPL wiring reports tokens for the
// subscription run instead of a fabricated $0.
const mkTrace = (over: Partial<RunTrace>): RunTrace =>
  RunTrace.parse({
    id: "root/2026-07-04-run1", agent: "root", task: "t", triggeredBy: "user",
    ledger: { retrieved: [], applied: [], skipped: [] },
    toolCalls: [], artifacts: [], delegatedOut: [], outcome: "completed",
    tokens: 0, costUsd: 0, durationMs: 0, started: "2026-07-04T10:00:00.000Z", ...over,
  });

test("/costs rolls up spend and reports subscription tokens, never a fabricated $0", async () => {
  const { ws, props } = await setup();
  writeTrace(ws, mkTrace({ id: "root/2026-07-04-run1", agent: "root", tokens: 100, costUsd: 2, model: "gpt-5.5" }));
  writeTrace(ws, mkTrace({ id: "writer/2026-07-04-run1", agent: "writer", tokens: 300, costUsd: null, costNote: "subscription", model: "codex" }));
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/costs", ENTER);
  await waitFor(lastFrame, "by agent");
  const frame = lastFrame() ?? "";
  expect(frame).toContain("400 tok");             // 100 priced + 300 subscription tokens, combined
  expect(frame).toContain("$2.0000 priced");      // only the priced run contributes USD
  expect(frame).toContain("subscription run(s)"); // subscription surfaced honestly
  expect(frame).not.toContain("$0.00");           // never a fabricated zero-dollar cost
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
  await waitFor(lastFrame, "› /teams");            // row 2 (Plan 19 inserted /teams) — advanced twice
  await sleep(60);                                  // let any stray re-render/onChange fire
  expect(lastFrame()).toContain("› /teams");       // still on row 2, not snapped back to /help
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

test("failed chat turn is audited but excluded from future context", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const failing = new MockLanguageModelV3({ doGenerate: (() => { throw new Error("forced failure"); }) as any });
  const { ws, props } = await setup({ model: failing });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "please do the impossible", ENTER);
  await waitFor(lastFrame, "failed");

  const failed = listTraces(ws, "root").find((t) => t.outcome === "failed");
  expect(failed).toBeTruthy();
  expect(loadLedger(ws, "root").map((t) => t.content)).toContain("please do the impossible");
  expect(loadLedger(ws, "root").some((t) => t.status === "failed" && String(t.content).includes("forced failure"))).toBe(true);

  const context = loadContext(ws, "root");
  expect(context.includedTurns).toEqual([]);
  expect(context.excludedTurns.length).toBe(2);

  const runDir = paths.runRecordDir(ws, failed!.id);
  expect(existsSync(join(runDir, "input.json"))).toBe(true);
  expect(readFileSync(join(runDir, "failure.md"), "utf8")).toContain("forced failure");
  expect(readFileSync(join(runDir, "transcript.jsonl"), "utf8")).toContain("model_error");

  const task = readTaskState(ws, taskIdForRun(failed!.id));
  expect(task?.status).toBe("failed");
});

// Plan 01 Ph5: the App-local recordTurnOutcome was removed; the ENGINE seam must still audit a
// COMPLETED chat turn (ledger user+assistant, context includes both) AND write the boot-replay cache
// (thread.jsonl) that Plan 05 Ph3 compacts — proven from the real App submit path, not a unit call.
test("completed chat turn is audited by the engine seam and populates the boot-replay cache", async () => {
  const { ws, props } = await setup({ model: mockModel("all done") });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "please summarize the report", ENTER);
  await waitFor(lastFrame, "all done");

  const led = loadLedger(ws, "root");
  expect(led.map((t) => t.content)).toContain("please summarize the report"); // user turn recorded
  expect(led.some((t) => t.role === "assistant" && t.status === "completed" && String(t.content).includes("all done"))).toBe(true);
  const ctx = loadContext(ws, "root");
  expect(ctx.includedTurns.length).toBe(2);   // both turns safe to replay
  expect(ctx.excludedTurns).toEqual([]);

  // the derived boot-replay cache (what a relaunch would load) now carries the completed turn
  const replay = loadThread(ws, "root");
  expect(replay.map((m) => String(m.content))).toEqual(["please summarize the report", "all done"]);
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

// ── Plan 01: hand-off artifacts (save / read / list + delegation hand-off) ──

const toolCall = (name: string, input: object) =>
  ({ content: [{ type: "tool-call", toolCallId: "c1", toolName: name, input: JSON.stringify(input) }],
     finishReason: { unified: "tool-calls", raw: "tool_use" }, usage }) as unknown as LanguageModelV3GenerateResult;

test("save_artifact end-to-end: root saves a structured artifact and it persists in the store", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    toolCall("save_artifact", { title: "Research dossier", type: "dossier", summary: "on the topic", body: "the full body" }),
    finalText("Saved research-dossier@v1"),
  ) as any });
  const { ws, props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "save a research dossier", ENTER);
  await waitFor(lastFrame, "Saved research-dossier");
  const stored = listArtifacts(ws);
  expect(stored.length).toBe(1);
  expect(stored[0]).toMatchObject({ id: "research-dossier", version: 1, producer: "root", type: "dossier" }); // provenance from ctx
});

test("read_artifact end-to-end: root reads a pre-seeded artifact and the run completes (tool actually executed)", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    toolCall("read_artifact", { id: "seeded" }),
    finalText("read the artifact"),
  ) as any });
  const { ws, props } = await setup({ model });
  saveArtifact(ws, { id: "seeded", title: "Seeded", summary: "the summary", body: "the body", producer: "human", runId: "human/1" });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "read the seeded artifact", ENTER);
  await waitFor(lastFrame, "read the artifact");
  const done = listTraces(ws, "root").find((t) => t.outcome === "completed");
  expect(done?.toolCalls.some((c) => c.tool === "read_artifact")).toBe(true); // wiring proven: the tool ran in-loop
});

test("list_artifacts end-to-end: root lists the store and the run completes", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    toolCall("list_artifacts", {}),
    finalText("here are the artifacts"),
  ) as any });
  const { ws, props } = await setup({ model });
  saveArtifact(ws, { id: "one", title: "One", body: "1", producer: "human", runId: "human/1" });
  saveArtifact(ws, { id: "two", title: "Two", body: "2", producer: "human", runId: "human/1" });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "list artifacts", ENTER);
  await waitFor(lastFrame, "here are the artifacts");
  const done = listTraces(ws, "root").find((t) => t.outcome === "completed");
  expect(done?.toolCalls.some((c) => c.tool === "list_artifacts")).toBe(true);
});

test("delegation hand-off end-to-end: root hands an artifact to a worker by reference; the graph is recorded", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    toolCall("delegate_task", { to: "writer", goal: "write from the dossier", inputArtifacts: ["research-foo"] }), // root step 1
    toolCall("save_artifact", { title: "Script", type: "script", summary: "a 30s script", body: "SCENE 1..." }),   // child step 1
    finalText("child saved the script"),                                                                          // child step 2
    finalText("root done — see script@v1"),                                                                       // root step 2
  ) as any });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write.", tools: ["save_artifact", "read_artifact"] }, "root");
  saveArtifact(ws, { id: "research-foo", title: "Foo dossier", summary: "foo summary", body: "THE ENORMOUS BODY", producer: "human", runId: "human/1" });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "have writer turn the dossier into a script", ENTER);
  await waitFor(lastFrame, "root done", 8000);
  const root = listTraces(ws, "root").find((t) => t.outcome === "completed" && t.delegatedOut.length === 1);
  expect(root).toBeTruthy();
  expect(root!.inputArtifacts).toEqual(["research-foo"]);   // handed DOWN by reference
  expect(root!.outputArtifacts).toEqual(["script@v1"]);      // received UP from the child
  const art = readArtifact(ws, "script@v1")!;
  expect(art.producer).toBe("writer");                       // the child really produced it
});

test("a non-streaming agent reply renders markdown (bold stripped of ** markers)", async () => {
  const { props } = await setup({ model: mockModel("Here is **bold** and a `code` word.") });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "hi", ENTER);
  await waitFor(lastFrame, "bold");
  expect(lastFrame()).toContain("bold");
  expect(lastFrame()).not.toContain("**bold**"); // markdown was rendered, not shown raw
});

// ── Plan 04: background dispatch (dispatch_task → keep chatting → settle notification → /tasks) ──

test("dispatch_task runs in the BACKGROUND: root returns immediately, the captain keeps chatting, then a settle notification + /tasks show the finished task", async () => {
  const GOAL = "research the fusion timeline";
  const dispatchCall = toolCall("dispatch_task", { to: "bgworker", goal: GOAL });
  // One model, branching by prompt content, so the root run and the detached worker run each get a
  // deterministic response no matter how their calls interleave. The worker is delayed so its
  // completion clearly lands AFTER the foreground turns (proving dispatch never blocked the captain).
  const model = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async ({ prompt }: { prompt: unknown }) => {
      const s = JSON.stringify(prompt);
      if (s.includes("BACKGROUND-WORKER-IDENTITY")) { await sleep(300); return finalText("background work complete"); } // the detached worker run
      if (s.includes("what else")) return finalText("still here — that task runs in the background");                    // a 2nd foreground chat turn
      if (s.includes("task_bg_")) return finalText("kicked it off in the background");                                   // root, after dispatch returned a taskId
      return dispatchCall;                                                                                                // root, first turn
    }) as any,
  });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "bgworker", role: "Background worker", identity: "BACKGROUND-WORKER-IDENTITY — you do detached work.", tools: [] }, "root");
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "kick off a background research job", ENTER);
  await waitFor(lastFrame, "dispatched");                       // the ⇢ dispatch breadcrumb
  await waitFor(lastFrame, "kicked it off in the background");  // root replied WITHOUT waiting on the worker

  // The captain keeps chatting while the background task is still running.
  await send(stdin, "what else can you do", ENTER);
  await waitFor(lastFrame, "still here");                       // a second turn ran while the task was in flight

  // The background task settles → a REPL notification appears (notify + /tasks per Phase 0).
  await waitFor(lastFrame, "background task", 4000);
  expect(lastFrame()).toContain("completed");

  // /tasks lists the finished background task (the index survived across the turns).
  await send(stdin, "/tasks", ENTER);
  await waitFor(lastFrame, GOAL);                               // the goal shows only in the /tasks list row

  // …and it is durably recorded as a completed background task.
  const rows = listTaskIndex(db, { activeOrBackground: true });
  const bg = rows.find((r) => r.agent === "bgworker");
  expect(bg?.status).toBe("completed");
  expect(bg?.kind).toBe("background");
});

test("Plan 20 (Plan 18's settle half): a background task settle TICKS the plan item it was bound to", async () => {
  // Root writes a plan, dispatches its item to a background worker, and finishes its turn. When the
  // detached task settles, the REPL settle path must tick the bound item from the task's REAL outcome
  // — the seam settlePlanItemForTask existed for but nothing called (the item used to stay
  // in_progress forever, until boot's reconcilePlans wrongly marked it interrupted).
  const model = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async ({ prompt }: { prompt: unknown }) => {
      const s = JSON.stringify(prompt);
      if (s.includes("BACKGROUND-WORKER-IDENTITY")) { await sleep(200); return finalText("background item done"); } // the detached worker run
      if (s.includes("task_bg_")) return finalText("dispatched the plan item");   // root, after dispatch returned a taskId
      if (s.includes("minted")) return toolCall("dispatch_task", { to: "bgworker", goal: "do the bg item", itemId: "it_bg" }); // root, after write_plan's result
      return toolCall("write_plan", { goal: "prove the settle half", items: [{ id: "it_bg", text: "background item" }] });     // root, first turn
    }) as any,
  });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "bgworker", role: "Background worker", identity: "BACKGROUND-WORKER-IDENTITY — you do detached work.", tools: [] }, "root");
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "plan it and kick it off", ENTER);
  await waitFor(lastFrame, "dispatched the plan item");          // root's turn finished; the task is in flight
  await waitFor(lastFrame, "background task", 4000);             // the settle notification

  const planId = currentPlanId(db, "root");
  expect(planId).toBeTruthy();
  const st = foldPlan(ws, planId!)!;
  const item = st.items.find((i) => i.id === "it_bg")!;
  expect(item.status).toBe("done");                              // ← the previously-unwired settle
  expect(item.note ?? "").toContain("completed");
});

test("Plan 20 (review finding): cancelling a QUEUED task settles its bound plan item too", async () => {
  // Two dispatches to a maxConcurrentRuns:1 worker: one runs (holds the slot ~800ms), one QUEUES.
  // Cancelling the queued one never reaches settleTask/failTask (start() never ran) — the scheduler's
  // onCancelQueued hook is the only seam for that transition, and it was unwired.
  const model = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async ({ prompt }: { prompt: unknown }) => {
      const s = JSON.stringify(prompt);
      if (s.includes("QUEUE-WORKER-IDENTITY")) { await sleep(800); return finalText("bg slot freed"); }
      if (s.includes("task_bg_")) return finalText("both dispatched");
      if (s.includes("minted")) return {
        content: [
          { type: "tool-call", toolCallId: "d_a", toolName: "dispatch_task", input: JSON.stringify({ to: "queueworker", goal: "task A", itemId: "it_a" }) },
          { type: "tool-call", toolCallId: "d_b", toolName: "dispatch_task", input: JSON.stringify({ to: "queueworker", goal: "task B", itemId: "it_b" }) },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
      } as unknown as LanguageModelV3GenerateResult;
      return toolCall("write_plan", { goal: "queue cancel proof", items: [{ id: "it_a", text: "task A" }, { id: "it_b", text: "task B" }] });
    }) as any,
  });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "queueworker", role: "queued worker", identity: "QUEUE-WORKER-IDENTITY — one at a time.", tools: [] }, "root");
  // Cap the worker to ONE concurrent run (budgets are config/frontmatter-disposed, not a draft field).
  const af = join(ws, "agents", "queueworker", "agent.md");
  // createAgent already serializes a budgets block — patch INSIDE it (a duplicate budgets: key would
  // lose to the original under YAML last-key-wins, silently leaving the cap unbounded).
  writeFileSync(af, readFileSync(af, "utf8").replace("  maxIterationsPerRun: 30", "  maxConcurrentRuns: 1\n  maxIterationsPerRun: 5"));
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "plan then dispatch both", ENTER);
  await waitFor(lastFrame, "both dispatched");
  // One task runs, the other sits queued (order between A/B is SDK execution order — read the truth).
  const queued = listTaskIndex(db, { activeOrBackground: true }).find((r) => r.status === "queued");
  expect(queued).toBeTruthy();
  const queuedItem = queued!.goal === "task A" ? "it_a" : "it_b";
  const runningItem = queuedItem === "it_a" ? "it_b" : "it_a";

  await send(stdin, `/tasks cancel ${queued!.id}`, ENTER);
  await waitFor(lastFrame, "cancelled");
  const planId = currentPlanId(db, "root")!;
  const afterCancel = foldPlan(ws, planId)!;
  const dropped = afterCancel.items.find((i) => i.id === queuedItem)!;
  expect(dropped.status).toBe("failed");                          // ← was stranded in_progress forever
  expect(dropped.note ?? "").toContain("queued");

  await waitFor(lastFrame, "background task", 4000);              // the running task settles normally
  const st = foldPlan(ws, planId)!;
  expect(st.items.find((i) => i.id === runningItem)!.status).toBe("done");
});

test("Plan 20 (review finding): /agents reindex refreshes App's roster STATE — /teach sees a hand-added agent", async () => {
  const { ws, props } = await setup({ model: mockModel('{"when":"citing facts","do":"always cite sources","scope":"agent"}') });
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "/teach ghostcoach cite your sources", ENTER);
  await waitFor(lastFrame, 'No agent "ghostcoach"');              // gate reads the (stale) roster state

  // Hand-author the agent file, then reindex mid-session — the DB refresh alone was not enough,
  // because /teach's gate reads App's in-memory roster state, not the DB.
  mkdirSync(join(ws, "agents", "ghostcoach"), { recursive: true });
  writeFileSync(join(ws, "agents", "ghostcoach", "agent.md"),
    '---\nid: ghostcoach\nrole: cites sources\ntools: []\ncanSee: ["*"]\ncanDelegateTo: []\nisRoot: false\ncreated: "2026-07-13T00:00:00.000Z"\n---\nYou cite sources.\n');
  await send(stdin, "/agents reindex", ENTER);
  await waitFor(lastFrame, "roster reindexed");

  await send(stdin, "/teach ghostcoach cite your sources", ENTER);
  await waitFor(lastFrame, "always cite sources");                // the distilled draft card — the gate passed
  expect((lastFrame()!.match(/No agent "ghostcoach"/g) ?? []).length).toBe(1); // no SECOND refusal
  await send(stdin, "n");                                         // reject the proposal, drain cleanly
  await waitFor(lastFrame, "discarded");
});

test("Plan 20: /agents reindex picks up a hand-edit to agent.md (team: takes effect mid-session)", async () => {
  const { ws, db, props } = await setup({ model: mockModel("hi") });
  await createAgent(ws, db, { id: "member", role: "member role", identity: "You are a member." }, "root");
  expect(loadIndex(db).find((r) => r.id === "member")!.team ?? null).toBeNull();

  // The documented membership mechanism: hand-edit the agent's own frontmatter.
  const file = join(ws, "agents", "member", "agent.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("id: member", "id: member\nteam: news"));

  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/agents reindex", ENTER);
  await waitFor(lastFrame, "roster reindexed");
  expect(loadIndex(db).find((r) => r.id === "member")!.team).toBe("news");   // the derived row refreshed
});

test("Plan 20: focus-mode Enter opens the run the ring HIGHLIGHTS, not blockFeed insertion order", async () => {
  // Root streams a delta BEFORE delegating, so root's runId enters blockFeed first. The rendered
  // block list (allBlocks) EXCLUDES root — index 0 is the child — but the old Enter path indexed
  // [...blockFeed.keys()], which included root: highlighting the child opened ROOT's run. The child
  // streams slowly (chunkDelayInMs) so its block is live while we navigate; its trace isn't written
  // yet, so the operation view renders "no data for run <childRunId>" — the run ID is the proof.
  const su = { inputTokens: { total: 3 }, outputTokens: { total: 2 } } as const;
  const stream = (chunks: unknown[], delay = 0) =>
    ({ stream: simulateReadableStream({ initialDelayInMs: 0, chunkDelayInMs: delay, chunks: chunks as never[] }) });
  const model = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doStream: (async ({ prompt }: { prompt: unknown }) => {
      const s = JSON.stringify(prompt);
      if (s.includes("PROOF-CHILD-IDENTITY"))
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          ...Array.from({ length: 6 }, () => ({ type: "text-delta", id: "1", delta: "child working… " })),
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: su },
        ], 150);                                                     // ~900ms live window for the keys
      if (s.includes("child working"))
        return stream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "root all wrapped" },
          { type: "text-end", id: "1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: su },
        ]);
      return stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "handing off to the squad" },  // root's delta → root enters blockFeed FIRST
        { type: "text-end", id: "1" },
        { type: "tool-call", toolCallId: "d1", toolName: "delegate_task", input: JSON.stringify({ to: "proofchild", goal: "do the thing" }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: su },
      ]);
    }) as any,
  });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "proofchild", role: "proves focus", identity: "PROOF-CHILD-IDENTITY — you stream slowly.", tools: [] }, "root");
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "go", ENTER);
  await waitFor(lastFrame, "child working");        // the child's live block is on screen
  await send(stdin, "[Z");                    // shift+tab → focus mode (ring on block 0 = the child)
  await waitFor(lastFrame, "navigate", 1500);       // the focus-mode footer proves focus engaged
  await send(stdin, ENTER);                         // open the highlighted block
  await waitFor(lastFrame, "esc to close");         // the operation view is open (live or settled)
  // The view must identify the CHILD — "/ proofchild" in its esc line (settled) or its runId in the
  // no-data line (still live). The OLD code opened ROOT's view here ("/ root").
  await waitForPred(
    lastFrame,
    (f) => f.includes("/ proofchild") || f.includes("no data for run proofchild"),
    "operation view identifies proofchild",
    2000,
  );
  await send(stdin, "");                      // esc closes the operation view
  await waitFor(lastFrame, "root all wrapped");     // drain the foreground turn cleanly
});

// ── Plan 04 Phase 6: /schedules add → list → remove (durable, from the REPL) ──

test("/schedules add persists a durable schedule, /schedules list shows it, /schedules remove deletes it", async () => {
  const { ws, props } = await setup({ model: mockModel("hi") });
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "/schedules add audit the logs --every 1h --id aud", ENTER);
  await waitFor(lastFrame, "added schedule aud");
  // It is DURABLE on disk (survives a restart — reconciled + armed on boot).
  expect(listSchedules(ws).map((s) => s.id)).toEqual(["aud"]);
  expect(listSchedules(ws)[0]!.approve).toBe("reject"); // unattended-safe default

  await send(stdin, "/schedules list", ENTER);
  await waitFor(lastFrame, "aud");
  expect(lastFrame()).toContain("every 3600000ms");

  await send(stdin, "/schedules remove aud", ENTER);
  await waitFor(lastFrame, "removed schedule aud");
  expect(listSchedules(ws).length).toBe(0);
});

// ── Fix 2: /schedules run routes through the runner's inFlight-guarded fireNow (not the raw closure) ──

test("/schedules run goes through the runner guard — an on-disk schedule NOT armed in this session is refused, not fired", async () => {
  const { ws, props } = await setup({ model: mockModel("hi") });
  const { stdin, lastFrame } = render(<App {...props} />);

  // A synchronous (non-busy) slash command first proves the app is mounted and the boot arming effect
  // has flushed over an EMPTY schedule set — so the schedule we write next is NOT armed this session.
  await send(stdin, "/schedules list", ENTER);
  await waitFor(lastFrame, "no schedules");

  // Put a schedule on disk WITHOUT arming it (bypass `/schedules add`, which calls schedRunner.add).
  // Pre-fix, `/schedules run` fired the raw fire closure regardless of the runner (bypassing the
  // inFlight guard); post-fix it routes through fireNow, which refuses an id not armed this session.
  createSchedule(ws, { id: "ext", goal: "audit", trigger: { kind: "interval", everyMs: 3600_000 } });

  await send(stdin, "/schedules run ext", ENTER);
  await waitFor(lastFrame, "not armed in this session"); // fireNow refused it (the guarded path)
  expect(lastFrame()).not.toContain("firing →");          // it did NOT bypass the guard and fire
});

test("delegation with acceptance criteria: a twice-failed verdict is surfaced to the captain and recorded (Plan 06)", async () => {
  // root delegates WITH criteria; the independent checker (same mock model) fails both the first
  // attempt and the one bounded retry, so the result comes back with the failed verdict attached.
  const delegateCall = {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "delegate_task", input: JSON.stringify({ to: "writer", goal: "write X", criteria: "must mention Y" }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
  } as unknown as LanguageModelV3GenerateResult;
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    delegateCall,                                                    // root: delegate with criteria
    finalText("attempt one, no Y"),                                  // writer (1st attempt)
    finalText('{"pass": false, "reasons": ["missing Y"]}'),          // checker (1st) — independent call
    finalText("attempt two, still no Y"),                            // writer (retry)
    finalText('{"pass": false, "reasons": ["still missing Y"]}'),    // checker (2nd)
    finalText("Writer produced X; note it did not pass verification."), // root final reply
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "get writer to write X", ENTER);
  await waitFor(lastFrame, "still failed verification", 8000);        // the captain SEES the failed-verdict breadcrumb
  // The breadcrumb fires from INSIDE delegate_task (mid-run); wait for the root's final reply so the
  // root run has actually settled and written its trace before we read it back.
  await waitFor(lastFrame, "Writer produced X", 8000);
  // …and the verdict is durably recorded on the trace and the task-state.
  const done = listTraces(ws, "root").filter((t) => t.outcome === "completed");
  const root = done.at(-1)!;
  expect(root.verification.length).toBe(2);
  expect(root.verification.every((v) => v.verdict.pass === false)).toBe(true);
  const task = readTaskState(ws, taskIdForRun(root.id));
  expect(task?.verifications.length).toBe(2);
});

// ── Plan 17: the /trace waterfall (inspector + live) was retired — trace visualization is
//    OpenTelemetry's job now. The tests that drove it are removed with it. ──

// ── Plan 10: the live status bar (Layer-1, through the real App) ──

test("status bar shows the agent's live state during a run and clears on completion", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slow = new MockLanguageModelV3({ doGenerate: (async () => { await sleep(300); return finalText("done"); }) as any });
  const { props } = await setup({ model: slow });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "go", ENTER);
  await waitFor(lastFrame, "root thinking");          // the StatusBar segment (distinct from RunStatus's "root · thinking…")
  await waitFor(lastFrame, "done");                   // run finishes
  await waitForGone(lastFrame, "root thinking");      // …and the bar clears
});

test("status bar shows the current tool while an agent delegates (parent delegating + child live)", async () => {
  const rootModel = new MockLanguageModelV3({ doGenerate: mockValues(
    toolCall("delegate_task", { to: "writer", goal: "write the thing" }),
    finalText("root done"),
  ) as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slowWriter = new MockLanguageModelV3({ doGenerate: (async () => { await sleep(350); return finalText("writer done"); }) as any });
  const { ws, db, props } = await setup({ model: rootModel });
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  // route root → rootModel, writer → the slow model so the delegation is observable mid-flight
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (props as any).resolveModel = (id: string) => id === "writer" ? { model: slowWriter, modelId: "m" } : { model: rootModel, modelId: "m" };
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "have writer do it", ENTER);
  await waitFor(lastFrame, "root delegating");        // parent shows the delegate_task in flight
  expect(lastFrame()).toContain("writer");            // the child agent is live in the bar at the same time
  await waitFor(lastFrame, "root done");
  await waitForGone(lastFrame, "root delegating");    // bar clears when the cascade completes
});

test("status bar shows 'waiting' while an approval card is up, then clears on approval", async () => {
  const createCall = {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "create_agent", input: JSON.stringify({ id: "scout", role: "Scouts", identity: "A scout" }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
  } as unknown as LanguageModelV3GenerateResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(createCall, finalText("Created scout")) as any });
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "make a scout", ENTER);
  await waitFor(lastFrame, "New agent");              // the approval card is up…
  expect(lastFrame()).toContain("waiting");           // …and the bar loudly shows the squad is blocked on the captain
  await send(stdin, "y");                              // approve
  await waitFor(lastFrame, "Created scout");
  await waitForGone(lastFrame, "waiting");             // bar clears after the run completes
});

// ── Plan 10 Phase 4: the split-pane view (Layer-1, through the real App) ──

test("Plan 10 Phase 4: a pane appears on a delegation, streams the tool line with argsPreview, and collapses on completion", async () => {
  const rootModel = new MockLanguageModelV3({ doGenerate: mockValues(
    toolCall("delegate_task", { to: "writer", goal: "write the fusion timeline" }),
    finalText("root done"),
  ) as any });
  // A slow writer so the delegation is observable mid-flight (parent `delegating` + child live).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slowWriter = new MockLanguageModelV3({ doGenerate: (async () => { await sleep(350); return finalText("writer done"); }) as any });
  const { ws, db, props } = await setup({ model: rootModel });
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (props as any).resolveModel = (id: string) => id === "writer" ? { model: slowWriter, modelId: "m" } : { model: rootModel, modelId: "m" };
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "/view panes", ENTER);          // isolate the panes (bar hidden) so pane content is unambiguous
  await waitFor(lastFrame, "live view → panes");
  await send(stdin, "have writer do it", ENTER);

  await waitFor(lastFrame, "root delegating", 8000); // the PARENT pane shows delegate_task in flight (a pane-only status)
  const frame = () => lastFrame() ?? "";
  const headerLine = (f: string) => f.split("\n").find((l) => l.includes("root delegating") && l.includes("fusion"));
  // the pane BODY streams the tool line with its argsPreview ("→ …", distinct from the "↳" scrollback breadcrumb)
  const bodyLine = (f: string) => f.split("\n").find((l) => l.includes("→ delegate_task") && l.includes("fusion") && !l.includes("↳"));
  // These live surfaces settle over separate frames; gate on ALL of them together to kill the render-
  // timing race BEFORE asserting (the assertion's intent is unchanged — every structural check remains).
  await waitForPred(
    lastFrame,
    (f) => !!headerLine(f) && !!bodyLine(f) && f.includes("writer thinking") && f.includes("▎"),
    "the parent tool line (header + body with argsPreview) + the live child pane + split-pane accent",
    8000,
  );
  // the pane HEADER carries the current tool + its argsPreview on one line
  expect(headerLine(frame())).toContain("fusion");
  expect(bodyLine(frame())).toBeTruthy();
  expect(frame()).toContain("writer thinking");      // the CHILD is live in its own pane at the same time
  expect(frame()).toContain("▎");                    // left-accent split panes actually rendered

  await waitFor(lastFrame, "root done", 8000);
  await waitForGone(lastFrame, "root delegating", 6000); // the pane collapses after completion (settle → gone)
});

test("Plan 10 Phase 4: /view switches the live surfaces (bar / panes / both) and persists the choice", async () => {
  let calls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slow = new MockLanguageModelV3({ doGenerate: (async () => { await sleep(300); calls++; return finalText(`reply ${calls}`); }) as any });
  const { ws, props } = await setup({ model: slow });
  const { stdin, lastFrame } = render(<App {...props} />);

  // bar-only: a live run shows the bar's live state but NO bordered pane
  await send(stdin, "/view bar", ENTER);
  await waitFor(lastFrame, "live view → bar");
  expect(getViewMode(ws)).toBe("bar");               // persisted to disk (the mechanism prefs use)
  await send(stdin, "run one", ENTER);
  await waitFor(lastFrame, "root thinking");          // the bar renders the live status…
  expect(lastFrame()).not.toContain("▎");             // …and the split panes are suppressed
  await waitFor(lastFrame, "reply 1");                // run finishes → idle again

  // panes-only: a live run renders a bordered pane
  await send(stdin, "/view panes", ENTER);
  await waitFor(lastFrame, "live view → panes");
  expect(getViewMode(ws)).toBe("panes");             // persisted
  await send(stdin, "run two", ENTER);
  await waitFor(lastFrame, "▎");                      // a split pane rendered
  await waitFor(lastFrame, "reply 2");

  // both (the default): confirm the toggle + persistence round-trips back
  await send(stdin, "/view both", ENTER);
  await waitFor(lastFrame, "live view → both");
  expect(getViewMode(ws)).toBe("both");
});

test("Plan 10 Phase 4: below the minimum terminal size the panes degrade to bar-only", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slow = new MockLanguageModelV3({ doGenerate: (async () => { await sleep(400); return finalText("done"); }) as any });
  const { props } = await setup({ model: slow });
  // An explicit tiny terminal (below MIN_PANE_COLS/ROWS) is authoritative over the live stdout.
  const small = { ...props, terminalSize: { columns: 40, rows: 8 } };
  const { stdin, lastFrame } = render(<App {...small} />);
  await send(stdin, "go", ENTER);
  await waitFor(lastFrame, "root thinking");          // the bar (the complete summary) still renders…
  expect(lastFrame()).not.toContain("▎");             // …but the panes are degraded away
  await waitFor(lastFrame, "done");
});

// ── Plan 13 (corrected): consistent agent blocks — sub-agent reply NOT in scrollback ──

test("Plan 13 (corrected): a delegation renders blocks for the sub-agent, and the sub-agent's full reply is NOT in scrollback", async () => {
  // Root delegates to a worker. The worker produces a long reply. The block shows a bounded tail,
  // but the full reply text does NOT appear in scrollback (the block is the sub-agent's only on-screen
  // presence; the full text stays in the on-disk transcript).
  const SUB_AGENT_REPLY = "writer produced a very long reply that should NOT appear in scrollback because it would flood the screen";
  const rootModel = new MockLanguageModelV3({ doGenerate: mockValues(
    toolCall("delegate_task", { to: "writer", goal: "write something" }),
    finalText("root done"),
  ) as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const writerModel = new MockLanguageModelV3({ doGenerate: (async () => { await sleep(200); return finalText(SUB_AGENT_REPLY); }) as any });
  const { ws, db, props } = await setup({ model: rootModel });
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (props as any).resolveModel = (id: string) => id === "writer" ? { model: writerModel, modelId: "m" } : { model: rootModel, modelId: "m" };
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "have writer do it", ENTER);
  await waitFor(lastFrame, "root done", 8000); // the delegation completed

  // The sub-agent's full reply text is NOT in scrollback (the block is its only on-screen presence).
  expect(lastFrame()).not.toContain(SUB_AGENT_REPLY);
  // But the block IS rendered (the sub-agent's name + state appear in the block header).
  expect(lastFrame()).toContain("writer");
  // And root's reply IS in scrollback (root's direct reply uses the scrollback channel).
  expect(lastFrame()).toContain("root done");
});

// ── Plan 04: routeSteer routing (Layer-1, through the real App) ──

test("routeSteer: an @agent steer with no live run for that agent tells the captain (no silent misroute)", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slow = new MockLanguageModelV3({ doGenerate: (async () => { await sleep(400); return finalText("root done"); }) as any });
  const { props } = await setup({ model: slow });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "think a while", ENTER);
  await waitFor(lastFrame, "thinking");                 // root run is live (REPL busy)
  await send(stdin, "@ghost hurry up", ENTER);          // steer targeting an agent with no live run
  await waitFor(lastFrame, "no active run for @ghost");
});

test("routeSteer: a plain steer while a run is live routes to the foreground root and reaches the model", async () => {
  // The run iterates via a delayed tool call; the plain steer, queued mid-run, is injected before a
  // later model call and the model echoes it — proving it reached THE foreground run (foregroundRootRef).
  const model = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async ({ prompt }: { prompt: unknown }) => {
      const s = JSON.stringify(prompt);
      if (s.includes("STEER-ECHO-TOKEN")) return finalText("acknowledged STEER-ECHO-TOKEN");
      await sleep(80);
      return toolCall("list_artifacts", {}); // keep the loop iterating so a later poll picks up the steer
    }) as any,
  });
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "start a long task", ENTER);
  await waitFor(lastFrame, "list_artifacts");                        // the run is live and mid-loop
  await send(stdin, "STEER-ECHO-TOKEN please", ENTER);
  await waitFor(lastFrame, "(steer)");                              // routeSteer accepted the plain steer
  await waitFor(lastFrame, "acknowledged STEER-ECHO-TOKEN", 8000);  // it reached the foreground run
});

test("routeSteer: an @agent steer prefers the FOREGROUND run when the same agent is also live in a background run", async () => {
  // "w" ends up live in TWO runs at once: a background dispatch (started first → first in the
  // activeRuns Map) and a foreground @w turn. A naive first-match-by-Map-order would steer the
  // BACKGROUND run; the fix prefers the foreground cascade, so the correction the captain types reaches
  // the run they are watching. The foreground w run's reply renders to the main output; the background
  // one's does not — so an echoed STEER-TOKEN in the frame proves the steer landed on the foreground run.
  const model = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async ({ prompt }: { prompt: unknown }) => {
      const s = JSON.stringify(prompt);
      if (s.includes("STEER-TOKEN")) return finalText("acknowledged STEER-TOKEN");        // whichever w run got the steer echoes it
      if (s.includes("W-WORKER-IDENTITY")) { await sleep(60); return toolCall("list_artifacts", {}); } // both w runs loop, awaiting a steer
      if (s.includes("task_bg_")) return finalText("root kicked it off");                  // root, after dispatch returned a taskId
      return toolCall("dispatch_task", { to: "w", goal: "background loop" });              // root, first turn
    }) as any,
  });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "w", role: "worker", identity: "W-WORKER-IDENTITY", tools: ["list_artifacts"] }, "root");
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "kick off bg", ENTER);
  await waitFor(lastFrame, "⇢ dispatched");            // background w run started (first into the activeRuns Map)
  await waitFor(lastFrame, "root kicked it off");       // root's turn finished — the REPL is free again
  await send(stdin, "@w foreground task", ENTER);       // foreground w run (second into the activeRuns Map)
  await waitFor(lastFrame, "esc to cancel");            // the foreground @w run is live (REPL busy)
  await sleep(150);                                      // let the foreground run iterate at least once
  await send(stdin, "@w STEER-TOKEN", ENTER);           // steer @w while BOTH w runs are live
  await waitFor(lastFrame, "(steer @w)");               // routeSteer accepted it
  await waitFor(lastFrame, "acknowledged STEER-TOKEN", 8000); // the FOREGROUND run echoed → correct routing
});

// ── Plan 04: concurrent approval requests QUEUE (never clobber) ──

test("concurrent approval requests queue instead of clobbering: both are answered and both runs resolve", async () => {
  // A background dispatched run and the foreground run both block on the captain at once. Before the
  // fix, the second setPending overwrote the first — the first request's resolver was lost forever and
  // its run hung. Now they queue: answer the head, the next surfaces, and BOTH promises resolve.
  const model = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async ({ prompt }: { prompt: unknown }) => {
      const s = JSON.stringify(prompt);
      // Discriminate root by MESSAGE content ("kick off" — its own user turn; agent identities leak via
      // the roster block, so those aren't reliable). Each ask_human has ≥2 options (schema minimum) and
      // BLOCKS on the card; the run only reaches its "done" branch once the card is actually answered
      // (the question text then sits in history, proving the approval resolved — not auto-progressed).
      if (s.includes("kick off")) {
        if (s.includes("FG question?")) return finalText("root done");           // FG card was answered → finish
        if (s.includes("task_bg_")) return toolCall("ask_human", { question: "FG question?", options: ["ok", "no"] });
        return toolCall("dispatch_task", { to: "bgworker", goal: "detached work" });
      }
      // the background worker's detached run:
      if (s.includes("BG question?")) return finalText("bg worker done");         // BG card was answered → finish
      await sleep(150);                                                            // land after the FG ask, so BOTH queue together
      return toolCall("ask_human", { question: "BG question?", options: ["ok", "no"] });
    }) as any,
  });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "bgworker", role: "bg", identity: "BG-WORKER-IDENTITY", tools: ["ask_human"] }, "root");
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "kick off", ENTER);
  await waitFor(lastFrame, "FG question?");             // root dispatched, then asked → the foreground card shows first
  await sleep(300);                                      // the background worker's ask_human lands and QUEUES behind it
  await send(stdin, "1");                               // answer the head (foreground) → picks fg-answer
  await waitFor(lastFrame, "BG question?");             // the SECOND (background) approval was NOT clobbered — it surfaces
  await send(stdin, "1");                               // answer it → picks bg-answer
  await waitFor(lastFrame, "root done");                // the foreground run's promise resolved (not lost)
  await waitFor(lastFrame, "background task", 6000);    // the background run settled → its promise resolved too
  const bg = listTaskIndex(db, { activeOrBackground: true }).find((r) => r.agent === "bgworker");
  expect(bg?.status).toBe("completed");                // both runs finished cleanly
});

// ── Plan 01 Phase 4 — the /artifacts UI (view / annotate / approve) ──────────

test("/artifacts list shows a stored artifact with its handle", async () => {
  const { ws, props } = await setup();
  saveArtifact(ws, { id: "dossier", title: "Foo dossier", type: "dossier", summary: "on foo", body: "BODY", producer: "root", runId: "root/1" });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/artifacts list", ENTER);
  await waitFor(lastFrame, "dossier@v1");
  expect(lastFrame()).toContain("Foo dossier");
});

test("/artifacts on an empty store reports (no artifacts)", async () => {
  const { props } = await setup();
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/artifacts", ENTER);
  await waitFor(lastFrame, "no artifacts");
});

test("/artifacts annotate attaches human feedback (asserted against the store)", async () => {
  const { ws, props } = await setup();
  saveArtifact(ws, { id: "dossier", title: "Dossier", body: "BODY", producer: "root", runId: "root/1" });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/artifacts annotate dossier tighten the intro", ENTER);
  await waitFor(lastFrame, "annotated dossier@v1");
  const open = listAnnotations(ws, "dossier", { status: "open" });
  expect(open.length).toBe(1);
  expect(open[0].author).toBe("human");
  expect(open[0].body).toBe("tighten the intro");
  expect(open[0].kind).toBe("feedback");
});

test("/artifacts approve records a captain sign-off", async () => {
  const { ws, props } = await setup();
  saveArtifact(ws, { id: "dossier", title: "Dossier", body: "BODY", producer: "root", runId: "root/1" });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/artifacts approve dossier@v1", ENTER);
  await waitFor(lastFrame, "approved dossier@v1");
  expect(listAnnotations(ws, "dossier").map((a) => a.kind)).toEqual(["approval"]);
});

test("/artifacts show surfaces provenance + the artifact BODY + the open feedback", async () => {
  const { ws, props } = await setup();
  saveArtifact(ws, { id: "dossier", title: "Dossier", type: "dossier", summary: "sum", body: "THE ACTUAL DELIVERABLE BODY", producer: "root", runId: "root/1" });
  annotateArtifact(ws, { target: "dossier@v1", author: "human", body: "add dates" });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/artifacts show dossier", ENTER);
  await waitFor(lastFrame, "add dates");
  const frame = lastFrame() ?? "";
  expect(frame).toContain("producer=root");
  expect(frame).toContain("versions=[1]");
  expect(frame).toContain("THE ACTUAL DELIVERABLE BODY"); // the BODY is rendered, not just the envelope
});

test("/artifacts annotate on a missing artifact reports the error (no dangling feedback)", async () => {
  const { props } = await setup();
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/artifacts annotate ghost do something", ENTER);
  await waitFor(lastFrame, "no artifact");
});

test("/artifacts gc archives old unreferenced versions and reports what it collected", async () => {
  const { ws, props } = await setup();
  for (let i = 1; i <= 5; i++) saveArtifact(ws, { id: "doc", title: `v${i}`, body: `${i}`, producer: "root", runId: "root/1" });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/artifacts gc", ENTER);
  await waitFor(lastFrame, "archived 2 version(s)");
  expect(readArtifact(ws, "doc@v1")).toBeNull();        // v1/v2 archived out of the live store
  expect(readArtifact(ws, "doc")!.version).toBe(5);     // latest untouched
});

// PRODUCTION CONDITION (PR #17 review): each version is pinned by its OWN producing trace.artifacts —
// the real state after iterative revision. The handler must protect by the CONSUMPTION/hand-off graph,
// not the producing record, or gc is a no-op (keep-latest-N shadowed). The pre-fix handler folded
// t.artifacts into `referenced`, so every version was protected and nothing was ever archived.
test("/artifacts gc still archives superseded versions when each is pinned by its producing trace", async () => {
  const { ws, props } = await setup();
  for (let i = 1; i <= 5; i++) {
    saveArtifact(ws, { id: "doc", title: `v${i}`, body: `${i}`, producer: "root", runId: `root/2026-07-04-run${i}` });
    writeTrace(ws, mkTrace({ id: `root/2026-07-04-run${i}`, agent: "root", artifacts: [`doc@v${i}`] }));
  }
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/artifacts gc", ENTER);
  await waitFor(lastFrame, "archived 2 version(s)"); // v1/v2 collected despite being trace-pinned
  expect(readArtifact(ws, "doc@v1")).toBeNull();
  expect(readArtifact(ws, "doc@v2")).toBeNull();
  expect(readArtifact(ws, "doc")!.version).toBe(5);
});

// A version CONSUMED via the hand-off graph (inputArtifacts/outputArtifacts) must survive gc, however
// old — this is the safety invariant the re-scoped protected set must still honor.
test("/artifacts gc never archives a version handed off across a delegation edge", async () => {
  const { ws, props } = await setup();
  for (let i = 1; i <= 5; i++) {
    saveArtifact(ws, { id: "doc", title: `v${i}`, body: `${i}`, producer: "root", runId: `root/2026-07-04-run${i}` });
    writeTrace(ws, mkTrace({ id: `root/2026-07-04-run${i}`, agent: "root", artifacts: [`doc@v${i}`] }));
  }
  // A later run handed old doc@v1 DOWN to a child and received doc@v2 UP — both are live references.
  writeTrace(ws, mkTrace({ id: "root/2026-07-04-run9", agent: "root", inputArtifacts: ["doc@v1"], outputArtifacts: ["doc@v2"] }));
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "/artifacts gc", ENTER);
  await waitFor(lastFrame, "nothing to collect"); // v1+v2 protected by hand-off; v3/v4/v5 are keep-latest-3
  expect(readArtifact(ws, "doc@v1")!.title).toBe("v1");
  expect(readArtifact(ws, "doc@v2")!.title).toBe("v2");
});

// ── Plan 15: completion action bar + artifact viewer ──

test("Plan 21: a completed turn with artifacts DOCKS the browser; ⏎ opens the full-screen reader; esc chain", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    toolCall("save_artifact", { id: "test-doc", title: "Test Document", body: "# Hello\n\nThis is the content." }),
    finalText("Done. See artifact test-doc@v1."),
  ) as any });
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "create a document", ENTER);
  await waitFor(lastFrame, "ARTIFACTS");                 // the shelf docked itself — no bar, no command
  expect(lastFrame()).toContain("test-doc@v1");          // the row is on the shelf
  expect(lastFrame()).toContain("1 artifact");           // the honesty line
  expect(lastFrame()).toContain("this run");             // scoped to the run that just ended

  await send(stdin, ENTER);                              // ⏎ → the full-screen reader
  await waitFor(lastFrame, "Hello");                     // the body renders
  expect(lastFrame()).toContain("test-doc@v1 · root");   // reader header: handle · producer
  expect(lastFrame()).toContain("esc shelf");

  await send(stdin, ESC);                                // reader → shelf
  await waitFor(lastFrame, "ARTIFACTS");
  await send(stdin, ESC);                                // shelf → chat
  await waitForGone(lastFrame, "ARTIFACTS");
  await waitFor(lastFrame, "> ");                        // the input line is back
});

test("Plan 21: a turn with no artifacts does not dock the browser", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(finalText("just text, no artifacts")) as any });
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "say hi", ENTER);
  await waitFor(lastFrame, "just text, no artifacts");
  expect(lastFrame()).not.toContain("ARTIFACTS");
});

test("Plan 21: a FAILED turn never docks, even when it produced artifacts (spec §1 unifies the old two triggers)", async () => {
  // The @agent path used to show the bar unconditionally; now both paths gate on completed.
  let calls = 0;
  const model = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async () => {
      calls += 1;
      if (calls > 1) throw Object.assign(new Error("provider died"), { code: "ECONNREFUSED" });
      return toolCall("save_artifact", { id: "orphan", title: "Orphan", body: "body" });
    }) as any,
  });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "maker", role: "makes things", identity: "You make things." }, "root");
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "@maker make a thing", ENTER);
  await waitFor(lastFrame, "failed");                    // the run line reports the failure
  expect(lastFrame()).not.toContain("ARTIFACTS");        // no dock on a failed turn
});

test("Plan 21: bare /artifacts re-enters the browser scoped to the latest run", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    toolCall("save_artifact", { id: "re-doc", title: "Re Doc", body: "content" }),
    finalText("saved."),
  ) as any });
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "make it", ENTER);
  await waitFor(lastFrame, "ARTIFACTS");
  await send(stdin, ESC);                                // leave the dock
  await waitForGone(lastFrame, "ARTIFACTS");
  await send(stdin, "/artifacts", ENTER);                // one command re-enters
  await waitFor(lastFrame, "ARTIFACTS");
  expect(lastFrame()).toContain("re-doc@v1");            // same latest-run scope
});

test("Plan 21 Ph2: scope round-trip — this run / conversation / all runs (grouped)", async () => {
  // Two turns, two artifacts. Scope 1 shows only the latest turn's; scope 2 (ledger union) shows
  // both; scope 3 shows both under run-group headers.
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    toolCall("save_artifact", { id: "art-one", title: "Art One", body: "first" }),
    finalText("one saved."),
    toolCall("save_artifact", { id: "art-two", title: "Art Two", body: "second" }),
    finalText("two saved."),
  ) as any });
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "make one", ENTER);
  await waitFor(lastFrame, "art-one@v1");
  await send(stdin, ESC);                                 // leave the first dock
  await waitForGone(lastFrame, "ARTIFACTS");
  await send(stdin, "make two", ENTER);
  await waitFor(lastFrame, "art-two@v1");                 // second turn docked, scoped to ITS run
  expect(lastFrame()).not.toContain("art-one@v1");        // scope 1 = this run only

  await send(stdin, "2");                                 // conversation scope: every ledger turn
  await waitFor(lastFrame, "art-one@v1");
  expect(lastFrame()).toContain("art-two@v1");

  await send(stdin, "3");                                 // all runs: grouped by producing run
  await waitFor(lastFrame, "artifact");                   // a group header ("── … · 1 artifact · …")
  expect(lastFrame()).toContain("──");
  expect(lastFrame()).toContain("art-one@v1");
  expect(lastFrame()).toContain("art-two@v1");

  await send(stdin, "1");                                 // back to this run
  await waitForGone(lastFrame, "art-one@v1");
  expect(lastFrame()).toContain("art-two@v1");
});

test("Plan 21 Ph2: a background settle while docked HINTS instead of lying a row into scope 1", async () => {
  const model = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async ({ prompt }: { prompt: unknown }) => {
      const s = JSON.stringify(prompt);
      if (s.includes("bg-art")) return finalText("bg done");                  // worker AFTER its save (before
      // the identity branch — the worker's prompt always carries its identity; identity-first loops it)
      if (s.includes("HINT-WORKER-IDENTITY")) {
        await sleep(300); // settle AFTER the dock is up
        return toolCall("save_artifact", { id: "bg-art", title: "BG Art", body: "made off-turn" });
      }
      if (s.includes("task_bg_")) return finalText("dispatched and saved.");  // root after dispatch
      return {
        content: [
          { type: "tool-call", toolCallId: "s1", toolName: "save_artifact", input: JSON.stringify({ id: "fg-art", title: "FG Art", body: "foreground" }) },
          { type: "tool-call", toolCallId: "d1", toolName: "dispatch_task", input: JSON.stringify({ to: "hintworker", goal: "make one off-turn" }) },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
      } as unknown as LanguageModelV3GenerateResult;
    }) as any,
  });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "hintworker", role: "background maker", identity: "HINT-WORKER-IDENTITY — you save artifacts off-turn.", tools: [] }, "root");
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "save and dispatch", ENTER);
  await waitFor(lastFrame, "ARTIFACTS");                  // docked (scope 1) with the foreground artifact
  expect(lastFrame()).toContain("fg-art@v1");
  await waitFor(lastFrame, "press 3", 6000);              // the settle hinted…
  expect(lastFrame()).not.toContain("bg-art@v1");         // …and did NOT inject the out-of-scope row
  await send(stdin, "3");                                 // one keystroke away, as promised
  await waitFor(lastFrame, "bg-art@v1");
}, 15000);

test("Plan 21 Ph3: '/' search live-narrows the shelf and the honesty line admits it", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    {
      content: [
        { type: "tool-call", toolCallId: "a1", toolName: "save_artifact", input: JSON.stringify({ id: "fusion-notes", title: "Fusion Notes", body: "plasma" }) },
        { type: "tool-call", toolCallId: "a2", toolName: "save_artifact", input: JSON.stringify({ id: "market-brief", title: "Market Brief", body: "money" }) },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
    } as unknown as LanguageModelV3GenerateResult,
    finalText("both saved."),
  ) as any });
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "make both", ENTER);
  await waitFor(lastFrame, "2 artifacts");                // both on the shelf
  await send(stdin, "/");                                 // open search (the browser's own input line)
  await waitFor(lastFrame, "searching title");
  await send(stdin, "f", "u", "s");                       // type to narrow, live
  await waitFor(lastFrame, "1 of 2 match");               // the honesty line
  expect(lastFrame()).toContain("fusion-notes@v1");
  expect(lastFrame()).not.toContain("market-brief@v1");
  await send(stdin, ESC);                                 // esc clears the query
  await waitFor(lastFrame, "2 artifacts");
});

test("Plan 21 Ph3: the `f` chip row narrows by feedback:open, live", async () => {
  const model = new MockLanguageModelV3({ doGenerate: mockValues(
    {
      content: [
        { type: "tool-call", toolCallId: "a1", toolName: "save_artifact", input: JSON.stringify({ id: "flagged", title: "Flagged", body: "needs work" }) },
        { type: "tool-call", toolCallId: "a2", toolName: "save_artifact", input: JSON.stringify({ id: "clean", title: "Clean", body: "fine" }) },
      ],
      finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
    } as unknown as LanguageModelV3GenerateResult,
    finalText("saved."),
  ) as any });
  const { ws, props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "make both", ENTER);
  await waitFor(lastFrame, "2 artifacts");
  // Pin open feedback on one of them (the store call the `a` verb will make in Ph4).
  annotateArtifact(ws, { target: "flagged@v1", author: "human", body: "tighten this up" });
  await send(stdin, "f");                                 // open the chip row
  await waitFor(lastFrame, "FILTER");
  await send(stdin, RIGHT, RIGHT);                        // producer → type → feedback
  await send(stdin, DOWN);                                // any → open (applies live)
  await waitFor(lastFrame, "1 of 2 match");
  expect(lastFrame()).toContain("flagged@v1");
  expect(lastFrame()).not.toContain("clean@v1");
  await send(stdin, "x");                                 // clear all chips
  await waitFor(lastFrame, "2 artifacts");
});

test("Plan 21: a pending approval SUSPENDS the docked browser — the card owns 'y', the dock returns after", async () => {
  // Turn 1: root saves an artifact AND dispatches a background worker, then finishes → the dock
  // appears. The worker (slow start) then requests create_agent → the approval card must take the
  // WHOLE keyboard (dock unmounted), 'y' answers the CARD (never approves an artifact), and when the
  // queue drains the dock remounts from preserved state. This is the spec §1 blocker test.
  const model = new MockLanguageModelV3({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    doGenerate: (async ({ prompt }: { prompt: unknown }) => {
      const s = JSON.stringify(prompt);
      if (s.includes("minted-by-bg")) return finalText("bg worker done");         // worker AFTER approval (check
      // BEFORE the identity branch — the worker's prompt always carries its identity, and matching it
      // first would loop the worker into requesting create_agent forever)
      if (s.includes("SUSPEND-WORKER-IDENTITY")) {
        await sleep(250); // let the dock render first
        return toolCall("create_agent", { id: "minted-by-bg", role: "background-minted", identity: "You were minted from a background approval." });
      }
      if (s.includes("task_bg_")) return finalText("dispatched and saved.");      // root after dispatch result
      return {
        content: [
          { type: "tool-call", toolCallId: "s1", toolName: "save_artifact", input: JSON.stringify({ id: "sus-doc", title: "Sus Doc", body: "content" }) },
          { type: "tool-call", toolCallId: "d1", toolName: "dispatch_task", input: JSON.stringify({ to: "susworker", goal: "mint an agent" }) },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
      } as unknown as LanguageModelV3GenerateResult;
    }) as any,
  });
  const { ws, db, props } = await setup({ model });
  await createAgent(ws, db, { id: "susworker", role: "suspends the dock", identity: "SUSPEND-WORKER-IDENTITY — you request approvals.", tools: ["create_agent"] }, "root");
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "save and dispatch", ENTER);
  await waitFor(lastFrame, "ARTIFACTS");                 // docked after the completed foreground turn
  await waitFor(lastFrame, "approve?", 6000);            // the background approval CARD is up (gate on the
                                                         // card's own text — the ↳ breadcrumb fires earlier)
  expect(lastFrame()).not.toContain("ARTIFACTS");        // …and it SUSPENDED the dock outright
  await send(stdin, "y");                                // 'y' can only mean the card
  await waitFor(lastFrame, "ARTIFACTS", 6000);           // queue drained → the dock remounted
  await waitFor(lastFrame, "background task", 8000);     // the worker settled — its create_agent has run
  expect(existsSync(join(ws, "agents", "minted-by-bg", "agent.md"))).toBe(true);  // the card was approved
  expect(lastFrame()).toContain("sus-doc@v1");           // state preserved (same shelf)
}, 15000);

// --- Plan 19: /teams through the real REPL (Layer 1 — UI wiring never ships on typecheck alone) ----

test("/teams reports an empty squad, then lists a real team read from disk", async () => {
  const { props } = await setup();
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "/teams", ENTER);
  await waitFor(lastFrame, "(no teams)");

  // A team is a captain-owned file. Write one, then ask again — App re-reads teams/ per invocation,
  // so an edit shows up without a restart.
  createTeam(props.ws, { id: "news", charter: "covers breaking stories", lead: "editor" });
  await createAgent(props.ws, props.db, { id: "editor", role: "assigns copy", identity: "You edit.", team: "news" }, "root");
  await reindex(props.ws, props.db);

  await send(stdin, "/teams", ENTER);
  await waitFor(lastFrame, "news: covers breaking stories");
  expect(lastFrame()).toContain("lead: editor");
  expect(lastFrame()).toContain("editor: assigns copy");
});

// --- Plan 18: the pinned plan panel (Layer 1 — UI wiring never ships on typecheck alone) -----------

test("the plan panel appears when the model writes a plan, and ticks live", async () => {
  const model = mockCalls(
    call("write_plan", { goal: "ship the notifier", items: [{ id: "it_survey", text: "survey the code" }, { id: "it_ship", text: "open the PR" }] }),
    call("update_plan_item", { itemId: "it_survey", status: "done" }),
    textResult("all set"),
  );
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);

  await send(stdin, "plan and go", ENTER);
  // wait for the SECOND tool call to land, not just the first — the panel redraws in place
  await waitFor(lastFrame, "1/2");
  const frame = lastFrame()!;
  expect(frame).toContain("p_ship-the-notifier@v1");
  expect(frame).toContain("survey the code");
  expect(frame).toContain("open the PR");
  expect(frame).toContain("1/2");          // the tick landed
  expect(frame).toContain("✓");            // done glyph
  expect(frame).toContain("○");            // pending glyph
});

test("/plan off hides the panel and persists; /plan on brings it back", async () => {
  const model = mockCalls(
    call("write_plan", { goal: "ship it", items: [{ id: "it_a", text: "do the thing" }] }),
    textResult("ok"),
  );
  const { props } = await setup({ model });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "go", ENTER);
  await waitFor(lastFrame, "do the thing");
  await waitFor(lastFrame, "ok"); // the run must SETTLE first, or the slash command is read as a steer

  await send(stdin, "/plan off", ENTER);
  await waitFor(lastFrame, "plan panel → off");
  expect(lastFrame()).not.toContain("▎plan");
  expect(readPrefs(props.ws).planPanel).toBe(false);

  await send(stdin, "/plan on", ENTER);
  await waitFor(lastFrame, "plan panel → on");
  expect(lastFrame()).toContain("do the thing");
  expect(readPrefs(props.ws).planPanel).toBe(true);
});

test("a plan on disk is shown at boot — it survives a restart visibly", async () => {
  const { props } = await setup();
  const { plan } = writePlan(props.ws, { owner: "root", goal: "resume me", items: [{ id: "it_a", text: "left over from last session" }], producer: "root", runId: "root/r1" });
  reindexPlans(props.ws, props.db);
  expect(currentPlanId(props.db, "root")).toBe(plan.id);

  const { lastFrame } = render(<App {...props} />);
  await waitFor(lastFrame, "left over from last session");
  expect(lastFrame()).toContain("▎plan");
});

test("a plan step event does NOT disturb the live status map (it is phase-less by construction)", async () => {
  // The regression this guards: giving the plan its own StepPhase would fall through statusReducer's
  // switch and mint a bogus AgentState for the run.
  const before = statusReducer(new Map(), { agent: "root", runId: "r1", phase: "model_start" }, 1000);
  const after = statusReducer(before, { agent: "root", runId: "r1", plan: undefined } as never, 2000);
  expect(after).toBe(before); // the guard `if (!ev.phase || !ev.runId) return map` drops it, same Map
  expect(after.get("r1")!.state).toBe("thinking");
});
