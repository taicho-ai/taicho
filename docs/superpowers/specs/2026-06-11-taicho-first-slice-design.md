# taicho — First Working Slice (Design)

**Status:** approved (design); pending written-spec review (waived by user — "we'll check later")
**Date:** 2026-06-11
**Scope owner:** captain (user) + Claude

---

## 1. Goal

Turn the existing skeleton (~476 LOC of well-designed but unwired modules) into something you can launch and use end-to-end — the **full captain→squad→artifact loop, plus trace inspection and mid-flight steering**. This lands 4 of the 5 control surfaces (enter-anywhere, steer-mid-flight, traces, org-rules-via-ACL). Coaching is the only surface left out.

**Definition of done:** From a cold workspace I can:
1. Launch `taicho`; a **root agent** is seeded and greets me.
2. Tell root "I need a researcher on X"; root proposes an `AgentDef`; I approve via the `ProposalCard`; the worker is persisted to `agents/<id>/agent.md` and is immediately live.
3. Task the worker — either `@worker <goal>` directly, or let root `delegate_task` to it. The worker runs the agent loop against a **real model**, calls a real tool (`write_artifact`), and produces an **immutable artifact**.
4. A **run trace** is written to `runs/<agent>/...` and is inspectable via `/runs` and `/trace`.
5. While a run is in flight, I can type a message that reaches the agent as an **out-of-band steer** without killing the run.

## 2. Non-goals (this slice)

- **Coaching** (durable, conditional, approval-gated policy) — 5th surface, larger; the `propose_coaching` seam is left in place but not wired.
- `config.yaml` loader — env-var keys only for now.
- `sqlite-vec` — brute-force cosine is sufficient at this scale.
- Per-agent provider mixing, exemplar promotion, budget-spend accounting beyond token counts.
- `@`-autocomplete / fuzzy picker UX — exact `@id` is enough for the slice.

**Deferred, tracked after Task-9 review (follow-up slice):**
- **Delegation depth/cycle guard.** `delegate_task → runChild → executeRun` is recursive with no depth or cycle bound (TODO in `run.ts`). A pathological agent could delegate indefinitely. Real models + approval-gating make this non-exploitable today; harden before autonomous fan-out.
- **`nextRunId` concurrency.** Read-then-write `max+1`; safe while delegates are serial/awaited, but two overlapping runs for the same agent/day could collide. Needs reservation (or a unique suffix) before concurrent runs land.
- **Approval `edit` path.** `ProposalCard` offers `[e]dit`, but the slice treats edit as reject (no edit-then-resubmit loop yet).

## 3. Core principles (carried from the skeleton's design comments)

- **Files are canon; the DB is a cache.** Deleting `taicho.db` and re-indexing must always reproduce state. (`store/db.ts`, `store/files.ts`)
- **Roster is unbounded and runtime-dynamic.** 1 or 10,000 agents; each created agent is live immediately, no restart. See §5.
- **Discovery is retrieval, not enumeration.** No design path stuffs the whole roster into a prompt. See §5.
- **The one interaction grammar is propose→approve.** Roster growth and (later) coaching never happen autonomously; they surface as `ProposalCard`s the captain approves. (`ui/ProposalCard.tsx`, `core/registry.ts`)
- **Prompt assembly is dumb and deterministic; intelligence lives upstream in retrieval.** (`core/prompt.ts`)
- **Model proposes (what); config disposes (how much).** Budgets come from `AgentDef`/config; model-supplied budget params are ignored. (`core/loop.ts`)

## 4. Root agent model

Root is a **seeded LLM orchestrator**:

- **Auto-created at workspace init** (idempotent): if `agents/root/agent.md` is absent, `ensureWorkspace` writes a seeded `AgentDef` with `isRoot: true`, `canSee: ["*"]`, `canDelegateTo: ["*"]`, and a built-in orchestrator identity.
- It **interviews** the captain, **proposes workers** (`create_agent`), **delegates** (`delegate_task`), and routes — but does **not** do domain work itself.
- It is the **default addressee**: a bare message goes to root; `@id` addresses a specific agent.
- "Squad is empty" means *no worker agents yet* — root always exists.

## 5. Dynamic roster & scale (the load-bearing section)

The roster is files on disk, indexed by the DB, discovered by search. Nothing caps its size.

