import { useState, useRef, useEffect } from "react";
import { Box, Text, useInput, useApp, type Key } from "ink";
import TextInput from "ink-text-input";
import type { Database } from "bun:sqlite";
import { ProposalCard, type CardKeyHandler } from "./ProposalCard";
import { QuestionCard } from "./QuestionCard";
import { parseInput } from "./input";
import { makeDeps, executeRun, type Model, type ApprovalRequest, type ApprovalDecision } from "../core/run";
import { loadAgent, loadIndex, type RegistryRow } from "../store/roster";
import { listTraces, readTrace } from "../store/trace";
import { listPolicies, deletePolicy } from "../store/policy";
import { appendTurn, shouldPersistTurn } from "../store/thread";
import type { ModelMessage } from "ai";
import type { AuthSource, TaichoConfig } from "../store/config";
import { formatAuthStatus, noCredentialLines, authExpiredMessage } from "../core/auth/status";
import { runSlash as runSlashPure, type Line, type SlashCommand, suggestCommands, cycleIndex } from "./slash";
import { draftPolicy, persistApprovedPolicy } from "../coaching/teach";
import { mergeDraft } from "../core/draft";
import type { McpManager } from "../core/mcp/manager";
import { addMcpServer, removeMcpServer } from "../store/mcp-store";
import { parseMcpCommand, formatMcpStatus } from "./slash";

type Pending = { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void } | null;

type ResolveModelFn = (agentId: string) => { model: Model; modelId: string; subscription?: boolean; captureCost?: boolean };
type PriceFn = (u: { inputTokens: number; outputTokens: number }) => number;
interface BuiltAuth { model: Model | null; resolveModel?: ResolveModelFn; priceUsd?: PriceFn }

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Animated run indicator: a braille spinner + the live activity (which agent is doing what) +
 *  elapsed seconds + the controls hint. Owns its own ticker so only this line repaints. */
