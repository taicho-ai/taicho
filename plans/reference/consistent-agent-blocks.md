# Consistent agent blocks — the default delegation view (Plan 13, corrected)

**Status:** re-opened 2026-07-05. Supersedes the shipped Plan 13 (`/view stream`), which was the
wrong shape and did not solve the problem. Visual reference (mockup v3):
`https://claude.ai/code/artifact/4442e6d7-df82-4e37-b9b5-ed7f4df2e2d7`

## The problem (unchanged from the original Plan 13)

When root delegates, every agent's **full reply streams into the CLI scrollback**. A 5-agent run
dumps thousands of lines; the user's own question scrolls off the top; context is lost. The captain
can see *that* work is happening but drowns in *what* is being said.

## Why the shipped version was wrong

The merged Plan 13 added a `/view stream` **opt-in mode** with a rolling tail. Two failures:
1. **Wrong shape** — it was a separate command nobody turns on. The user never asked for a mode;
   streaming is the *default* behaviour of the whole view, so the fix belongs in the default render.
2. **Wrong effect** — even in `/view stream`, *"the reply still commits to scrollback"*
   (`App.tsx`). The firehose kept running underneath; the rolling tail was decoration on top of it.
   The thousand-line dump was never actually removed.

Also shipped with **no Layer-4 video evidence** (the sibling squad-UI plan, Plan 10, has one:
`squad-panes`). A UI change of this class must ship a recorded proof.

## The corrected model — one block per agent, one shape for its whole life

An agent (root and every sub-agent) is rendered as a single **block**:

```
▎ <name> · <state> · <elapsed> [· <artifact@vN>]      ← header (one line)
▎   <body line 1>                                      ← body: fixed 2 lines (3 max)
▎   <body line 2>
```

**The block never changes shape.** Thinking, writing, or done, it is a header + a fixed two-line
body. Only three things change across its lifecycle:

| | State label | Rail colour | Two-line body |
|---|---|---|---|
| **live** | `thinking` / `writing` / `delegating` | amber | the **rolling tail** — newest delta line in at the bottom, oldest scrolls off *inside* the window |
| **done** | `done` | green | the agent's **settled summary** (the `delegate_task` summary / `final.md` first lines), and the **artifact handle moves into the header** |
| **failed** | `failed` | red | the failure reason (first 2 lines); artifact slot empty |

Rules:
- **Fixed height.** The body is exactly two lines (hard cap three), live and done alike. A
  2,000-line reply and a 6-line reply occupy the same two lines. It never grows.
- **The block IS the record.** The block you watched live is the exact block that settles into
  scrollback. No collapse into a different element, no second UI. (This is the specific critique that
  re-opened the plan: the shipped version morphed a 3-line live window into a 1-line done record —
  two UIs pretending to be one. Do not do that.)
- **Nesting.** Children render indented one level under the block that delegated them (mirror the
  `delegatedOut` / delegation depth). Root sits at the top of its subtree.
- **Ordering is stable.** A block keeps its position when it settles — it does not jump. New child
  blocks append under their parent in spawn order.

## What changes on screen (the core behaviour change)

1. **Kill the scrollback dump.** The full streamed reply of an agent's run **must no longer be
   committed to scrollback.** Today `App.tsx` folds `streamRef` (the full accumulated text) into
   scrollback via `splitCompletedBlocks`. That path is removed for agent work: the *only* on-screen
   presence of an agent's output is its two-line block. The full text continues to be written to the
   on-disk transcript (`runs/.../transcript.jsonl`, `final.md`) exactly as now — we bound the
   **screen**, never the **record**.
2. **Live region → settle in place → scrollback.** While a run is live its block redraws in the
   dynamic region (tail updates as `delta` events arrive). When the run ends, the same-shaped block
   is committed to Ink `<Static>` scrollback (frozen). Scrollback ends up as: the user's prompt(s),
   one consistent block per agent, and root's answer. The whole run fits on a screen.