| Concern | Design |
|---|---|
| **Boot cost** | One `SELECT id, role, is_root FROM registry`. **Not** N markdown reads. Flat regardless of roster size. |
| **Identity (SOUL) load** | Lazy: an agent's full `agent.md` is read+parsed only when that agent is about to run. |
| **Discovery** | `prompt.assemble` injects the visible roster inline **only when small (≤ `INLINE_ROSTER_MAX`, default 30)**. Above that, the agent gets a **`find_agents(query, k)`** tool: keyword scoring (token overlap) over the registry → top-k `{id, role}`. (Semantic embeddings via `store/vectors.ts` are a deferred upgrade.) |
| **Creation** | `create_agent` = write one `agent.md` + insert one `registry` row, in-process. O(1); immediately discoverable + addressable. |
| **Visibility ACL** | `registry.visibleTo` / `canDelegate` still enforce org rules; at scale they filter the *search candidate set*, not an inline dump. |
| **Embedding scale** | Brute-force cosine over ~10k role vectors is low-ms. `sqlite-vec` is the later swap (already noted in `vectors.ts`). |
| **Addressing UX** | Exact `@id` for the slice; fuzzy autocomplete is a later nice-to-have. |

## 6. Architecture — modules

**New modules (each one job, independently testable):**

| Module | Responsibility | Depends on |
|---|---|---|
| `store/config.ts` | Resolve provider/model/key — env-first (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`); `config.yaml` deferred | — |
| `core/model.ts` | provider+model → AI-SDK model instance | config |
| `store/roster.ts` | Index load (registry), **lazy** per-agent `agent.md` parse (frontmatter→`AgentDef` + body→identity) + zod validate, **seed root if absent**, save on create, embed role | schemas, files, vectors |
| `core/tools.ts` | Per-agent toolset: root→`create_agent`+`delegate_task`+`find_agents`; worker→`write_artifact`(+`find_agents` when roster large) | schemas, files |
| `core/run.ts` | Orchestrate one run: `assemble` prompt → build tools → `runLoop` → steer injection → write artifacts + trace | prompt, loop, tools, trace |
| `store/trace.ts` | Write/read `runs/<agent>/<date>-run<n>.json` per `RunTrace` | schemas, files |

**Changes to existing files:**

- `core/loop.ts` — add `pollSteer?: () => string | null`; between iterations, if a steer is queued, append `steerMarker(text)` to the last tool result message before the next `generateText`. (Markers already defined in `prompt.ts`.)
- `core/prompt.ts` — `assemble` takes the full visible set but inlines it only under `INLINE_ROSTER_MAX`; otherwise emits a "use find_agents" note instead of the list.
- `ui/App.tsx` — real routing (bare→root, `@id`→direct), slash commands (`/runs [agent]`, `/trace <id>`), in-flight **steer-input mode**, render streamed run steps + `ProposalCard` for `create_agent`.
- `index.tsx` — real boot: `ensureWorkspace`(+seed root) → load registry index → build model → render `App`.
- `schemas/agent.ts` — `vectors.ts` gains `kind:'agent'` usage (no schema change; embeddings table already generic).

## 7. Data flow

1. **Boot:** `ensureWorkspace` (creates dirs + seeds `agents/root/agent.md` if absent) → `openDb` → load registry index → sync any new on-disk agents into registry + embeddings → build model from config → render `App` with `hasApiKey` + roster summary.
2. **Bare message → root chat:** assemble root's prompt (no brief; roster inline-or-search) → `runLoop` with tools `[create_agent, delegate_task, find_agents]`, streamed to transcript.
   - `create_agent(draft)` → emit `ProposalCard`; on **approve**, `roster.save` writes `agent.md` + registry row + role vector, returns the new id as the tool result so root can continue (e.g. delegate to it). On **reject/edit**, that decision is the tool result.
   - `delegate_task(to, goal, context?)` → spawn a **worker run** (step 4) with a `Brief{from: root, ...}`; its result returns as root's tool result.
3. **`@worker message`:** start a worker run directly with `Brief{from: "user", goal}`.
4. **Worker run:** assemble worker prompt (identity + brief + policies[empty] + roster) → `runLoop` with `[write_artifact (+find_agents)]` → tool calls execute (`write_artifact` → `artifactPath`, immutable, new file per run) → on completion write `RunTrace` (toolCalls, artifacts, tokens, outcome, started, durationMs; `ledger` arrays empty this slice) → stream result to transcript.
5. **Mid-flight steering:** while a run loops, captain keystrokes go to a **steer queue** (not a new submit); `pollSteer` drains it and injects a `steerMarker` on the next iteration.
6. **Inspection:** `/runs [agent]` lists trace files; `/trace <id>` renders one (task, tools, artifacts, tokens, outcome).

## 8. Component contracts (interfaces)

- `config.resolve(): { provider, model, apiKey } | { missing: true }`
- `model.build(cfg): LanguageModel` (AI-SDK v6 model instance for `generateText`).
- `roster.loadIndex(db): RegistryRow[]` · `roster.loadAgent(ws, id): AgentDef` (lazy, validated) · `roster.seedRoot(ws): void` (idempotent) · `roster.create(ws, db, draft, taughtBy): AgentDef` (writes file + registry + vector).
- `tools.forAgent(agent, ctx): ToolSet` — returns only the tools that agent's role/`isRoot` permits.
- `run.execute({ agent, brief?, model, db, ws, onStep, pollSteer }): RunResult` — returns `{ text, trace }`; always writes a trace, even on failure.
- `trace.write(ws, RunTrace): string` (returns path) · `trace.list(ws, agent?): RunTraceMeta[]` · `trace.read(ws, id): RunTrace`.
- `loop.runLoop(...)` — unchanged signature except new optional `pollSteer`.

## 9. Error handling

| Condition | Behavior |
|---|---|
| No API key | Existing deterministic message; **no tokens burned**. |
| Model/network error | Surface in transcript; trace `outcome:"failed"`; run ends cleanly. |
| Budget exhausted | `runLoop` returns `[budget exhausted]`; trace `outcome:"blocked"`. |
| Invalid/corrupt `agent.md` | Skip that agent + warn; never crash boot. |
| `@unknown-id` | Friendly "no such agent — try /agents or describe one to root". |
| Steer while no run active | Treated as a normal submit. |

## 10. Testing strategy (TDD, `bun test`)

- **Pure units (no network):** `prompt.assemble` (inline vs find_agents threshold), `registry.visibleTo`/`canDelegate`, roster frontmatter parse + zod validate (incl. malformed → skip), `trace` round-trip, steer-injection ordering, `vectors.topK` ranking.
- **Loop/run with injected fake model:** `runLoop` already takes `model` as a param → inject `MockLanguageModelV3` from `ai/test` with `mockValues(...)` scripting "tool-call → text" (verified: the v6 mock is V3, not V2; `finishReason` is `{unified,raw}`, `usage` is nested, tool-call `input` is stringified JSON). Integration test drives boot→`create_agent`→approve→`delegate`→worker run→`write_artifact`→trace with **zero network**.
- **Steering test:** fake model emits a tool call; test enqueues a steer; assert the next prompt contains the `STEER_OPEN…STEER_CLOSE` marker.

## 11. Assumptions / decisions (revisit at review)

1. Default model **Anthropic `claude-sonnet-4-6`** (per-agent override allowed); key via env this slice.
2. `agent.md` = **YAML frontmatter (natural nested shape, incl. `budgets`) + markdown body (identity)**; parsed by **`Bun.YAML.parse`** (native, dependency-free — verified present), then zod-validated. No hand-rolled reader, no flattening.
3. **Coaching deferred**; `propose_coaching` seam preserved.
4. `INLINE_ROSTER_MAX = 30` — the threshold between inline roster injection and `find_agents` search.
5. **`find_agents` is keyword search** over the registry for this slice (deterministic, network-free, scales via one SQL scan). Semantic embeddings (`vectors.ts`) are deferred — wiring them would force an OpenAI key purely for embeddings.

## 12. Build sequence (vertical, thin→thick — each step runnable)

1. **Boot + config + model** — launch, resolve key, build model; root seeded; registry index loads.
2. **Root chat** — bare message runs root's loop against the real model; replies stream.
3. **create_agent → ProposalCard → persist** — propose/approve writes a live worker (file + registry + vector).
4. **Worker run + write_artifact + trace** — `@worker`/`delegate_task` runs the loop, produces an artifact, writes a trace.
5. **find_agents discovery** — search tool + role embeddings; assemble switches to search above the threshold.
6. **Inspection** — `/runs`, `/trace`.
7. **Mid-flight steering** — steer queue + `pollSteer` injection.

Each step ships with its tests before the next begins.
