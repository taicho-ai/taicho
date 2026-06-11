# taicho v1 · Phase 3 — Coaching (5th surface) + prerequisites (Design)

**Date:** 2026-06-11
**Status:** proposed (decisions resolved to roadmap recommendations; user waived the approval gate)
**Roadmap items:** #5 coaching (lean cut) + #4 persistence-state (tight) + #6a ux-polish (cheap half). **Branch:** `phase3-coaching` (off `main` = Phases 1+2 + auth).

---

## 1. Goal
The captain's **corrections become durable, approval-gated policy** that shapes an agent's future runs — taicho's headline differentiator. Plus the two things coaching rides on: the **conversation persists** across launches (so "enter anywhere, any time" is real), and the **propose→approve grammar gains an edit step** (reused by both agent creation and coaching).

**Definition of done:**
1. `/teach <agentId> <correction>` turns a free-text correction into a proposed policy `{when, do, scope}` (one LLM call), surfaced on the `ProposalCard`; on approve it's persisted under `agents/<id>/policies/`.
2. An agent's **approved policies are injected into its prompt on every subsequent run** (the `assemble` "Standing instructions" block — already built), and the run's trace **ledger records which policy ids were applied**.
3. `/policies <agentId>` lists an agent's notes; `/forget <agentId> <pol_id>` removes one. Both approval/edit go through the same card.
4. Quitting and relaunching **resumes the root conversation** (persisted, bounded); failed turns never poison it.
5. Workers see a **"recent runs" digest** (last K traces) in context, so they're not fully amnesiac.
6. A proposed agent OR policy can be **edited** before approval (`[e]dit` actually works now), and `/help` lists the grammar; `runSlash` is extracted to a tested pure module.

