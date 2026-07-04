# Reference — Observability Waterfall

Design detail for **Plan 02**. An in-terminal, interactive trace inspector modeled on LangSmith's
waterfall: a **span tree** with absolute-time **timeline bars**, and **drill-into-span** for
inputs/outputs/tokens/cost. Native to the terminal, **no external service**.

Status: design approved (brainstorm). Phase 0 capture-gaps and Phases 1–5 are the v1 build; live mode
+ task-level traces are v2 (Phase 6).

---

## 1. North-star view

```
TRACE root/…run3      4.2s · 8,410 tok · $0.031 · ✓
────────────────────────────────────────────────
▾ root · chat         ✓  ├████████████████┤  4.2s
    llm gpt-5.5 #1   ✓  ├██┤               0.7s
  ▾ researcher deleg  ✓  ├───████████┤      3.1s
    llm #1           ✓  ├─██┤              0.6s
❯   read_url         ✓  ├──░███┤           0.9s   ← selection
    llm #2           ✓  ├────░████┤        1.1s
  ▾ writer deleg      ✗  ├──────░███┤       0.9s
────────────────────────────────────────────────
[read_url] in {"url":"https://…"}  out 3.4KB md
↑↓ move · → expand · ⏎ open · q quit
```

A **trace** = one top-level `triggeredBy: "user"` run plus its delegation subtree (exactly like a
LangSmith trace = one top-level invocation). Bars are **absolute-time** on a shared axis so gaps and
the cascade are visible — that is what makes it a waterfall rather than an indented tree.

## 2. The observability gaps this closes

From the code audit (see also `context-hygiene-audit.md`). The waterfall is the single **reader** for
the write-only evidence the system already produces:

| # | Gap | How the waterfall closes it |
|---|-----|-----------------------------|
| 1 | Rich evidence is **write-only** (transcript/ledger/task/child-runs/failure never read back) | The inspector is the reader for all of it. |
| 2 | `/trace` is **shallow** (tool counts only) | Becomes the deep, navigable trace view. |
| 3 | **No delegation tree** | The span tree *is* the delegation graph. |
| 4 | **Aggregation hidden** (`aggregate`/`childSpend` computed, not shown) | Header total + rolled-up tokens/cost per run span. |
| 5–6 | **Thin failure diagnosis** (`failure.md`, `model_error` written, never shown) | Error spans marked `✗`; drill-in shows the error + failed response. |
| 7 | **"Why did it do that?"** (coaching `ledger` in trace, never shown) | Run-span drill-in shows policies/KB/skills retrieved·applied·skipped + the assembled prompt. |

Residual gaps **not** covered here (→ Plan 03): structured file logging that doesn't fight Ink, and a
documented headless event stream.

## 3. Span model

One unit; everything renders from it.

```ts
type SpanKind = 'run' | 'llm' | 'tool' | 'approval';
interface Span {
  id: string;
  parentId?: string;
  kind: SpanKind;
  name: string;            // "root · chat" · "llm gpt-5.5 #1" · "read_url" · "delegate → researcher"
  agent: string;
  status: 'ok' | 'error' | 'running' | 'blocked' | 'interrupted';
  startMs: number;         // absolute epoch ms — shared time axis
  endMs: number;
  tokens?: number;         // self; rolled up on run spans
  costUsd?: number | null;
  error?: string;
  detail: SpanDetail;      // lazy-loaded on drill-in (§6)
}
```

## 4. Derivation — mostly from data already on disk

`deriveTrace(ws, rootRunId): Span[]`

- **Run spans (the tree).** Start at the root run's trace. Recursively follow `delegatedOut`
  (`readTrace` each child). Each run → a `run` span; `startMs = Date.parse(started)`,
  `endMs = startMs + durationMs`. `triggeredBy` confirms the parent edge.
- **LLM spans.** Read each run's `runs/<agent>/<run>/transcript.jsonl`. Pair `model_request` →
  `model_response` by `iteration` → an `llm` span (`startMs`/`endMs` from the two `ts`; `tokens` from
  `model_response.data.usage`). **Already captured.**
