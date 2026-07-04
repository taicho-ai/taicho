# Reference — Context-Hygiene Audit (ledger / context / task-state)

Detail for **Plan 01, Phase 5**. This captures the review of the uncommitted conversation-audit
work so the analysis isn't lost. It is the "keep context clean" half; hand-off artifacts are the
"keep payloads off context" half.

---

## What was added (uncommitted)

Three new persistence layers on top of the existing `runs/<agent>/<run>.json` traces and
`agents/<id>/thread.jsonl`:

| Layer | File(s) | Written by | Read back in prod? |
|---|---|---|---|
| Run evidence | `runs/<agent>/<run>/` — `input.json`, `transcript.jsonl`, `final.md`, `failure.md`, `child-runs.json` | engine (`run.ts`), every run incl. children | no (debug/e2e only) |
| Conversation ledger + context | `conversations/<id>/ledger.jsonl` + `context.json` | UI (`App.tsx`), user-triggered top-level runs only | **no** |
| Task state | `tasks/<taskId>.json` | UI (`App.tsx`), user top-level only | **no** |

The engine also threads a `transcript[]` through `LoopResult`, collects `childTraces`, and fires an
`onRunStart` hook.

## Tensions found

1. **Two parallel mechanisms decide "which turns replay" — only the old one is load-bearing.**
   `thread.jsonl` (via `shouldPersistTurn` = completed-only) is what actually loads at boot and
   replays. The new `context.json` records the *same* include/exclude decision with richer reasons,
   but `loadContext` is never called in production → **write-only, and duplicative → will drift.**
2. **Audit lives in two layers.** Run evidence is engine-written for every run; ledger + task are
   UI-written for only user-triggered top-level runs. A future non-Ink caller gets run evidence but
   silently no ledger and no task.
3. **`App.tsx submit()` carries two near-identical ~30-line audit blocks** (chat vs `@agent`) — the
   symptom of #2. Wants to be one `recordTurnOutcome(...)` seam, not in the React component.
4. **Speculative / dead pieces.** `verifiedClaims` is in `TaskState` but never populated.
   `modelMessageContent` is exported, unused, *and* a no-op (`typeof x === "string" ? x : x`).
   `statusFromOutcome` is an identity passthrough.
5. **Transcript verbosity.** `model_response` events store full `text` + `responseMessages`,
   duplicating `final.md` and the trace.

## Fidelity note that unlocks the clean option

The existing `thread.jsonl` already stores only final assistant **text** (`content: res.text`), not
structured tool-call/response messages. The new ledger likewise stores text. So making the ledger
authoritative is **not** a fidelity regression versus what replays today.

## Recommended direction

- **Decision 1 — one source of truth (option C):** ledger = append-only truth; `context.json` =
  decision log; `thread.jsonl` = derived cache of *included* turns, written *through the same seam*
  as the decision. One decision point produces all three artifacts → nothing drifts, boot path
  unchanged. (Option B — reconstruct replay from ledger+context, drop `thread.jsonl` — is the
  "someday" endpoint.)
- **Decision 2 — move audit into the engine:** fold ledger + task writes into `executeRun`, guarded
  by `triggeredBy === "user"` (already distinguishes top-level user turn from delegated child).
  `App.tsx`'s duplicated blocks and the `onRunStart` audit wiring both delete; any non-Ink caller
  gets identical audit for free.
- **Small ones:** delete `modelMessageContent`; inline/delete `statusFromOutcome`. Keep full
  transcript for now; trim `model_response` if runs get long.
- **`verifiedClaims` / task-state cuts are OFF** (decided 2026-07-04): task verification is a
  real goal — **Plan 06** renames `verifiedClaims` → `verifications[]` and populates it, and
  **Plan 04** promotes `task-state.ts` from write-only audit record to a persistent task queue.
  Do not trim either.

## The convergence

One seam — `recordUserTurn(...)` at run start, `recordTurnOutcome(...)` at run end — writes ledger +
context decision + task update + the derived `thread.jsonl` line, called from `executeRun`. That
single change closes tensions #1, #2, and #3 together. Phase 5 then extends the replayed context to
carry **artifact handles** instead of payloads — the point where this meets Plan 01's hand-off work.
