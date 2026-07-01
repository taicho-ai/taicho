/** The KB embedder: turns text into a vector for semantic recall. Two optional, null-degrading
 *  backends (→ keyword+graph when absent): a LOCAL WASM model (transformers.js all-MiniLM-L6-v2 — no
 *  API key, self-installs on first use into ~/.taicho/models) and OpenAI text-embedding-3-small (zero
 *  binary weight, needs OPENAI_API_KEY). Config-selected. Both loaded via RUNTIME dynamic import so
 *  neither is statically bundled into the single binary (the local WASM stack must never bundle). */
import { homedir } from "node:os";
import { join } from "node:path";

export interface Embedder {
  model: string;
  dim: number;
  embed: (text: string) => Promise<Float32Array>;
  embedMany: (texts: string[]) => Promise<Float32Array[]>;
}

export type EmbedProvider = "off" | "local" | "openai";

const LOCAL = { pkg: "@huggingface/transformers", model: "Xenova/all-MiniLM-L6-v2", dim: 384 };
const OPENAI = { pkg: "@ai-sdk/openai", model: "text-embedding-3-small", dim: 1536 };

/** Build the configured embedder, or null (→ keyword+graph). Default: openai when OPENAI_API_KEY is
 *  set, else local (self-installing). Never throws — a missing package degrades at embed()-time. */
export function createEmbedder(opts: { provider?: EmbedProvider; env?: Record<string, string | undefined>; home?: string } = {}): Embedder | null {
  const env = opts.env ?? process.env;
  const provider: EmbedProvider = opts.provider ?? (env.OPENAI_API_KEY ? "openai" : "local");
  if (provider === "off") return null;
  if (provider === "openai") return env.OPENAI_API_KEY ? openaiEmbedder() : null;
  return localEmbedder(opts.home ?? join(homedir(), ".taicho", "models"));
}

function openaiEmbedder(): Embedder {
  const embedMany = async (texts: string[]): Promise<Float32Array[]> => {
    const { openai } = await import(OPENAI.pkg);         // installed; dynamic keeps it out of the hot path
    const { embedMany: aiEmbedMany } = await import("ai");
    const { embeddings } = await aiEmbedMany({ model: openai.embedding(OPENAI.model), values: texts });
    return embeddings.map((e: number[]) => new Float32Array(e));
  };
  return { model: OPENAI.model, dim: OPENAI.dim, embed: async (t) => (await embedMany([t]))[0]!, embedMany };
}

function localEmbedder(cacheDir: string): Embedder {
  // Lazy: load transformers.js (WASM) + the model on first use, cached thereafter. If the package
  // isn't installed or the model can't load, the promise rejects and callers fall back to keyword.
  let pipe: Promise<(t: string) => Promise<Float32Array>> | null = null;
  const load = () => (pipe ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tf: any = await import(LOCAL.pkg);             // variable specifier ⇒ NOT statically bundled
    tf.env.cacheDir = cacheDir;
    tf.env.allowRemoteModels = true;
    const extractor = await tf.pipeline("feature-extraction", LOCAL.model);
    return async (t: string) => {
      const out = await extractor(t, { pooling: "mean", normalize: true });
      return new Float32Array(out.data as Float32Array);
    };
  })());
  const embed = async (t: string) => (await load())(t);
  return { model: LOCAL.model, dim: LOCAL.dim, embed, embedMany: (ts) => Promise.all(ts.map(embed)) };
}
