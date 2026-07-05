# Artifact viewer + completion action bar

**Status:** designed 2026-07-05 (brainstormed + captain-approved). Visual reference (mockup):
`https://claude.ai/code/artifact/22d69f7e-d2be-49b1-ac97-068de06477c1`

## The problem

When a flow finishes, root pastes the whole deliverable (e.g. the full master script) into its final
reply, dumping it into the terminal scrollback. The captain doesn't want the content in the chat —
they want a way to **see** the produced artifacts *after* the run, cleanly, without the firehose.

taicho already has the pieces but not the surface:
- `readArtifact` / `readArtifactBody` / `listArtifacts` (`src/store/artifacts.ts`) — the store readers.
- `/artifacts show <handle>` (`App.tsx` ~L916) — prints only the **envelope** (title/type/producer/
  versions/summary/annotations) to scrollback. It does **not** render the body. That's the gap.
- Plan 13 `OperationView.tsx` — a cardKeyRef-owned full-screen card that reads one run's evidence.
- Each run's trace records the artifacts it produced (`RunTrace.artifacts` / `outputArtifacts`,
  `src/schemas/trace.ts`).

## The design (captain-approved)

Three parts. All display-only; no new engine behaviour, no extra model turn for "opening".

### 1. Completion action bar (the trigger)

When a **user** conversation turn finishes (`triggeredBy: "user"`) and its delegation subtree produced
**≥1 artifact**, the app shows a keyboard-navigable action row pinned above the input, e.g.:

```
▸ View artifacts (4)     Continue chatting          ←/→ move · ⏎ open · type to chat
```

- Deterministic UI — the **app** shows it (not root's decision), so it always happens and costs no
  model turn.
- `←/→` (or `↑/↓`) move the focus; `⏎` selects. `Continue chatting` — or the captain just starts
  typing — dismisses the bar and returns to the REPL.
- Turns that produced **no** artifacts show no bar (normal chat, unchanged).
- Rendered in `App.tsx`; keyboard via the existing card/focus forwarding (`cardKeyRef`), so the bar
  owns keys only while shown and the input reclaims them on dismiss.

### 2. Root's reply stays short (the actual fix for the dump)

`prompt.ts` guidance steers root to **name the deliverable handle and stop** — never paste an
artifact body into its final reply. The viewer is how content is seen. (Pair this with the Plan 13
principle that delegated work never dumps to scrollback; this closes root's own-reply channel for
artifact bodies.) The completion bar makes the content one keystroke away, so there is no reason to
paste it.

### 3. Artifact viewer (the browser)

`View artifacts` opens a full-screen card — **new `src/ui/ArtifactViewer.tsx`**, cardKeyRef-owned
(same pattern as `OperationView`/`TraceInspector`):

- Renders the selected artifact's **body as markdown**, scrollable (`↑/↓`). Reuse the markdown
  render already used for streamed replies / the block bodies — do NOT hand-roll a second renderer.
- **Ordered latest-first**; opens on the **newest** artifact (the deliverable). Header shows the
  handle, producer, age, position (`1 / 4 · newest`), and the verification verdict if present.
- **Browse:** `←/→` = previous / next artifact.
- **Jump list** (`tab`): a list of this chat's artifacts, latest-first (`title · handle · producer ·
  age`); `↑/↓` move, `⏎` opens. This is the "dropdown."
- `esc` returns to the chat (back to the action bar / input).
- Footer keys: `←/→ prev/next · ↑/↓ scroll · tab jump list · o open in editor · esc back`.

### Scope & data source

The viewer browses the **conversation's** artifacts (not just the last run). Gather them from the
conversation's run traces — the `rootRunId` + child runs' `artifacts`/`outputArtifacts` — de-duped by
handle, then resolved via `readArtifact` (envelope) + `readArtifactBody` (body), ordered by `created`
desc. One row per **logical artifact, latest version** (see open decision on versions). Prefer
reusing a `trace-tree`-style walk over the conversation's runs rather than a parallel scanner.

## Keys (summary)

| Surface | Keys |
|---|---|
| Completion bar | `←/→` move · `⏎` open · `esc`/type → chat |
| Viewer | `←/→` prev/next artifact · `↑/↓` scroll · `tab` jump list · `o` open in editor · `esc` chat |
| Jump list | `↑/↓` move · `⏎` open · `esc` back to viewer |

## Code map (files a worker touches)

- `src/ui/ArtifactViewer.tsx` — **new**. The viewer card (markdown body render, prev/next, jump
  list). cardKeyRef-owned.
- `src/ui/App.tsx` — (a) the completion action bar (show when a completed user turn produced
  artifacts; keyboard + dismiss); (b) wire `View artifacts` → mount `ArtifactViewer` for the
  conversation; (c) an optional `/artifacts view` slash entry to reopen it on demand.
- `src/core/prompt.ts` — root reply guidance: name the deliverable, never paste the body.
- `src/store/artifacts.ts` — reuse `readArtifact`/`readArtifactBody`/`listArtifacts`; add a small
  helper only if needed to list a conversation's artifacts by run set.
- `src/core/trace-tree.ts` — reuse to gather the conversation's runs → their produced artifacts.
- `TESTING.md`, `CLAUDE.md`, `docs/events.md` (if surface changes) — doc updates.

## Testing

- **Layer-1 `App.test.tsx`:** a delegation that produces artifacts → the completion bar appears with
  the right count; `⏎` on `View artifacts` opens the viewer on the **newest** artifact; `←/→` steps
  to the next; `tab` opens the jump list and `⏎` switches; `esc` returns to chat; a no-artifact turn
  shows **no** bar. Assert root's final reply does **not** contain the artifact body.
- **Pure unit:** the conversation-artifact gather/order function (latest-first, de-dup by handle,
  correct set from a fixture trace tree).
- **Layer-4 VHS evidence** (same bar as Plan 10/13): a slow-mode scenario drives a delegation to
  completion, screenshots the completion bar, opens the viewer (markdown body on screen), opens the
  jump list; file assertions confirm the artifacts exist and the body text is NOT in the transcript
  scrollback.

## Open decisions (captain to disposition; sensible defaults noted)

- **`o` open-in-editor:** keep the escape hatch to shell out to `$EDITOR`/`code <path>` for the real
  file, or is the in-TUI viewer enough? *Default: keep it (cheap, and root already has `run_command`;
  the viewer opens the file via the configured opener, not a model turn).* 
- **Versions:** one row per logical artifact showing the **latest** version (default, matches the
  mockup), or list every version (`v1`, `v2`, …)? *Default: latest per id, with older versions
  reachable via a per-artifact version step later if wanted.*
- **Reopen after dismiss:** `/artifacts view` (no arg) reopens the viewer for the current
  conversation; the completion bar is the just-in-time entry. *Default: add the slash too.*

## Non-goals

- Not changing what is recorded or how artifacts are produced/stored — this is a **read** surface.
- Not editing artifacts in-viewer (annotate stays `/artifacts annotate` / the operation-view path).
- Not a general file browser — scoped to this conversation's artifacts.
