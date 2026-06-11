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
import type { TaichoConfig } from "../store/config";

type Line = { kind: "user" | "agent" | "system"; from?: string; text: string };
type Pending = { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void } | null;

export function App(props: {
  ws: string; db: Database; model: Model | null; roster: RegistryRow[];
  cfg: { provider: string; model: string } | null;
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
  resolveModel?: (agentId: string) => { model: Model; modelId: string };
  configDefaults?: TaichoConfig["defaults"];
}) {
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>(() => initialLines(props));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [roster, setRoster] = useState(props.roster);
  const steerQueue = useRef<string[]>([]);
  const thread = useRef<ModelMessage[]>([]);
  const aborter = useRef<AbortController | null>(null);

  useInput((_i, key) => {
    if (!key.escape) return;
    if (busy) { aborter.current?.abort(); say({ kind: "system", text: "  ⊗ cancelling…" }); }
    else exit();
  }, { isActive: !pending });

  const say = (l: Line) => setLines((prev) => [...prev, l]);

  const requestApproval = (req: ApprovalRequest) =>
    new Promise<ApprovalDecision>((resolve) => setPending({ req, resolve }));

  const deps = (model: Model) => makeDeps({
    ws: props.ws, db: props.db, model,
    requestApproval,
    onStep: ({ tool, agent }) => { if (tool) say({ kind: "system", text: `  ↳ ${agent} → ${tool}()` }); },
    pollSteer: () => steerQueue.current.shift() ?? null,
    signal: aborter.current?.signal,
    priceUsd: props.priceUsd,
    resolveModel: props.resolveModel,
    configDefaults: props.configDefaults,
  });

  const submit = async (value: string) => {
    if (!value.trim()) return;
    setInput("");

    if (busy) { steerQueue.current.push(value); say({ kind: "user", text: `(steer) ${value}` }); return; }

    const parsed = parseInput(value);
    say({ kind: "user", text: value });

    if (!props.model) { say({ kind: "system", text: "Set ANTHROPIC_API_KEY or OPENAI_API_KEY, then relaunch — I won't burn tokens until then." }); return; }
    const model = props.model;

    if (parsed.kind === "slash") return runSlash(parsed.cmd, parsed.arg);

    setBusy(true);
    steerQueue.current = [];
    aborter.current = new AbortController();
    try {
      if (parsed.kind === "chat") {
        thread.current.push({ role: "user", content: parsed.text });
        const root = await loadAgent(props.ws, "root");
        const res = await executeRun(deps(model), { agent: root, messages: [...thread.current], triggeredBy: "user" });
        say({ kind: "agent", from: "root", text: res.text });
        if (res.trace.outcome === "completed") {
          thread.current.push({ role: "assistant", content: res.text });
        } else {
          thread.current.pop(); // drop the user turn so failures don't accumulate as context
          say({ kind: "system", text: `  trace: ${res.runId} (${res.trace.outcome}, ${res.trace.tokens} tok, ${res.trace.costUsd == null ? "subscription" : "$" + res.trace.costUsd.toFixed(4)})` });
        }
        setRoster(loadIndex(props.db)); // create_agent may have grown the squad
      } else {
        const target = await loadAgent(props.ws, parsed.to).catch(() => null);
        if (!target) { say({ kind: "system", text: `No agent "${parsed.to}". Try /agents, or describe one to root.` }); return; }
        const res = await executeRun(deps(model), { agent: target, messages: [{ role: "user", content: parsed.text }], triggeredBy: "user" });
        say({ kind: "agent", from: target.id, text: res.text });
        say({ kind: "system", text: `  trace: ${res.runId} (${res.trace.outcome}, ${res.trace.tokens} tok, ${res.trace.costUsd == null ? "subscription" : "$" + res.trace.costUsd.toFixed(4)}, ${res.trace.artifacts.length} artifact(s))` });
      }
    } finally { setBusy(false); }
  };

  const runSlash = (cmd: string, arg: string) => {
    if (cmd === "agents") { for (const r of roster) say({ kind: "system", text: `  ${r.is_root ? "*" : "-"} ${r.id}: ${r.role}` }); return; }
    if (cmd === "runs") {
      const traces = listTraces(props.ws, arg || undefined);
      if (!traces.length) say({ kind: "system", text: "  (no runs yet)" });
      for (const t of traces) say({ kind: "system", text: `  ${t.id}  ${t.outcome}  ${t.tokens}tok` });
      return;
    }
    if (cmd === "trace") {
      try {
        const t = readTrace(props.ws, arg);
        say({ kind: "system", text: `  ${t.id} — ${t.task}\n  outcome=${t.outcome} tokens=${t.tokens} tools=${t.toolCalls.map((c) => `${c.tool}×${c.count}`).join(",")}\n  artifacts: ${t.artifacts.join(", ") || "none"}` });
      } catch { say({ kind: "system", text: `  no such trace: ${arg}` }); }
      return;
    }
    say({ kind: "system", text: `  unknown command: /${cmd}` });
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
          onDecision={(d) => { const r = pending.resolve; setPending(null); r({ type: d }); }}
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

function initialLines(p: { model: Model | null; roster: RegistryRow[] }): Line[] {
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
