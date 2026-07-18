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
bun test packages/cli/src/ui/App.test.tsx   # a single file
bun run typecheck              # bunx tsc --noEmit
bun run build                  # compile dist/taicho
bun run test:e2e               # Layer 2 — builds, then runs tui-test
bun scripts/e2e-evidence.ts agent-flow        # Layer 4 — records real-binary video proof (needs vhs)
bun scripts/e2e-evidence.ts artifact-handoff  # Layer 4 — Plan 01 hand-off by reference (parent stays thin)
bun scripts/e2e-evidence.ts squad-panes       # Layer 4 — Plan 10 live panes + bar during a delegation
bun scripts/e2e-evidence.ts consistent-blocks # Layer 4 — Plan 13 agent blocks live→done + operation view
bun scripts/e2e-evidence.ts artifact-browser  # Layer 4 — Plan 21 docked browser + full-screen reader
bun scripts/otel-verify.ts                    # Layer 4b — real OTLP wire verification (see below)
```
There is no `npm test` script — use `bun test` (Bun's built-in runner discovers `src/**/*.test.ts`).

For the focused real-binary agent workflow and recording evidence, see [CLI_TESTING.md](/Users/rajeshsharma/Documents/Works/Personal/agents/taicho/CLI_TESTING.md).

---

## Layer 1 — unit + in-process E2E (`bun test`)

Tests are colocated `*.test.ts` next to the code. Two flavors:

**Pure logic** — `config.test.ts`, `slash.test.ts`, `input.test.ts`, `pricing.test.ts`, etc. Plain assertions.

**The agent loop, with a mocked model** — since Plan 07 the loop unifies on `streamText`, so the AI
SDK drives EVERY model via `doStream` (a raw `doGenerate`-only `ai/test` mock cannot drive `runLoop`).
Use the local wrapper `packages/framework/src/core/mock-model.ts`, which auto-derives a streaming `doStream` from a
`doGenerate` script while keeping `.doGenerateCalls` assertions working:
```ts
import { MockLanguageModelV3, mockValues } from "../core/mock-model"; // NOT "ai/test"
// sequence the model's turns; tool-call turn → final-text turn (see run.test.ts)
new MockLanguageModelV3({ doGenerate: mockValues(toolCallResp, finalResp) as any });
```
A response is a `LanguageModelV3GenerateResult`-shaped object (`content`, `finishReason`, `usage`).
Tests that need chunk-level control (deltas, provider cost metadata, the Codex path) pass a
`doStream` directly — see `loop.test.ts`'s `streamOf`/`streamSeq` helpers.

**Delegation verification (Plan 06) — sequence the checker into the same mock.** When `delegate_task` carries `criteria`, the child's output is judged by an **independent checker call** on the *delegating agent's* model. In a test that model is the same `MockLanguageModelV3`, so the checker's turn is just the next value in your `mockValues(...)` sequence — return a JSON verdict string, e.g. `text('{"pass": false, "reasons": ["missing Y"]}')`. A fail→retry→fail flow is six turns: `delegate_task` call · child attempt · checker(fail) · child retry · checker(fail) · parent final. **No criteria ⇒ no checker turn** (assert `doGenerateCalls.length` to prove the extra call is absent, and `trace.verification` is empty). See the Plan 06 tests in `run.test.ts` and the `delegation with acceptance criteria` test in `App.test.tsx` (the captain sees the failed-verdict breadcrumb via the `onStep` `note`).

**Context compaction (Plan 05) — force a tiny threshold; no network.** The fold is DETERMINISTIC (no LLM call), so it is pure-unit tested in `core/compaction.test.ts` (estimator, per-model window table + threshold, and `compactMessages`: kept-verbatim head + recent tail, summary tool histogram, re-fold of a prior summary). To trigger it inside the loop, pass `runLoop` an explicit `compactThresholdTokens` (a tiny number like `60`) plus a tool whose `execute` returns a chunky result so the message array grows fast, then sequence several tool-call turns before the final — assert a `compaction` transcript event fired, `res.compactions > 0`, and a later `doGenerateCalls` prompt still contains the original brief AND the `[CONTEXT COMPACTION]` summary (head kept verbatim, oldest round-trips folded). `contextTokens` is measured **every** run even with no threshold. See the two Plan 05 tests in `loop.test.ts`.

**Background dispatch (Plan 04) — one branching mock covers two runs.** `dispatch_task` is fire-and-forget: the root run returns immediately and a **detached** worker run executes off-turn on the *same* model. Sequential `mockValues(...)` is racy here (two runs pop the same queue in nondeterministic order), so give the mock a `doGenerate` that **branches on the prompt**: match the worker's identity string → return its result (optionally `await sleep(...)` so it settles *after* the foreground turns, proving dispatch never blocked); match the dispatched taskId (`task_bg_`) in a tool result → root's post-dispatch reply; else → the initial `dispatch_task` tool call. Assert the settle **notification** appears in a later frame and `listTaskIndex(db, { activeOrBackground: true })` records the task `completed`. `TaskScheduler` (`core/tasks.test.ts`) and the task store (`store/task-state.test.ts`) are covered as pure units. See the `dispatch_task runs in the BACKGROUND` test in `App.test.tsx`.

**Scheduled/triggered runs (Plan 04 Phase 6) — INJECT the clock, never the wall.** The `SchedulerRunner` (`core/scheduler.ts`) takes its clock (`now`), its file-stat (`statMtimeMs`), and its fire action as **injected seams**, so tests drive time with explicit values — never `Date.now()`, never a real timer. A test sets `let clock = 0; now: () => clock`, calls `runner.tick()` at chosen clock values, and asserts a schedule fires **at** its due time (not before), doesn't double-fire one window (its `nextDueMs` advances), and never re-fires while its previous run is in flight (hold the fire promise unresolved). Watch triggers inject `statMtimeMs` (fire on an mtime change). Because `fire` is deferred a microtask, drain the loop with `await new Promise(r => setTimeout(r, 0))` before asserting — the same pattern `tasks.test.ts` uses; that `setTimeout(0)` flushes the event loop, it is NOT the scheduler's clock. The end-to-end "unattended → auto-reject" invariant is proven by wiring `fire` to the real `runHeadless({approve:"reject"})` on a model that requests `create_agent` and asserting no agent was created (`core/scheduler.test.ts`). The store (`store/schedules.test.ts`), the shared `parseScheduleCommand` + `runScheduleCli` (`core/schedule-cli.test.ts`), and a Layer-1 `/schedules` round-trip (`App.test.tsx`) cover the rest.

**The real REPL, in-process** — `packages/cli/src/ui/App.test.tsx` renders the actual `<App>` with `ink-testing-library`, a mocked model, and a **fake `McpManager`**, then scripts keystrokes and asserts on rendered frames. This exercises the real `submit → runSlash → executeRun → runLoop` wiring without a terminal or LLM. The `setup()` helper builds a throwaway workspace (`ensureWorkspace`/`seedRoot`/`openDb`/`reindex`) and fake props — dependency injection (`model`, `mcp`, `authSource` are all `<App>` props) is what makes this possible.

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

When you need to prove the system *actually works* with the live model (delegation, collaboration, memory), write a plain `bun` script that wires the engine exactly like `packages/cli/src/index.tsx` and inspects the resulting **traces**. Pattern:

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
bun scripts/e2e-evidence.ts agent-flow        # → evidence/agent-flow/{session.mp4, *.png, manifest.json}
bun scripts/e2e-evidence.ts artifact-handoff   # Plan 01 — A produces, B consumes BY REFERENCE, parent stays thin
bun scripts/e2e-evidence.ts squad-panes        # Plan 10 — two agents live in split panes + bar during a delegation
```

