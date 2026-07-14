import { test, expect } from "bun:test";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { ChatInput } from "./ChatInput";

const ENTER = "\r";
const OPT_BACKSPACE = "\x1b\x7f"; // Option+Backspace (ESC + DEL) — Ink sets {backspace, meta}
const CTRL_W = "\x17";            // Ctrl+W
const UP = "\x1b[A";              // ↑
const sleep = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function Harness(props: { onSubmit?: (v: string) => void; history?: string[] }) {
  const [value, setValue] = useState("");
  return (
    <ChatInput
      value={value} onChange={setValue}
      onSubmit={(v) => { props.onSubmit?.(v); setValue(""); }}
      history={props.history ?? []} isActive suggestOpen={false}
      placeholder="message root" width={40}
    />
  );
}

test("renders a bordered box with the prompt + placeholder", async () => {
  const { lastFrame } = render(<Harness />);
  await sleep();
  const f = lastFrame()!;
  expect(f).toContain("╭"); expect(f).toContain("╰"); // the box: a line above and below
  expect(f).toContain("message root");
});

test("typing inserts and Enter submits the value", async () => {
  let submitted = "";
  const { stdin } = render(<Harness onSubmit={(v) => (submitted = v)} />);
  await sleep();
  stdin.write("hello"); await sleep();
  stdin.write(ENTER); await sleep();
  expect(submitted).toBe("hello");
});

test("Option+Backspace deletes the previous WORD, not one char", async () => {
  let submitted = "";
  const { stdin } = render(<Harness onSubmit={(v) => (submitted = v)} />);
  await sleep();
  stdin.write("the quick fox"); await sleep();
  stdin.write(OPT_BACKSPACE); await sleep();   // deletes the word "fox", keeping the separator space
  stdin.write(ENTER); await sleep();
  expect(submitted).toBe("the quick "); // the whole word went, not one char (would be "the quick fo")
});

test("Ctrl+W deletes the previous word (the universal fallback)", async () => {
  let submitted = "";
  const { stdin } = render(<Harness onSubmit={(v) => (submitted = v)} />);
  await sleep();
  stdin.write("alpha beta"); await sleep();
  stdin.write(CTRL_W); await sleep();
  stdin.write(ENTER); await sleep();
  expect(submitted).toBe("alpha "); // "beta" removed as one word, separator space kept
});

test("↑ recalls the last submitted message", async () => {
  let submitted = "";
  const { stdin } = render(<Harness onSubmit={(v) => (submitted = v)} history={["first", "second"]} />);
  await sleep();
  stdin.write(UP); await sleep();  // ↑ -> "second"
  stdin.write(ENTER); await sleep();
  expect(submitted).toBe("second");
});
