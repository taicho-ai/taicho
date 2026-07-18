import { test, expect } from "bun:test";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { ChatInput } from "./ChatInput";

const ENTER = "\r";
const OPT_BACKSPACE = "\x1b\x7f"; // Option+Backspace (ESC + DEL) — Ink sets {backspace, meta}
const CTRL_W = "\x17";            // Ctrl+W
const CTRL_J = "\n";              // Ctrl+J → raw linefeed (universal newline fallback)
const SHIFT_ENTER = "\x1b[13;2u"; // kitty-protocol Shift+Enter → Ink sets {return, shift}
const UP = "\x1b[A";              // ↑
const DOWN = "\x1b[B";            // ↓
const LEFT = "\x1b[D";            // ←
const RIGHT = "\x1b[C";           // →
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

test("the cursor VISIBLY moves on ←/→ (the desync bug: it used to stay stale until you typed)", async () => {
  const { stdin, lastFrame } = render(<Harness />);
  await sleep();
  stdin.write("abcde"); await sleep();
  expect(lastFrame()).toContain("abcde▏");   // caret at end (▏ marks the cursor off-TTY)
  stdin.write(LEFT); stdin.write(LEFT); await sleep();
  expect(lastFrame()).toContain("abc▏de");   // moved between c and d — re-rendered, not stuck
  expect(lastFrame()).not.toContain("abcde▏");
  stdin.write(RIGHT); await sleep();
  expect(lastFrame()).toContain("abcd▏e");   // → moves it back one
});

test("Shift+Enter inserts a newline (Enter still submits); the message spans two rows", async () => {
  let submitted = "";
  const { stdin, lastFrame } = render(<Harness onSubmit={(v) => (submitted = v)} />);
  await sleep();
  stdin.write("aaa"); await sleep();
  stdin.write(SHIFT_ENTER); await sleep(); // a newline, NOT a submit
  stdin.write("bbb"); await sleep();
  const f = lastFrame()!;
  expect(f).toContain("aaa"); expect(f).toContain("bbb▏");
  expect(f.indexOf("bbb")).toBeGreaterThan(f.indexOf("aaa") + 3); // on a later row, not the same line
  expect(submitted).toBe(""); // Shift+Enter did not submit
  stdin.write(ENTER); await sleep(); // NOW submit
  expect(submitted).toBe("aaa\nbbb");
});

test("Ctrl+J inserts a newline too (the terminal-agnostic fallback)", async () => {
  let submitted = "";
  const { stdin } = render(<Harness onSubmit={(v) => (submitted = v)} />);
  await sleep();
  stdin.write("one"); await sleep();
  stdin.write(CTRL_J); await sleep();
  stdin.write("two"); await sleep();
  stdin.write(ENTER); await sleep();
  expect(submitted).toBe("one\ntwo");
});

test("↑/↓ move by LINE inside a multi-line message (keeping the column)", async () => {
  const { stdin, lastFrame } = render(<Harness />);
  await sleep();
  stdin.write("hello"); await sleep();
  stdin.write(CTRL_J); await sleep();
  stdin.write("world"); await sleep();
  expect(lastFrame()).toContain("world▏");   // caret at end of the bottom line (col 5)
  stdin.write(UP); await sleep();
  expect(lastFrame()).toContain("hello▏");   // ↑ jumped to the top line, same column
  expect(lastFrame()).not.toContain("world▏");
  stdin.write(DOWN); await sleep();
  expect(lastFrame()).toContain("world▏");   // ↓ came back down
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

// Suggester opens whenever the value starts with "/" — mirrors App's `sugg.length > 0`.
function SmartHarness(props: { onSubmit?: (v: string) => void; history?: string[] }) {
  const [value, setValue] = useState("");
  return (
    <ChatInput
      value={value} onChange={setValue}
      onSubmit={(v) => { props.onSubmit?.(v); setValue(""); }}
      history={props.history ?? []} isActive
      suggestOpen={value.startsWith("/")} onSuggestNav={() => {}} onSuggestAccept={() => {}}
      placeholder="p" width={40}
    />
  );
}

test("history browsing is sticky: ↑ walks PAST a recalled slash command, not trapped by the menu", async () => {
  let submitted = "";
  const { stdin } = render(<SmartHarness onSubmit={(v) => (submitted = v)} history={["hello", "/help", "world"]} />);
  await sleep();
  stdin.write(UP); await sleep();  // -> "world"
  stdin.write(UP); await sleep();  // -> "/help" (suggestOpen becomes true)
  stdin.write(UP); await sleep();  // -> "hello" (still history, because we're browsing)
  stdin.write(ENTER); await sleep();
  expect(submitted).toBe("hello");
});