A **scenario** (`e2e/scenarios/<name>.ts`) = a VHS tape (drives the flow, waits gated on on-screen
text) + file assertions (decide pass/fail). The wrapper (`scripts/e2e-evidence.ts`) builds + warms
the binary, records in a **fresh temp workspace** (never the repo root), and writes
`evidence/<scenario>/manifest.json` — the deliverable. **Video is evidence, not assertion**:
pass/fail comes only from the workspace-file assertions. Deterministic via
`TAICHO_E2E_MODEL=<mode>` (`packages/framework/src/core/e2e-model.ts`), same keystone as Layer 2.

The **`artifact-handoff`** scenario (Plan 01) proves the hand-off store end-to-end: root creates a
researcher (A) and a writer (B), A `save_artifact`s a dossier, root delegates it to B **by handle**
(`inputArtifacts:[dossier@v1]`), and B `read_artifact`s it and derives a `brief` linked back via
`parents`. Its keystone assertion: the dossier BODY payload marker appears in the artifact's body
file but **NEVER** in the orchestrating root run's `transcript.jsonl`/`input.json` — heavy content
stayed on disk, the parent context stayed thin.

Needs `vhs` on PATH (`brew install vhs`) — verified on this machine with **vhs 0.11.0 / ttyd
1.7.7** (ffmpeg already present). Full guide, the assertion contract, and the verified
gotchas (relative vhs `Output`/`Screenshot` paths, the `ttyd` localhost port, binary warm-up):
[CLI_TESTING.md](/Users/rajeshsharma/Documents/Works/Personal/agents/taicho/CLI_TESTING.md).

