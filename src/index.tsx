#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./ui/App";
import { ensureWorkspace } from "./store/files";
import { openDb } from "./store/db";
import { seedRoot, reindex, loadIndex } from "./store/roster";
import { loadConfig, resolveAuth, type AuthSource } from "./store/config";
import { buildModel, createModelResolver, type Model } from "./core/model";
import { pricerFor } from "./core/pricing";
import { readProfile, writeProfile, deleteProfile } from "./core/auth/profile";
import { createRefresher } from "./core/auth/refresh";
import { runLoginFlow } from "./core/auth/login";
import { createCodexProvider } from "./core/providers/openai-codex";
import { OPENAI_CODEX_AUTH } from "./core/auth/constants";

const ws = process.cwd();
const config = await loadConfig(ws);
await ensureWorkspace(ws);
await seedRoot(ws, config.defaults);
const db = openDb(ws);
if (loadIndex(db).length === 0) await reindex(ws, db);
const roster = loadIndex(db);

const authSource = resolveAuth({ config, loadProfile: () => readProfile() });

export interface BuiltAuth {
  model: Model | null;
  resolveModel?: (id: string) => { model: Model; modelId: string; subscription?: boolean };
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
}

/** Map an AuthSource -> the model/resolver/pricer the REPL should use. Pure aside from provider
 *  construction; called both at boot and after a live /login so the REPL re-arms without restart. */
function buildFromAuth(src: AuthSource): BuiltAuth {
  if (src.kind === "env") {
    const cfg = { provider: src.provider, model: src.model };
    return {
      model: buildModel(cfg),
      resolveModel: createModelResolver({ config, fallback: cfg }).resolveModel,
      priceUsd: pricerFor(src.model),
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

const initial = buildFromAuth(authSource);

async function onLogin(): Promise<AuthSource> {
  // Never log the token bundle; only print the authorize URL for the paste fallback.
  const profile = await runLoginFlow({ onUrl: (u) => console.error("Open to sign in:\n" + u) });
  writeProfile(profile);
  return { kind: "oauth-openai-codex", accountId: profile.account_id, expiresAt: profile.expires_at };
}

render(
  <App
    ws={ws} db={db} roster={roster}
    configDefaults={config.defaults}
    authSource={authSource}
    buildFromAuth={buildFromAuth}
    onLogin={onLogin}
    onLogout={() => deleteProfile()}
    {...initial}
    cfg={authSource.kind === "env" ? { provider: authSource.provider, model: authSource.model } : null}
  />,
);
