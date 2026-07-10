#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./ui/App";
import { ensureWorkspace } from "./store/files";
import { openDb } from "./store/db";
import { seedRoot, seedLibrarian, reindex, loadIndex, reconcileWorkerTools, LIBRARIAN_ID } from "./store/roster";
import { reindexKnowledge, reconcileKbScope } from "./store/knowledge";
import { validateTeams } from "./store/teams";
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
import { makeSpendLedger, hasAnyCeilings } from "./store/spend-ledger";
import { seedSkills } from "./store/seed-skills";
import { reindexSkills } from "./store/skills";
import { reindexTasks, reconcileTasks } from "./store/task-state";
import { createE2eModel } from "./core/e2e-model";
import { parseCli, runHeadless, runTail, scheduleFireOptions } from "./core/headless";
import { runScheduleCli } from "./core/schedule-cli";
import { configureLogger, log } from "./core/logger";
import { initTelemetry } from "./core/otel";

const ws = process.cwd();
const cli = parseCli(process.argv);
// Point the file logger at this workspace and raise the level when --verbose (a general debug mode;
// historically only the codex path honored TAICHO_DEBUG). All diagnostics now land in taicho.log
// instead of fighting the Ink render.
configureLogger({ ws, level: cli.verbose ? "debug" : undefined });

// `taicho tail [runId]` only reads the runs/ event stream — short-circuit before the heavy boot
// (DB, seeds, MCP connect) so an external observer's tail starts instantly.
if (cli.command?.kind === "tail") {
  await runTail(ws, cli.command);
  process.exit(0);
}

const config = await loadConfig(ws);
await ensureWorkspace(ws);

// `taicho schedule <add|list|remove>` only touches the durable schedule store — short-circuit before
// the heavy boot (seeds, DB, MCP connect). `schedule run` needs a model, so it falls through to the
// full boot and is fired via the headless path below.
if (cli.command?.kind === "schedule" && cli.command.args[0] !== "run") {
  const r = await runScheduleCli({ ws, out: (l) => process.stdout.write(l + "\n") }, cli.command.args);
  process.exit(r.ok ? 0 : 1);
}

await seedRoot(ws, config.defaults);
await seedLibrarian(ws, config.defaults);
// Plan 14 T3: rescue any worker born toolless (`tools: []`) — grant it the default artifact baseline so
// a live squad (root/2026-07-04-run6's 9 empty-tools agents) becomes usable without hand-editing each file.
const backfilledWorkers = await reconcileWorkerTools(ws);
await seedSkills(ws);
const db = openDb(ws);
const idx = loadIndex(db);
if (idx.length === 0 || !idx.some((r) => r.id === LIBRARIAN_ID)) await reindex(ws, db);
// Plan 19 Ph1b: rewrite any kb node file still saying `scope: deck` BEFORE the reindex below reads them.
reconcileKbScope(ws, db);
reindexKnowledge(ws, db); // rebuild the KB graph index from kb/nodes/*.md (files are canon)
reindexSkills(ws, db); // rebuild the skills index from skills/*.md (files are canon)
const kbDrift = diffSources(ws, db);
// Plan 04 Phase 5: rebuild the task index from files, then reconcile — a task left `running`/`queued`
// means the process died mid-flight → mark `interrupted` and report it (report-and-ask per Phase 0;
// auto-resume is deferred). The captain can inspect/cancel via /tasks.
reindexTasks(ws, db);
const interruptedTasks = reconcileTasks(ws, db);
// Plan 19: a team whose `lead` is missing, or sits on a DIFFERENT team, would route work out of the
// team it is supposed to run. Report it — one bad team.md must not block boot, and the fix is an edit.
const teamProblems = validateTeams(ws, db);
// Plan 19: an agent's team, read from the derived registry index. Injected into the model resolver so
// it can walk agent → team → defaults without importing the DB. A prepared statement: resolveModel runs
// once per run, and per delegated child.
const teamOfStmt = db.query<{ team: string | null }, [string]>("SELECT team FROM registry WHERE id = ?");
const teamOf = (agentId: string): string | undefined => teamOfStmt.get(agentId)?.team ?? undefined;
const notices: string[] = [];
if (teamProblems.length)
  notices.push(`teams: ${teamProblems.map((p) => `${p.team} (${p.problem})`).join("; ")} — /teams to review`);
if (kbDrift.changed.length || kbDrift.deleted.length)
  notices.push(`kb: ${kbDrift.changed.length} changed / ${kbDrift.deleted.length} removed source(s) — run /kb sync`);
if (interruptedTasks.length)
  notices.push(`tasks: ${interruptedTasks.length} interrupted last session (${interruptedTasks.slice(0, 3).map((t) => t.taskId).join(", ")}${interruptedTasks.length > 3 ? "…" : ""}) — /tasks to review`);
if (backfilledWorkers.length)
  notices.push(`agents: granted the artifact-tool baseline to ${backfilledWorkers.length} worker(s) born toolless (${backfilledWorkers.slice(0, 3).join(", ")}${backfilledWorkers.length > 3 ? "…" : ""})`);
const startupNotice = notices.length ? notices.join(" · ") : undefined;
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
      // Firecrawl is a built-in default MCP server on every squad (scrape/crawl/search/map/extract)
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

// Plan 09: one squad-wide spend ledger, shared by every run this session. DB-backed rolling counters
// keyed by UTC day / ISO week persist across sessions. Built only when a ceiling is configured, so
// with no `budgets` in taicho.yaml the loop does zero extra DB work (pre-Plan-09 behavior).
// Plan 19: the same ledger meters the squad ceiling and every configured team ceiling.
const ceilingConfig = {
  squad: config.budgets,
  teams: Object.fromEntries(Object.entries(config.teams ?? {}).map(([id, t]) => [id, t.ceilings])),
};
const spendLedger = hasAnyCeilings(ceilingConfig) ? makeSpendLedger(db, ceilingConfig) : undefined;

