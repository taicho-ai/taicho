# Plan 21 — The Artifact Browser

**Date:** 2026-07-13
**Status:** approved (design), not yet built
**Topic:** Artifacts become a mode, not a command set. Runs end inside a docked browser; the reader
is full-screen; the five `/artifacts` subcommands collapse into keys.
**Mockup:** rev 2, approved by the captain (docked shelf + full-screen reader confirmed).

## 0. The one-line thesis

You don't open the artifact browser — **runs end inside it**. The moment a foreground turn produces
≥1 artifact, the REPL docks the browser over the lower region of the screen, scoped to that run,
first row selected and previewed. `esc` is the whole cost of leaving. Every verb that today is a
`/artifacts` subcommand with a hand-typed handle becomes one key sitting next to the thing it acts on.

## 1. The mode model

- **Auto-enter** fires when a `triggeredBy:"user"` (foreground) turn ends with
  `outcome === "completed"` AND ≥1 artifact in its delegation subtree. This unifies today's two
  accidental triggers (the chat path gated on completed; the `@agent` path showed the bar even on a
  failed run — that was a bug, not a contract): **failed/blocked turns never auto-enter**, they print
  the run line as today. The completion action bar **is replaced and deleted** (no pref, no gate;
  decided). Background task settles NEVER auto-enter (§2 says what they do to a docked shelf).
