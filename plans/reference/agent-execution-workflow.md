# Reference — Agent Execution Workflow (how the plans get built)

Direction set by the user (2026-07-04): plans are implemented by **separately spun-up workflow
agents**, each working and testing in **its own git worktree**, shipping a **pull request** per
unit of work. The captain's main session reviews PRs as they arrive. This doc is the operating
contract for those agents — read it before touching anything.

---

## 1. The model

```
main (protected by review)
 ├─ worktree ../taicho-plan-11        → branch plan-11-e2e-evidence      → PR
 ├─ worktree ../taicho-plan-01-p1-3   → branch plan-01-artifact-store    → PR
 └─ worktree ../taicho-plan-02-p0     → branch plan-02-span-capture      → PR
```

- **One agent per unit of work.** A unit = one plan, or one coherent phase group of a big plan
  (e.g. "Plan 01 Phases 1–3"). Never two plans in one PR.
- **Each agent gets its own worktree + branch off `main`.** Setup:
  ```bash
  git -C /path/to/taicho worktree add ../taicho-plan-NN -b plan-NN-<slug> main
  cd ../taicho-plan-NN && bun install        # node_modules is NOT shared between worktrees
  ```
- **Why worktrees are non-negotiable here** (not just hygiene): the **repo root is the live dev
  workspace** — `agents/`, `kb/`, `skills/`, `runs/`, `taicho.db*` there are the captain's real
  data (gitignored, unrecoverable). A fresh worktree physically does not contain them, so an
  agent cannot trample what its checkout doesn't have. Corollary: **never run your dev binary or
  tests with cwd = the main repo root.** Evidence runs use temp workspaces anyway (runbook §0).

## 2. What an agent does, start to finish

1. **Read your plan** — the `## Plan NN` section in `plans/tasks.md` (tracking view) **and its
   reference doc** in `plans/reference/` (the decided design: every Phase 0 fork is already
   closed; do not re-open decisions — if a decision proves wrong in practice, STOP and report,
   don't silently deviate).
2. **Read the interlocks** in the plan header. If your plan depends on an unmerged PR (e.g.
   Plan 05 Phase 3 needs Plan 01 Phase 5's seam), either build on that branch explicitly (say so
   in the PR) or pick different work.
3. **Set up the worktree** (§1) and implement phase by phase, updating checkboxes in
   `plans/tasks.md` (`[ ]` → `[~]` → `[x]`) **in your branch** as part of the PR — the merged PR
   is what updates the tracking state.
4. **Test your own work** in the worktree:
   - `bun run typecheck` and `bun test` green — the floor, not the bar.
   - **UI wiring gets Layer-1 `App.test.tsx` coverage** (ink-testing-library) — typecheck+build
     is NOT sufficient for App.tsx changes (a real `/kb list` bug once shipped that way).
   - Model/provider/MCP wiring: also `bun run build` (the bundle catches what tsc doesn't).
   - **Evidence:** if your plan has an evidence scenario (Plans 01/04/06/10 test phases), run
     `bun scripts/e2e-evidence.ts <scenario>` and get a passing manifest. vhs is installed
     machine-wide (0.11.0, smoke-tested); the sandbox/ttyd landmine and everything else you
     need is in `integration-testing-runbook.md`.
5. **Open the PR** (`gh pr create`), one per unit of work — see §3 for what it must contain.
6. **Respond to review** with rigor, not performative agreement — if a review point seems wrong,
   verify against the code and say so with evidence.

## 3. PR contract

Every PR body must include:

- **Plan reference:** "Implements Plan NN Phases X–Y" + a line per checkbox flipped.
- **Deviations:** anything done differently from the plan/reference doc, with why. An
  undeclared deviation found in review is an automatic change-request.
- **Test evidence:**
  - the `typecheck` / `bun test` tail (counts),
  - for evidence scenarios: the **`manifest.json` content pasted verbatim** (assertions with
    expected/actual). The video itself stays out of git (`evidence/` is ignored) — proof is
    **re-runnable**: the reviewer reruns `bun scripts/e2e-evidence.ts <scenario>` in the PR's
    worktree and watches the mp4 locally. Optionally attach the GIF to the PR via the web UI.
- **Touched-files list** if it strays outside the plan's stated file set (drift signal).
- The standard footer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## 4. Review (the captain's main session)

PRs are reviewed **against the plan + reference doc**, not just for code quality:

0. **`baseRefName` is `main`.** A stacked PR (based on another PR's branch) must be
   retargeted to `main` before review — merging a stacked PR lands it on the stale base branch,
   not `main` (this happened with PR #3; fixed manually). `gh pr view N --json baseRefName`.

1. Does it implement what the plan says, honoring the closed Phase 0 decisions and the design
   principles (payload-agnostic artifacts; video-is-evidence-not-assertion; model proposes,
   config disposes; resolver shape kept in sync across its four mirrors)?
2. Is the test evidence real — Layer-1 coverage for UI wiring, evidence manifest passing,
   re-runnable?
3. No workspace/secret hazards (nothing writes to the repo-root live workspace; no tokens
   logged; `.envt`-class files never committed).
4. Checkbox updates in `plans/tasks.md` match what actually shipped.
5. **Combined-tree verification when main moved since the branch was cut**: GitHub's MERGEABLE
   is textual, not semantic — a green branch + green main can still produce a broken merge (seen
   live: #10/#11 were MERGEABLE after #12 rewrote the loop tests, yet the combined tree failed
   typecheck). The reviewer verifies a local test-merge with current main (typecheck + suite +
   evidence) before merging; parallel PRs touching the same hotspots get serialized rebase orders.

Merge is the captain's call (or the reviewer's, when the captain has said to ship).

## 5. Parallelism & conflict discipline

- **Hotspot files** — `src/core/tools.ts`, `src/core/run.ts`, `src/core/loop.ts`,
  `src/ui/App.tsx`, `src/store/roster.ts` — are touched by most plans. Two agents editing the
  same hotspot concurrently = a merge-conflict tax on whoever lands second. Prefer picking
  plans with disjoint file sets; when overlap is unavoidable, serialize (wait for the other PR
  to merge, then rebase).
- **Suggested PR order** (from the interlocks):
  1. **Plan 11** (evidence harness) — first, so every later PR can prove itself with video.
  2. **Plan 01 Phases 1–3** (artifact store + read + hand-off) — unlocks 04/05/06.
  3. **Plan 02 Phase 0 + Plan 10 Phase 1 together** (shared engine instrumentation — one PR,
     it's one seam).
  4. Then 02/10 surfaces, 01 Phase 5, and 04/05/06 as dependencies clear; placeholders
     (03/07/08/09) whenever.
- **Worktree cleanup:** after merge, `git worktree remove ../taicho-plan-NN` and delete the
  branch. Stale worktrees accumulate confusion.

## 6. Hard rules (from memory — violations have burned us before)

- **NEVER** rm/overwrite `agents/ kb/ skills/ runs/ artifacts/ taicho.db*` in the main repo
  root — live user data.
- **Never `bun add`** — edit `package.json` + `bun install`, keep the `overrides` block.
- **Never log auth tokens**; use `redactAuthHeader` for debug output.
- Keystroke tests: separate writes per key, ANSI escapes as `` JS escapes, poll frames
  (`TESTING.md` gotchas).
- Evidence runs: temp workspace via the wrapper, never the checkout dir, never the main root.