---

## Observability (Plan 16/17): OTel is the trace reader — the `/trace` waterfall is RETIRED

Plan 17 deleted the in-terminal `/trace` waterfall and everything under it: `core/trace-tree.ts`,
`core/trace-layout.ts`, `core/live-trace.ts`, `ui/TraceInspector.tsx`, `ui/LiveWaterfall.tsx`, their
tests, the `/trace` + `/runs` commands, and the `/view waterfall` mode (`/view` is now
`bar|panes|both`). Trace visualization is OpenTelemetry's job — see `docs/observability.md` and
**Layer 4b** below for how the OTel export is tested (`core/otel.test.ts` for span shape,
`scripts/otel-verify.ts` for the wire). The one survivor of the retirement is
`gatherConversationArtifacts`, which moved to `packages/framework/src/core/conversation-artifacts.ts` for the Plan 15
artifact browser.

## Squad UI: the live status bar + split panes (Plan 10)

While a run executes, two surfaces render the live per-agent status (`core/agent-status.ts`, folded
from the one typed `onStep` event stream): the **status bar** (`ui/StatusBar.tsx`, one compact
segment per live agent, pinned above the input) and the **split panes** (`ui/SquadPanes.tsx`, one
pane per live agent — a status line plus its recent tool lines with `argsPreview`). `/view bar` ·
`/view panes` · `/view both` (default **both**) switches which surface(s) show; the choice persists
via `store/prefs.ts` (`<ws>/agents/.prefs.json`, the same file-under-`agents/` mechanism the MCP
store uses). Both surfaces render from the SAME status model — panes are the detail, the bar the
complete summary.

- **Pure units** — `ui/SquadPanes.test.tsx` covers `resolveLayout(mode, cols, rows)` (which surfaces
  show per mode; a too-small terminal degrades EVERY mode to bar-only) and `paneOneLine` (strips the
  inline markdown markers the REPL hides). `store/prefs.test.ts` covers the `/view` persistence
  round-trip and the malformed-file fallback.
- **Layer 1 (Ink)** — the Plan 10 Phase 4 tests in `App.test.tsx` render the real `<App>`: a pane
  appears on a **delegation** (parent `delegating` + child live at once), streams the tool line with
  its `argsPreview`, and collapses after completion; `/view` toggles bar/panes/both and the choice
  round-trips through `getViewMode(ws)`; a `terminalSize={{columns,rows}}` prop (the size seam — else
  the App tracks live `stdout` + its `resize` event) drives the below-minimum **degrade-to-bar-only**.
  - **Two non-obvious things for the next author.** (1) The pane deliberately does **not** echo the
    streamed/final REPLY text — that lives in the scrollback (the reply channel). Duplicating it made
    the reply appear in the pane *before* the scrollback committed and the trace persisted, so every
    "`waitFor` the reply, then assert the trace" test returned early and read a not-yet-written trace.
    The pane's live state + tool lines carry the transparency; the bar + scrollback carry the text.
    (2) The panes render on **every** event during a run, so keep them cheap: no Ink `borderStyle`
    box (its yoga re-layout perturbed a timing-sensitive steering test), and the elapsed-ticker runs
    **only while panes are up** (`hasPanes` gate) — an always-on interval re-rendered the whole App
    at rest and pushed that same test over its per-test timeout. A left-accent rule (`▎`) is the
    pane-only marker the Layer-1 tests key on.
