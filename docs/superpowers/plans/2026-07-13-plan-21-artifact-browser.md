# Plan 21 — Artifact Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/superpowers/specs/2026-07-13-plan-21-artifact-browser-design.md` — the docked
artifact browser with a full-screen reader, replacing the completion action bar and the `/artifacts`
subcommands.

**Architecture:** One branch (`plan-21-artifact-browser`), one PR, commits per phase. Three units:
a pure `src/ui/browser-model.ts` (scopes, filters, grouping, counts — no Ink), `src/ui/ArtifactBrowser.tsx`
(Shelf docked + Reader full-screen; ALL its UI state lives in App's `browserState` so a card suspension
can unmount and remount it losslessly), and App wiring (fixed keyboard precedence: pending card →
operation view → browser → chat, via a NEW `browserKeyRef`).

**Tech Stack:** Bun + TS ESM, React 19/Ink 7, `bun:test` + ink-testing-library, `core/mock-model.ts`
mocks, VHS Layer-4 evidence.

## Global Constraints

- Worktree only (`../taicho-plan-21`, branch `plan-21-artifact-browser`); repo root is the live workspace.
- Gate per phase: `bun run typecheck` + `bun test` green; `bun run build` at PR time.
- Store additions are EXACTLY: `ArtifactFilter.since`, `GcOptions.dryRun`, `artifactBodyPath` (spec §6).
- The browser must never take `cardKeyRef`; a truthy `pending` unmounts the dock (spec §1).
- The main TextInput unmounts while the browser is docked/reading; the browser renders its own input line.

---

### Task 1 (Phase 1): the pure model — `src/ui/browser-model.ts`

**Files:** Create `src/ui/browser-model.ts`, `src/ui/browser-model.test.ts`.

**Interfaces (locked — later tasks depend on these exact names):**

```ts
export type BrowserScope = "run" | "conversation" | "all";
export type BrowserSort = "run" | "time" | "producer";
export interface BrowserFilters { producer?: string; type?: string; feedback?: "open" | "any"; verdict?: "pass" | "fail" | "any"; since?: "24h" | "7d" | "30d" | "all"; q?: string; }
export interface RowBadges { openFeedback: number; approved: boolean; verdict?: "pass" | "fail"; }
export type ShelfRow = { kind: "header"; label: string } | { kind: "artifact"; artifact: Artifact; badges: RowBadges };
export function resolveScope(ws: string, scope: BrowserScope, opts: { rootRunId?: string }): Artifact[];
export function latestRunFallback(ws: string): string | undefined;   // newest ledger turn runId across conversations/*/ledger.jsonl
export function applyFilters(ws: string, arts: Artifact[], f: BrowserFilters): Artifact[];
export function shelfRows(ws: string, arts: Artifact[], scope: BrowserScope, sort: BrowserSort): ShelfRow[];
export function countLine(matched: number, total: number, scope: BrowserScope): string;  // "4 of 31 match" | "3 artifacts"
```

- `resolveScope`: `"run"` → `gatherConversationArtifacts(ws, opts.rootRunId)` (empty without id);
  `"conversation"` → union over DISTINCT runIds of EVERY `conversations/<agent>/ledger.jsonl`
  (`readdirSync(paths.conversationsDir?)` — walk the conversations dir; reuse `loadLedger` per agent),
  de-dup latest-per-id, created desc; `"all"` → `listArtifacts(ws)`.
- `shelfRows` for `"all"`+`sort:"run"`: group by `artifact.runId`, groups ordered by newest member,
  header label `── <runId short> · <n> artifact(s) · <age>`; flat sorts (`time`, `producer`) drop headers.
  Badges from `listAnnotations(ws, handle)`: openFeedback = open count; approved = any `kind:"approval"`;
  verdict = latest annotation with `verdict` → pass/fail.
- Phase 1 needs only `resolveScope("run")` + `shelfRows` flat + `countLine`; write the full module now,
  tests cover everything (the module is pure + cheap to finish in one pass).

- [ ] Steps: failing tests for each function over a temp workspace with seeded artifacts/annotations
  (reuse `saveArtifact`/`annotateArtifact` helpers as `artifacts.test.ts` does) → implement → green → commit.

### Task 2 (Phase 1): `ArtifactBrowser.tsx` — Shelf + Reader, state lifted to App

**Files:** Create `src/ui/ArtifactBrowser.tsx`; delete nothing yet.

