# Phase 2 — Config & Per-Agent Models Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional `taicho.yaml` (workspace root) that sets default and per-agent provider/model/budgets, so a squad can mix a cheap orchestrator with expensive specialists; secrets stay env-only.

**Architecture:** A new `loadConfig(ws)` parses+validates `taicho.yaml` (Bun.YAML+zod; malformed→warn+defaults). `createModelResolver({config, fallback})` turns the single boot model into a cached per-agent `resolveModel(agentId)→{model, modelId}`. `RunDeps` gains an **additive** `resolveModel?` (falls back to today's single `model`, so existing tests are untouched); `executeRun` resolves each agent's model + builds a per-agent pricer. Config `defaults.budgets` seed `seedRoot`/`createAgent`.

**Tech Stack:** Bun + TypeScript, `Bun.YAML`, zod v4, `@ai-sdk/anthropic`/`@ai-sdk/openai`, `bun test`.

## File structure
- **Modify** `src/store/config.ts` — `TaichoConfig` schema + `loadConfig(ws)`.
- **Modify** `src/core/model.ts` — `createModelResolver` + cache.
- **Modify** `src/store/roster.ts` — `createAgent`/`seedRoot` accept config `defaults`.
- **Modify** `src/core/run.ts` — `RunDeps.resolveModel`/`configDefaults`; `executeRun` per-agent model + pricer.
- **Modify** `src/index.tsx`, `src/ui/App.tsx` — boot wiring.
- Tests co-located.

## Verified facts
- `Bun.YAML.parse(str)` exists (used in `roster.ts`); `Bun.file(p).exists()/.text()` for reads.
- Current `config.ts` exports `Provider`, `ResolvedConfig`, `MissingConfig`, `resolveConfig(env)`, `isMissing(c)`, and a private `DEFAULT_MODEL`.
- Current `model.ts`: `export type Model = Parameters<typeof generateText>[0]["model"]; export function buildModel(cfg: ResolvedConfig): Model`.
- Current `roster.ts createAgent(ws, db, draft, _taughtBy)` builds `AgentDef.parse({... budgets: <unset> ...})` (schema defaults apply); `seedRoot(ws)` builds root similarly.
- Current `run.ts`: `RunDeps` has `model: Model`, `priceUsd?`, `signal?`, `runCounter?`, `onStep?`, `pollSteer?`, `requestApproval`. `executeRun` calls `runLoop({ model: deps.model, ..., priceUsd: deps.priceUsd })`. `ctx.createAgent = (draft) => createAgent(deps.ws, deps.db, draft, opts.agent.id)`. `pricerFor` is exported from `./pricing`.
- MockLanguageModelV3 records calls in `model.doGenerateCalls` (cast `(m as any).doGenerateCalls.length`).

---

## Task 0: Baseline (branch already created)

- [ ] **Step 1:** Confirm on branch `phase2-config` (stacked on `phase1-safety-budgets`) and baseline green.
Run: `git branch --show-current` (→ `phase2-config`); `bun test && bunx tsc --noEmit` → 57 pass, clean.

---

## Task 1: TaichoConfig schema + loadConfig

**Files:** Modify `src/store/config.ts`; Test `src/store/config.test.ts` (extend)

- [ ] **Step 1: Append failing tests** to `src/store/config.test.ts`:
```ts
import { loadConfig } from "./config";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("loadConfig returns empty config when no file exists", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-cfg-"));
  const c = await loadConfig(ws);
  expect(c.defaults).toBeUndefined();
  expect(c.agents).toBeUndefined();
});

test("loadConfig parses defaults and per-agent overrides", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-cfg-"));
  writeFileSync(join(ws, "taicho.yaml"),
    "defaults:\n  model: claude-opus-4-8\nagents:\n  writer:\n    provider: openai\n    model: gpt-5.5\n");
  const c = await loadConfig(ws);
  expect(c.defaults?.model).toBe("claude-opus-4-8");
  expect(c.agents?.writer?.provider).toBe("openai");
  expect(c.agents?.writer?.model).toBe("gpt-5.5");
});

test("loadConfig warns and falls back to empty on malformed yaml", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-cfg-"));
  writeFileSync(join(ws, "taicho.yaml"), "defaults:\n  provider: not-a-provider\n");
  const c = await loadConfig(ws); // invalid enum -> safeParse fails -> {}
  expect(c.defaults).toBeUndefined();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test src/store/config.test.ts`
Expected: FAIL — `loadConfig` not exported.

- [ ] **Step 3: Implement** — add to the TOP of `src/store/config.ts` (after the existing imports add the zod/bun/path imports if missing):
```ts
import { z } from "zod";
import { YAML } from "bun";
import { join } from "node:path";

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

export const TaichoConfig = z.object({
  defaults: z.object({
    provider: z.enum(["anthropic", "openai"]).optional(),
    model: z.string().optional(),
    budgets: PartialBudgets,
  }).optional(),
  agents: z.record(z.string(), AgentOverride).optional(),
}).default({});
export type TaichoConfig = z.infer<typeof TaichoConfig>;

export async function loadConfig(ws: string): Promise<TaichoConfig> {
  const file = join(ws, "taicho.yaml");
  if (!(await Bun.file(file).exists())) return TaichoConfig.parse({});
  let raw: unknown;
  try {
    raw = YAML.parse(await Bun.file(file).text());
  } catch (e) {
    console.warn(`taicho: failed to parse taicho.yaml — using defaults (${e instanceof Error ? e.message : String(e)})`);
    return TaichoConfig.parse({});
  }
  const result = TaichoConfig.safeParse(raw);
  if (!result.success) {
    console.warn("taicho: invalid taicho.yaml — using defaults");
    return TaichoConfig.parse({});
  }
  return result.data;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test src/store/config.test.ts`
Expected: PASS (existing 4 + 3 new = 7).

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` → clean.
```bash
git add src/store/config.ts src/store/config.test.ts
git commit -m "feat(config): taicho.yaml loader (Bun.YAML + zod, malformed -> warn + defaults)"
```

---

## Task 2: Per-agent model resolver

**Files:** Modify `src/core/model.ts`; Test `src/core/model.test.ts` (extend)

- [ ] **Step 1: Append failing tests** to `src/core/model.test.ts`:
```ts
import { createModelResolver } from "./model";
import { TaichoConfig } from "../store/config";

test("resolveModel: per-agent override beats defaults beats fallback", () => {
  const config = TaichoConfig.parse({ defaults: { model: "claude-opus-4-8" }, agents: { writer: { provider: "openai", model: "gpt-5.5" } } });
  const { resolveModel } = createModelResolver({ config, fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } });
  expect(resolveModel("writer").modelId).toBe("gpt-5.5");
  expect(resolveModel("writer").provider).toBe("openai");
  expect(resolveModel("other").modelId).toBe("claude-opus-4-8"); // defaults
});

