/** Resolve which provider/model to use and whether a key is present.
 *  Env-first; config.yaml is deferred. Keys are read by the AI SDK from env directly. */
export type Provider = "anthropic" | "openai";
export interface ResolvedConfig { provider: Provider; model: string; }
export interface MissingConfig { missing: true; }

const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.5",
};

export function resolveConfig(env: Record<string, string | undefined> = process.env): ResolvedConfig | MissingConfig {
  const wanted = env.TAICHO_PROVIDER === "openai" ? "openai" : env.TAICHO_PROVIDER === "anthropic" ? "anthropic" : null;
  const pick = (p: Provider): ResolvedConfig => ({ provider: p, model: env.TAICHO_MODEL ?? DEFAULT_MODEL[p] });

  if (wanted) {
    const key = wanted === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
    return key ? pick(wanted) : { missing: true };
  }
  if (env.ANTHROPIC_API_KEY) return pick("anthropic");
  if (env.OPENAI_API_KEY) return pick("openai");
  return { missing: true };
}

export function isMissing(c: ResolvedConfig | MissingConfig): c is MissingConfig {
  return "missing" in c;
}
