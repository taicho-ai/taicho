/** provider+model -> AI-SDK model instance. Keys are read from env by the providers. */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { generateText } from "ai";
import type { Provider, ResolvedConfig, TaichoConfig } from "../store/config";
import { log } from "./logger";

// Reuse the exact model param type generateText expects (robust across SDK versions).
export type Model = Parameters<typeof generateText>[0]["model"];

const warnedMismatch = new Set<string>();

// One OpenRouter provider instance. apiKey defaults to OPENROUTER_API_KEY; the HTTP-Referer/X-Title
// headers are OpenRouter's recommended app attribution. usage:{include:true} (set per model) makes
// the backend return the real per-call cost in providerMetadata.openrouter.usage.cost.
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  headers: { "HTTP-Referer": "https://taicho.ai", "X-Title": "taicho" },
});

/** OpenRouter has no default model; fail loudly (not at an opaque call-time 400) when none is set.
 *  The slug must be namespaced (vendor/model) — this also catches a first-party fallback model
 *  (e.g. "claude-sonnet-4-6") bleeding into a per-agent `provider: openrouter` override. */
function instantiate(provider: Provider, model: string): Model {
  if (provider === "openrouter") {
    if (!model.includes("/")) {
      throw new Error(
        "OpenRouter requires an explicit namespaced model (vendor/model). Set TAICHO_MODEL or " +
          "defaults.model in taicho.yaml, e.g. 'anthropic/claude-sonnet-4.5'. Browse slugs at " +
          "https://openrouter.ai/models",
      );
    }
    return openrouter(model, { usage: { include: true } });
  }
  return provider === "anthropic" ? anthropic(model) : openai(model);
}

export function buildModel(cfg: ResolvedConfig): Model {
  return instantiate(cfg.provider, cfg.model);
}

export interface ResolvedModel { model: Model; modelId: string; provider: Provider; captureCost?: boolean; }

export function createModelResolver(opts: { config: TaichoConfig; fallback: ResolvedConfig }): {
  resolveModel: (agentId: string) => ResolvedModel;
} {
  const cache = new Map<string, Model>();
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
    if (!inst) { inst = instantiate(provider, model); cache.set(key, inst); }
    // OpenRouter returns the real per-call cost (usage:{include:true}); the loop reads it from
    // providerMetadata instead of the static price table.
    return { model: inst, modelId: model, provider, captureCost: provider === "openrouter" || undefined };
  };
  return { resolveModel };
}