test("resolveModel: falls back when config is empty", () => {
  const { resolveModel } = createModelResolver({ config: TaichoConfig.parse({}), fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } });
  expect(resolveModel("x").modelId).toBe("claude-sonnet-4-6");
});

test("resolveModel caches one instance per provider:model", () => {
  const { resolveModel } = createModelResolver({ config: TaichoConfig.parse({}), fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } });
  expect(resolveModel("a").model).toBe(resolveModel("b").model); // same provider:model -> same cached instance
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test src/core/model.test.ts`
Expected: FAIL — `createModelResolver` not exported.

- [ ] **Step 3: Implement** — append to `src/core/model.ts` (and add the `Provider`/`TaichoConfig` type imports):
```ts
import type { Provider, TaichoConfig } from "../store/config";

export interface ResolvedModel { model: Model; modelId: string; provider: Provider; }

export function createModelResolver(opts: { config: TaichoConfig; fallback: ResolvedConfig }): {
  resolveModel: (agentId: string) => ResolvedModel;
} {
  const cache = new Map<string, Model>();
  const resolveModel = (agentId: string): ResolvedModel => {
    const a = opts.config.agents?.[agentId];
    const provider: Provider = a?.provider ?? opts.config.defaults?.provider ?? opts.fallback.provider;
    const model = a?.model ?? opts.config.defaults?.model ?? opts.fallback.model;
    const key = `${provider}:${model}`;
    let inst = cache.get(key);
    if (!inst) { inst = provider === "anthropic" ? anthropic(model) : openai(model); cache.set(key, inst); }
    return { model: inst, modelId: model, provider };
  };
  return { resolveModel };
}
```
(`ResolvedConfig` is already imported via the existing `import type { ResolvedConfig } from "../store/config";` — if it is currently imported as part of `buildModel`'s signature, keep it; otherwise add it to the type import.)

- [ ] **Step 4: Run — verify pass**

Run: `bun test src/core/model.test.ts`
Expected: PASS (existing 2 + 3 new = 5).

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` → clean.
```bash
git add src/core/model.ts src/core/model.test.ts
git commit -m "feat(model): per-agent model resolver with provider:model instance cache"
```

---

## Task 3: Config-default budgets for new agents

**Files:** Modify `src/store/roster.ts`; Test `src/store/roster.test.ts` (extend)

- [ ] **Step 1: Append failing test** to `src/store/roster.test.ts`:
```ts
test("createAgent applies config default budgets, schema fills the rest", async () => {
  const { ws, db } = await freshWs();
  await reindex(ws, db);
  const a = await createAgent(ws, db, { id: "w", role: "writes", identity: "x" }, "root", { budgets: { maxTokensPerRun: 500 } });
  expect(a.budgets.maxTokensPerRun).toBe(500);
  expect(a.budgets.maxIterationsPerRun).toBe(30); // schema default still applies
});
```
(`freshWs` already exists in this test file.)

- [ ] **Step 2: Run — verify fail**

Run: `bun test src/store/roster.test.ts`
Expected: FAIL — `createAgent` takes 4 args / `budgets` not applied.

- [ ] **Step 3: Implement** — modify `src/store/roster.ts`:
First add a type import: `import type { TaichoConfig } from "./config";`
(a) Add an optional 5th param to `createAgent` and pass budgets into the parse. Change the signature `export async function createAgent(ws: string, db: Database, draft: NewAgentDraft, _taughtBy: string)` to:
```ts
export async function createAgent(ws: string, db: Database, draft: NewAgentDraft, _taughtBy: string, defaults?: TaichoConfig["defaults"]): Promise<AgentDef> {
```
and in the `AgentDef.parse({...})` call add `budgets: defaults?.budgets,` (zod fills any unset fields with their schema defaults; `undefined` → all schema defaults; the partial-budgets shape is valid zod input).
(b) Add the same optional `defaults` to `seedRoot`: change `export async function seedRoot(ws: string)` to `export async function seedRoot(ws: string, defaults?: TaichoConfig["defaults"])` and add `budgets: defaults?.budgets,` to root's `AgentDef.parse({...})`.

- [ ] **Step 4: Run — verify pass**

Run: `bun test src/store/roster.test.ts`
Expected: PASS (existing 6 + 1 new = 7).

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` → clean.
```bash
git add src/store/roster.ts src/store/roster.test.ts
git commit -m "feat(roster): seed root + new agents from config default budgets"
```

---

## Task 4: Per-agent model + pricer in executeRun

**Files:** Modify `src/core/run.ts`; Test `src/core/run.test.ts` (extend)

- [ ] **Step 1: Append failing test** to `src/core/run.test.ts`:
```ts
test("a per-agent resolveModel makes an agent run its own model", async () => {
  const { ws, db } = await boot();
  await createAgent(ws, db, { id: "writer", role: "writes", identity: "You write." }, "root");
  const writerModel = new MockLanguageModelV3({ doGenerate: (async () => text("writer ran")) as any });
  const otherModel = new MockLanguageModelV3({ doGenerate: (async () => text("other ran")) as any });
  const deps = makeDeps({ ws, db, model: otherModel,
    resolveModel: (id: string) => id === "writer" ? { model: writerModel, modelId: "writer-model" } : { model: otherModel, modelId: "other-model" },
  });
  const writer = await loadAgent(ws, "writer");
  const res = await executeRun(deps, { agent: writer, messages: [{ role: "user", content: "x" }], triggeredBy: "user" });
  expect(res.text).toBe("writer ran");
  expect((writerModel as any).doGenerateCalls.length).toBe(1);
  expect((otherModel as any).doGenerateCalls.length).toBe(0);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test src/core/run.test.ts`
Expected: FAIL — `makeDeps` rejects `resolveModel`.

- [ ] **Step 3: Implement** — modify `src/core/run.ts`:
(a) Add imports at the top: `import { pricerFor } from "./pricing";` and `import type { TaichoConfig } from "../store/config";`
(b) Add to the `RunDeps` interface:
```ts
  resolveModel?: (agentId: string) => { model: Model; modelId: string };
  configDefaults?: TaichoConfig["defaults"];
```
(c) In `makeDeps`'s opts type add `resolveModel?: RunDeps["resolveModel"]; configDefaults?: RunDeps["configDefaults"];` and include `resolveModel: opts.resolveModel, configDefaults: opts.configDefaults,` in the returned object.
(d) In `executeRun`, just before the `runLoop` call, resolve the per-agent model + pricer:
```ts
  const picked = deps.resolveModel?.(opts.agent.id);
  const model = picked?.model ?? deps.model;
  const priceUsd = picked ? pricerFor(picked.modelId) : deps.priceUsd;
```
and change the `runLoop({ model: deps.model, ..., priceUsd: deps.priceUsd })` call to use the locals: `model,` (instead of `model: deps.model`) and `priceUsd,` (instead of `priceUsd: deps.priceUsd`).
(e) Update `ctx.createAgent` to pass config defaults: change `createAgent: (draft) => createAgent(deps.ws, deps.db, draft, opts.agent.id),` to `createAgent: (draft) => createAgent(deps.ws, deps.db, draft, opts.agent.id, deps.configDefaults),`.

- [ ] **Step 4: Run — verify pass**

Run: `bun test src/core/run.test.ts`
Expected: PASS (all existing run tests + 1 new). Existing tests pass a single `model` and no `resolveModel`, so they take the fallback path unchanged.

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` → clean. Run `bun test` → all green.
```bash
git add src/core/run.ts src/core/run.test.ts
git commit -m "feat(run): per-agent model selection + per-agent pricer via resolveModel"
```

---

## Task 5: Boot wiring

**Files:** Modify `src/index.tsx`, `src/ui/App.tsx` (manual smoke — no Ink test harness)

- [ ] **Step 1: Rewrite `src/index.tsx`** (load config first; seed root + resolver from it):
```tsx
#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./ui/App";
import { ensureWorkspace } from "./store/files";
import { openDb } from "./store/db";
import { seedRoot, reindex, loadIndex } from "./store/roster";
import { resolveConfig, isMissing, loadConfig } from "./store/config";
import { buildModel, createModelResolver } from "./core/model";
import { pricerFor } from "./core/pricing";

const ws = process.cwd();
const config = await loadConfig(ws);
await ensureWorkspace(ws);
await seedRoot(ws, config.defaults);
const db = openDb(ws);
if (loadIndex(db).length === 0) await reindex(ws, db);

const cfg = resolveConfig();
const model = isMissing(cfg) ? null : buildModel(cfg);
const resolveModel = isMissing(cfg) ? undefined : createModelResolver({ config, fallback: cfg }).resolveModel;
const roster = loadIndex(db);

render(
  <App
    ws={ws} db={db} model={model} resolveModel={resolveModel}
    configDefaults={config.defaults} roster={roster}
    cfg={isMissing(cfg) ? null : cfg}
    priceUsd={isMissing(cfg) ? undefined : pricerFor(cfg.model)}
  />,
);
```

- [ ] **Step 2: Wire `src/ui/App.tsx`**
(a) Add a type import `import type { TaichoConfig } from "../store/config";` and add to the App props type:
```ts
  resolveModel?: (agentId: string) => { model: Model; modelId: string };
  configDefaults?: TaichoConfig["defaults"];
```
(b) In the `deps` factory's `makeDeps({...})` call, add `resolveModel: props.resolveModel, configDefaults: props.configDefaults,`.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit` → clean. (Import `Model` type in App if not already: it is imported from `../core/run`.)

- [ ] **Step 4: Full suite (regression)**

Run: `bun test` → all green.

- [ ] **Step 5: Headless smoke**

Run: `bun -e 'const m = await import("./src/ui/App.tsx"); console.log("App ok:", typeof m.App === "function");'`
Expected: `App ok: true`.

Also smoke the config path headlessly:
```
bun -e 'import { loadConfig } from "./src/store/config.ts"; import { createModelResolver } from "./src/core/model.ts"; const c = await loadConfig(process.cwd()); const r = createModelResolver({ config: c, fallback: { provider: "anthropic", model: "claude-sonnet-4-6" } }); console.log("root ->", r.resolveModel("root").modelId);'
```
Expected: prints a model id (no crash).

- [ ] **Step 6: Commit**

```bash
git add src/index.tsx src/ui/App.tsx
git commit -m "feat(ui): boot loads taicho.yaml, wires per-agent model resolver + config defaults"
```

---

## Task 6: Full green + final review

- [ ] **Step 1:** `bun test && bunx tsc --noEmit && bun run build` → all green, clean, binary builds.
- [ ] **Step 2: Self-review vs spec** (§DoD 1–5): config load + malformed fallback, per-agent model (delegated child differs), defaults seed agents, env-only secrets, precedence. Confirm existing 57 tests still green (single-model fallback path unchanged).
- [ ] **Step 3: Adversarial review** (dispatch a reviewer over the `phase1-safety-budgets..phase2-config` diff) focusing on: precedence correctness (per-agent > defaults > env > built-in), the resolver cache key, per-agent pricer wiring (cost reflects the agent's model), secrets never read from yaml, and malformed-config-doesn't-brick-boot. Fix findings, re-run.

## Self-review (filled after writing)
**Spec coverage:** DoD#1 loadConfig+malformed → Task 1. DoD#2 per-agent model + delegated child → Tasks 2,4. DoD#3 defaults seed agents → Task 3. DoD#4 env-only secrets → Task 1 (schema has no apiKey). DoD#5 precedence → Task 2 resolver. ✓
**Placeholder scan:** No TBDs; every step has concrete code/commands.
**Type consistency:** `TaichoConfig`/`Provider` defined in config.ts (Task 1), imported by model.ts (Task 2), roster.ts (Task 3), run.ts (Task 4), App (Task 5). The config-defaults param is typed `TaichoConfig["defaults"]` everywhere (createAgent/seedRoot/`RunDeps.configDefaults`/App prop), so `config.defaults` passes straight through and `defaults?.budgets` is valid zod input to `AgentDef.parse` (avoids the `Record<string,number>` mismatch where partial/optional budget fields aren't assignable to a `number` index). `resolveModel: (id)=>{model,modelId}` shape is identical in run.ts (Task 4), index/App (Task 5), and the test fixtures.
