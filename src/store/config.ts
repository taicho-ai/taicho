/** Resolve which provider/model to use and whether a key is present.
 *  Env-first; config.yaml is deferred. Keys are read by the AI SDK from env directly. */
import { z } from "zod";
import { YAML } from "bun";
import { join } from "node:path";

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
  auth: z.object({ chatgpt_signin: z.boolean().optional() }).optional(),
}).default({});
export type TaichoConfig = z.infer<typeof TaichoConfig>;

export type AuthSource =
  | { kind: "env"; provider: Provider; model: string }
  | { kind: "oauth-openai-codex"; accountId: string; expiresAt: number }
  | { kind: "none" };

/** Precedence: TAICHO_PROVIDER=openai-codex forces OAuth → env API keys → stored OAuth profile
 *  (if auth.chatgpt_signin !== false) → none. */
export function resolveAuth(opts: {
  env?: Record<string, string | undefined>;
  config: TaichoConfig;
  loadProfile: () => { account_id: string; expires_at: number } | null;
}): AuthSource {
  const env = opts.env ?? process.env;
  const flagOn = opts.config.auth?.chatgpt_signin !== false;
  const profile = flagOn ? opts.loadProfile() : null;
  const oauth = (): AuthSource =>
    profile ? { kind: "oauth-openai-codex", accountId: profile.account_id, expiresAt: profile.expires_at } : { kind: "none" };
  if (env.TAICHO_PROVIDER === "openai-codex") return oauth();
  const envCfg = resolveConfig(env);
  if (!isMissing(envCfg)) return { kind: "env", provider: envCfg.provider, model: envCfg.model };
  return oauth();
}

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