- **Tool spans.** `tool_call` events give the call; a `delegate_task` tool span's child *is* the
  delegated run span (link by matching the returned `runId`). **Duration needs the Phase 0 add**
  (today only the emit ts exists — see §7).
- **Roll-ups.** Sum child tokens/cost onto run spans; `aggregate` already carries this.

All derivation is **pure** (input: files; output: `Span[]`) → unit-testable over fixtures, no Ink.

## 5. Layout (pure)

- **Scale.** Map `[traceStart, traceEnd]` → N columns (N = terminal width − label/meta gutter).
- **Min-width floor.** Every bar ≥ 1 cell so sub-second LLM/tool spans stay visible; a 4-second trace
  and a 4-minute trace both read well because the scale is duration-adaptive.
- **Row.** indent-by-depth + tree glyphs · status icon · bar (offset+width from scale) · duration ·
  tokens.
- **Collapse/expand** state → visible-rows computation (collapsing a run hides its subtree).
- Unit-tested independently of the Ink component.

> **Flagged default:** absolute-time bars assume comparable timestamps — they are (all wall-clock
> ISO). The min-width floor + adaptive scale handle the "tiny sub-second bars" problem. Alternative if
> disliked: raw proportional bars with no floor (rejected — tiny spans vanish).

## 6. Interactive inspector (Ink)

- `TraceInspector` component takes over the keyboard **while open**, reusing the existing pattern
  where the active card publishes its handler to `cardKeyRef` during render (so it composes with the
  REPL's one boot-registered `useInput`, avoiding the first-keystroke race documented in memory).
- **Keys:** `↑↓` move · `→/←` expand/collapse · `⏎` open detail · `q`/esc close.
- **Selected-span summary** pinned at the bottom; `⏎` opens full detail.
- **Detail (`SpanDetail`) by kind:**
  - `llm` — assembled prompt (from `input.json`), response text, tokens, finish reason.
  - `tool` — args in / result out (+ error).
  - `run` — outcome, rolled-up tokens/cost, `notes`, and the **coaching ledger**
    (policies / KB nodes / skills retrieved · applied · skipped).

## 7. Capture adds (Phase 0 — small)

The v1 tree + LLM spans work off existing data. Two small emitter additions make the bars complete:

1. **Tool span timing.** Wrap tool `execute()` to append `tool_start` / `tool_end` (or a single
   `tool_result` with `ts`) to `transcript.jsonl`, so tool bars have real durations.
2. **Approval waits — core, not optional.** Time `requestApproval` / `ask_human` waits as
   `approval` spans. Human latency frequently dominates wall-clock in this system (every
   create_agent / add_mcp / propose_skill / guarded command blocks on the captain); a waterfall
   without approval spans silently misattributes that wait to whatever llm/tool span contains it,
   which is exactly the kind of lie the waterfall exists to prevent.

Note: **Plan 04 Phase 5** moves `transcript.jsonl` to incremental (per-event) flushing — the same
change live mode (v2 here) needs; whichever plan lands first builds it.

## 8. Command surface

- `/trace` (no arg) → latest run's waterfall (the "what just happened" case).
- `/trace <id>` → that run. `/runs` stays the picker (add duration to rows).
- Post-run inline hint appended to the existing `trace: <id>` line: *"/trace to inspect."*

## 9. Scope / phasing

- **v1:** post-hoc interactive inspector over run tree + LLM spans (+ Phase 0 tool timing).
- **v2 (deferred):** live mode — same span tree, streamed and redrawn in place, replacing the flat
  `↳` breadcrumbs; task-level traces spanning multiple user turns.

## 10. Testing

- **Pure unit** — span-tree derivation from fixture traces/transcripts; layout (floor, indent,
  collapse).
- **Layer-1 Ink** (`ink-testing-library`) — `TraceInspector` render, navigation, drill-in, error span.
- **Real-binary e2e** (tui-test) — run a delegation, open `/trace`, assert the tree renders and a
  drill-in works.
