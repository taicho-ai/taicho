# Testing taicho

taicho is tested in **four layers**, fastest/most-isolated first. Most work only needs Layer 1.

| Layer | What it covers | Tool | Run with | Speed |
|-------|----------------|------|----------|-------|
| **1. Unit + in-process E2E** | pure logic, the agent loop, and the **real `<App>` REPL** with a mocked model | `bun:test` + `ink-testing-library` | `bun test` | ~1.5s, deterministic |
| **2. Real-binary E2E** | the **compiled `dist/taicho`** booting and responding in a real terminal | `@microsoft/tui-test` (xterm pty) | `bun run test:e2e` | ~20s |
| **3. Real-model verification** | actual multi-agent behavior (delegation, memory, …) with the **live LLM** | plain `bun` scripts | `bun run <script>.ts` | seconds, costs tokens |
| **4. VHS evidence** | **real user flows through the real binary, with watchable video proof** — records a true session video + screenshots and asserts on the **workspace files** | VHS (`ttyd`+`ffmpeg`) + wrapper | `bun scripts/e2e-evidence.ts <scenario>` | ~15–30s, needs `vhs` |

```bash
bun test                       # Layer 1 — the whole src suite
bun test src/ui/App.test.tsx   # a single file
bun run typecheck              # bunx tsc --noEmit
bun run build                  # compile dist/taicho
bun run test:e2e               # Layer 2 — builds, then runs tui-test
bun scripts/e2e-evidence.ts agent-flow       # Layer 4 — records real-binary video proof (needs vhs)
bun scripts/e2e-evidence.ts trace-inspector  # Layer 4 — the /trace waterfall, opened over a real trace
```
There is no `npm test` script — use `bun test` (Bun's built-in runner discovers `src/**/*.test.ts`).

For the focused real-binary agent workflow and recording evidence, see [CLI_TESTING.md](/Users/rajeshsharma/Documents/Works/Personal/agents/taicho/CLI_TESTING.md).

---

## Layer 1 — unit + in-process E2E (`bun test`)

Tests are colocated `*.test.ts` next to the code. Two flavors:

**Pure logic** — `config.test.ts`, `slash.test.ts`, `input.test.ts`, `pricing.test.ts`, etc. Plain assertions.

**The agent loop, with a mocked model** — use `MockLanguageModelV3` from `ai/test`:
```ts
import { MockLanguageModelV3, mockValues } from "ai/test";
// sequence the model's turns; tool-call turn → final-text turn (see loop.test.ts)
new MockLanguageModelV3({ doGenerate: mockValues(toolCallResp, finalResp) as any });
```
A response is a `LanguageModelV3GenerateResult`-shaped object (`content`, `finishReason`, `usage`). For the ChatGPT-subscription/Codex path, `runLoop` streams — pass `codexBackend: true` and a `doStream` mock (see the `codexBackend` test in `loop.test.ts`).

**Delegation verification (Plan 06) — sequence the checker into the same mock.** When `delegate_task` carries `criteria`, the child's output is judged by an **independent checker call** on the *delegating agent's* model. In a test that model is the same `MockLanguageModelV3`, so the checker's turn is just the next value in your `mockValues(...)` sequence — return a JSON verdict string, e.g. `text('{"pass": false, "reasons": ["missing Y"]}')`. A fail→retry→fail flow is six turns: `delegate_task` call · child attempt · checker(fail) · child retry · checker(fail) · parent final. **No criteria ⇒ no checker turn** (assert `doGenerateCalls.length` to prove the extra call is absent, and `trace.verification` is empty). See the Plan 06 tests in `run.test.ts` and the `delegation with acceptance criteria` test in `App.test.tsx` (the captain sees the failed-verdict breadcrumb via the `onStep` `note`).

**Context compaction (Plan 05) — force a tiny threshold; no network.** The fold is DETERMINISTIC (no LLM call), so it is pure-unit tested in `core/compaction.test.ts` (estimator, per-model window table + threshold, and `compactMessages`: kept-verbatim head + recent tail, summary tool histogram, re-fold of a prior summary). To trigger it inside the loop, pass `runLoop` an explicit `compactThresholdTokens` (a tiny number like `60`) plus a tool whose `execute` returns a chunky result so the message array grows fast, then sequence several tool-call turns before the final — assert a `compaction` transcript event fired, `res.compactions > 0`, and a later `doGenerateCalls` prompt still contains the original brief AND the `[CONTEXT COMPACTION]` summary (head kept verbatim, oldest round-trips folded). `contextTokens` is measured **every** run even with no threshold. See the two Plan 05 tests in `loop.test.ts`.

**Background dispatch (Plan 04) — one branching mock covers two runs.** `dispatch_task` is fire-and-forget: the root run returns immediately and a **detached** worker run executes off-turn on the *same* model. Sequential `mockValues(...)` is racy here (two runs pop the same queue in nondeterministic order), so give the mock a `doGenerate` that **branches on the prompt**: match the worker's identity string → return its result (optionally `await sleep(...)` so it settles *after* the foreground turns, proving dispatch never blocked); match the dispatched taskId (`task_bg_`) in a tool result → root's post-dispatch reply; else → the initial `dispatch_task` tool call. Assert the settle **notification** appears in a later frame and `listTaskIndex(db, { activeOrBackground: true })` records the task `completed`. `TaskScheduler` (`core/tasks.test.ts`) and the task store (`store/task-state.test.ts`) are covered as pure units. See the `dispatch_task runs in the BACKGROUND` test in `App.test.tsx`.

**The real REPL, in-process** — `src/ui/App.test.tsx` renders the actual `<App>` with `ink-testing-library`, a mocked model, and a **fake `McpManager`**, then scripts keystrokes and asserts on rendered frames. This exercises the real `submit → runSlash → executeRun → runLoop` wiring without a terminal or LLM. The `setup()` helper builds a throwaway workspace (`ensureWorkspace`/`seedRoot`/`openDb`/`reindex`) and fake props — dependency injection (`model`, `mcp`, `authSource` are all `<App>` props) is what makes this possible.

### ⚠️ ink-testing-library gotchas (the non-obvious part)

1. **Write each keystroke as its OWN `stdin.write`.** ink parses a single multi-char chunk as *literal text*, so `stdin.write("hi\r")` types `hi` but **does not submit**. Write the text, then `"\r"`, as separate events with a tick between:
   ```ts
   async function send(stdin, ...chunks) { for (const c of chunks) { stdin.write(c); await sleep(20); } }
   await send(stdin, "hello", "\r");
   ```
2. **Arrow/Esc keys are ANSI escapes:** down `\u001B[B`, up `\u001B[A`, Esc `\u001B`. **Use the `\u001B` JS escape in source** — a raw ESC byte pasted into a file is invisible and fragile (verify with `od -c` if a key test mysteriously fails). Enter is `"\r"`.
3. **State updates are async** — poll the frame, don't assert immediately:
   ```ts
   async function waitFor(frame, sub, t=4000) { /* poll frame() until it includes sub */ }
   ```
4. **Catch transient states with a slow mock** — to assert something that only shows mid-run (e.g. the loading spinner), give the mock model a delay (`doGenerate: async () => { await sleep(250); return finalResp; }`).
5. **Approval/question flows** (`create_agent`, `ask_human`): drive the model to emit the tool-call, `waitFor` the card, send the choice key, then `waitFor` the resumed reply (see the `ask_human end-to-end` test).

---

## Layer 2 — real-binary E2E (`@microsoft/tui-test`)

`bun run test:e2e` builds `dist/taicho`, then `tui-test` spawns it in a **real xterm pty** and asserts on the actual rendered terminal. Tests live in `e2e/*.tui.ts`; config in `tui-test.config.ts`.
```ts
import { test, expect } from "@microsoft/tui-test";
test.use({ program: { file: "./dist/taicho" }, columns: 100, rows: 30 });
test("…", async ({ terminal }) => {
  await expect(terminal.getByText("taicho —")).toBeVisible();  // wait for boot
  terminal.submit("/help");                                     // text + Enter
  await expect(terminal.getByText("/agents")).toBeVisible();
});
```

**File separation:** `bun test` owns `src/**/*.test.ts`; `tui-test` owns `e2e/*.tui.ts` (via `testMatch`). They never run each other's files — keep the extensions distinct.

### ⚠️ tui-test caveats
- It's **v0.0.4** (early) — treat it as a thin smoke layer, not the main suite.
- **cwd isolation is imperfect** at 0.0.4: it effectively runs the binary from the repo root, so tests touch the repo's (gitignored) workspace. Fine for boot/slash smoke tests (they don't start model runs).
- **Timing is flaky** (`retries: 1` is set) — assert on **robust signals** (e.g. a server's startup line) rather than races like submitting `/mcp list` right at boot.
- **Model-driven runs** can't be black-boxed here without a key/mock — keep deep run logic in Layer 1.

---

## Layer 3 — real-model verification scripts

When you need to prove the system *actually works* with the live model (delegation, collaboration, memory), write a plain `bun` script that wires the engine exactly like `src/index.tsx` and inspects the resulting **traces**. Pattern:

```ts
const authSource = resolveAuth({ config, loadProfile: () => readProfile() });
// build the real model like index.tsx's buildFromAuth (env → buildModel; subscription → createCodexProvider)
const deps = makeDeps({ ws, db, model, resolveModel, requestApproval: async () => ({ type: "approve" }) });
const res = await executeRun(deps, { agent: root, messages: [...], triggeredBy: "user" });
console.log(res.trace.delegatedOut, listTraces(ws).map(t => `${t.id} ${t.outcome}`));
```
Auto-approving `requestApproval` lets it run unattended. Assert on the trace: `delegatedOut`, `toolCalls`, `artifacts`, `outcome`. These run on the user's **subscription/API** (real tokens), so keep them small and don't commit them to CI. Park them under `scripts/` or a scratch dir.

---

## Layer 4 — VHS evidence (recorded real-binary proof)

When a flow needs **watchable, auditable proof** (not just "tests passed"), Layer 4 drives the
compiled `dist/taicho` through a real user flow in a headless terminal and hands back a folder a
human can watch: a **true session video** + screenshots + machine-checked assertions on the files
the binary produced.

```bash
bun scripts/e2e-evidence.ts agent-flow    # → evidence/agent-flow/{session.mp4, *.png, manifest.json}
```

A **scenario** (`e2e/scenarios/<name>.ts`) = a VHS tape (drives the flow, waits gated on on-screen
text) + file assertions (decide pass/fail). The wrapper (`scripts/e2e-evidence.ts`) builds + warms
the binary, records in a **fresh temp workspace** (never the repo root), and writes
`evidence/<scenario>/manifest.json` — the deliverable. **Video is evidence, not assertion**:
pass/fail comes only from the workspace-file assertions. Deterministic via
`TAICHO_E2E_MODEL=agent-flow` (`src/core/e2e-model.ts`), same keystone as Layer 2.

Needs `vhs` on PATH (`brew install vhs`) — verified on this machine with **vhs 0.11.0 / ttyd
1.7.7** (ffmpeg already present). Full guide, the assertion contract, and the verified
gotchas (relative vhs `Output`/`Screenshot` paths, the `ttyd` localhost port, binary warm-up):
[CLI_TESTING.md](/Users/rajeshsharma/Documents/Works/Personal/agents/taicho/CLI_TESTING.md).

---

## Observability: testing the `/trace` waterfall (Plan 02)

The `/trace` inspector is the **reader** for the run evidence the system produces (traces,
`transcript.jsonl`, coaching ledger, verification verdicts). It is tested at three layers, and
because its derivation is **pure**, most of it needs no terminal at all.

- **Pure unit** — `src/core/trace-tree.test.ts` exercises `deriveTrace(ws, rootRunId)` over
  fixtures generated by **real engine runs** (not hand-written JSON): it asserts the span tree
  (run/llm/tool/approval spans), the `delegate_task` → child-run adoption via `childRunId`, the
  verification-retry first-attempt nesting, and token/cost roll-up. `src/core/trace-layout.test.ts`
  covers the layout: the ≥1-cell min-width floor, indent-by-depth, and that collapsing a run hides
  its subtree. No Ink, no network.
- **Layer 1 (Ink)** — `src/ui/App.test.tsx` renders the real `<App>`, opens the inspector, and
  drives `↑↓` navigation, `⏎` drill-in, and an error span with `ink-testing-library`.
- **Layer 4 (VHS evidence)** — `bun scripts/e2e-evidence.ts trace-inspector` drives the compiled
  binary through a real **delegation** (create → approve → delegate, reusing the `agent-flow` e2e
  model), then types `/trace`, waits for the waterfall tree, drills into the root run span, and
  screenshots both. Its file assertions call `deriveTrace` on the produced workspace and assert the
  delegation tree (root run span + `delegate_task` tool span with a `childRunId` + a nested
  proof-agent run span) — so the same pure derivation the inspector renders is what decides pass/fail.
  - **Deterministic screen-gating (documented for the next author).** Gating the `/trace` submit is
    the one non-obvious part: the bare word "trace" is already on screen (the post-run `· /trace to
    inspect` hint), so it can't gate the Enter. The tape instead waits on **"waterfall inspector"** —
    the `/trace` command's summary in the live suggester, which appears only once `/trace` is fully
    typed and is unambiguous. The tree render gates on **"TRACE"** (the inspector header, nowhere
    else); the drill-in gates on **"coaching ledger"** (rendered only in the run-span detail). All
    three proved stable across repeated runs; none is a load-bearing fixed `Sleep`.

## Adding a dependency (testing-adjacent gotcha)

`bun add <pkg>` re-resolves the whole tree and hits a broken upstream publish (`@vercel/ai-tsconfig@0.0.0`, 404). **Instead: edit `package.json` and run `bun install`**, keeping the `overrides` block intact (it pins the transitive `@ai-sdk/*` packages; never override a *direct* dep — npm's `EOVERRIDE` would then break `npx`, which launches stdio MCP servers). See the note in `package.json`.

## Before claiming done
`bun run typecheck` **and** `bun test` must be green. For changes to model/provider/MCP wiring, also `bun run build` (the single-binary bundle catches import issues `tsc` won't), and consider `bun run test:e2e`.
