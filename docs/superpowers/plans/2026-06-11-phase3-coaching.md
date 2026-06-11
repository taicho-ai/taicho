# Phase 3 — Coaching + prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD, checkbox steps. Implements `docs/superpowers/specs/2026-06-11-phase3-coaching-design.md`. Branch `phase3-coaching` (off `main`).

**Goal:** Corrections become durable, approval-gated policy injected into future runs (the 5th control surface), riding on persistent conversation + a generic approve/edit UX.

**Architecture:** Sequenced sub-slices — **3a UX foundation** (generic editable `ProposalCard` + extracted tested `slash.ts` + `/help`), **3b persistence** (`thread.jsonl` + worker trace digest), **3c coaching** (`store/policy.ts` + `/teach` draft→approve→persist + recall into `assemble`'s already-built policies block + trace ledger). Lean cut: render approved notes (no embeddings / no per-run LLM condition-check / no auto-supersede).

**Tech:** Bun, zod, ai v6, React/Ink, `bun test`. Existing scaffold reused: `schemas/policy.ts` (`PolicyNote`), `coaching/proposal.ts` (`toPolicy`, `ProposalDraft`), `prompt.ts` `assemble` (renders `policies[]` + has a `context` tier), `schemas/trace.ts` (`ledger`).

## Task list

### 3a — UX foundation
- **T1 · extract slash + /help** — Create `src/ui/slash.ts`: pure `runSlash(cmd, arg, deps) → Line[]` where `deps = { roster, listTraces, readTrace }` (+ later coaching fns). Move `/agents`,`/runs`,`/trace` logic out of `App.tsx`; add `/help`. Test `src/ui/slash.test.ts`: every branch incl. `/runs <agent>`, `/trace <missing>`, `/help`, unknown. Then App calls `runSlash(...).forEach(say)`.
- **T2 · generic editable ProposalCard** — `src/ui/proposalEdit.ts` (pure): given the card's field list + raw edited strings → a `{ ok: true; values } | { ok: false; error }` (validation). Test it. `ProposalCard` gains an edit mode (per-field `ink-text-input`, `e` enters edit, Enter resubmits, Esc cancels). `ApprovalDecision` (run.ts) → `{type:"approve"; draft?: Record<string,string>} | {type:"reject"} | {type:"edit"; draft: Record<string,string>}`. App resolves edit with the edited values.
- **T3 · create_agent honors edit** — `tools.ts` `create_agent.execute`: on `{type:"edit", draft}` build the agent from the edited draft (merge over the proposed draft) then create; on approve unchanged. Run-level test: a `requestApproval` returning `{type:"edit", draft:{role:"edited"}}` → persisted agent has the edited role.

### 3b — Persistence
- **T4 · thread store** — `src/store/thread.ts`: `appendTurn(ws, agentId, msg: ModelMessage)`, `loadThread(ws, agentId, maxTurns=40): ModelMessage[]` (bounded tail, tolerant of corrupt lines), `clearThread(ws, agentId)`. Files: `agents/<id>/thread.jsonl`. Test: append→load round-trip; bound (append 50, load 40 → last 40); corrupt line skipped; clear.
- **T5 · worker memory digest** — `src/core/memory.ts`: `recentRunsDigest(ws, agentId, k=5): string | undefined` from `listTraces` (`task · outcome · artifacts`), newest first; `undefined` when none. Test: formatting + empty. Extend `assemble` opts with `memoryBlock?: string` rendered in the `context` tier (test: block appears when provided).
- **T6 · wire persistence** — `index.tsx`: `loadThread(ws,"root")` on boot, pass to App; App seeds `thread.current` and appends ONLY completed-outcome turns via `appendTurn`. `executeRun`/App: for `@worker` runs, pass `memoryBlock: recentRunsDigest(ws, agentId)` into the run's `assemble`. Run-level test: a worker's 2nd run sees a digest mentioning its 1st run's artifact. Failed root turn NOT persisted (run-level/App-logic test on the persist guard — extract the "should persist?" predicate as pure + test).

### 3c — Coaching
- **T7 · policy store** — `src/store/policy.ts`: `writePolicy(ws, note)`, `listPolicies(ws, agentId): PolicyNote[]`, `readPolicy`, `deletePolicy(ws, agentId, polId)`; files `agents/<id>/policies/<pol_id>.md` (frontmatter = note minus `do`, body = `do`), mirroring `roster.ts` serialize/parse via `Bun.YAML`. Test: round-trip, list (approved filter), delete, malformed-skip.
- **T8 · recall into runs** — `executeRun`: replace `policies: []` with approved notes for `opts.agent.id` (via `listPolicies` filtered `status==="approved"`) + any `scope==="global"` notes across agents; pass into `assemble`'s `policies[]`; set `trace.ledger.retrieved`/`applied` to the injected ids (`skipped:[]`). Best-effort (load error → run with none). **Load-bearing test:** write an approved note → run the agent with a mock model → assert the note's `do`/`when` text is in the assembled system prompt (inspect `model.doGenerateCalls[0]` system) AND `res.trace.ledger.applied` contains the note id; + a `global`-scope note authored on agent A reaches agent B's run.
- **T9 · /teach + propose_coaching** — `ApprovalRequest` += `{ kind:"propose_coaching"; draft: ProposalDraft }`. `/teach <agentId> <text>` (in `slash.ts` + App): one model call producing a `ProposalDraft {when,do,scope}` (use ai `generateObject` or a structured prompt → parse; reuse the agent's resolved model) → `requestApproval({kind:"propose_coaching", draft})` → on approve `toPolicy(draft, {agent, taughtBy:"user"})` (status forced `approved`) + `writePolicy`. `/policies <agentId>` (list), `/forget <agentId> <polId>` (delete) in `slash.ts`. Tests: the draft→toPolicy→writePolicy path with a mock model + stub approval (assert persisted approved note); `/policies` lists; `/forget` deletes. Interactive `/teach` end-to-end is manual smoke.
- **T10 · full green + review** — `bun test` + `tsc` + build; self-review vs spec DoD; adversarial review (recall correctness + ledger honesty, global-scope leakage vs intent, thread poisoning on failure, edit-card draft plumbing, no policy file crashes a run); fix; manual-smoke notes.

## Key code — T8 recall (the load-bearing change in `src/core/run.ts`)
Replace the `assemble(...)` call's `policies: []` with a loaded set, and populate the ledger:
```ts
// before assemble():
let applied: PolicyNote[] = [];
try {
  const own = listPolicies(deps.ws, opts.agent.id).filter((n) => n.status === "approved");
  const globals = loadIndex(deps.db)
    .filter((r) => r.id !== opts.agent.id)
    .flatMap((r) => listPolicies(deps.ws, r.id))
    .filter((n) => n.status === "approved" && n.scope === "global");
  applied = [...own, ...globals];
} catch (e) { console.error(`policy load failed for ${opts.agent.id}:`, e); }
// ...
const { system } = assemble(opts.agent, { visibleAgents: visible, brief: ..., policies: applied, memoryBlock });
// in the trace literal:
ledger: { retrieved: applied.map((n) => n.id), applied: applied.map((n) => n.id), skipped: [] },
```
(Imports: `listPolicies` from `../store/policy`, `type PolicyNote` from `../schemas/policy`.)

## Self-review
**Spec coverage:** DoD1 /teach→persist (T9). DoD2 inject + ledger (T8). DoD3 /policies+/forget (T9). DoD4 thread resume + no-poison (T4,T6). DoD5 worker digest (T5,T6). DoD6 edit + /help + slash extraction (T1,T2,T3). ✓
**Sequence:** 3a (T1–T3) → 3b (T4–T6) → 3c (T7–T9) → review (T10); coaching reuses the edit card + slash module from 3a.
**Type notes:** `ApprovalDecision` edit-draft is `Record<string,string>` (generic field values) shared by create_agent + propose_coaching; `ApprovalRequest` union widens for propose_coaching; `assemble.policies[]` already typed `PolicyNote[]`.
**Out of scope (kept):** embeddings, condition-check, auto-supersede, team scope, per-worker threads, exemplars.
