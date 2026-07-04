# Reference — Evidence-Grade E2E (video proof)

Design detail for **Plan 11**. Direction set by the user (2026-07-04): E2E tests must produce
**proof** — the agent drives the real binary in a terminal and hands back a video of the test.

---

## 1. The goal

An agent (Claude, CI, or a script) runs one command per scenario and delivers a folder a human can
**watch and audit**: a true video of the compiled binary being driven through a real user flow,
plus machine-checked assertions on the files that flow produced. Not "tests passed, trust me" —
watchable, re-runnable proof.

## 2. Current state (evidence from the repo)

- **The ambition is already documented** — `CLI_TESTING.md` defines the minimum acceptable flow
  (create agent → approve → verify file → use agent → verify delegation → verify ledger) and lists
  the exact file assertions.
- **A deterministic driver exists** — `TAICHO_E2E_MODEL=agent-flow` (`src/core/e2e-model.ts`)
  scripts the model's turns, so the compiled binary runs multi-agent flows with no network, no
  tokens, repeatable output. This is the keystone; it already works.
- **The recording half is the weak part** — `e2e/record-agent-flow.expect` drives the binary with
  fixed `after 200` sleeps (flaky with Ink `TextInput`, per CLI_TESTING.md's known problems) and
  captures a raw ANSI log; the MP4 is **rendered from the log afterward** — a presentation of
  evidence, not a recording (CLI_TESTING.md calls this out honestly).
- **Layer 2 (`@microsoft/tui-test`) asserts but can't record** — it runs the binary in its own
  headless xterm; there is no captureable session, and at v0.0.4 it stays a thin smoke layer.
- Tooling on this machine: `ffmpeg` ✓, `expect` ✓; `vhs`/`ttyd`/`asciinema` not installed
  (`brew install vhs` pulls `ttyd`; vhs uses the existing ffmpeg).

## 3. The design

### 3a. Tool: VHS (charmbracelet)

[VHS](https://github.com/charmbracelet/vhs) runs a command in a real headless terminal
(ttyd + ffmpeg) from a scripted `.tape` file and emits a **true recording** — `.mp4` / `.gif` /
`.webm` — plus `Screenshot foo.png` at chosen moments. Two properties make it the right fit:

1. **`Wait+Screen /regex/`** — "wait until this text is on screen, then send the next keys."
   This replaces the expect script's fixed sleeps with the same wait-for-signal discipline the
   Layer-1 tests use (`waitFor(frame, …)`), killing the timing flakiness at the root.
2. **The video is the session** — what you watch is what ran, not a re-render of a log.

Example tape shape (agent-flow scenario):

```tape
Output evidence/agent-flow/session.mp4
Set Width 1200
Set Height 700
Env TAICHO_E2E_MODEL agent-flow
Type "create a proof worker agent"  Enter
Wait+Screen /New agent/            # approval card is up
Screenshot evidence/agent-flow/approval-card.png
Type "y"
Wait+Screen /Created proof-agent/
Type "use the proof worker to prove delegation works"  Enter
Wait+Screen /Root used proof-agent/
Screenshot evidence/agent-flow/final.png
```

### 3b. Principle: video is evidence, not assertion

A video can show a happy path over a silently-wrong workspace. So a **scenario** = three parts:

1. **`e2e/tapes/<scenario>.tape`** — drives `dist/taicho` through the user flow (3a).
2. **`scripts/e2e-evidence.ts`** — the wrapper an agent runs:
   `bun scripts/e2e-evidence.ts <scenario>` → builds the binary, creates a **temp workspace**
   (never the repo root — it is the live dev workspace), runs `vhs` with the workspace as cwd,
   then runs the scenario's **file assertions** against that same workspace (the CLI_TESTING.md
   list: trace `outcome`, `delegatedOut`, child `final.md`, ledger lines, `child-runs.json`).
   Assertions decide pass/fail; the video shows what happened. Non-zero exit on any failure.
3. **`evidence/<scenario>/manifest.json`** — ties the proof together: video + screenshot paths,
   assertion results (each with expected/actual), workspace pointer, git SHA, timestamp, tape
   used. This folder **is the deliverable** an agent hands back.

### 3c. How it layers into TESTING.md

| Layer | Role | Records? | Asserts? |
|---|---|---|---|
| 1 `bun test` | logic + in-process REPL | no | yes — the main suite |
| 2 `tui-test` | binary boots/responds, CI smoke | no | yes — thin |
| 3 real-model scripts | live-LLM behavior | no | trace inspection |
| **4 VHS evidence** | **real user flows through the real binary, with watchable proof** | **yes — true video** | **yes — workspace files** |

- Layer 4 **replaces** `e2e/record-agent-flow.expect` (delete it once the first tape passes) and
  supersedes the rendered-MP4 approach — this closes CLI_TESTING.md's "Next Improvements" 1–3.
- Scenarios stay **deterministic** (e2e-model modes). Each new flow that needs proof adds one
  e2e-model mode + one tape + one assertion set. Real-model evidence runs are possible (same
  tape, no `TAICHO_E2E_MODEL`) but stay manual/off-CI like Layer 3 (tokens, variability).
- CI: `charmbracelet/vhs-action` exists; evidence artifacts upload as build artifacts. Local-first
  is fine for v1.

### 3d. Scenario roster (v1)

1. **agent-flow** — port the existing expect scenario (create → approve → delegate); assertions
   already written in `e2e/agent-flow.tui.ts` / CLI_TESTING.md — reuse them.
2. **conversation-audit** — port `e2e/conversation-audit.tui.ts`'s interrupted-turn scenario.
3. Every new headline capability (Plans 01, 04, 06, 10) adds its proof scenario as part of its
   test phase — e.g. Plan 10's "two agents visible in panes + bar" is a natural tape.

## 4. Phase 0 decisions (closed 2026-07-04 — user direction + recommendation)

| # | Decision | Decided |
|---|----------|---------|
| 1 | Recorder | **VHS** — true session video, `Wait+Screen` robustness, screenshots, one brew install. (asciinema+agg noted as the lighter fallback if VHS/ttyd misbehaves; `.cast` is diffable but the toolchain is two tools and no wait-gating.) |
| 2 | Proof unit | **tape + wrapper assertions + manifest** — video is evidence, never the assertion. |
| 3 | Determinism | **e2e-model modes per scenario**; real-model evidence stays manual like Layer 3. |

## 5. Explicitly out of scope / YAGNI (for now)

- Recording Layer-1/Layer-2 runs (nothing visual to record — tui-test's xterm is headless).
- Pixel-diff / screenshot-regression testing (assertions live on workspace files + on-screen
  text waits; visual regression is a different, heavier discipline).
- CI-gating on evidence runs (start local; wire `vhs-action` once tapes are stable).