```ts
export interface BrowserUiState {
  scope: BrowserScope; sort: BrowserSort; filters: BrowserFilters;
  sel: number;                 // selected artifact row (indexes the artifact rows, headers skipped)
  reading: boolean; scroll: number;
  filterOpen: boolean; filterField: number;   // Phase 3
  search: string | null;       // "/" live query (Phase 3); null = closed
  hint?: string;               // background-settle scope hint (Phase 2)
}
export function initialBrowserUi(): BrowserUiState;
export function ArtifactBrowser(props: {
  ws: string; width: number; rows: number;
  rootRunId?: string;
  st: BrowserUiState; onChange: (next: BrowserUiState) => void;
  keyRef: React.MutableRefObject<CardKeyHandler | null>;   // browserKeyRef — NOT cardKeyRef
  onClose: () => void;
  onSubmitChat?: (text: string) => void;                   // Phase 5 `r`
}): JSX.Element;
```

- Shelf: two panes (list 47% / preview) like the mockup; preview = envelope header + first ~12 body
  lines via `readArtifactBody` + open-feedback lines; degrade to single pane under the same
  `MIN_PANE_COLS/ROWS` constants SquadPanes uses. Mode line at the bottom (keys + countLine).
- Reader (`st.reading`): full-screen — reuse the ArtifactViewer render shape (header line
  `handle · producer · age · position`, markdown body, scroll) + verb row (verbs land Phase 4; Phase 1
  renders navigation hints only).
- Keys (published to `keyRef` via effect — App's dispatch order makes the timing race moot):
  shelf: ↑↓ move, `⏎` read, `tab`/`1|2|3` scope (Phase 2 enables 2/3), esc → `onClose()`;
  reader: ↑↓ scroll, ←/→ prev/next, esc → shelf.
- [ ] Steps: build; Layer-1 coverage arrives in Task 3's App tests (the component alone isn't rendered
  outside App). `bun run typecheck` green → commit.

### Task 3 (Phase 1): App wiring — auto-enter, precedence, deletions

**Files:** Modify `src/ui/App.tsx`, `src/ui/slash.ts`, `src/core/prompt.ts:28`; Test `src/ui/App.test.tsx`.

- Replace state: `completionArtifacts`/`actionBarFocus`/`artifactViewerOpen` → 
  `browser: { rootRunId?: string; ui: BrowserUiState } | null` + `browserKeyRef` (a second
  `useRef<CardKeyHandler | null>`).
- `useInput` dispatch becomes (order is the spec §1 contract):

