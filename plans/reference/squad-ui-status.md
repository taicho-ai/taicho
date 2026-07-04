# Reference — Squad UI: Live Agent Status & Multi-Pane View

Design detail for **Plan 10**. Direction set by the user (2026-07-04, revised same day): **both
surfaces ship in this plan** — the status bar (glanceable summary) and split panes (one agent per
pane). No v1/v2 split. All forks closed (§4).

---

## 1. The problem

While a run executes, the captain is nearly blind. There is a spinner, an "esc to cancel · type to
steer" hint, and flat `↳` breadcrumb lines — that's it. Three specific complaints:

1. **Agent status is opaque.** No answer to "what is each agent doing *right now*?" — idle /
   thinking (model call in flight) / writing (streaming a response) / working (executing a tool) /
   waiting on the captain (approval, ask_human).
2. **Tool calls are not transparent.** Names appear post-hoc as breadcrumbs; the args never show;
   there is no "calling `read_url(https://…)` now" moment. When an agent writes something, the
   captain can't tell what it is doing or for how long.
3. **No squad-level view.** With delegation (and especially Plan 04's parallel/background runs),
   several agents can be live at once; the UI renders one undifferentiated stream.

## 2. Current state (evidence from the code)

- **`onStep` is the only live channel** (`src/core/run.ts:90` — `{ text?, tool?, delta?, agent }`).
  It already carries the agent id (tagged per-run at `src/core/run.ts:277`), so per-agent status is
  plumbing-compatible today.
- **Tool events are post-hoc.** The AI SDK executes tools *inside* `generateText`/`streamText`;
  the loop only learns about them after the call settles (`src/core/loop.ts:170-174` iterates
  `toolCalls` after `out` resolves). So the UI can never show "working: read_url" while it happens
  — **fixing this needs the tool `execute()` wrapper that Plan 02 Phase 0 already plans** (emit
  start/end); the same hook feeds both the waterfall's bars and the live status.
- **`delta` only streams on the Codex path** (`src/core/loop.ts:134`); Anthropic/OpenAI/OpenRouter
  use plain `generateText`, so a "writing" state can't be shown there until **Plan 07** (unified
  streaming) lands.
- **Approval waits are invisible in-flow** — the card renders, but nothing says *which agent* in a
  deep cascade is blocked waiting for the captain.
- The REPL is a single Ink column (`src/ui/App.tsx`); the spinner is `@inkjs/ui` (recent commit).

## 3. Proposed model

### 3a. Status is derived from engine events, not invented in the UI

One `AgentStatus` per **active run**, derived from a slightly enriched event stream:

```
idle      — no active run for this agent
thinking  — model call in flight (model_request emitted, nothing streamed yet)
writing   — text deltas arriving (streaming paths)
working   — a tool execute() is in flight; carries { tool, argsPreview }
waiting   — blocked on the captain (approval card / ask_human)
delegating— a delegate_task/dispatch_task child cascade is running under it
```

Engine additions (shared with Plan 02 Phase 0 — build once):
- Extend `onStep` to a typed event: `{ agent, runId, phase: 'model_start'|'delta'|'tool_start'|
  'tool_end'|'approval_start'|'approval_end'|'final', tool?, argsPreview?, text? }`.
- `tool_start/tool_end` come from the same `execute()` wrapper Plan 02 needs for span timing.
- `approval_start/approval_end` wrap `ctx.requestApproval` (also Plan 02's approval spans).
- `argsPreview`: a one-line, redacted, length-capped render of tool args ("read_url
  https://foo…", "run_command bun test") — **transparency without payload dumping**; never log
  auth material (respect the existing `redactAuthHeader` discipline).

### 3b. Surface 1 — the status bar

A single always-visible bar (bottom, above the input; [?] §4) summarizing every live agent:

```
● researcher working read_url(https://arxiv.org/…) 12s · ● writer thinking 3s · ✋ root waiting: approve command
```

- One compact segment per active run: status glyph, agent, state, current tool + argsPreview,
  elapsed-in-state.
- `waiting` segments are visually loud (this is the "the squad is stalled on YOU" signal).
- Collapses gracefully: nothing running → hidden (or a dim `idle`); more agents than width →
  "+2 more" (with `/tasks` / the waterfall as the drill-down).
- Replaces/absorbs the flat `↳` breadcrumb lines as the *live* channel; breadcrumbs can stay as
  the scrollback record.

### 3c. Surface 2 — split panes (ships with the bar)

One pane per **live** agent — its status line plus its live stream (tool lines with argsPreview,
streamed/final text). Both surfaces render from the same `AgentStatus` model + event stream; the
bar is the summary, panes are the detail.

- **Layout:** Ink flex rows/columns; the REPL pane keeps full width when the squad is idle; panes
  appear as agents go live and collapse on completion (with a brief settle state so the captain
  sees the result land). Visible panes capped by terminal size, "+N more" overflow — the bar
  remains the *complete* summary; panes are best-effort real estate.
- **View modes:** `/view bar` · `/view panes` · `/view both` (default **both**: panes above, bar
  pinned above the input). Persisted.
- **Focus:** the REPL always owns the keyboard — panes are display-only in this plan (steering
  stays via the input; per-agent targeting arrives with Plan 04 Phase 4). This sidesteps the Ink
  `useInput` registration race entirely (one boot-registered handler, as today).
- **Resize:** re-flow on terminal resize; below a minimum size degrade to bar-only.
- **Honest note:** panes reach full value once Plan 04 makes agents genuinely concurrent — but a
  delegation cascade already lights up multiple panes in sequence (parent `delegating`, child
  `working`), which is exactly the transparency being asked for.

## 4. Phase 0 decisions (closed 2026-07-04)

| # | Decision | Decided |
|---|----------|---------|
| 1 | Bar position: top vs bottom | **Bottom, directly above the input** — status is glanceable where the eyes already are; top scrolls out of attention in a terminal. |
| 2 | Bar vs panes | **Both ship in this plan** (user, revised same day) — bar = complete summary, panes = per-agent detail; no v1/v2 split. |

## 5. Synthesis with the other plans

- **Plan 02 (waterfall)** — Phase 0 emitters (tool execute() wrapper, approval spans) are shared
  infrastructure: one instrumentation change feeds post-hoc bars *and* live status. Build them
  together. The waterfall is the drill-down the bar links to ("/trace to inspect").
- **Plan 04 (async/parallel)** — the bar is how background tasks stay visible ("● researcher
  working — task t-42"); per-run steer targeting (Plan 04 Phase 4) pairs with the bar naming
  which agents are live.
- **Plan 07 (unified streaming)** — prerequisite for the `writing` state on non-Codex providers;
  until then those show `thinking` during generation (honest, just coarser).

## 6. Explicitly out of scope / YAGNI (for now)

- Full-payload tool-call logging in the UI (argsPreview only; the waterfall drill-in shows full
  args/results post-hoc).
- Mouse support / clickable segments.
- Per-agent *scrollback* (panes show the live tail only; history lives in the REPL scrollback and
  the waterfall — scrollable pane buffers are a later upgrade if the tail proves insufficient).
- Keyboard focus inside panes (display-only; steering stays in the REPL input).