3. **This is the default.** No mode toggle. `/view stream` is **deleted** (remove `stream` from
   `VIEW_MODES` in `store/prefs.ts`, the `showStream` branch in `resolveLayout`, the slash surface,
   and `RollingStream`'s opt-in gating). The consistent-block view is simply how a run renders.

## Navigation — focus the blocks, open one

- **Enter focus:** `shift+tab` moves keyboard focus **out of the input** into the block region. The
  up-arrow stays bound to input history (untouched) — that is why the focus key is a distinct chord.
- **Move:** `↑` / `↓` move a focus ring across blocks — **live and done blocks alike** (same unit,
  same navigation). The focused block shows a `▸` marker + a highlighted rail/background.
- **Open:** `⏎` opens the focused block into the **operation view** (below).
- **Leave:** `esc` returns focus to the input.
- While focus is in the squad, the input is visually paused (dimmed) and does not capture keys.

## The operation view (drill-in)

Opening a block gives it the full screen — this is where "see the whole thing" lives, so the squad
surface can stay two lines:

```
← esc   / <name>
<name> · ✓ done · 19s · 4.5k tok · via <parent>

BRIEF     <the goal/brief this agent was given>
OUTPUT    <the agent's FULL, untrimmed output — scrollable>
          ↑↓ scroll · N more lines
TOOLS     <tools it ran, e.g. use_skill(...) · save_artifact>
ARTIFACT  <artifact@vN> → handed to <consumers>
```

- Data source: reuse the per-run evidence the `/trace` inspector already reads — the run's
  `input.json` (brief), `transcript.jsonl` / `final.md` (full output), `child-runs.json` /
  `trace.artifacts` (artifact + consumers). Prefer reusing `deriveTrace` / the run-span detail from
  `core/trace-tree.ts` rather than a parallel reader.
- Owns the keyboard while open via the **`cardKeyRef` pattern** (same as `TraceInspector` and the
  approval card — App's one boot-registered `useInput` forwards keys to the active card; dodges the
  first-keystroke race, see [[ink-useinput-registration-race]]).
- Keys: `↑↓` scroll · `⏎` open the artifact (into the artifact viewer / `/artifacts show`) · `t`
  jump to the full `/trace` waterfall rooted at this run · `esc` back to the squad focus ring.

## UI polish (from mockup review)

- **Header spacing.** Segments are separated by a single ` · ` (space–middot–space). Keep it
  consistent — the name must not sit one character tighter against the separator than the other
  segments do. One separator token, uniform padding, no ad-hoc spaces.
- Elapsed uses `tabular-nums`-style fixed width so the times don't jitter as they tick.
- (The red error affordance in the "today/firehose" mockup frame is illustrative only — **not** a
  feature to build.)

## Evidence — REQUIRED (this was the gap)

Ship a **Layer-4 VHS scenario** at the same bar as Plan 10's `squad-panes`:
- New `e2e-model.ts` mode (slow-mode, so a delegation stays live long enough for VHS to freeze a
  frame — reuse the `squad-panes` slow pattern).
- `e2e/scenarios/consistent-blocks.ts` — tape drives a real root→squad delegation, gates on the
  live two-line blocks (`Wait+Screen` on a live state string that only the block shows), screenshots
  the live state, then the settled (done) state, then drives `shift+tab` → `↑↓` → `⏎` and screenshots
  the operation view.
- File assertions decide pass/fail (delegation trace exists; children completed; artifacts produced);
  the video is evidence, not the assertion.

## Code map (files an implementer will touch)

- `src/ui/RollingStream.tsx` → becomes the **consistent block** component (header + fixed 2-line
  body; `live` / `done` / `failed` variants; focus state). Rename if clearer (e.g. `AgentBlock.tsx`).
- `src/ui/SquadPanes.tsx` — the live-region layout (nesting by delegation depth, ordering, height
  cap). Reconcile with the block; the block replaces the pane body.
- `src/ui/App.tsx` — (a) **remove the full-reply scrollback dump** for agent work (`streamRef` /
  `splitCompletedBlocks` path); (b) commit settled blocks to `<Static>` scrollback; (c) keyboard:
  `shift+tab` focus mode + focus-ring state + `⏎` open; (d) delete `/view stream` wiring.
- `src/ui/OperationView.tsx` — **new** drill-in view (cardKeyRef-owned; reads run evidence via
  `trace-tree`).
- `src/core/agent-status.ts` — the reducer already yields per-run state + current tail from the
  `onStep` stream; feed the block header + live body from it (should need little change).
- `src/store/prefs.ts` — remove `stream` from `VIEW_MODES` (+ `isViewMode`, the round-trip test).
- `src/core/trace-tree.ts` — reuse for the operation view's data; no new reader.
- `src/core/e2e-model.ts`, `e2e/scenarios/consistent-blocks.ts` — the evidence scenario.
- Docs: `TESTING.md` (Squad UI section + Layer-4 example), `CLAUDE.md` (`src/ui/` — replace the
  `/view stream` line with the consistent-block default + drill-in).

## Open decisions (confirm before build; captain to disposition)

- **Body height:** fixed 2 lines both live and done (recommended — true consistency), or 2 live / 1
  when done?
- **Focus key:** `shift+tab` (recommended) or `ctrl+↑`? (Up-arrow stays input history either way.)
- **Long squads:** 12 agents = 12 blocks. Cap visible **done** blocks with a `+N more · ⏎ to
  expand` line, or let them all stand in scrollback? (Live blocks are always shown.)
- **Root's final answer to the user:** a short conversational reply (e.g. "what's 2+2 → 4") should
  still print as readable text, not be hidden behind a drill-in. Decide the boundary: block-only for
  *delegated/sub-agent* work, and root's own final assistant message renders in full (bounded) as
  the conversational reply — while root's *intermediate* thinking/working still uses its block.

## Non-goals

- Not changing what is recorded or replayed (Plan 05 owns compaction). This bounds the **screen**.
- Not changing steering/keyboard ownership of the REPL beyond the additive focus mode; the input
  still owns the keyboard by default.
- Not touching the live waterfall (`/view waterfall`, Plan 02 Ph6) — it stays a separate opt-in.
