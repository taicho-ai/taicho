/** provider+model -> AI-SDK model instance. Keys are read from env by the providers. */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { generateText } from "ai";
import type { ResolvedConfig } from "../store/config";

// Reuse the exact model param type generateText expects (robust across SDK versions).
export type Model = Parameters<typeof generateText>[0]["model"];

export function buildModel(cfg: ResolvedConfig): Model {
  return cfg.provider === "anthropic" ? anthropic(cfg.model) : openai(cfg.model);
}
