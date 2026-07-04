# Reference — Context Compaction

Design detail for **Plan 05**. Phase 0 forks **closed (2026-07-04, all per recommendation)** — see §4.

---

## 1. The problem

Nothing in taicho ever makes context **smaller**. Two unbounded growth paths:

1. **Within a run** — the loop appends every model response + tool round-trip to `messages`
   (`src/core/loop.ts:175`) for up to `maxIterationsPerRun` (default 30) iterations. A
   tool-heavy run drags every earlier tool result into every later model call — pure cost and,
   eventually, a context-window overflow the loop has no answer to.
2. **Across turns** — `thread.jsonl` replays every completed turn at boot, forever. A
   long-lived deck accumulates history until the assembled prompt no longer fits; there is no
   summarization, no trimming, not even a warning.

Plan 01 Phase 5 keeps *payloads* out of context (handles, not bodies). This plan is the other
half: the coordination layer itself must stay bounded. This is the failure mode that bites
first in real use — quietly, as degrading quality and rising cost, then loudly as hard API
errors.

## 2. Current state (evidence from the code)

- **No token awareness at assembly.** `assemble` (`src/core/prompt.ts`) concatenates identity +
  roster + policies + memory digest + KB block + skills block with no size accounting. The loop
  *measures* `inputTokens` per call (`src/core/loop.ts:158`) but only for budgets — the number is
  never fed back to shrink anything.
- **In-run growth is uncapped.** `messages.push(...responseMessages)` each iteration; budget
  exhaustion (`maxTokensPerRun`) stops the run, it doesn't slim it — the run just dies as
  `[budget exhausted]`.
- **Cross-turn replay is all-or-nothing.** `thread.jsonl` stores final assistant text per
  completed turn and all of it loads at boot. The new `conversation` ledger records include/
  exclude decisions per turn but is write-only (see `context-hygiene-audit.md`).
- **A summarization precedent exists.** `recentRunsDigest` (`src/core/memory.ts`) already
  compresses recent run traces into a bounded digest block — the pattern (bounded, derived,
  injected) is exactly what compaction generalizes.

## 3. Proposed model

### 3a. Measure first (Phase 1)

Cheap token estimation (chars/4 is fine — this gates behavior, it doesn't bill) over the
assembled system prompt + messages, surfaced in three places: the trace (`contextTokens`), the
waterfall LLM-span detail (Plan 02), and a loop-level check. No estimates in the dark.

### 3b. In-run compaction (Phase 2)

When the estimated next-call size crosses a threshold (config-disposed, default ~70% of the
model's window from a per-model table):

- Fold the **oldest tool round-trips** into a single compact summary message ("iterations 1–8:
  called read_url×3 …, learned X, produced artifact Y") — keep the system prompt, the original
  user/brief message, and the most recent N iterations verbatim.
- [?] Fork: deterministic fold (truncate tool results, keep call names + key lines) vs an LLM
  summarization call (costs a call, reads better). Recommended: **deterministic first** —
  predictable, free, testable; LLM summary as a later upgrade.
- Record a `compaction` event in `transcript.jsonl` so the waterfall can show that (and what) was
  folded — compaction must never be invisible in the trace.

### 3c. Cross-turn compaction (Phase 3)

- Boot replay becomes **rolling summary + recent tail**: turns older than the tail collapse into
  a persistent conversation summary; recent K turns replay verbatim.
- Write the summary **through the same seam** as the ledger/context decision (the
  `recordTurnOutcome` seam from the context-hygiene audit) so ledger, context decision, derived
  `thread.jsonl`, and the rolling summary can't drift — this plan *depends on* Plan 01 Phase 5
  landing that seam first.
- The ledger stays append-only truth; compaction only changes what *replays*, never what is
  *recorded*.

## 4. Phase 0 decisions (closed 2026-07-04)

| # | Decision | Decided |
|---|----------|----------------|
| 1 | In-run fold: deterministic vs LLM-summarized | **Deterministic first**, LLM upgrade later. |
| 2 | Threshold source | Per-model window table + config override (`defaults.compactAt`), default ~70%. |
| 3 | Cross-turn: summarize with which model | The deck's cheap default; summary quality is not the bottleneck. |
| 4 | Token estimator | chars/4 heuristic; exact tokenizers are YAGNI for a gate. |

## 5. Explicitly out of scope / YAGNI (for now)

- Exact tokenizer integration per provider.
- Semantic retrieval over old turns ("infinite memory") — the KB already covers durable facts;
  compaction is about the *conversation*, not knowledge.
- Compacting the KB/skills/roster blocks (already bounded by their own caps).
