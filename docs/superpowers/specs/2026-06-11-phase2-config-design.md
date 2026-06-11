# taicho v1 · Phase 2 — Config & Per-Agent Models (Design)

**Date:** 2026-06-11
**Status:** proposed (decisions resolved to roadmap recommendations; user waived the approval gate)
**Roadmap item:** #3 config. **Branch:** `phase2-config` (stacked on `phase1-safety-budgets`).

---

## 1. Goal
Let a squad **mix models** — a cheap orchestrator (`root`) with expensive specialists — via an optional `taicho.yaml`, and let that file set default models/budgets for new agents. Today every agent shares one global model built at boot; this is the single highest-leverage config feature and the architecture is right at the seam.

**Definition of done:**
1. An optional `taicho.yaml` at the workspace root is loaded at boot, zod-validated; absent or malformed → warn + use built-in defaults (boot never bricks).
2. `agents.<id>.model`/`provider` in the file makes that agent run a different model — **a delegated child can run a different model than `root`**, verified by a test.
3. `defaults.{provider,model,budgets}` apply to `root` and to newly-created agents (replacing today's hardcoded literals) and act as the fallback when an `agent.md` omits a budget field.
4. **API keys never come from the file** — providers read them from env exactly as today; the missing-key UX is unchanged.
5. Precedence is explicit: per-agent yaml > yaml `defaults` > env (`TAICHO_PROVIDER`/`TAICHO_MODEL`) > built-in default. Secrets are env-only.

## 2. Resolved decisions
| Decision | Resolution |
|---|---|
| File location / name | `taicho.yaml` at **workspace root** only (defer global `~/.taicho`). |
| Parser | `Bun.YAML.parse` (already used for `agent.md`; no new dep), then zod-validate. |
| Malformed file | `console.warn` + fall back to empty config (never throw at boot). |
| Secrets | **Env-only.** A zod schema with no `apiKey` field; if present, ignore + warn. |
| Per-agent model home | `taicho.yaml` (`agents.<id>`). `agent.md` stays provider-agnostic — no `model` field added to `AgentDef`. |
| Model threading | **Additive** `resolveModel?(agentId): { model, modelId }` on `RunDeps`; `executeRun` uses it, falling back to today's single `deps.model`. Existing 57 tests untouched. |
| Per-agent pricing | `executeRun` builds the pricer from the **resolved** model id (`pricerFor(modelId)`), so cost reflects the model that actually ran. |
| Defaults → new agents | `defaults.budgets` (and `defaults` provider/model) seed `createAgent`/`seedRoot`; fallback when `agent.md` omits a field; **never rewrite existing files**. |
| Provider enum | Keep `anthropic | openai`. |

## 3. Config schema (`store/config.ts`)
```ts
const PartialBudgets = z.object({
  maxIterationsPerRun: z.number().int().positive().optional(),
  maxWorkItemsPerRequest: z.number().int().positive().optional(),
  maxTokensPerRun: z.number().int().positive().optional(),
  maxCostPerRunUsd: z.number().positive().optional(),
}).optional();

const AgentOverride = z.object({
  provider: z.enum(["anthropic", "openai"]).optional(),
  model: z.string().optional(),
  budgets: PartialBudgets,
});

const TaichoConfig = z.object({
  defaults: z.object({
    provider: z.enum(["anthropic", "openai"]).optional(),
    model: z.string().optional(),
    budgets: PartialBudgets,
  }).optional(),
  agents: z.record(z.string(), AgentOverride).optional(),
}).default({});
```

## 4. Design

### 4.1 Config loading (`store/config.ts`)
- Add `loadConfig(ws): TaichoConfig` — read `taicho.yaml` (via `Bun.file`); absent → `{}`; parse with `Bun.YAML.parse`; `TaichoConfig.safeParse` → on failure `console.warn` + `{}`. Strips/ignores any `apiKey`-like keys (schema has none, so they're dropped).
- Keep `resolveConfig(env)` (the env key-presence + global provider/model resolver) as today — it still decides whether *any* key exists and the global default provider.

### 4.2 Model resolver (`core/model.ts`)
- Keep `buildModel({provider, model})` (rename internal to `buildModelInstance(provider, model)` if cleaner).
- Add `createModelResolver(opts: { config: TaichoConfig; fallback: ResolvedConfig })`:
  - returns `{ resolveModel(agentId: string): { model: Model; modelId: string; provider: Provider } }`.
  - resolution: `provider = config.agents[id]?.provider ?? config.defaults?.provider ?? fallback.provider`; `model = config.agents[id]?.model ?? config.defaults?.model ?? fallback.model`.
  - **instance cache** keyed `\`${provider}:${model}\`` so repeated agents reuse one model object.

### 4.3 Budget defaults (`store/roster.ts`)
- `createAgent(ws, db, draft, taughtBy, defaults?)` — when building the `AgentDef`, merge `defaults.budgets` under any draft-provided budget, over the schema defaults (precedence: draft > config defaults > schema default). Tools default stays `["write_artifact"]` unless a future field overrides.
- `seedRoot(ws, defaults?)` — same: root's budgets come from `defaults.budgets` when present.
- These are **fallbacks at creation**; existing `agent.md` files are never rewritten.

### 4.4 Run wiring (`core/run.ts`)
- `RunDeps` gains `resolveModel?: (agentId: string) => { model: Model; modelId: string }`.
- `executeRun`: `const picked = deps.resolveModel?.(opts.agent.id); const model = picked?.model ?? deps.model; const priceUsd = picked ? pricerFor(picked.modelId) : deps.priceUsd;` — pass `model` to `runLoop` and use `priceUsd`.
- `makeDeps` accepts + forwards `resolveModel`. `deps.model` stays the fallback (tests pass a single model and no resolver → unchanged behavior). `runChild` reuses `deps`, so each child resolves its own model by its own id.

### 4.5 Boot (`index.tsx`, `ui/App.tsx`)
- `index.tsx`: `const config = loadConfig(ws); const cfg = resolveConfig();` → if a key exists, build `const resolver = createModelResolver({ config, fallback: cfg });`. Pass `resolveModel={resolver.resolveModel}` into `<App>`. Seed root + reindex use `config.defaults`.
- `App.tsx`: add `resolveModel?` prop; `deps(...)` passes `resolveModel: props.resolveModel`. The single `model` prop becomes the fallback (still used when no resolver / for the key-present check).

## 5. Error handling
| Condition | Behavior |
|---|---|
| No `taicho.yaml` | Use built-in/env defaults silently. |
| Malformed yaml / schema fail | `console.warn` once; use empty config (defaults). Boot proceeds. |
| Per-agent provider with no env key | The AI SDK errors at call time → surfaces as a `failed` run (Phase 1 partial-token accounting applies). Documented; not a boot error. |
| `apiKey` in yaml | Ignored (not in schema) + warn. |

## 6. Testing (TDD, network-free)
- `loadConfig`: absent → `{}`; valid file → parsed; malformed → warns + `{}`; per-agent + defaults present.
- `createModelResolver`: per-agent override beats defaults beats fallback; instance cache returns the same object for the same provider:model; distinct ids/models return distinct `modelId`.
- `createAgent` with config defaults: a new agent's budgets reflect `defaults.budgets`; explicit draft budget still wins; existing files not rewritten.
- **Per-agent selection in `executeRun`:** a `resolveModel` returning DISTINCT `MockLanguageModelV3` instances for `root` vs a worker → assert the worker's run used the worker's model (inspect which mock's `doGenerateCalls` grew), proving a delegated child runs its own model.
- Existing 57 tests stay green (single-model path unchanged).
- App/index boot wiring: headless import smoke + manual run (no Ink test harness).

## 7. Out of scope (Phase 2)
- Global `~/.taicho/config.yaml` + workspace-over-global layering.
- A third provider; per-agent `apiKey`; hot-reload.
- Cost-$ budget *engine* (Phase 1 already enforces `maxTokensPerRun`/`maxCostPerRunUsd`; config only sets the values).
- Central org-rules ACL config (`canSee`/`canDelegateTo` stay per-`agent.md`).
- Adding `model` to `agent.md` frontmatter (kept provider-agnostic).

## 8. Build order (each its own TDD task, runnable + committed)
1. `TaichoConfig` schema + `loadConfig` + tests.
2. `createModelResolver` (per-agent resolution + cache) + tests.
3. `createAgent`/`seedRoot` config-default budgets + tests.
4. `RunDeps.resolveModel` + `executeRun` per-agent model + pricer + tests (per-agent selection test).
5. `index.tsx`/`App.tsx` boot wiring + headless smoke.
6. Full green + final review.
