import { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { ProposalCard, type CardField } from "./ProposalCard";

type Line = { kind: "user" | "agent" | "system"; from?: string; text: string };
type Pending = { title: string; fields: CardField[]; resolve: (d: string) => void } | null;

/** State-aware REPL shell. Deterministic below the LLM line (missing config -> fixed
 *  message, no tokens); conversational above it (missing capability -> proposal). */
export function App(props: { hasApiKey: boolean; rosterEmpty: boolean }) {
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>(() => initialLines(props));
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending>(null);

  useInput((_i, key) => { if (key.escape) exit(); });

  const submit = (value: string) => {
    if (!value.trim()) return;
    setInput("");
    setLines((l) => [...l, { kind: "user", text: value }]);
    if (!props.hasApiKey) {
      setLines((l) => [...l, { kind: "system", text: "Set an API key first (see message above) — I won't burn tokens until then." }]);
      return;
    }
    // TODO: route to root agent / @agent addressing
    setLines((l) => [...l, { kind: "system", text: "[routing not wired yet]" }]);
  };

  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} color={l.kind === "user" ? "white" : l.kind === "system" ? "gray" : "green"}>
          {l.kind === "user" ? "> " : l.from ? `${l.from}: ` : ""}{l.text}
        </Text>
      ))}
      {pending ? (
        <ProposalCard title={pending.title} fields={pending.fields}
          onDecision={(d) => { pending.resolve(d); setPending(null); }} />
      ) : (
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} />
        </Box>
      )}
    </Box>
  );
}

function initialLines(p: { hasApiKey: boolean; rosterEmpty: boolean }): Line[] {
  if (!p.hasApiKey)
    return [
      { kind: "system", text: "taicho — no API key configured." },
      { kind: "system", text: "Set ANTHROPIC_API_KEY or OPENAI_API_KEY (or add one to config.yaml), then relaunch." },
    ];
  if (p.rosterEmpty)
    return [
      { kind: "system", text: "taicho — your squad is empty." },
      { kind: "system", text: "Describe your first agent to me (e.g. \"I need a researcher that covers geopolitics, with web search\")." },
    ];
  return [{ kind: "system", text: "taicho — squad ready. Bare messages go to root; @agent to address someone directly. ESC to quit." }];
}