function RunStatus({ activity }: { activity: string }) {
  const [frame, setFrame] = useState(0);
  const started = useRef(Date.now());
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, []);
  const secs = ((Date.now() - started.current) / 1000).toFixed(1);
  return (
    <Box>
      <Text color="cyan">{SPINNER[frame]} </Text>
      <Text color="yellow">{activity}</Text>
      <Text color="gray">{`  ${secs}s  `}</Text>
      <Text dimColor>esc to cancel · type to steer</Text>
    </Box>
  );
}

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
  rootThread?: ModelMessage[];
  mcp?: McpManager;
  mcpYamlServers?: string[];
}) {
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>(() => initialLines(props));
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(0);
  const [activity, setActivity] = useState("working…"); // live status shown by the run spinner
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
  const thread = useRef<ModelMessage[]>(props.rootThread ?? []);
  const aborter = useRef<AbortController | null>(null);
  // The active approval/question card publishes its key handler here (during its render). App's one
  // boot-registered useInput forwards to it while a card is up — see the useInput below.
  const cardKeyRef = useRef<CardKeyHandler | null>(null);

  // The live suggester: which commands match what's being typed (empty once past the command name).
  const sugg = suggestCommands(input);

  useInput((input, key) => {
    // While a card is up, this boot-registered useInput is the only listener guaranteed to be wired
    // when the captain's first keystroke arrives, so we forward it to the active card. (A card-owned
    // useInput registers a beat after its render commits and would drop that first key — the hang
    // we're fixing.) The card publishes its handler to cardKeyRef during render.
    if (pending) { cardKeyRef.current?.(input, key); return; }
    if (key.escape) { if (busy) { aborter.current?.abort(); say({ kind: "system", text: "  ⊗ cancelling…" }); } else { void (async () => { await props.mcp?.closeAll(); exit(); })(); } return; }
    if (sugg.length > 0) {
      if (key.upArrow)   { setSelected((s) => cycleIndex(s, sugg.length, -1)); return; }
      if (key.downArrow) { setSelected((s) => cycleIndex(s, sugg.length, +1)); return; }
      if (key.tab)       { acceptSuggestion(sugg); return; }
    }
  }, { isActive: true });

  const say = (l: Line) => setLines((prev) => [...prev, l]);

  // Run the highlighted command now (no arg) or fill `/<cmd> ` so the captain can type its argument.
  const acceptSuggestion = (list: SlashCommand[]) => {
    const cmd = list[Math.min(selected, list.length - 1)];
    if (!cmd) return;
    setSelected(0);
    if (cmd.requiresArg) { setInput(`/${cmd.name} `); return; }
    setInput("");
    say({ kind: "user", text: `/${cmd.name}` });
    void runSlash(cmd.name, "");
  };
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
    onStep: ({ tool, agent }) => { if (tool) { setActivity(`${agent} → ${tool}()`); say({ kind: "system", text: `  ↳ ${agent} → ${tool}()` }); } },
    pollSteer: () => steerQueue.current.shift() ?? null,
    signal: aborter.current?.signal,
    priceUsd,
    resolveModel,
    configDefaults: props.configDefaults,
    mcp: props.mcp,
  });

  const submit = async (value: string) => {
    if (!value.trim()) return;

    if (busy) { setInput(""); steerQueue.current.push(value); say({ kind: "user", text: `(steer) ${value}` }); return; }

    const matches = suggestCommands(value);
    if (matches.length > 0) { acceptSuggestion(matches); return; } // Enter selects the highlighted command
    setInput("");

    const parsed = parseInput(value);
    say({ kind: "user", text: value });

    // Slash commands work even without a model (e.g. /login to acquire one).
    if (parsed.kind === "slash") return runSlash(parsed.cmd, parsed.arg);

    if (!model) { say({ kind: "system", text: "No credentials — set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY and relaunch, or run /login openai. I won't burn tokens until then." }); return; }
    const activeModel = model;

    setBusy(true);
    setActivity(parsed.kind === "address" ? `${parsed.to} · thinking…` : "root · thinking…");
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
          if (shouldPersistTurn(res.trace.outcome)) {
            appendTurn(props.ws, "root", { role: "user", content: parsed.text });
            appendTurn(props.ws, "root", { role: "assistant", content: res.text });
          }
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
    } catch (e) {
      // A pre-run failure that throws rather than returning a failed RunResult — e.g. resolveModel's
      // explicit-model guard for a misconfigured OpenRouter agent. Surface it instead of crashing Ink.
      say({ kind: "system", text: `  ${e instanceof Error ? e.message : String(e)}` });
    } finally { setBusy(false); }
  };

  const runSlash = async (cmd: string, arg: string) => {
    if (cmd === "status") { say({ kind: "system", text: `  ${formatAuthStatus(authSource)}` }); return; }
    if (cmd === "login") {
      if (arg && arg !== "openai") { say({ kind: "system", text: `  unknown login target: ${arg} (try /login openai)` }); return; }
      setBusy(true);
      setActivity("signing in…");
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
    if (cmd === "mcp") {
      if (!props.mcp) { say({ kind: "system", text: "  MCP is disabled (set mcp.enabled in taicho.yaml or add a server)." }); return; }
      const mcp = props.mcp;
      const parsed = parseMcpCommand(arg);
      if (parsed.kind === "error") { say({ kind: "system", text: `  ${parsed.message}` }); return; }
      if (parsed.kind === "list") { formatMcpStatus(mcp.list()).forEach((t) => say({ kind: "system", text: t })); return; }
      const inYaml = (props.mcpYamlServers ?? []).includes(parsed.name);
      if (parsed.kind === "remove") {
        const inStore = removeMcpServer(props.ws, parsed.name);
        const live = await mcp.removeServer(parsed.name);
        if (inYaml) say({ kind: "system", text: `  "${parsed.name}" is defined in taicho.yaml — dropped for this session; edit the file to remove it permanently.` });
        else say({ kind: "system", text: inStore || live ? `  removed "${parsed.name}".` : `  no such MCP server "${parsed.name}".` });
        return;
      }
      if (parsed.kind === "add" && inYaml) { say({ kind: "system", text: `  "${parsed.name}" is already defined in taicho.yaml — edit the file, or add it under a different name.` }); return; }
      // add | login | reconnect — all may connect (and open a browser for OAuth).
      setBusy(true);
      const verb = parsed.kind === "add" ? "connecting" : parsed.kind === "login" ? "signing in to" : "reconnecting";
      setActivity(`${verb} ${parsed.name}…`);
      say({ kind: "system", text: `  ${verb} "${parsed.name}"…` });
      try {
        let st;
        if (parsed.kind === "add") { addMcpServer(props.ws, parsed.name, parsed.spec); st = await mcp.addServer(parsed.name, parsed.spec); }
        else if (parsed.kind === "login") st = await mcp.login(parsed.name);
        else st = await mcp.reconnect(parsed.name);
        formatMcpStatus([st]).forEach((t) => say({ kind: "system", text: t }));
        if (st.status === "connected" && parsed.kind === "add") say({ kind: "system", text: `  add "mcp:${parsed.name}" to an agent's tools to let it use these.` });
      } catch (e) {
        say({ kind: "system", text: `  ${parsed.kind} failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally { setBusy(false); }
      return;
    }
    if (cmd === "teach") {
      const spaceIdx = arg.indexOf(" ");
      const agentId = spaceIdx === -1 ? arg : arg.slice(0, spaceIdx);
      const correction = spaceIdx === -1 ? "" : arg.slice(spaceIdx + 1).trim();
      if (!agentId || !correction) { say({ kind: "system", text: "  usage: /teach <agentId> <correction>" }); return; }
      if (!roster.some((r) => r.id === agentId)) { say({ kind: "system", text: `No agent "${agentId}". Try /agents.` }); return; }
      if (!model) { say({ kind: "system", text: "  no model — set credentials first" }); return; }
      const activeModel = model;
      setBusy(true);
      setActivity(`teaching ${agentId}…`);
      try {
        const draft = await draftPolicy(activeModel, agentId, correction);
        const decision = await requestApproval({ kind: "propose_coaching", draft });
        if (decision.type === "reject") { say({ kind: "system", text: "  discarded" }); }
        else {
          const finalDraft = decision.type === "edit" ? mergeDraft(draft, decision.draft) : draft;
          persistApprovedPolicy(props.ws, finalDraft, agentId);
          say({ kind: "system", text: `  taught ${agentId}: ${finalDraft.do}` });
        }
      } catch (e) {
        say({ kind: "system", text: `  teach error: ${e instanceof Error ? e.message : String(e)}` });
      } finally { setBusy(false); }
      return;
    }
    runSlashPure(cmd, arg, {
      roster,
      listTraces: (a?: string) => listTraces(props.ws, a),
      readTrace: (id: string) => readTrace(props.ws, id),
      listPolicies: (a: string) => listPolicies(props.ws, a),
      deletePolicy: (a: string, p: string) => deletePolicy(props.ws, a, p),
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
        pending.req.kind === "ask_human" ? (
          <QuestionCard
            question={pending.req.question}
            options={pending.req.options}
            keyHandlerRef={cardKeyRef}
            onDecision={(d) => { const r = pending.resolve; cardKeyRef.current = null; setPending(null); r(d); }}
          />
        ) : (
          <ProposalCard
            title={pending.req.kind === "propose_coaching" ? "New coaching note — approve?" : "New agent — approve?"}
            fields={
              pending.req.kind === "propose_coaching"
                ? [
                    { label: "when", value: pending.req.draft.when },
                    { label: "do", value: pending.req.draft.do },
                    { label: "scope", value: pending.req.draft.scope },
                  ]
                : [
                    { label: "id", value: pending.req.draft.id },
                    { label: "role", value: pending.req.draft.role },
                    { label: "identity", value: pending.req.draft.identity },
                  ]
            }
            keyHandlerRef={cardKeyRef}
            onDecision={(d) => { const r = pending.resolve; cardKeyRef.current = null; setPending(null); r(d); }}
          />
        )
      ) : (
        <>
          {busy && <RunStatus activity={activity} />}
          <Box>
            <Text color={busy ? "gray" : "cyan"}>{busy ? "❯ " : "> "}</Text>
            <TextInput value={input} onChange={(v) => { setInput(v); setSelected(0); }} onSubmit={submit} />
          </Box>
          {!pending && sugg.length > 0 && (
            <Box flexDirection="column">
              {sugg.map((c, i) => {
                const on = i === Math.min(selected, sugg.length - 1);
                return (
                  <Text key={c.name} color={on ? "cyan" : "gray"}>
                    {`${on ? "›" : " "} /${c.name}${c.usage ? " " + c.usage : ""} — ${c.summary}`}
                  </Text>
                );
              })}
            </Box>
          )}
        </>
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
