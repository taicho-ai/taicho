#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./ui/App";
import { ensureWorkspace } from "./store/files";
import { openDb } from "./store/db";
import { seedRoot, seedLibrarian, reindex, loadIndex, LIBRARIAN_ID } from "./store/roster";
import { reindexKnowledge } from "./store/knowledge";
import { diffSources } from "./store/sources";
import { createEmbedder } from "./core/embed";
import { ensureEmbedSpace } from "./store/migrate";
import { loadConfig, resolveAuth, type AuthSource } from "./store/config";
import { buildModel, createModelResolver, type Model } from "./core/model";
import { pricerFor } from "./core/pricing";
import { readProfile, writeProfile, deleteProfile } from "./core/auth/profile";
import { loadThread } from "./store/thread";
import { createRefresher } from "./core/auth/refresh";
import { runLoginFlow } from "./core/auth/login";
import { createCodexProvider } from "./core/providers/openai-codex";
import { OPENAI_CODEX_AUTH } from "./core/auth/constants";
import { createMcpManager, type McpManager } from "./core/mcp/manager";
import { readMcpStore } from "./store/mcp-store";

const ws = process.cwd();
const config = await loadConfig(ws);
await ensureWorkspace(ws);
await seedRoot(ws, config.defaults);
await seedLibrarian(ws, config.defaults);
const db = openDb(ws);
const idx = loadIndex(db);
if (idx.length === 0 || !idx.some((r) => r.id === LIBRARIAN_ID)) await reindex(ws, db);
reindexKnowledge(ws, db); // rebuild the KB graph index from kb/nodes/*.md (files are canon)
const kbDrift = diffSources(ws, db);
const startupNotice = (kbDrift.changed.length || kbDrift.deleted.length)
  ? `kb: ${kbDrift.changed.length} changed / ${kbDrift.deleted.length} removed source(s) — run /kb sync`
  : undefined;
const roster = loadIndex(db);

// Semantic KB embedder (optional; null ⇒ keyword+graph recall). Env-driven, decoupled from the chat
// provider. ensureEmbedSpace wipes stale kb vectors if the embed model/dim changed.
const embedder = createEmbedder({ provider: config.embeddings?.provider });
if (embedder) ensureEmbedSpace(db, embedder.model, embedder.dim);

// MCP: connect configured servers (taicho.yaml `mcp.servers` ∪ the /mcp-added store; yaml wins on
// name collision). Best-effort — a server that fails is skipped, never blocking the REPL. The
// manager is mutable so /mcp add/remove/login work at runtime. `mcp.enabled: false` disables it.
const mcp: McpManager | undefined = config.mcp?.enabled === false
  ? undefined
  : await createMcpManager({
      ws,
      // Firecrawl is a built-in default MCP server on every deck (scrape/crawl/search/map/extract)
      // whenever FIRECRAWL_API_KEY is set — lowest precedence, so a workspace's store/yaml can override
      // or replace it. Then layer the /mcp-added store, then taicho.yaml (yaml wins on a name clash).
      servers: {
        ...(process.env.FIRECRAWL_API_KEY
          ? { firecrawl: { command: "npx", args: ["-y", "firecrawl-mcp"], env: { FIRECRAWL_API_KEY: "${FIRECRAWL_API_KEY}" } } }
          : {}),
        ...readMcpStore(ws),
        ...(config.mcp?.servers ?? {}),
      },
      onUrl: (u) => console.error("Open to authorize the MCP server:\n" + u),
    });
// Reap MCP servers on shutdown. The ESC quit path awaits closeAll(); SIGTERM closes then exits.
// (Ctrl+C/SIGINT is owned by Ink, which exits the app; stdio children otherwise die with the
// foreground process group. Async cleanup can't run in a process "exit" handler, so we don't use one.)
if (mcp) process.on("SIGTERM", () => { void mcp.closeAll().finally(() => process.exit(0)); });

const authSource = resolveAuth({ config, loadProfile: () => readProfile() });

// Transparency: a signed-in subscription is preferred over env keys; say so when both are present.
if (authSource.kind === "oauth-openai-codex" && (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)) {
  console.error("taicho: using your ChatGPT subscription (an API key is also set — run with TAICHO_PROVIDER=openai to use the key instead).");
}

export interface BuiltAuth {
  model: Model | null;
  resolveModel?: (id: string) => { model: Model; modelId: string; subscription?: boolean; captureCost?: boolean };
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
}

/** Map an AuthSource -> the model/resolver/pricer the REPL should use. Pure aside from provider
 *  construction; called both at boot and after a live /login so the REPL re-arms without restart. */
function buildFromAuth(src: AuthSource): BuiltAuth {
  if (src.kind === "env") {
    // A config-supplied default model is honored for the top-level fallback model too — needed for
    // OpenRouter, whose env-resolved src.model may be empty (it carries no default slug).
    const cfg = { provider: src.provider, model: config.defaults?.model ?? src.model };
    return {
      model: buildModel(cfg),
      resolveModel: createModelResolver({ config, fallback: cfg }).resolveModel,
      priceUsd: pricerFor(cfg.model),
    };
  }
  if (src.kind === "oauth-openai-codex") {
    const codex = createCodexProvider({
      load: () => readProfile(),
      refresh: createRefresher({ load: () => readProfile(), save: writeProfile }),
    });
    // Subscription calls are not metered in USD; mark subscription:true so the run trace reports
    // "subscription" instead of a (meaningless) dollar cost.
    const pick = (id: string) => {
      const m = config.agents?.[id]?.model ?? config.defaults?.model ?? OPENAI_CODEX_AUTH.defaultModelId;
      return { model: codex(m), modelId: m, subscription: true };
    };
    return { model: codex(config.defaults?.model ?? OPENAI_CODEX_AUTH.defaultModelId), resolveModel: pick };
  }
  return { model: null };
}

// buildFromAuth can throw on misconfiguration (e.g. OpenRouter selected with no model) — fail fast
// with the actionable message rather than an Ink render crash.
let initial: BuiltAuth;
try {
  initial = buildFromAuth(authSource);
} catch (e) {
  console.error(`taicho: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

async function onLogin(): Promise<AuthSource> {
  // Never log the token bundle; only print the authorize URL for the paste fallback.
  const profile = await runLoginFlow({ onUrl: (u) => console.error("Open to sign in:\n" + u) });
  writeProfile(profile);
  return { kind: "oauth-openai-codex", accountId: profile.account_id, expiresAt: profile.expires_at };
}

const rootThread = loadThread(ws, "root");

render(
  <App
    ws={ws} db={db} roster={roster}
    configDefaults={config.defaults}
    authSource={authSource}
    buildFromAuth={buildFromAuth}
    onLogin={onLogin}
    onLogout={() => deleteProfile()}
    rootThread={rootThread}
    mcp={mcp}
    mcpYamlServers={Object.keys(config.mcp?.servers ?? {})}
    embed={embedder?.embed}
    startupNotice={startupNotice}
    {...initial}
    cfg={authSource.kind === "env" ? { provider: authSource.provider, model: authSource.model } : null}
  />,
);
