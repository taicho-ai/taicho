/** Resolve which provider/model to use and whether a key is present.
 *  Env-first; config.yaml is deferred. Keys are read by the AI SDK from env directly. */
import { z } from "zod";
import { YAML } from "bun";
import { join } from "node:path";
import { log } from "../core/logger";

export type Provider = "anthropic" | "openai" | "openrouter";
export interface ResolvedConfig { provider: Provider; model: string; }
export interface MissingConfig { missing: true; }

// OpenRouter has no sensible default slug (its catalog drifts), so it maps to "" — an empty
// sentinel meaning "model is required". buildModel/createModelResolver enforce non-empty there.
const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.5",
  openrouter: "",
};

const keyFor = (env: Record<string, string | undefined>, p: Provider): string | undefined =>
  p === "anthropic" ? env.ANTHROPIC_API_KEY : p === "openai" ? env.OPENAI_API_KEY : env.OPENROUTER_API_KEY;

export function resolveConfig(env: Record<string, string | undefined> = process.env): ResolvedConfig | MissingConfig {
  const tp = env.TAICHO_PROVIDER;
  const wanted: Provider | null = tp === "openai" ? "openai" : tp === "anthropic" ? "anthropic" : tp === "openrouter" ? "openrouter" : null;
  const pick = (p: Provider): ResolvedConfig => ({ provider: p, model: env.TAICHO_MODEL ?? DEFAULT_MODEL[p] });

  if (wanted) return keyFor(env, wanted) ? pick(wanted) : { missing: true };
  // Auto-detect: prefer a first-party key; OpenRouter is last so a stray key can't hijack a setup.
  if (env.ANTHROPIC_API_KEY) return pick("anthropic");
  if (env.OPENAI_API_KEY) return pick("openai");
  if (env.OPENROUTER_API_KEY) return pick("openrouter");
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
  maxConcurrentRuns: z.number().int().positive().optional(), // Plan 04: per-agent background concurrency cap
}).optional();

const AgentOverride = z.object({
  provider: z.enum(["anthropic", "openai", "openrouter"]).optional(),
  model: z.string().optional(),
  budgets: PartialBudgets,
});

/** An MCP server: a local stdio subprocess, or a remote HTTP endpoint. Distinguished by
 *  `command` vs `url` (no explicit type tag). Secrets in env/headers use ${VAR} (see interpolateEnv). */
const McpStdioServer = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const McpHttpServer = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  auth: z.literal("oauth").optional(), // omitted ⇒ no-auth or static-header auth
});
export const McpServerConfig = z.union([McpStdioServer, McpHttpServer]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;
export const isStdioServer = (s: McpServerConfig): s is z.infer<typeof McpStdioServer> => "command" in s;

const McpConfig = z.object({
  enabled: z.boolean().optional(), // default: on when servers are present
  servers: z.record(z.string(), McpServerConfig).optional(),
}).optional();
export type McpConfig = z.infer<typeof McpConfig>;

/** Expand ${VAR} references against the environment so secrets stay in env, not the config file. */
export function interpolateEnv(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => env[name] ?? "");
}

/** Plan 09: deck-WIDE spend ceilings (all agents, all runs) enforced in the loop and persisted across
 *  sessions. Distinct from per-run/per-agent `budgets` above — these bound the whole deck's rolling
 *  daily/weekly spend. Any subset may be set; USD ceilings only constrain priced runs (a subscription
 *  deck is bounded by tokens, never a fabricated dollar figure). */
const DeckBudgets = z.object({
  dailyTokens: z.number().int().positive().optional(),
  weeklyTokens: z.number().int().positive().optional(),
  dailyCostUsd: z.number().positive().optional(),
  weeklyCostUsd: z.number().positive().optional(),
}).optional();

export const TaichoConfig = z.object({
  defaults: z.object({
    provider: z.enum(["anthropic", "openai", "openrouter"]).optional(),
    model: z.string().optional(),
    budgets: PartialBudgets,
    // Plan 05: fraction (0..1) of a model's context window at which the loop folds the oldest tool
    // round-trips into one compact summary. Default ~0.7 (see compaction.ts DEFAULT_COMPACT_AT).
    compactAt: z.number().positive().max(1).optional(),
    // Plan 05 Ph3: how many recent conversation turns boot-replay keeps VERBATIM; older turns fold
    // into a rolling summary. Default 6 (conversation-replay.ts DEFAULT_REPLAY_KEEP_TURNS).
    replayKeepTurns: z.number().int().nonnegative().optional(),
    // Plan 12: per-request transport deadline (ms) for a model fetch. A genuinely hung request (open
    // socket, zero tokens) aborts the connection and errors, routed through the AI SDK's maxRetries —
    // replaces the deleted loop-level idle watchdog. Default 120s (request-timeout.ts).
    modelRequestTimeoutMs: z.number().int().positive().optional(),
  }).optional(),
  // Deck-level ceilings (Plan 09) — top-level because they bound the whole deck, not one agent.
  budgets: DeckBudgets,
  agents: z.record(z.string(), AgentOverride).optional(),
  auth: z.object({ chatgpt_signin: z.boolean().optional() }).optional(),
  // Plan 04: a global ceiling on total in-flight + queued BACKGROUND runs (dispatch_task). Bounds
  // system-wide fan-out independent of per-agent maxConcurrentRuns; default applied in the REPL (32).
  tasks: z.object({ maxBackgroundRuns: z.number().int().positive().optional() }).optional(),
  mcp: McpConfig,
  embeddings: z.object({ provider: z.enum(["off", "local", "openai"]).optional() }).optional(), // semantic KB backend
}).default({});
export type TaichoConfig = z.infer<typeof TaichoConfig>;

export type AuthSource =
  | { kind: "env"; provider: Provider; model: string }
  | { kind: "oauth-openai-codex"; accountId: string; expiresAt: number }
  | { kind: "none" };

/** Precedence: an explicit `TAICHO_PROVIDER` always wins (`openai-codex` → subscription;
 *  `openai`/`anthropic`/`openrouter` → that env API key). Otherwise a signed-in ChatGPT
 *  subscription is PREFERRED over env API keys (if you logged in, you meant it), then env keys,
 *  then none. `auth.chatgpt_signin: false` disables the subscription path entirely. */
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
  const envAuth = (): AuthSource => {
    const envCfg = resolveConfig(env);
    return isMissing(envCfg) ? { kind: "none" } : { kind: "env", provider: envCfg.provider, model: envCfg.model };
  };

  if (env.TAICHO_PROVIDER === "openai-codex") return oauth();
  if (env.TAICHO_PROVIDER === "openai" || env.TAICHO_PROVIDER === "anthropic" || env.TAICHO_PROVIDER === "openrouter") return envAuth();
  return profile ? oauth() : envAuth(); // signed-in subscription preferred over env keys
}

export async function loadConfig(ws: string): Promise<TaichoConfig> {
  const file = join(ws, "taicho.yaml");
  if (!(await Bun.file(file).exists())) return TaichoConfig.parse({});
  let raw: unknown;
  try {
    raw = YAML.parse(await Bun.file(file).text());
  } catch (e) {
    log.warn(`failed to parse taicho.yaml — using defaults`, e);
    return TaichoConfig.parse({});
  }
  const result = TaichoConfig.safeParse(raw);
  if (!result.success) {
    log.warn("invalid taicho.yaml — using defaults");
    return TaichoConfig.parse({});
  }
  return result.data;
}
