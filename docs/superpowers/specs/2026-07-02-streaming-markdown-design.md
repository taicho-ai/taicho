# Streaming markdown rendering for agent replies

**Date:** 2026-07-02
**Status:** approved (direction) — user gave go-ahead
**Topic:** Render agent output as clean, formatted markdown in the Ink REPL, **incrementally as blocks
complete during streaming** (not a single re-render at the end).

## 1. Background & problem

The REPL renders every message as a single flat `<Text>` line (`src/ui/App.tsx:383-389`): agent =
green, user = white, system = gray, with an inline `${from}:` prefix. An entire agent reply is one
green `<Text>` blob, so markdown source (`**bold**`, `# headings`, `- lists`, fenced code) shows
**literally**. Agent text also streams token-by-token into a live line (`liveText`,
`App.tsx:388-389`) and is committed at the `flushStream()` boundary (`App.tsx:211, 229`); the
non-streaming path commits `res.text` directly (`App.tsx:212, 230`). There is no markdown rendering
anywhere in the codebase.

**Research summary (see the brainstorming conversation):** for Ink 7 + Bun single-binary + streaming,
the pragmatic, bundle-safe choice is `marked` + `marked-terminal` (pure JS, brings `cli-highlight`
for code fences). `ink-markdown` is dormant (a ~5-line wrapper we can own). Shiki adds WASM /
dynamic-grammar bundling risk and is unnecessary for a chat CLI. The idiomatic Ink pattern is to
render markdown to an **ANSI string** placed in `<Text>`, freeze finalized output in `<Static>`, and
drive the renderer's wrap `width` from Ink's actual measured width (else double-wrapping mangles
tables/box output).

## 2. Goals & non-goals

**Goals**
- Agent replies render as formatted markdown (headings, bold/italic, lists, blockquotes, fenced code
  with syntax highlighting, links, tables) in the terminal.
- **Incremental streaming:** as the agent streams, each markdown *block* renders as soon as it
  completes (at newline/blank-line/closed-fence boundaries) — not deferred to a single end-of-message
  re-render. The still-growing trailing block stays raw until it completes.
- Stays inside the single-binary build (`bun run build`) with no native/WASM deps.
- Tested at the unit level (the renderer + the block splitter) **and** the Ink level
  (`ink-testing-library`, per `TESTING.md` Layer 1).

**Non-goals (this spec)**
- **Conversation-view redesign** (bordered message panels / boxes — option "C"). Framing stays
  minimal: keep the current role attribution; let block spacing carry readability.
