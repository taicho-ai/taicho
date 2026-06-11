/** provider+model -> AI-SDK model instance. Keys are read from env by the providers. */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { generateText } from "ai";
import type { Provider, ResolvedConfig, TaichoConfig } from "../store/config";

// Reuse the exact model param type generateText expects (robust across SDK versions).
export type Model = Parameters<typeof generateText>[0]["model"];

const warnedMismatch = new Set<string>();

export function buildModel(cfg: ResolvedConfig): Model {
  return cfg.provider === "anthropic" ? anthropic(cfg.model) : openai(cfg.model);
}

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
    // Heuristic diagnostic: a partial per-agent override can pair a model id with a mismatched
    // provider (e.g. an OpenAI model under the Anthropic provider). Warn once per provider:model
    // so a misconfiguration surfaces here instead of as a cryptic call-time API error.
    const looksMismatched =
      (provider === "anthropic" && !model.startsWith("claude-")) ||
      (provider === "openai" && model.startsWith("claude-"));
    if (looksMismatched && !warnedMismatch.has(key)) {
      warnedMismatch.add(key);
      console.warn(`taicho: model "${model}" looks mismatched with provider "${provider}" for agent "${agentId}" — check taicho.yaml (set both provider and model)`);
    }
    let inst = cache.get(key);
    if (!inst) { inst = provider === "anthropic" ? anthropic(model) : openai(model); cache.set(key, inst); }
    return { model: inst, modelId: model, provider };
  };
  return { resolveModel };
}