## 2. Resolved decisions
| Decision | Resolution |
|---|---|
| Recall mechanism | **Render all approved notes** for the agent (+ `global`-scope notes) into the prompt; the model self-applies each note's `WHEN`. **No per-run LLM condition-check, no embeddings** (both deferred to Phase 4). Ledger records injected ids as `applied`; `skipped: []`. |
| Scope | `agent` + `global` only. `team` deferred (no team concept exists). |
| Drafting | Free-text correction → **one LLM call** → `ProposalDraft {when, do, scope}` (uses the agent's resolved model). Captain approves/edits. |
| Supersede | **Deferred** (no LLM auto-contradiction). Notes are additive; a bad note is removed via `/forget`. (Auto-supersede = Phase 4.) |
| Policy storage | One file per note under `agents/<id>/policies/<pol_id>.md` (YAML frontmatter = `PolicyNote` minus `do`, body = the instruction), mirroring `agent.md`/`roster.ts`. Files are canon; status `approved` on persist (approval-gated). |
| Root persistence | `agents/root/thread.jsonl`, append-only, **only completed-outcome turns** (mirrors today's pop-on-failure); reload a bounded **tail (last 40 turns)** on boot. `/forget-thread` (or deleting the file) resets it. |
| Worker memory | Read-only **digest of the last K=5 traces** (`task · outcome · artifacts`) rendered into the `context` tier. No per-worker thread, no scratchpad (deferred). |
| Edit UX | `ApprovalDecision` carries an optional edited draft; `ProposalCard` becomes a generic field-list editor reused by `create_agent` and `propose_coaching`. |

## 3. Build sequence (each sub-slice is TDD + committed)

### 3a — UX foundation (do first; coaching reuses it)
- `ApprovalDecision` → `{ type: "approve"; draft?: GenericDraft } | { type: "reject" } | { type: "edit"; draft: GenericDraft }`. `create_agent`'s execute treats edit-with-draft as approve-with-edited-draft.
- `ProposalCard` gains an inline edit mode (per-field `ink-text-input`; Enter resubmits, Esc cancels to the y/n/e prompt). A pure `src/ui/proposalEdit.ts` merges raw field strings → a validated draft (unit-tested); the card renders it.
- Extract `runSlash` → **`src/ui/slash.ts`** as a pure `runSlash(cmd, arg, deps) → Line[]` (deps = injected store fns); unit-test `/agents`, `/runs`, `/runs <agent>`, `/trace`, `/trace <missing>`, `/help`, unknown. Add `/help`.

### 3b — Persistence
- `src/store/thread.ts`: `appendTurn(ws, agentId, msg)` (append a JSON line), `loadThread(ws, agentId, maxTurns=40)` (bounded tail), `clearThread`. Used for root. Unit-tested (append→load round-trip, bound, clear).
- `src/core/memory.ts`: `recentRunsDigest(ws, agentId, k=5): string | undefined` from `listTraces` (task·outcome·artifacts) → a context block; pass into `assemble` for worker runs. Unit-tested.
- `index.tsx`: load the root thread on boot; `App` seeds `thread.current` from it and **appends only completed turns**.

### 3c — Coaching (the surface)
- `src/store/policy.ts`: `writePolicy`/`listPolicies(ws, agentId)`/`readPolicy`/`deletePolicy`, files under `agents/<id>/policies/`. Uses the existing `PolicyNote` schema (`schemas/policy.ts`) + `toPolicy` (`coaching/proposal.ts`). Unit-tested (round-trip, list, delete, malformed-skip).
- `propose_coaching`: a new `ApprovalRequest` variant `{ kind: "propose_coaching"; draft: ProposalDraft }`. `/teach <agentId> <text>` → one model call producing a `ProposalDraft` (a small structured-output prompt) → `requestApproval` → on approve `toPolicy(...)` + `writePolicy` (status `approved`).
- **Recall in `executeRun`**: replace `policies: []` — load `listPolicies(ws, agent.id)` filtered to `status==="approved"` + `global`-scope notes from any agent, pass into `assemble`'s `policies[]`. Populate `trace.ledger.retrieved`/`applied` with the injected ids.
- `/policies <agentId>` (list), `/forget <agentId> <pol_id>` (delete) via `slash.ts`.

## 4. Schema / type deltas
- `ApprovalRequest` (run.ts): add `| { kind: "propose_coaching"; draft: ProposalDraft }`. `ApprovalDecision`: add optional `draft` payload (generic).
- No `PolicyNote`/`RunTrace.ledger` schema change (both already exist; ledger is currently written empty).
- `assemble` already renders `policies` + accepts a context block — reuse for the worker digest (add an optional `memoryBlock?: string` to `assemble`'s opts, rendered in the `context` tier).

## 5. Error handling
- `/teach` draft LLM call fails → surface the error, no policy written (no half-state).
- Malformed policy file → skipped on load + warn (never crash a run).
- Recall is best-effort: if loading policies throws, log + run with none (a coaching glitch must not break the run).
- Persistence: a corrupt `thread.jsonl` line → skip it (tolerant read); thread load failure → start fresh.

## 6. Testing
- **3a:** `proposalEdit` merge/validate; `slash.runSlash` all branches (incl. `/help`, unknown); `ApprovalDecision` edit path through `create_agent` (run-level test: edit returns the edited draft → persisted agent reflects edits).
- **3b:** `thread` append/load/bound/clear; `recentRunsDigest` formatting + empty case; failed-turn-not-persisted (run-level).
- **3c:** `policy` store round-trip/list/delete; **recall injects approved notes into the prompt** (run-level: write an approved note → run the agent → assert the note text appears in the assembled system prompt AND `trace.ledger.applied` contains its id) — the load-bearing coaching test; `/teach` draft→approve→persist (with a mock model producing the draft + stub approval); `global`-scope note reaches another agent.
- All existing 94 tests stay green.
- App interactive paths (the edit card, `/teach` end-to-end, thread resume across real launches) are manual smoke.

## 7. Out of scope (Phase 3 → Phase 4+)
- Embeddings / semantic recall; per-run LLM condition-check; auto-supersede (LLM contradiction judge).
- `team` scope; per-worker conversation threads; agent-writable scratchpad.
- Exemplars (separate roadmap item).

## 8. Why this order
3a's generic edit card + `slash.ts` are reused by 3c's `propose_coaching`/`/teach`/`/policies`; 3b establishes the on-disk-state conventions; 3c is then a mostly-additive layer on the (already-built) `assemble` policies block + the existing coaching scaffold. Each sub-slice ends green and independently useful.