```ts
if (pending || operationRunId) { cardKeyRef.current?.(input, key); return; }
if (browser) { browserKeyRef.current?.(input, key); return; }
```

  (Delete the action-bar branch. `artifactViewerOpen` disappears from the first condition — the old
  viewer's latent double-delivery bug goes with it.)
- Auto-enter in `submit()`: BOTH chat and @agent paths, gated on `outcome === "completed"`:

```ts
const artifacts = gatherConversationArtifacts(props.ws, res.runId);
if (artifacts.length > 0) setBrowser({ rootRunId: res.runId, ui: initialBrowserUi() });
```

  (The @agent path's unconditional gather was accidental — now unified, per spec §1.)
- Render: dock `{!pending && !operationRunId && browser && <ArtifactBrowser …/>}`; while `browser`
  is set ALSO suppress SquadPanes + AgentBlocks + PlanPanel (`&& !browser` on their gates — StatusBar
  stays); TextInput unmount gate becomes `!pending && !operationRunId && !browser`.
- `/artifacts` bare → open browser: in `runSlash`, `if (cmd === "artifacts" && !arg.trim()) { setBrowser({ rootRunId: lastRunRef.current ?? latestRunFallback(props.ws), ui: initialBrowserUi() }); return; }`
  — `lastRunRef` is a new ref set beside the auto-enter. Subcommands (`list`/`show`/…) still parse
  and work until Phase 4. `slash.ts` usage row: `"artifacts", usage: "" summary: "browse the squad's artifacts"`.
- `prompt.ts:28`: "the captain views artifacts via the completion action bar" → "the captain browses
  artifacts in the artifact browser (it opens when a turn produces artifacts)".
- Delete `ArtifactViewer.tsx` + its import (the Reader supersedes it).
- [ ] Layer-1 tests (write FIRST, red): auto-enter on completed artifact turn ("ARTIFACTS" + row on
  frame); NOT on failed turn; `⏎` → reader shows body; esc chain reader→shelf→chat; `/artifacts`
  re-enters; **card-suspension**: while docked, a background dispatch raises `create_agent` approval →
  card visible + dock gone + `y` approves the CARD (agent exists) + dock returns with selection intact;
  old bar/viewer tests updated. → implement → green → commit.

### Task 4 (Phase 1): VHS swap + docs touch

- [ ] Replace `e2e/scenarios/artifact-viewer.ts` with `e2e/scenarios/artifact-browser.ts` (same
  `artifact-viewer` e2e-model mode): gates `Wait /ARTIFACTS/` (dock), `⏎` → `Wait /Dossier|# /`
  (reader body), screenshots dock + reader; keep the file assertions (artifact exists, body marker
  not in root transcript). TESTING.md quick-ref + Plan 15 section updated to the browser.
- [ ] Run `bun scripts/e2e-evidence.ts artifact-browser` → PASS. Commit. **Phase 1 gate:** typecheck +
  full `bun test`.

### Task 5 (Phase 2): scopes

- [ ] browser-model: already built (Task 1). Wire `tab`/`1|2|3` in the Shelf; group headers render for
  all-runs; `s` cycles sort. Cold `/artifacts` with no session run → `latestRunFallback`, else scope "all".
- [ ] Background settle → if `browser` docked: re-gather current scope; scopes 1–2 set
  `ui.hint = "+N from background — press 3"` (cleared on scope change). Wire in `settleTask` beside the
  Plan 20 plan-settle hook.
- [ ] Layer-1: scope round-trip; settle-hint (background settle while docked shows hint, no row in scope 1).
  Commit.

### Task 6 (Phase 3): filters + search

- [ ] `ArtifactFilter.since` in `store/artifacts.ts` (ISO-delta predicate on `created`); unit test.
- [ ] Shelf: `f` chip row (fields producer/type/feedback/verdict/since; ←→↑↓⏎, `x` clear), `/` search
  (browser's own input line, live `q`), countLine honesty. Pure tests in browser-model.test; Layer-1:
  `/` narrows + "N of M" shows. Commit.

### Task 7 (Phase 4): verbs + command collapse

- [ ] Store: `GcOptions.dryRun` (same pass, return `{archived: []…}` without renames — the existing
  return shape gains `wouldArchive` when dry) + `artifactBodyPath(ws, handle)` (recompute like
  `readArtifactBody`; null for external). Unit tests; PORT the three gc protection tests from
  App.test.tsx to `artifacts.test.ts` driving `gcArtifacts` directly.
- [ ] Reader verbs: `a` (inline feedback input → `annotateArtifact({kind:"feedback", author:"human"})`),
  `y` (`kind:"approval"`), `v` (versions jump list via `artifactVersions`), `o` (spawn
  `$EDITOR`/`open` with `artifactBodyPath`; external → URI line). Shelf `g` (all-runs only): dry-run
  → confirm line → real run.
- [ ] Retire subcommands: `/artifacts <anything>` → "the browser owns this now — /artifacts opens it";
  delete `parseArtifactsCommand` + its slash.test tests + the five App.test subcommand tests (gc trio
  already ported). Layer-1: `a` lands open annotation on the viewed VERSION; `y` lands approval. Commit.

### Task 8 (Phase 5): `r` request revision

- [ ] Reader `r`: composes `revise <handle>: <open feedback bodies, "; "-joined>` and calls
  `onSubmitChat(text)` → App submits it as a NORMAL turn (browser closes first — `setBrowser(null)` —
  the turn's completion re-docks with the new version on top). Layer-1: `r` from reader triggers a
  root run whose prompt contains the handle + feedback; completion re-docks. Commit.

### Task 9 (Phase 6): evidence + docs sweep

- [ ] Extend `artifact-browser` tape: `a` annotate flow (gate on the feedback line) + assertion the
  annotation landed. Docs: CLAUDE.md src/ui section (browser replaces viewer + bar), README artifact
  paragraph, TESTING.md sections. Flip this plan's + tasks.md checkboxes. Full gates + `bun run build`.

### After

- [ ] Adversarial review of the diff (review-the-fix discipline), fix confirmed findings.
- [ ] Push branch, open PR (merge after captain review).
