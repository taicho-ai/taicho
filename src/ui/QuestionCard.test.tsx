import { test, expect } from "bun:test";
import { useRef } from "react";
import { render } from "ink-testing-library";
import { useInput } from "ink";
import { QuestionCard } from "./QuestionCard";
import type { ApprovalDecision } from "../core/run";
import type { CardKeyHandler } from "./ProposalCard";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\u001B[B"; // ANSI cursor-down (arrow key)
const ESC = "\u001B"; // ESC key

// Mirrors how App drives a card: ONE boot-registered useInput forwards each keystroke to the handler
// the card publishes via keyHandlerRef. The card owns no useInput of its own (that's the fix for the
// dropped-first-keystroke hang), so these isolation tests exercise it through the same contract.
function Harness(props: { question: string; options: string[]; onDecision: (d: ApprovalDecision) => void }) {
  const ref = useRef<CardKeyHandler | null>(null);
  useInput((input, key) => { ref.current?.(input, key); });
  return (
    <QuestionCard question={props.question} options={props.options} keyHandlerRef={ref} onDecision={props.onDecision} />
  );
}

test("renders the question, numbered options, and the custom row", () => {
  const { lastFrame } = render(<Harness question="Favorite color?" options={["red", "blue", "green"]} onDecision={() => {}} />);
  const f = lastFrame() ?? "";
  expect(f).toContain("Favorite color?");
  expect(f).toContain("1. red");
  expect(f).toContain("2. blue");
  expect(f).toContain("3. green");
  expect(f).toContain("type your own");
});

test("a number key answers with that option immediately", async () => {
  let decision: ApprovalDecision | undefined;
  const { stdin } = render(<Harness question="q" options={["red", "blue"]} onDecision={(d) => { decision = d; }} />);
  await sleep(20); // let the harness's useInput register before the keystroke
  stdin.write("2");
  await sleep(30);
  expect(decision).toEqual({ type: "answered", answer: "blue" });
});

test("down-arrow to the custom row + Enter opens free-text; typing + Enter answers", async () => {
  let decision: ApprovalDecision | undefined;
  const { stdin, lastFrame } = render(<Harness question="q" options={["red", "blue"]} onDecision={(d) => { decision = d; }} />);
  await sleep(20);
  stdin.write(DOWN); await sleep(20);   // → blue
  stdin.write(DOWN); await sleep(20);   // → custom row
  stdin.write("\r"); await sleep(20);   // → free-text mode
  expect(lastFrame()).toContain("your answer");
  stdin.write("teal"); await sleep(20);
  stdin.write("\r"); await sleep(20);
  expect(decision).toEqual({ type: "answered", answer: "teal" });
});

test("Esc cancels (reject)", async () => {
  let decision: ApprovalDecision | undefined;
  const { stdin } = render(<Harness question="q" options={["red", "blue"]} onDecision={(d) => { decision = d; }} />);
  await sleep(20);
  stdin.write(ESC);
  await sleep(30);
  expect(decision).toEqual({ type: "reject" });
});
