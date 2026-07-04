/** provider+model -> AI-SDK model instance. Keys are read from env by the providers. */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { generateText } from "ai";
import type { Provider, ResolvedConfig, TaichoConfig } from "../store/config";
import { log } from "./logger";
import { withRequestTimeout, DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from "./providers/request-timeout";

// Reuse the exact model param type generateText expects (robust across SDK versions).
export type Model = Parameters<typeof generateText>[0]["model"];

const warnedMismatch = new Set<string>();

/** OpenRouter has no default model; fail loudly (not at an opaque call-time 400) when none is set.
 *  The slug must be namespaced (vendor/model) — this also catches a first-party fallback model
 *  (e.g. "claude-sonnet-4-6") bleeding into a per-agent `provider: openrouter` override.
 *  Plan 12: `timeoutFetch` is the transport-deadline-wrapped fetch (a hung request errors + retries
 *  via the AI SDK's maxRetries) — applied to EVERY env-key provider, not just codex. */
function instantiate(provider: Provider, model: string, timeoutFetch: typeof fetch): Model {
  if (provider === "openrouter") {
    if (!model.includes("/")) {
      throw new Error(
        "OpenRouter requires an explicit namespaced model (vendor/model). Set TAICHO_MODEL or " +
          "defaults.model in taicho.yaml, e.g. 'anthropic/claude-sonnet-4.5'. Browse slugs at " +
          "https://openrouter.ai/models",
      );
    }
    // apiKey defaults to OPENROUTER_API_KEY; the HTTP-Referer/X-Title headers are OpenRouter's
    // recommended app attribution. usage:{include:true} (per model) returns the real per-call cost.
    const openrouter = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
      headers: { "HTTP-Referer": "https://taicho.ai", "X-Title": "taicho" },
      fetch: timeoutFetch,
    });
    return openrouter(model, { usage: { include: true } });
  }
  return provider === "anthropic"
    ? createAnthropic({ fetch: timeoutFetch })(model)
    : createOpenAI({ fetch: timeoutFetch })(model);
}

export function buildModel(cfg: ResolvedConfig, timeoutMs?: number): Model {
  return instantiate(cfg.provider, cfg.model, withRequestTimeout(fetch, timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS));
}

export interface ResolvedModel { model: Model; modelId: string; provider: Provider; captureCost?: boolean; }

export function createModelResolver(opts: { config: TaichoConfig; fallback: ResolvedConfig; timeoutMs?: number }): {
  resolveModel: (agentId: string) => ResolvedModel;
} {
  const cache = new Map<string, Model>();
  // Plan 12: one transport-deadline fetch shared across every model this resolver builds. The deadline
  // is config-disposed (defaults.modelRequestTimeoutMs) — model-supplied values never reach it.
  const timeoutFetch = withRequestTimeout(fetch, opts.timeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
  const resolveModel = (agentId: string): ResolvedModel => {
    const a = opts.config.agents?.[agentId];
    const provider: Provider = a?.provider ?? opts.config.defaults?.provider ?? opts.fallback.provider;
    const model = a?.model ?? opts.config.defaults?.model ?? opts.fallback.model;
    const key = `${provider}:${model}`;
    // Heuristic diagnostic: a partial per-agent override can pair a model id with a mismatched
    // provider (e.g. an OpenAI model under the Anthropic provider). Warn once per provider:model
    // so a misconfiguration surfaces here instead of as a cryptic call-time API error.
    const looksMismatched =
      (provider === "anthropic" && !model.startsWith("claude-")) ||
      (provider === "openai" && model.startsWith("claude-"));
    if (looksMismatched && !warnedMismatch.has(key)) {
      warnedMismatch.add(key);
      log.warn(`model "${model}" looks mismatched with provider "${provider}" for agent "${agentId}" — check taicho.yaml (set both provider and model)`);
    }
    let inst = cache.get(key);
    if (!inst) { inst = instantiate(provider, model, timeoutFetch); cache.set(key, inst); }
    // OpenRouter returns the real per-call cost (usage:{include:true}); the loop reads it from
    // providerMetadata instead of the static price table.
    return { model: inst, modelId: model, provider, captureCost: provider === "openrouter" || undefined };
  };
  return { resolveModel };
}