- **Live intra-block repair** (rendering a half-open `**` or unclosed fence as styled markdown
  mid-line, à la Streamdown's repair-then-reparse). We render at block boundaries only; the tail is
  raw. This is the "keep it simple" choice and avoids garbled partial renders.
- **Shiki / VS-Code-grade themes.** `cli-highlight` (via `marked-terminal`) is sufficient.
- Markdown for **user** input echoes and **system/trace** lines — those stay plain (they're not
  prose the agent authored; keeping them plain preserves the visual distinction).

## 3. The renderer (pure, isolated unit)

New module `src/ui/markdown.ts`:

```ts
export function renderMarkdown(text: string, width?: number): string
```
- Configures a module-singleton `marked` instance with a `marked-terminal` renderer (`new
  TerminalRenderer({ width, reflowText: true, ... })`), parses `text`, returns the ANSI string
  (trimmed of the trailing newline). Pure and synchronous — trivially unit-testable, no Ink, no I/O.
- `width` defaults to a sane fallback (e.g. 80) when not supplied; callers pass Ink's real width.
- Owns the wrapper `marked`+`marked-terminal` wiring (the ~5 lines `ink-markdown` would have given us),
  so nothing else in the app imports `marked`/`marked-terminal` directly.

## 4. Incremental block engine (the streaming core)

New module `src/ui/markdown-stream.ts` — a pure function that, given the full accumulated buffer,
reports which markdown blocks are complete and what raw tail remains:

```ts
export interface BlockSplit { blocks: string[]; tail: string }
/** Split a (possibly partial) markdown buffer into COMPLETED block sources + the still-growing tail.
 *  Uses marked's lexer: every top-level token except the last is stable; the last token is the tail
 *  (it may still grow — an open code fence is a single incomplete token that stays in `tail`). */
export function splitCompletedBlocks(buffer: string): BlockSplit
```
- Implementation: `marked.lexer(buffer)` → top-level tokens. Return the `raw` source of all tokens
  except the last as `blocks`, and the last token's `raw` as `tail`. Empty/whitespace buffer →
  `{ blocks: [], tail: buffer }`.
- Pure, deterministic, unit-testable without Ink or a model.

### Streaming flow in `App.tsx`
During a streaming run, deltas already accumulate in `streamRef.current` (`App.tsx:163`). On each
delta (the `onStep` delta branch):
1. `const { blocks, tail } = splitCompletedBlocks(streamRef.current)`.
2. Commit any blocks **newly** completed since the last tick (track a committed-block count/offset):
   for each new block, `say({ kind: "agent", from, text: block, rendered: true })` — i.e. push a
   finalized agent line whose text is that block's markdown source (rendered at paint time, §5).
3. Set `liveText` to the raw `tail` (rendered raw/plain, as today).

On `flushStream()` (stream end): commit the final `tail` as a rendered agent block, then clear.
Because blocks are committed progressively, at end there is at most one trailing block left to flush.

Non-streaming replies (`res.text`) are committed as a single agent line with `rendered: true`.

**Committed-offset tracking:** the streaming buffer only grows, and `marked.lexer` is deterministic,
so the block list is a stable prefix that only extends. Track how many blocks have been committed
(`streamBlocksRef`) and commit only `blocks.slice(committed)` each tick. Reset it per run.

## 5. Rendering the committed markdown

Extend the `Line` type (`src/ui/slash.ts`) with an optional `rendered?: boolean`. In `App.tsx`'s
render:
- For a line with `rendered`, compute `renderMarkdown(l.text, width)` and emit the role prefix (the
  agent label) followed by the ANSI string. Render the ANSI as **one `<Text>` per output line**
  inside a `<Box flexDirection="column">` (so Ink's own `wrap-ansi` pass is a no-op on
  already-wrapped lines — avoids the double-wrap mangling from the research).
- Non-`rendered` lines (user/system/trace, and the live `tail`) render exactly as today.
- `width` = Ink's measured columns via `useStdout().stdout.columns` (fallback 80), minus any box
  padding. Re-render on resize is automatic (React re-render); memoize `renderMarkdown` per line by
  `(text, width)` to avoid re-parsing unchanged committed lines every keystroke.

**`<Static>` (perf):** move committed lines into Ink's `<Static>` region so finalized output is
rendered once and never re-diffed; keep the live `tail`, cards, input, and suggester in the dynamic
region. This is a contained change to the render tree and is the load-bearing Ink perf pattern for a
growing scrollback. (If `<Static>` interaction with the existing card/suggester layout proves fiddly,
it can land as a follow-up; the correctness of markdown rendering does not depend on it.)

## 6. Dependencies & bundling

- Add `marked@^15` (peer-capped by marked-terminal) and `marked-terminal@^7.3.0` to `package.json`
  **by editing the file + `bun install`** — NOT `bun add` (which re-resolves the tree and hits the
  broken `@vercel/ai-tsconfig` publish, per `TESTING.md`). Keep the `overrides` block intact.
- `marked` / `marked-terminal` / `cli-highlight` are pure JS with static requires — they bundle into
  `bun build --compile`. Verify: `bun run build` succeeds and the flow renders in the real binary.

## 7. Testing

- **`renderMarkdown` unit** (`src/ui/markdown.test.ts`): `**bold**` → contains the ANSI bold code;
  a heading, a `- list`, and a fenced ```` ```ts ```` code block each produce non-raw output (assert
  the ANSI differs from the input and key styling bytes are present); plain text passes through.
- **`splitCompletedBlocks` unit** (`src/ui/markdown-stream.test.ts`): two paragraphs separated by a
  blank line → one completed block + the second as tail; a heading followed by a partial paragraph →
  heading completed, paragraph in tail; an **open** code fence → everything stays in `tail` (nothing
  committed) until the closing fence, then it becomes a completed block; empty buffer → no blocks.
- **Ink Layer-1** (`src/ui/App.test.tsx`, per `TESTING.md`): stream a mocked agent reply containing
  markdown across multiple blocks (via a `doStream` mock emitting deltas with newlines) and assert
  (a) completed blocks appear formatted (ANSI styling present / raw `**` markers gone) as they
  complete, and (b) the final block renders after `flushStream`. Also a non-streaming reply renders
  formatted. Model the mock on the existing `subscription path streams the reply live` test.
- **Build**: `bun run typecheck` + `bun test` green; `bun run build` succeeds (single binary bundles
  `marked-terminal`).

## 8. File structure

- Create: `src/ui/markdown.ts` (renderer), `src/ui/markdown-stream.ts` (block splitter),
  `src/ui/markdown.test.ts`, `src/ui/markdown-stream.test.ts`.
- Modify: `src/ui/slash.ts` (`Line.rendered?`), `src/ui/App.tsx` (streaming commit of blocks, render
  of `rendered` lines, `<Static>`, width), `src/ui/App.test.tsx` (Ink tests), `package.json` (deps).

## 9. Risks & open questions

- **Double-wrap** (Ink re-wrapping already-wrapped ANSI): mitigated by passing Ink's real width to
  `marked-terminal` and rendering one `<Text>` per line. Primary thing to verify visually in the
  real binary.
- **`marked` ↔ `marked-terminal` peer range**: pin `marked@^15` (marked-terminal@7 caps `<16`). A
  mismatched `marked@18` would warn/break — the pin is load-bearing.
- **Streaming re-parse cost**: `marked.lexer` on the growing buffer each delta. At chat token rates
  this is cheap; committed blocks move to `<Static>` and are never re-parsed. If it ever matters,
  only lex the uncommitted tail. Deferred.
- **`<Static>` layout interaction** with the existing approval cards / suggester: if fiddly, ship
  markdown first and `<Static>` as a fast follow (§5).
- **Trace/tool interleaving**: `↳ agent → tool()` and `trace:` system lines interleave with agent
  blocks in the scrollback; they stay plain and keep their current ordering (committed as they occur).