- **Docked, not a takeover.** The shelf takes the lower region (~60% of rows, min the same
  `MIN_PANE_ROWS`-style floor the squad panes use); the last exchange stays visible above it, dimmed.
  On too-small terminals the shelf degrades to a single-pane list (no preview), mirroring
  `resolveLayout`'s degrade discipline. **While docked, the live squad surfaces YIELD**: SquadPanes,
  AgentBlocks, and the PlanPanel are suppressed (they'd fight the dock for the same rows); the
  one-line StatusBar stays pinned above the dock so live background runs remain visible. They all
  resume the moment the browser closes. §6's "unchanged" applies to behavior while the browser is
  NOT docked.
- **The reader is FULL-SCREEN** (captain-decided): `⏎` on a row opens today's full-screen viewer
  rendering — markdown body, scroll, `←/→` prev/next — with the verb row (§4).
- **Keyboard ownership — explicit precedence, not a shared slot.** The browser gets its OWN
  `browserKeyRef`; it is NEVER wired through `cardKeyRef` (a single slot with two live claimants
  flip-flops last-writer-wins between a card's render-time publish and a viewer's effect-time
  publish). App's `useInput` dispatches in fixed order: **pending card → operation view → browser →
  chat**. A pending approval/ask_human therefore SUSPENDS the browser outright: the dock unmounts
  (render gated on `!pending`, like today's action bar), the card owns every key — so `y` can only
  ever answer the card, never silently approve an artifact, and vice versa — and when the queue
  drains the dock remounts with its state (scope/filters/selection/reading) preserved in
  `browserState`, which lives in App, not the component.
- **Esc chain:** reader → shelf → chat. Chat's esc-quit semantics are UNCHANGED — the spec
  acknowledges the browser puts the captain one habitual esc closer to quit; a confirm-to-quit is
  deliberately out of scope. `/artifacts` re-enters **between turns**; while a foreground run is
  busy, typed input remains steering (unchanged — a mid-run `/artifacts` is steer text, as any
  slash-shaped steer is today). While docked, the main TextInput UNMOUNTS (the same rule that makes
  cards work); the browser renders its OWN input line for `/` search and `a` feedback — the shared
  input state and its slash suggester are never reused inside the mode.

## 2. Scopes — one shelf, three windows

`tab` (or `1` `2` `3`) widens the window:

1. **This run** — the delegation subtree of the turn that just finished:
   `gatherConversationArtifacts(ws, rootRunId)` as today. `browserState.rootRunId` is set at the
   auto-enter site from `res.runId` (today's `completionArtifacts` kept envelopes but lost the run —
   the state must carry the id, since `foregroundRootRef` is nulled at run end). A cold
   `/artifacts` (no turn yet this session) resolves "latest run" as the newest ledger turn's
   `runId` across agents; if there is none, the browser opens directly in all-runs scope.
2. **Conversation** — union of `gatherConversationArtifacts` over the DISTINCT `runId`s of **every
   agent's ledger** (`conversations/<agent>/ledger.jsonl` is per-agent; a foreground `@agent` turn
   audits to the TARGET agent's ledger, so reading root's alone would miss exactly the turns that
   auto-docked the browser), de-duped by handle, newest first.
3. **All runs** — the whole store (`listArtifacts`), **grouped by producing run** (`envelope.runId`),
   groups newest-first with a header row (`── run14 · <task one-liner> · 2m`). The widest scope reads
   as a history of executions, not a soup of files. `s` cycles sort within/instead of grouping:
   run (default) / time / producer — the flat sorts drop the group headers.

**Background settles while docked.** A dispatched task's run is structurally invisible to scopes 1–2
(dispatch does not append to `delegatedOut`; a `task_*`-triggered run writes no ledger turn), so a
settle must NOT inject a row there — that would violate §3's honesty rule. Instead: the settle
re-gathers the CURRENT scope (a real change only in all-runs) and, in scopes 1–2, adds one mode-line
hint — `+1 from background task · press 3` — so the row is one keystroke away, never a lie.
Schedule-fired runs behave identically (visible only in all-runs).

## 3. Filters and search — the shelf never lies

- `f` opens a chip row over the same shelf: **producer** · **type** · **feedback** (open / any) ·
  **verdict** (pass / fail / any) · **since** (24h / 7d / 30d / all).
  `←/→` field, `↑↓` value, `⏎` apply, `x` clear all, `esc` close. (A `versions: latest/all` chip was
  cut: every named source — the manifest, the gather walk — is latest-per-id BY CONSTRUCTION, so
  "all" had no data source; per-id version history is the reader's `v` jump list, which
  `artifactVersions(ws, id)` already serves.)
- `/` is instant search over `id + title + summary` (the existing `listArtifacts` `q` predicate),
  live-narrowing as you type — the same feel as the slash suggester, rendered by the browser's own
  input line (§1), never the shared one.
- **Honesty rule:** the mode line always states the window: a filtered shelf says `4 of 31 match`,
  never impersonates the whole store.
- Store surface: `ArtifactFilter` already carries `producer`/`type`/`role`/`q`; it gains
  `since?: string`. The browser layer computes `feedback`/`verdict` (from `listAnnotations`) —
  annotation-derived state stays OUT of the manifest (it lives in `annotations.jsonl`; the manifest
  must not cache what the ledger owns).

## 4. The reader's verbs

- `a` **annotate** — inline input on the reader's bottom line (the same inline pattern as steering);
  `⏎` lands it as an OPEN `feedback` annotation pinned to the viewed version. No hand-typed handles.
- `y` **approve** — the existing approval-kind annotation (`annotateArtifact({kind:"approval"})`).
- `r` **request revision** (LAST PHASE) — composes and submits a NORMAL foreground chat turn:
  `revise <handle>: <the open feedback bodies>`. It deliberately rides the ordinary turn machinery —
  root plans/delegates it, approvals apply, and when the revision run settles the browser auto-enters
  again with the new version on top. `r` is one key, not a new run type; the money it spends goes
  through exactly the gates a typed request would.
- `o` **open in `$EDITOR`** — the Plan 15 deferred escape hatch. The store exports
  `artifactBodyPath(ws, handle): string | null`, recomputing the path from `ws` exactly as
  `readArtifactBody` does (the envelope's baked absolute path goes stale on a workspace move —
  never read `location.path` directly) and returning `null` for `external` artifacts, where the
  reader shows the URI with an "external — no local file" line instead of spawning anything.
- `v` **versions** — jump list of this id's versions (envelope only, via `artifactVersions`), `⏎`
  switches the reader.
- `g` **gc** — all-runs scope only. `GcOptions` gains `dryRun?: boolean`: the SAME code path
  computes the protected set and the would-archive list but returns without renaming — the preview
  and the action cannot disagree because they are one function. `g` runs dry, shows the list on a
  confirm line, and a second `⏎` runs it for real (today's protections unchanged).

## 5. The command surface collapses

`/artifacts` becomes a single entry: open the browser scoped to the latest run. The subcommand
grammar (`parseArtifactsCommand`) retires with the subcommands:

| today | becomes |
|---|---|
| `/artifacts list [q]` | the shelf — all-runs scope + `/` search |
| `/artifacts show <handle>` | the reader (`⏎` on a row) |
| `/artifacts annotate <handle> <text>` | `a` in the reader |
| `/artifacts approve <handle>` | `y` in the reader |
| `/artifacts gc` | `g` in the all-runs shelf, with confirm |

`slash.ts`'s COMMANDS row becomes `{ name: "artifacts", summary: "browse the squad's artifacts",
usage: "" }`. Agent-facing tools (`save/read/list_artifacts`, `annotate_artifact`…) are untouched —
this plan is captain-surface only.

## 6. What must NOT change (and the three deliberate store additions)

- The artifact STORE's semantics — immutability, versioning, GC protections, the annotations
  ledger — are untouched. Exactly three additive surfaces are in scope, all named above:
  `GcOptions.dryRun` and `artifactBodyPath(ws, handle)`. Nothing else. (A planned `ArtifactFilter.since` was cut during implementation: scopes 1–2 never flow through `listArtifacts`, so the browser-layer `since` predicate — which covers every scope — made the store addition dead code.)
- The run-end path stays exception-safe: auto-enter is UI-only, downstream of turn completion —
  a browser bug must never fail a run.
- Blocks/panes/status bar behavior **while the browser is not docked** is unchanged; while docked,
  §1's yield rule applies (panes/blocks/plan panel suppressed, status bar stays).
- `gatherConversationArtifacts`'s contract (subtree walk, de-dup latest-per-id, newest first) is
  reused, not forked.
- The root operating note in `prompt.ts` currently tells agents "the captain views artifacts via the
  completion action bar" — Phase 1 rewrites that line to name the browser (an agent-facing string,
  owned here so it can't dangle).

## 7. Component shape

`ui/ArtifactViewer.tsx` grows into `ui/ArtifactBrowser.tsx`: `Shelf` (list + preview panes, scope
segmented control, filter chips, mode line, its own input line) + `Reader` (today's viewer + verb
row) + a pure `browser-model.ts` (scope resolution, filter predicate, grouping, sort, the "N of M"
line — unit-testable with no Ink). App wiring: replace `completionArtifacts`/action-bar state with
`browserState` (`{docked: boolean, rootRunId?: string, scope, filters, selection, reading?}`),
keyboard via the browser's OWN `browserKeyRef` behind the fixed §1 precedence (pending card →
operation view → browser → chat) — never `cardKeyRef`.

## 8. Testing

- **Pure units** (`browser-model.test.ts`): scope resolution per scope (incl. cold-start fallback),
  filter predicate (each chip), run-grouping + sorts, the "N of M" honesty line.
- **Layer 1 (App.test.tsx):** auto-enter on a COMPLETED artifact-producing foreground turn (and NOT
  on a failed turn, NOT on a background settle — which instead shows the scope-hint line); a pending
  approval card suspends the dock and owns `y`/esc exclusively, and the dock remounts with state
  when the queue drains; scope tab round-trip; `/` search narrows; `⏎` opens the full-screen reader;
  `a` lands an open annotation on the viewed version; `y` lands an approval; esc chain
  reader→shelf→chat; `/artifacts` re-enters.
- **Named breaking-test surface** (updated deliberately, never silently deleted): the completion
  action bar tests; `slash.test.ts`'s `parseArtifactsCommand` tests (retire WITH the parser in
  Phase 4); the eight `/artifacts` subcommand tests in App.test.tsx — of which the three **gc
  protection tests** (hand-off pins, keep-latest-3, producing-trace non-pinning) encode store
  semantics and MUST be ported to drive `gcArtifacts` directly at the store level before the slash
  path that drives them today is removed.
- **Layer 4 (VHS):** `artifact-browser` scenario replaces `artifact-viewer` **in Phase 1** (the
  Phase-1 bar deletion breaks the old tape's `Wait /View artifacts/` gate, so the swap cannot wait
  for a later phase): run ends → dock visible over dimmed chat → `⏎` full-screen reader → esc →
  file assertions. Later phases extend the tape (annotate in Phase 4).
- Docs: TESTING.md scenario list + completion-bar section, CLAUDE.md src/ui section, README's
  artifact paragraph, `prompt.ts`'s operating note (Phase 1).

## 9. Phases

1. **Shelf + reader + auto-enter** — dock on completed foreground artifact turns, this-run scope,
   `⏎`/esc chain, browserKeyRef precedence (card suspends dock), delete the completion action bar,
   bare `/artifacts` opens the browser (subcommands keep parsing until Phase 4 so re-entry never
   has a gap), swap the VHS scenario (`artifact-viewer` → minimal `artifact-browser`), update
   `prompt.ts`'s operating note. (The mode exists, reachable, with evidence.)
2. **Scopes** — conversation (all-agent ledger union) + all-runs with run-grouping and `s` sorts;
   background-settle scope-hint line.
3. **Filters + search** — chip row, `/` live search on the browser's own input, honesty line,
   the browser-layer `since` predicate (see §6 — the store addition was cut as dead code).
4. **Verbs** — `a` `y` `o` `v` `g` (`GcOptions.dryRun`, `artifactBodyPath`); port the gc protection
   tests to the store level; retire the `/artifacts` subcommands + `parseArtifactsCommand`.
5. **`r` request revision** — compose+submit a normal turn from the reader.
6. **Evidence + docs** — extend the `artifact-browser` tape (annotate flow), docs sweep.
