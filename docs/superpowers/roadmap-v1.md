# taicho — v1 Roadmap

**Date:** 2026-06-11
**Status:** HISTORICAL (2026-07-13) — essentially built. Plans 01–19 absorbed items #1–#7
(safety, budgets, config, persistence, coaching, ux, semantic retrieval) and went far beyond.
Still open from this list: **#8 exemplars** (schema remains unwired scaffolding) and
**#9 distribution** (no CI/release pipeline, no `--version`, no published assets). No
forward-looking roadmap has superseded this document yet.

**Original status:** proposed (grounded in a per-item scan of the then-current `main`)
**Premise:** v1 = the README's **five control surfaces** working end-to-end + **installable** + **safe to run autonomously**. The first slice shipped 4 of the 5 surfaces' runtime spine; this roadmap is what remains.

Each work-item below was scoped against the actual code (built vs scaffolded-but-inert vs absent). Sizes: small / medium / large. The v1 line and build order follow.

---

## Where we are (Phase 0 — done)
Runtime spine on `main`, 38 tests: seeded root orchestrator → propose/approve/create workers → manual `generateText` loop with `execute`-bearing tools → immutable artifacts + JSON run traces → `@agent` routing, mid-flight steering, `/runs` `/trace`, enforced ACLs, unbounded roster (registry index + lazy load + keyword `find_agents`). **Coaching (5th surface) and the whole embeddings/exemplar/budget-enforcement layer are scaffolded but inert.**

---

## The nine pending work-items

| # | Item | Size | Rec. | One-line gap |
|---|------|------|------|--------------|
| 1 | **safety-robustness** | M | v1-core | No delegation depth/cycle guard, no cancel/interrupt, failed runs record `tokens:0`, child failure can kill parent. |
| 2 | **budgets-spend** | M | v1-core | Only iteration count is capped; tokens are *counted* never *capped*; `maxWorkItemsPerRequest` is a declared-but-unenforced lie; no cost ($) or aggregate roll-up. |
| 3 | **config** | M | v1-core | Env-only, one global model for *every* agent. Per-agent model override is the high-leverage unlock (cheap root + expensive specialist). |
| 4 | **persistence-state** | M | v1-core | Quitting wipes the entire root conversation (in-memory `useRef`); workers are amnesiac. Contradicts "enter anywhere, any time." |
| 5 | **coaching** | L | v1-core* | The 5th control surface. All pieces exist (PolicyNote, prompt block, ProposalCard, recall modules) but **nothing is wired**: `run.ts` passes `policies:[]`, no persistence, no `/teach`, no `propose_coaching`. |
| 6 | **ux-polish** | M | split | `[e]dit` is advertised on the card but silently == reject; index-keyed lines (no scrollback); no `@`-autocomplete; `runSlash` inline+untested; no `/help` or input history. |
| 7 | **semantic-retrieval** | M | v1-stretch | `vectors.ts` is built but has **zero callers**; no `embed()` exists; the default provider (Anthropic) has **no embedding model**. Powers *semantic* recall for coaching/exemplars/find_agents. |
| 8 | **exemplars** | L | post-v1 | Promote an approved artifact → reusable exemplar (serve/imitate). Schema only; mostly greenfield; reuses coaching's seams. Not one of the README's 5 surfaces. |
| 9 | **distribution** | M | v1-core | `install.sh` curls GitHub Release assets that don't exist; no CI/release matrix, no `--version`, no `taicho.ai` host, no org/repo/remote. The gate to "a stranger can install it." |

\* coaching is the largest item and was deliberately deferred from slice 1, but it **is** the 5th surface — so it's v1-core in a **condition-only** cut (recall by rendering approved notes + LLM condition-check, *no embeddings*), with the semantic upgrade deferred to #7.

---

