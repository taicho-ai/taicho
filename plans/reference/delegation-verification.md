# Reference — Delegation Verification (quality loop)

Design detail for **Plan 06**. Phase 0 forks **closed (2026-07-04, all per recommendation)** — see §4.

---

## 1. The problem

Delegation trust is blind. A parent delegates a goal, the child returns text, and the parent
consumes it **unconditionally** — there is no acceptance criteria, no check, no retry. The only
quality loop in the system runs *through the human, after the fact* (coaching → policy notes).
For the target workloads (a writer consuming a researcher's dossier), "was this output actually
usable" is a first-class capability, and every hand-off without it silently propagates garbage
downstream at full token cost.

## 2. Current state (evidence from the code)

- **The return path is trust-everything.** `delegate_task` returns `{ result: child.text }`
  (`src/core/tools.ts:85`) straight into the parent's context. The parent *model* may notice a bad
  result, but nothing structural asks it to, and nothing bounds a re-delegation loop if it does.
- **A brief carries a goal, not a contract.** `runChild` passes `goal` + optional `context`
  (`src/core/run.ts:164`); the child never sees what "done" means.
- **`verifiedClaims` is an empty promise.** `TaskState` (uncommitted `src/store/task-state.ts`)
  carries a never-populated `verifiedClaims` field; the context-hygiene audit recommended cutting
  it "unless task-verification is a real near-term goal" — **this plan makes it one**; the cut is
  paused pending Phase 0 here.
- **Outcomes are mechanical, not qualitative.** `RunTrace.outcome` is
  completed/failed/blocked/interrupted (`src/core/run.ts:284`) — "completed" means the loop ended
  with text, not that the goal was met.
- **Coaching is the adjacent, proven pattern.** Corrections become durable policy notes
  (`src/coaching/`); verification failures are exactly the raw material coaching wants.

## 3. Proposed model

### 3a. Acceptance criteria in the brief (Phase 1)

`delegate_task` (and Plan 04's `dispatch_task`) gains `criteria?: string` — a plain-language
contract ("a markdown dossier with ≥5 cited sources; every claim dated"). It rides the brief into
the child's system prompt (`assemble`'s brief block), so the child aims at the contract, not just
the goal. Cheap, additive, useful even before any checking exists.

### 3b. The verification step (Phase 2)

On child return, when `criteria` was set, run a **bounded check** before the result reaches the
parent's context:

- [?] Fork — who verifies:
  1. **Checker call** (recommended): one extra model call — child's output + criteria → verdict
     `{ pass: boolean, reasons: string[] }`. Cheap (one call), symmetric (same model plumbing),
     and honest (independent of the child's self-assessment).
  2. Parent self-check: free but structurally identical to today's "the parent model may notice".
  3. Dedicated critic agent: a full run per hand-off — too heavy as the default; available later
     by simply pointing the checker at an agent.
- **On fail:** exactly **one** bounded retry — re-delegate with the original goal + the verdict's
  reasons appended as feedback. A second fail returns the result *with the failed verdict
  attached*, so the parent (and captain) see the caveat instead of a silent lie.
  Retries consume `maxWorkItemsPerRequest` like any delegation — no new runaway vector.
- Verdicts are recorded on the trace (`trace.verification`) and in the transcript, so the
  waterfall (Plan 02) can render a verification span and the ledger answers "why did it retry?".

### 3c. Artifact feedback tie-in (Phase 3, meets Plan 01 Phase 4)

When the hand-off is an artifact (Plan 01), the verdict becomes an **annotation on the artifact
version** — the same object a human review produces. Verification and human feedback converge on
one revision mechanism: annotation → revision run → new version. A repeated failure pattern is
coaching raw material (propose a policy note: "researcher dossiers keep missing dates").

### 3d. Task-state resolution

Phase 0 here must settle the audit's open question: either `verifiedClaims` becomes the populated
record of criteria→verdict pairs on the task, or it dies. Recommended: **rename to
`verifications[]`** ({criteria, verdict, runId, retried}) and populate it from 3b — the field
earns its place or leaves.

## 4. Phase 0 decisions (closed 2026-07-04)

| # | Decision | Decided |
|---|----------|----------------|
| 1 | Verifier | **Independent checker call**; critic-agent as later opt-in. |
| 2 | Retry policy | **One** bounded retry with verdict feedback, then surface the failure. |
| 3 | Criteria required? | Optional — no criteria ⇒ no check (today's behavior), zero cost when unused. |
| 4 | `verifiedClaims` | Rename → `verifications[]`, populate, or cut; decide here, not in the audit. |

## 5. Explicitly out of scope / YAGNI (for now)

- Deterministic validators (schema checks, linters) as criteria — the `run_command` +
  skills machinery can already express these; revisit if plain-language checks prove weak.
- Multi-round negotiation between parent and child (retry once, then escalate to a human).
- Verification of *root's* answer to the captain — the captain is the verifier there.
