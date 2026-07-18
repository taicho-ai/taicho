# CLI Testing — Layer 4 (evidence-grade E2E, video proof)

This document describes how we prove real user workflows through the compiled `dist/taicho`
binary and hand back **watchable, re-runnable evidence** — a true terminal-session video plus
machine-checked assertions on the files the binary produced. Not "tests passed, trust me."

This is **Layer 4** in [TESTING.md](/Users/rajeshsharma/Documents/Works/Personal/agents/taicho/TESTING.md).
Layer 2 (`@microsoft/tui-test`, `bun run test:e2e`) remains the thin, fast CI smoke; Layer 4 is
the deep, recorded proof.

## What this layer must prove (the assertion contract)

A useful CLI test exercises the same path a user does:

1. Build the executable with `bun run build`.
2. Start the compiled binary, `dist/taicho`, in a real terminal.
3. Type prompts into the Taicho terminal UI.
4. Approve interactive tool cards when needed.
5. Verify the files and run records the binary produced.

For the agent workflow, the minimum acceptable proof is:

1. Prompt Taicho to create an agent.
2. Approve the proposed agent.
3. Verify the agent file exists.
4. Prompt Taicho again to use that agent.
5. Verify the root run delegated to the child agent.
6. Verify the child agent completed and its output was rolled up into the root answer.
7. Verify the conversation ledger preserved the user prompts.

Anything less is only a smoke test.

## Run it

```bash
bun scripts/e2e-evidence.ts agent-flow
```

Exit 0 = pass. On success it writes `evidence/agent-flow/` (gitignored):

```
evidence/agent-flow/
  session.mp4        # true headless-terminal recording of the whole flow
  approval-card.png  # screenshot: the "New agent — approve?" card
  final.png          # screenshot: the completed delegation
  agent-flow.tape    # the exact VHS tape that drove this run (reproducibility)
  manifest.json      # THE deliverable — pass/fail, assertions w/ expected·actual, ws, git SHA
```

`evidence/agent-flow/manifest.json` is the folder's point: it ties the proof together and its
`assertions[]` (each with `expected`/`actual`) are what decide pass/fail.

**Requires `vhs` on PATH** (a system binary: `brew install vhs`, which also pulls `ttyd`; `ffmpeg`
is already present). Installed & verified on this machine: vhs 0.11.0, ttyd 1.7.7.

## How it works

A **scenario** = tape + assertions, in one file under `e2e/scenarios/<name>.ts`
(see [`e2e/scenarios/agent-flow.ts`](/Users/rajeshsharma/Documents/Works/Personal/agents/taicho/e2e/scenarios/agent-flow.ts)):

- `tape({ binary, evidenceDir })` returns the full VHS `.tape` source that drives the flow. Waits
  are gated on **on-screen text** (`Wait+Screen@Ns /regex/`) — the same wait-for-signal discipline
  as the Layer-1/2 tests, which kills timing flakiness. Two submits gate `Enter` on the typed
  prompt being visible (avoids the Ink `TextInput` submit race).
- `assertions(ws)` returns `AssertionResult[]` run against the temp workspace. Each catches its own
  error (a missing file ⇒ `pass:false`), so one failure never hides the rest. Run ids are
  **discovered dynamically** — they are date-stamped (`<date>-run<n>`), never hardcode them.

The wrapper [`scripts/e2e-evidence.ts`](/Users/rajeshsharma/Documents/Works/Personal/agents/taicho/scripts/e2e-evidence.ts):
build binary → **warm the binary** → **fresh temp workspace** (`mkdtemp` — NEVER the repo root,
which is the live dev workspace) → run `vhs` with `cwd = workspace` → copy the recorded artifacts
into `evidence/<scenario>/` → run the scenario's assertions → write `manifest.json` → exit non-zero
on any failure. Determinism comes from `TAICHO_E2E_MODEL=agent-flow`
([`packages/framework/src/core/e2e-model.ts`](/Users/rajeshsharma/Documents/Works/Personal/agents/taicho/packages/framework/src/core/e2e-model.ts)):
the compiled binary uses a scripted model, so the flow runs with no network, no tokens, repeatable.

**Video is evidence, not assertion.** A video can show a happy path over a silently-wrong
workspace, so pass/fail comes only from the file assertions — the video shows *what happened*.

## Gotchas (verified on this machine — honor these)

1. **VHS 0.11.0 cannot parse absolute paths in `Output`/`Screenshot`** (a leading `/` breaks its
   lexer). So the tape uses **relative** filenames (`Output session.mp4`, `Screenshot final.png`);
   vhs runs with `cwd = temp workspace` so they land next to the binary's data, and the wrapper
   **copies them into `evidence/<scenario>/`** afterwards. (An absolute path is fine *inside* a
   `Type` string — only `Output`/`Screenshot` arguments must be relative.)
2. **vhs spawns a local `ttyd` server** (needs a localhost port). A sandboxed shell that blocks
   localhost listening fails with `could not open ttyd: … ERR_CONNECTION_REFUSED`. Run the harness
   in a shell that can bind a local port. (typecheck / `bun test` / `bun run build` don't need
   this — only the vhs recording step does.) If vhs fails it can orphan its `ttyd`; a pile of
   orphans causes contention that flakes later runs — clear them with `pkill -f 'ttyd --port'` and
   re-run. On success vhs cleans up its own ttyd.
3. **The temp workspace gets a `taicho.yaml`** with `mcp.enabled: false` (MCP off or boot may hang)
   and `auth.chatgpt_signin: false`. With `TAICHO_E2E_MODEL` set, the binary bypasses `resolveAuth`,
   so no API key is needed. `TAICHO_E2E_MODEL` is passed via the wrapper env **and** typed on the
   binary's command line in the tape (belt-and-braces).
4. **The wrapper warms the freshly-built binary** before recording. `bun run build` rewrites a
   ~66MB compiled binary; macOS runs first-exec code-sign verification + builds the dyld closure on
   the FIRST exec of that new file — a cold, sluggish exec during which the booting app drops the
   submit keystroke (empirically ~5/6 flake without warm-up; 0/10 with). Any completed exec primes
   the OS's cached validation, so vhs's exec is then fast and the flow is reliable.

## Adding a scenario

Each new headline flow that needs proof adds: one `e2e-model.ts` mode (a scripted **`doStream`**
stream-parts sequence built with the `stream()`/`text()`/`call()` helpers — the loop streams every
provider since Plan 07), one `e2e/scenarios/<name>.ts` (tape + assertions), then
`bun scripts/e2e-evidence.ts <name>`. Real-model evidence runs need a tape edit, not just an env
change — the tape itself types `TAICHO_E2E_MODEL=<mode>` into the launch command (gotcha 3's
belt-and-braces) — and stay manual/off-CI like Layer 3: they cost tokens and vary.

## CI (later)

`charmbracelet/vhs-action` exists; the `evidence/<scenario>/` folder uploads as a build artifact.
Local-first for now — wire it into CI once the tapes prove stable.