- **Layer 4 (VHS evidence)** — `bun scripts/e2e-evidence.ts squad-panes` (Plan 10 Phase 5) is the
  recorded proof that two agents render **live in split panes + the bar during a delegation**. The
  blocker was timing: the `agent-flow` delegation returns sub-second, so a child's pane "flashes
  faster than a recorded frame." The scenario therefore uses a **slow-mode e2e model**
  (`packages/framework/src/core/e2e-model.ts` `squad-panes` mode) that **holds the child's model call in-flight ~4s**
  (fixed delay, overridable via `TAICHO_E2E_SLOW_MS`; well under the 120s transport deadline and the
  reopened chunk-idle timer — see CLAUDE.md's Plan 12 gotcha). The
  hold is in the **model, never the tape** — during the window root is `delegating` (its delegate_task
  tool blocks on the child) and proof-agent is `thinking` (its held call runs), so both strings appear
  only on the live surfaces (bar + panes), never in the scrollback breadcrumb. The tape's two gates —
  `Wait+Screen /root delegating/` then `Wait+Screen /proof-agent thinking/` — require **both** live
  panes on screen at once before `Screenshot panes.png`, which is the two-agents-in-panes+bar proof;
  file assertions (the delegation trace exists + the child completed) decide pass/fail. `Set Height
  1000` gives the panes vertical room (they degrade to bar-only below `MIN_PANE_ROWS`). Ran twice, no
  flake; `agent-flow` stays 7/7.

### Consistent agent blocks (Plan 13, corrected)

`ui/AgentBlock.tsx` is the **default** squad view for delegated work. Every sub-agent (root's children)
is rendered as a single consistent block: header + fixed 2-line body (3 max). The block NEVER changes
shape across its lifecycle — only the state label, rail colour, and body content change:

| | State label | Rail colour | Two-line body |
|---|---|---|---|
| **live** | `thinking` / `writing` / `delegating` | amber/yellow | the **rolling tail** — newest delta line in at the bottom, oldest scrolls off *inside* the window |
| **done** | `done` | green | the agent's **settled summary** |
| **failed** | `failed` | red | the failure reason (first 2 lines) |

That table describes the `AgentBlock` component's variants. **What App feeds today is narrower**: it
mints only `live`/`done` (a failed delegation renders as a done block), never populates the settled
`summary`/`error`/`artifact` fields, and blocks live in the Ink live region — a done block lingers
~800ms (`useBlockSettle`) then clears rather than persisting into scrollback. Root's own direct reply
still uses the scrollback (the conversational reply channel); blocks are for the squad, not root's
own answer.

**Focus navigation:** `shift+tab` moves keyboard focus into the block region; `↑↓` move a focus ring
across blocks (live AND done); `⏎` opens the focused block into the **operation view** (`ui/OperationView.tsx`,
a drill-in showing the brief, full output, tools, and artifact); `esc` returns focus to the input.

- **Pure units** — `ui/AgentBlock.tsx` exports `tailLines(text, n)` (the fixed-height window) and
  `useBlockSettle`/`useBlockTicker` hooks (the settle-then-collapse lifecycle). The block component
  is tested through the real `<App>` in Layer 1.
- **Layer 1 (Ink)** — the existing delegation tests in `App.test.tsx` exercise the block view: a
  delegation renders blocks for the child agent (not a scrollback flood); the block keeps its shape
  from live→done. The `/view stream` mode has been **deleted** — `stream` is removed from `VIEW_MODES`
  in `store/prefs.ts`, the `showStream` branch in `resolveLayout`, and the slash surface.
- **Layer 4 (VHS evidence)** — `bun scripts/e2e-evidence.ts consistent-blocks`: a slow-mode
  `e2e-model.ts` mode (`consistent-blocks`, holds the child ~4s) drives a real root→squad delegation;
  the tape gates + screenshots the live two-line block, the settled (done) state, and the
  `shift+tab`→`⏎` operation view. File assertions (including the child's reply NOT flooding
  scrollback) decide pass/fail.

### The artifact browser (Plan 21 — replaces Plan 15's bar + viewer)

`ui/ArtifactBrowser.tsx` is a mode, not a command set: a COMPLETED `triggeredBy:"user"` turn with ≥1
artifact in its subtree DOCKS the shelf over the (still visible) chat — no bar, no command — and `⏎`
opens the full-screen reader. `esc` chains reader → shelf → chat; bare `/artifacts` re-enters scoped
to the latest run. Scopes: `tab`/`1·2·3` — this run / conversation (all-agent ledger union) / all
runs (grouped by producing run, `s` cycles sorts). `f` opens filter chips, `/` live-searches on the
browser's OWN input line; the mode line always admits a narrowed window ("4 of 31 match"). Reader
verbs: `a` annotate inline (open feedback on the VIEWED version), `y` approve, `r` request revision
(composes + submits a normal chat turn), `v` versions, `o` `$EDITOR`; shelf `g` (all-runs) previews
GC with `GcOptions.dryRun` before archiving on confirm.

**Keyboard ownership is a fixed dispatch order** — pending card → operation view → browser (its own
`browserKeyRef`, published DURING RENDER per the ink registration race) → chat. A pending approval
SUSPENDS the dock outright (render gate + key order), so `y` can only ever answer the surface on
screen; the dock remounts losslessly from App-held `browserState`. While docked, panes/blocks/plan
panel yield (the one-line status bar stays) and the main TextInput unmounts.

- **Pure units** — `ui/browser-model.test.ts`: scope resolution (run subtree / ledger union / store),
  `latestRunFallback`, the filter predicate per chip, badges (approvals never inflate ⚑), run-grouping
  + sorts, the honesty line. `gatherConversationArtifacts` itself is still covered through these +
  the Layer-1 tests (no colocated test of its own).
- **Layer 1 (Ink)** — the `Plan 21` tests in `App.test.tsx`: auto-enter on completed artifact turns
  (never failed turns, never background settles — those hint); the esc chain; card-suspension (`y`
  answers the card, dock returns with state); scope round-trip; settle hint; `/` search + `f` chips;
  reader verbs `a`/`y`; the `g` dry-run→confirm pair; `r` composing a real turn; `/artifacts`
  re-entry; subcommands pointing at the browser.
- **Layer 4 (VHS)** — `bun scripts/e2e-evidence.ts artifact-browser`: the dock appears by ITSELF
  after a real delegation, `⏎` reader, `a` types feedback that must land as an OPEN annotation on the
  exact version, esc chain out. Keystone assertions: the body marker is in the artifact file, never
  in root's transcript; the typed feedback is in `annotations.jsonl`.

## Adding a dependency (testing-adjacent gotcha)

`bun add <pkg>` re-resolves the whole tree and hits a broken upstream publish (`@vercel/ai-tsconfig@0.0.0`, 404). **Instead: edit `package.json` and run `bun install`**, keeping the `overrides` block intact (it pins the transitive `@ai-sdk/*` packages; never override a *direct* dep — npm's `EOVERRIDE` would then break `npx`, which launches stdio MCP servers). See the note in `package.json`.


## Layer 4b — Real OTLP verification (`bun scripts/otel-verify.ts`)

`core/otel.test.ts` proves the SPANS are shaped right, using the in-memory exporter seam. It cannot
prove that a *shipped* taicho actually gets them onto the wire: everything between `initTelemetry` and
the network — the `BatchSpanProcessor`, the exit-path `telemetry.shutdown()` flush, the OTLP JSON
encoding — is untested by it.

`bun scripts/otel-verify.ts` closes that gap. It stands up a real OTLP/HTTP receiver on `:4318`, drives
the compiled `dist/taicho` headless through a plan + team delegation (`TAICHO_E2E_MODEL=plan-teams`)
with nothing but the standard `OTEL_*` env vars, and asserts on the spans that arrive:

- root's `run` span, and the child `run` span of the agent the TEAM routed to
- both sharing one `traceId` — a delegation is ONE distributed trace
- `taicho.plan.handle`, `taicho.plan.items.{total,done,open,failed}` on the run span
- the `gen_ai` model-call spans and the `write_plan` / `delegate_task` tool spans
- a metrics POST

It prints the received span tree either way, and exits non-zero on the first failed assertion. Needs no
network and no backend — the receiver is a ~40-line Bun server. Run it after any change to `otel.ts`,
`loop.ts`'s telemetry wiring, or the boot/exit paths in `index.tsx`.

## Before claiming done
`bun run typecheck` **and** `bun test` must be green. For changes to model/provider/MCP wiring, also `bun run build` (the single-binary bundle catches import issues `tsc` won't), and consider `bun run test:e2e`.