// Plan 16: OpenTelemetry. Enabled only when an OTLP endpoint is configured (OTEL_EXPORTER_OTLP_ENDPOINT)
// — otherwise undefined and every seam skips it (zero overhead). Shared by every run this session. Must
// be flushed on exit (BatchSpanProcessor buffers), so each exit path below awaits telemetry?.shutdown().
const telemetry = initTelemetry({ serviceVersion: "0.0.1" });
if (telemetry) process.on("SIGTERM", () => { void telemetry.shutdown(); });

const e2eModel = createE2eModel(process.env.TAICHO_E2E_MODEL);
const authSource = e2eModel
  ? { kind: "env" as const, provider: "openai" as const, model: `e2e:${process.env.TAICHO_E2E_MODEL}` }
  : resolveAuth({ config, loadProfile: () => readProfile() });

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
  if (e2eModel) {
    return {
      model: e2eModel,
      resolveModel: () => ({ model: e2eModel, modelId: `e2e:${process.env.TAICHO_E2E_MODEL}` }),
      priceUsd: () => 0,
    };
  }
  // Plan 12: the per-request transport deadline (ms) for a model fetch — config-disposed, applied to
  // EVERY provider fetch path (env keys + codex). Undefined ⇒ the provider layer's 120s default.
  const modelRequestTimeoutMs = config.defaults?.modelRequestTimeoutMs;
  if (src.kind === "env") {
    // A config-supplied default model is honored for the top-level fallback model too — needed for
    // OpenRouter, whose env-resolved src.model may be empty (it carries no default slug).
    const cfg = { provider: src.provider, model: config.defaults?.model ?? src.model };
    return {
      model: buildModel(cfg, modelRequestTimeoutMs),
      resolveModel: createModelResolver({ config, fallback: cfg, timeoutMs: modelRequestTimeoutMs, teamOf }).resolveModel,
      priceUsd: pricerFor(cfg.model),
    };
  }
  if (src.kind === "oauth-openai-codex") {
    const codex = createCodexProvider({
      load: () => readProfile(),
      refresh: createRefresher({ load: () => readProfile(), save: writeProfile }),
      timeoutMs: modelRequestTimeoutMs,
    });
    // Subscription calls are not metered in USD; mark subscription:true so the run trace reports
    // "subscription" instead of a (meaningless) dollar cost.
    const pick = (id: string) => {
      // agent → team → defaults, the same walk createModelResolver makes for the env-key providers.
      const t = teamOf(id);
      const m = config.agents?.[id]?.model ?? (t ? config.teams?.[t]?.model : undefined) ?? config.defaults?.model ?? OPENAI_CODEX_AUTH.defaultModelId;
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

// `taicho run "<goal>"` drives ONE run to completion without Ink, then exits with the run's status.
// Approvals default to auto-reject (unattended-safe; see core/headless.ts) — override with --approve.
if (cli.command?.kind === "run") {
  const res = await runHeadless(
    {
      ws, db, model: initial.model,
      resolveModel: initial.resolveModel, priceUsd: initial.priceUsd,
      configDefaults: config.defaults, mcp, embed: embedder?.embed,
      spendLedger, telemetry,
    },
    { goal: cli.command.goal, agent: cli.command.agent, approve: cli.command.approve },
  );
  if (mcp) await mcp.closeAll().catch((e) => log.warn("mcp closeAll failed", e));
  await telemetry?.shutdown(); // flush buffered spans/metrics before exit
  process.exit(res.ok ? 0 : 1);
}

// `taicho schedule run <id>` fires ONE schedule once through the same unattended headless path a live
// scheduled run uses — the schedule's own approval mode (default reject) applies (no captain, so no
// unsupervised privileged exec). add/list/remove already exited above; only `run` reaches here.
if (cli.command?.kind === "schedule") {
  const hd = { ws, db, model: initial.model, resolveModel: initial.resolveModel, priceUsd: initial.priceUsd, configDefaults: config.defaults, mcp, embed: embedder?.embed, spendLedger, telemetry };
  const r = await runScheduleCli(
    // `schedule run` is the same UNATTENDED path a live scheduled fire uses — mark it schedule:<id> so it
    // is EXCLUDED from the target agent's conversation ledger + boot-replay cache (still gets run evidence).
    { ws, out: (l) => process.stdout.write(l + "\n"), fire: (s) => runHeadless(hd, scheduleFireOptions(s)) },
    cli.command.args,
  );
  if (mcp) await mcp.closeAll().catch((e) => log.warn("mcp closeAll failed", e));
  await telemetry?.shutdown(); // flush buffered spans/metrics before exit
  process.exit(r.ok ? 0 : 1);
}

const rootThread = loadThread(ws, "root");

render(
  <App
    ws={ws} db={db} roster={roster}
    configDefaults={config.defaults}
    backgroundRunCeiling={config.tasks?.maxBackgroundRuns}
    authSource={authSource}
    buildFromAuth={buildFromAuth}
    onLogin={onLogin}
    onLogout={() => deleteProfile()}
    rootThread={rootThread}
    mcp={mcp}
    mcpYamlServers={Object.keys(config.mcp?.servers ?? {})}
    embed={embedder?.embed}
    spendLedger={spendLedger}
    telemetry={telemetry}
    startupNotice={startupNotice}
    {...initial}
    cfg={authSource.kind === "env" ? { provider: authSource.provider, model: authSource.model } : null}
  />,
);
