/** provider+model -> AI-SDK model instance. Keys are read from env by the providers. */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { generateText } from "ai";
import type { Provider, ResolvedConfig, TaichoConfig } from "../store/config";

// Reuse the exact model param type generateText expects (robust across SDK versions).
export type Model = Parameters<typeof generateText>[0]["model"];

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
    let inst = cache.get(key);
    if (!inst) { inst = provider === "anthropic" ? anthropic(model) : openai(model); cache.set(key, inst); }
    return { model: inst, modelId: model, provider };
  };
  return { resolveModel };
}