## Cross-cutting decisions to make at slice-start (these gate multiple items)
1. **Embedder provider** (gates #7, and the *semantic* quality of #5/#8/find_agents): local zero-key embedder (e.g. fastembed/transformers.js — adds binary size) vs require `OPENAI_API_KEY` for embeddings vs keyword-only baseline. The default provider (Anthropic) offers no embeddings, so **a keyword fallback is mandatory regardless.** This is why coaching ships condition-only first.
2. **Per-agent model home** (gates #3): `taicho.yaml` `agents.<id>.model` (captain-owned, central) vs `model:` in `agent.md` frontmatter (travels with the agent). Pick one canonical home + precedence. Recommend config.yaml; keep `agent.md` provider-agnostic.
3. **"Work item" definition** (gates #2): recommend = `delegate_task` fan-out count per run (uses existing `delegatedOut`/`counts`).
4. **Cancel semantics** (gates #1): ESC-while-busy vs Ctrl-C; and whether a user-cancel reuses the existing `interrupted` outcome or adds a `cancelled` enum value.

---

## Build order (respects hard deps; front-loads enablers)

### Phase 1 — Harden the core for autonomy
*Everything else builds on `run.ts`/`loop.ts`/`tools.ts`; make them safe and truthful first.*
- **#1 safety-robustness** — thread `depth`/`ancestry`/`AbortSignal`/run-counter through `executeRun`; depth+cycle guard returns recoverable `{error}`; UI cancel key; surface partial tokens on the error path; wrap `runChild` so a child failure degrades to a tool-result. *(The two true autonomy blockers: depth/cycle guard + cancel.)*
- **#2 budgets-spend** — `maxTokensPerRun`/`maxCostPerRun` enforced mid-loop (reuse the `exhausted→blocked` path); input/output token split + a per-model pricing table → `costUsd` in the trace; enforce `maxWorkItemsPerRequest`; aggregate child spend into the parent tree (lands *with* the depth guard — together they bound runaway cost).

### Phase 2 — Per-agent models
- **#3 config** — `taicho.yaml` loader (`Bun.YAML`, no new dep), zod-validated, env wins for secrets; turn the single boot `Model` into `modelFor(agentDef)` threaded through `executeRun`/`runChild` (cache by provider+model); config-driven default budgets/ACLs seed new agents. Do after Phase 1 stabilizes the run path it threads through.

### Phase 3 — The 5th surface
- **#6a ux-polish (cheap half)** — widen `ApprovalDecision` to carry an edited draft + a **generic** ProposalCard edit form; extract `runSlash`→`src/ui/slash.ts` (tested); add `/help`. Generic edit form so coaching/exemplars reuse it (no later rewrite).
- **#4 persistence-state (tight cut)** — persist+reload the root thread (`agents/root/thread.jsonl`, bounded, only completed turns); feed workers a deterministic "recent runs" digest from `listTraces`. Establishes the durable-state conventions coaching rides on. *(No per-worker threads, no scratchpad — those are post-v1.)*
- **#5 coaching (condition-only)** — `store/policy.ts` (write/read/list notes, mirrors `store/trace.ts`); `propose_coaching` via a new `ApprovalRequest` variant + a `/teach <agent>` entry (LLM turns a correction into a `{when,do,scope}` draft); `findContradiction` supersede on approve; recall = load approved notes → LLM condition-check → feed `assemble`'s `policies[]` (already renders); populate the trace ledger (`retrieved/applied/skipped`). Delivers the headline "corrections become durable policy."

### Phase 4 — Recall quality (stretch)
- **#7 semantic-retrieval** — embedder factory over AI-SDK `embedMany` + independent embedding-config + **graceful keyword fallback** + dimension-mismatch guard; write vectors at policy/agent create-points; upgrade coaching recall + `find_agents` from keyword→semantic. Gated on decision #1.

### Phase 5 — Ship it
- **#9 distribution** — create `taicho-ai/taicho` + remote; tag-driven GitHub Actions release; Bun cross-compiles all 4 targets from one Linux runner (no native addons), assets named `taicho-<os>-<arch>` to match `install.sh`; inject tag as `--version` (the one src change); SHA256SUMS; host `taicho.ai/install.sh` (a redirect suffices). Defer notarization/musl/npm/Homebrew.
- **#6b ux-polish (rest)** — `<Static>` scrollback + stable line keys + trim; fuzzy `@`-autocomplete (reuse `rankAgents`); input history. Daily-driver finish.

### Post-v1 (explicitly out)
**#8 exemplars** (full serve/imitate + recall — thin layer on coaching's seams, but greenfield and not a README surface); durable org-wide/lifetime budgets; mid-run coaching; `team` scope; sqlite-vec; macOS signing/notarization; npm/Homebrew; per-worker conversation threads; agent-writable scratchpad.

---

## Definition of "v1 done"
1. **All five control surfaces work**, coaching included (condition-only recall is acceptable).
2. **Safe to run autonomously** — delegation can't cycle/run away; the captain can always cancel; cost is recorded truthfully and capped.
3. **Per-agent models** — a squad can mix a cheap orchestrator with expensive specialists.
4. **Continuity** — relaunching resumes the conversation; agents aren't amnesiac.
5. **Installable** — `curl -fsSL https://taicho.ai/install.sh | bash` yields a working binary that reports `--version`.
6. The REPL is a **credible daily driver** — you can edit a proposal, scroll history, and get help.

**Rough sequencing estimate:** Phase 1 → 2 are the foundation (correctness/safety), Phase 3 is the biggest single push (coaching + its UX/persistence prerequisites), Phase 4 is an optional quality bump, Phase 5 ships. Each item is its own spec→plan→build cycle in the same style as the first slice.
