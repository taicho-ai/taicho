import { useState, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import type { Database } from "bun:sqlite";
import { ProposalCard } from "./ProposalCard";
import { parseInput } from "./input";
import { makeDeps, executeRun, type Model, type ApprovalRequest, type ApprovalDecision } from "../core/run";
import { loadAgent, loadIndex, type RegistryRow } from "../store/roster";
import { listTraces, readTrace } from "../store/trace";
import type { ModelMessage } from "ai";
import type { AuthSource, TaichoConfig } from "../store/config";
import { formatAuthStatus, noCredentialLines, authExpiredMessage } from "../core/auth/status";
import { runSlash as runSlashPure, type Line } from "./slash";

type Pending = { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void } | null;

type ResolveModelFn = (agentId: string) => { model: Model; modelId: string; subscription?: boolean };
type PriceFn = (u: { inputTokens: number; outputTokens: number }) => number;
interface BuiltAuth { model: Model | null; resolveModel?: ResolveModelFn; priceUsd?: PriceFn }

export function App(props: {
  ws: string; db: Database; model: Model | null; roster: RegistryRow[];
  cfg: { provider: string; model: string } | null;
  priceUsd?: PriceFn;
  resolveModel?: ResolveModelFn;
  configDefaults?: TaichoConfig["defaults"];
  authSource: AuthSource;
  buildFromAuth: (s: AuthSource) => BuiltAuth;
  onLogin: () => Promise<AuthSource>;
  onLogout: () => boolean;
}) {
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>(() => initialLines(props));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [roster, setRoster] = useState(props.roster);
  // Live auth: model/resolver/pricer are STATE (seeded from props) so /login can re-arm the REPL
  // without a restart. deps() reads these, so the next submit picks up the new credentials.
  const [authSource, setAuthSource] = useState<AuthSource>(props.authSource);
  const [model, setModel] = useState<Model | null>(props.model);
  const [resolveModel, setResolveModel] = useState<ResolveModelFn | undefined>(() => props.resolveModel);
  const [priceUsd, setPriceUsd] = useState<PriceFn | undefined>(() => props.priceUsd);
  const steerQueue = useRef<string[]>([]);
  const thread = useRef<ModelMessage[]>([]);
  const aborter = useRef<AbortController | null>(null);

  useInput((_i, key) => {
    if (!key.escape) return;
    if (busy) { aborter.current?.abort(); say({ kind: "system", text: "  ⊗ cancelling…" }); }
    else exit();
  }, { isActive: !pending });

  const say = (l: Line) => setLines((prev) => [...prev, l]);
  // Best-effort: a failed run whose surfaced text reflects an AuthExpiredError ("session expired")
  // gets an explicit nudge to re-run /login openai (the run already returned a failed outcome).
  const maybeSayAuthExpired = (text: string) => {
    if (/session expired/i.test(text)) say({ kind: "system", text: `  ${authExpiredMessage()}` });
  };

  const requestApproval = (req: ApprovalRequest) =>
    new Promise<ApprovalDecision>((resolve) => setPending({ req, resolve }));

  const deps = (model: Model) => makeDeps({
    ws: props.ws, db: props.db, model,
    requestApproval,
    onStep: ({ tool, agent }) => { if (tool) say({ kind: "system", text: `  ↳ ${agent} → ${tool}()` }); },
    pollSteer: () => steerQueue.current.shift() ?? null,
    signal: aborter.current?.signal,
    priceUsd,
    resolveModel,
    configDefaults: props.configDefaults,
  });

  const submit = async (value: string) => {
    if (!value.trim()) return;
    setInput("");

    if (busy) { steerQueue.current.push(value); say({ kind: "user", text: `(steer) ${value}` }); return; }

    const parsed = parseInput(value);
    say({ kind: "user", text: value });

    // Slash commands work even without a model (e.g. /login to acquire one).
    if (parsed.kind === "slash") return runSlash(parsed.cmd, parsed.arg);

    if (!model) { say({ kind: "system", text: "No credentials — set ANTHROPIC_API_KEY / OPENAI_API_KEY and relaunch, or run /login openai. I won't burn tokens until then." }); return; }
    const activeModel = model;

    setBusy(true);
    steerQueue.current = [];
    aborter.current = new AbortController();
    try {
      if (parsed.kind === "chat") {
        thread.current.push({ role: "user", content: parsed.text });
        const root = await loadAgent(props.ws, "root");
        const res = await executeRun(deps(activeModel), { agent: root, messages: [...thread.current], triggeredBy: "user" });
        say({ kind: "agent", from: "root", text: res.text });
        if (res.trace.outcome === "completed") {
          thread.current.push({ role: "assistant", content: res.text });
        } else {
          thread.current.pop(); // drop the user turn so failures don't accumulate as context
          maybeSayAuthExpired(res.text);
          say({ kind: "system", text: `  trace: ${res.runId} (${res.trace.outcome}, ${res.trace.tokens} tok, ${res.trace.costUsd == null ? "subscription" : "$" + res.trace.costUsd.toFixed(4)})` });
        }
        setRoster(loadIndex(props.db)); // create_agent may have grown the squad
      } else {
        const target = await loadAgent(props.ws, parsed.to).catch(() => null);
        if (!target) { say({ kind: "system", text: `No agent "${parsed.to}". Try /agents, or describe one to root.` }); return; }
        const res = await executeRun(deps(activeModel), { agent: target, messages: [{ role: "user", content: parsed.text }], triggeredBy: "user" });
        say({ kind: "agent", from: target.id, text: res.text });
        if (res.trace.outcome === "failed") maybeSayAuthExpired(res.text);
        say({ kind: "system", text: `  trace: ${res.runId} (${res.trace.outcome}, ${res.trace.tokens} tok, ${res.trace.costUsd == null ? "subscription" : "$" + res.trace.costUsd.toFixed(4)}, ${res.trace.artifacts.length} artifact(s))` });
      }
    } finally { setBusy(false); }
  };

  const runSlash = async (cmd: string, arg: string) => {
    if (cmd === "status") { say({ kind: "system", text: `  ${formatAuthStatus(authSource)}` }); return; }
    if (cmd === "login") {
      if (arg && arg !== "openai") { say({ kind: "system", text: `  unknown login target: ${arg} (try /login openai)` }); return; }
      setBusy(true);
      say({ kind: "system", text: "  opening browser…" });
      try {
        const src = await props.onLogin();
        const built = props.buildFromAuth(src);
        // Re-arm the live model/resolver/pricer state, then flip authSource. The NEXT submit reads
        // these via deps(), so the REPL is usable without restart.
        setModel(built.model);
        setResolveModel(() => built.resolveModel);
        setPriceUsd(() => built.priceUsd);
        setAuthSource(src);
        say({ kind: "system", text: "  signed in with ChatGPT — ready." });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        say({ kind: "system", text: `  login failed: ${msg}` });
      } finally { setBusy(false); }
      return;
    }
    if (cmd === "logout") {
      if (arg && arg !== "openai") { say({ kind: "system", text: `  unknown logout target: ${arg} (try /logout openai)` }); return; }
      props.onLogout();
      setModel(null);
      setResolveModel(() => undefined);
      setPriceUsd(() => undefined);
      setAuthSource({ kind: "none" });
      say({ kind: "system", text: "  logged out of openai." });
      return;
    }
    runSlashPure(cmd, arg, {
      roster,
      listTraces: (a?: string) => listTraces(props.ws, a),
      readTrace: (id: string) => readTrace(props.ws, id),
    }).forEach(say);
  };

  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} color={l.kind === "user" ? "white" : l.kind === "system" ? "gray" : "green"}>
          {l.kind === "user" ? "> " : l.from ? `${l.from}: ` : ""}{l.text}
        </Text>
      ))}
      {pending ? (
        <ProposalCard
          title="New agent — approve?"
          fields={[
            { label: "id", value: pending.req.draft.id },
            { label: "role", value: pending.req.draft.role },
            { label: "soul", value: pending.req.draft.identity.slice(0, 120) },
          ]}
          onDecision={(d) => { const r = pending.resolve; setPending(null); r(d); }}
        />
      ) : (
        <Box>
          <Text color="cyan">{busy ? "… " : "> "}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} />
        </Box>
      )}
    </Box>
  );
}

function initialLines(p: { model: Model | null; roster: RegistryRow[]; authSource: AuthSource }): Line[] {
  if (p.authSource.kind === "none")
    return noCredentialLines().map((text) => ({ kind: "system", text }));
  if (!p.model)
    return [
      { kind: "system", text: "taicho — no API key configured." },
      { kind: "system", text: "Set ANTHROPIC_API_KEY or OPENAI_API_KEY, then relaunch." },
    ];
  if (p.roster.filter((r) => !r.is_root).length === 0)
    return [
      { kind: "system", text: "taicho — your squad is empty (root is ready)." },
      { kind: "system", text: 'Describe your first agent to me (e.g. "I need a researcher that covers geopolitics, with web search"). /agents to list, ESC to quit.' },
    ];
  return [{ kind: "system", text: "taicho — squad ready. Bare messages go to root; @agent to address directly; /runs, /trace, /agents. ESC to quit." }];
}
