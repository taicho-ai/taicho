# OpenRouter provider support — design

Date: 2026-06-28

## Goal

Add `openrouter` as a third model provider alongside `anthropic` and `openai`, using
the official `@openrouter/ai-sdk-provider`, capturing OpenRouter's real per-run cost
from its usage accounting, and requiring an explicit model slug (no hardcoded default).

## Decisions (confirmed with user)

1. **Integration:** official `@openrouter/ai-sdk-provider` (not a hand-rolled
   `createOpenAI` baseURL shim).
2. **Cost:** capture OpenRouter's returned cost via usage accounting, rather than a
   static price table.
3. **Default model:** require an explicit model — fail with a clear message if unset.

## Verified package facts

- Package `@openrouter/ai-sdk-provider@^2.10.0`; peer deps `ai: ^6.0.0`,
  `zod: ^3.25 || ^4` — compatible with this repo (`ai@^6`, `zod@^4`).
- Provider: `createOpenRouter({ apiKey, headers, extraBody })` →
  `openrouter('vendor/model', { usage: { include: true } })`.
- Usage accounting: with `usage: { include: true }`, the real cost is returned at
  `result.providerMetadata.openrouter.usage.cost` (USD, per call). `totalTokens` is
  also present there. (BYOK `costDetails.upstreamInferenceCost` is out of scope.)
- Default `apiKey` source is `OPENROUTER_API_KEY`; we pass it explicitly.
- OpenRouter model slugs are namespaced `vendor/model` (e.g. `anthropic/claude-sonnet-4.5`,
  `openai/gpt-4o`). Browse: https://openrouter.ai/models

## Changes

### 1. `src/store/config.ts` — provider surface
- `Provider = "anthropic" | "openai" | "openrouter"`.
- Both zod enums (`defaults.provider`, `AgentOverride.provider`) add `"openrouter"`.
- Env: `OPENROUTER_API_KEY`. `TAICHO_PROVIDER=openrouter` forces it (requires the key).
- Auto-detect precedence (no `TAICHO_PROVIDER`): `ANTHROPIC_API_KEY` → `OPENAI_API_KEY`
  → `OPENROUTER_API_KEY`. OpenRouter is **last** so a stray key can't hijack a
  first-party setup; it is only auto-selected when it is the sole key present.
- `resolveAuth` subscription-preference logic is unchanged — OpenRouter is an `env`
  `AuthSource` (`{ kind: "env"; provider: "openrouter"; model }`).
- No default model for openrouter: `resolveConfig`'s `pick("openrouter")` returns
  `model = env.TAICHO_MODEL ?? ""` (empty sentinel). Emptiness is enforced at model
  construction (below), where `config.defaults.model` is also visible.

### 2. `src/core/model.ts` — model construction
- Module-level provider:
  `createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY, headers: { 'HTTP-Referer': 'https://taicho.ai', 'X-Title': 'taicho' } })`
  (headers are OpenRouter's recommended app-attribution; harmless, one-time).
- `buildModel` and `createModelResolver` gain an openrouter branch:
  `openrouter(model, { usage: { include: true } })`.
- Explicit-model guard: if `provider === "openrouter"` and `!model`, throw
  `Error("OpenRouter requires an explicit model. Set TAICHO_MODEL or defaults.model in taicho.yaml, e.g. 'anthropic/claude-sonnet-4.5'. Browse slugs at https://openrouter.ai/models")`.
- Mismatch heuristic (`looksMismatched`) applies only to `anthropic`/`openai`;
  openrouter slugs (`vendor/model`) are all valid and must not warn.
- `ResolvedModel` and the resolver return gain `captureCost?: boolean` (true for
  openrouter) so the run knows to read provider-reported cost.

### 3. `src/core/loop.ts` — cost capture
- New opt `captureProviderCost?: boolean`.
- On the `generateText` path, capture `r.providerMetadata`. After accumulating tokens:
  `const provCost = opts.captureProviderCost ? Number(providerMetadata?.openrouter?.usage?.cost) : undefined;`
  `costUsd += (provCost != null && Number.isFinite(provCost)) ? provCost : (opts.priceUsd?.({ inputTokens: inTok, outputTokens: outTok }) ?? 0);`
- The codex/streaming branch is untouched (no `providerMetadata` cost there).

### 4. `src/core/run.ts` — wiring
- `RunDeps.resolveModel` return type gains `captureCost?: boolean`.
- Pass `captureProviderCost: picked?.captureCost` to `runLoop`.
- Trace cost is unchanged in shape: for openrouter, `subscription` is false, so
  `costUsd: result.costUsd` is the real captured number; no `costNote`.

### 5. `src/index.tsx` — boot wiring
- `BuiltAuth.resolveModel` return type gains `captureCost?: boolean`.
- Env branch of `buildFromAuth`: `const cfg = { provider: src.provider, model: config.defaults?.model ?? src.model }`
  so a config-supplied model is honored for the top-level fallback model too (needed
  for openrouter, whose `src.model` may be empty).
- Wrap the boot `buildFromAuth(authSource)` call in try/catch: on the explicit-model
  error, `console.error("taicho: " + message)` and `process.exit(1)` (fail fast,
  actionable). `/login` (subscription only) is untouched.

### 6. `src/ui/App.tsx` — type mirror
- `ResolveModelFn` return type gains `captureCost?: boolean`. No behavioral change
  (openrouter is env-auth; `/login` re-arm path is subscription only).

## Tests (no network; mirror existing patterns)
- `config.test.ts`: `resolveConfig`/`resolveAuth` select openrouter on
  `TAICHO_PROVIDER=openrouter` (+ key) and via auto-detect when it's the only key;
  precedence keeps anthropic/openai ahead; openrouter model comes from `TAICHO_MODEL`.
- `model.test.ts`: `buildModel({ provider: "openrouter", model: "" })` throws the
  explicit-model error; a valid slug builds without a mismatch warning.
- `loop.test.ts`: with `captureProviderCost: true` and a mocked model whose result
  carries `providerMetadata.openrouter.usage.cost`, `costUsd` equals that value
  (and falls back to the token pricer when the field is absent).

## Out of scope (YAGNI)
- Provider routing / fallback model lists, BYOK cost breakdown, embeddings,
  a hardcoded default slug, OpenRouter-specific reasoning options.
