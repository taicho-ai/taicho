import { useState, type MutableRefObject } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { ApprovalDecision } from "@taicho/framework/core/run";
import type { CardKeyHandler } from "./ProposalCard";
import { cycleIndex } from "./slash";

/** An agent's question to the captain: numbered options (pick with 1-N or ↑↓+Enter) plus a free-text
 *  escape hatch ("type your own"). Mirrors ProposalCard's keyHandlerRef + typing-mode-with-TextInput. */
export function QuestionCard(props: {
  question: string;
  options: string[];
  keyHandlerRef: MutableRefObject<CardKeyHandler | null>;
  onDecision: (d: ApprovalDecision) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const total = props.options.length + 1; // options + the "type your own" row
  const answer = (a: string) => props.onDecision({ type: "answered", answer: a });

  // Published synchronously during render (NOT via a card-owned useInput) so App's boot-registered
  // useInput can forward the captain's very FIRST keystroke. A card-owned listener registers via a
  // useEffect that runs a beat after the render commits, so the first key would arrive before the
  // card is listening and be silently dropped — the hang this fixes. In typing mode we only handle
  // Esc; the chars are typed by the TextInput, whose own input handling fires independently.
  props.keyHandlerRef.current = (input, key) => {
    if (typing) { if (key.escape) setTyping(false); return; } // typing handled by the TextInput
    if (key.escape) { props.onDecision({ type: "reject" }); return; }
    if (key.upArrow) { setSelected((s) => cycleIndex(s, total, -1)); return; }
    if (key.downArrow) { setSelected((s) => cycleIndex(s, total, +1)); return; }
    if (key.return) { selected < props.options.length ? answer(props.options[selected]) : setTyping(true); return; }
    const n = Number(input); // 1-N fast path
    if (Number.isInteger(n) && n >= 1 && n <= props.options.length) answer(props.options[n - 1]);
  };

  if (typing)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Text color="yellow" bold>{props.question}</Text>
        <Box>
          <Text color="gray">your answer: </Text>
          <TextInput value={draft} onChange={setDraft} onSubmit={(v) => (v.trim() ? answer(v.trim()) : setTyping(false))} />
        </Box>
        <Text color="gray">Enter to submit · Esc to go back</Text>
      </Box>
    );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>{props.question}</Text>
      {props.options.map((o, i) => (
        <Text key={i} color={i === selected ? "cyan" : undefined}>{`${i === selected ? "›" : " "} ${i + 1}. ${o}`}</Text>
      ))}
      <Text color={selected === props.options.length ? "cyan" : "gray"}>
        {`${selected === props.options.length ? "›" : " "} ✎ type your own answer`}
      </Text>
      <Text color="gray">{`1-${props.options.length} or ↑↓ + Enter · esc to cancel`}</Text>
    </Box>
  );
}
