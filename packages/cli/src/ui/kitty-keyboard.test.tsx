/** Plan 24 (multi-line): when taicho negotiates the kitty keyboard protocol (index.tsx render options),
 *  terminals report modified keys as CSI-u sequences instead of legacy bytes. This locks in the exact
 *  decoding contract the multi-line + Ctrl+C wiring depends on — if a future Ink upgrade changes how it
 *  parses these sequences, THIS breaks rather than the app silently losing Shift+Enter or Ctrl+C-to-quit.
 *
 *  Uses the REAL `ink` render (not ink-testing-library) over a fake-TTY PassThrough, because the thing
 *  under test is Ink's stdin→keypress decoding + our `exitOnCtrlC:false` ownership of Ctrl+C — neither of
 *  which ink-testing-library exercises (it strips TTY and doesn't surface exit). */
import { test, expect } from "bun:test";
import React from "react";
import { render, Text, useInput, type Key } from "ink";
import { PassThrough } from "node:stream";
import { classifyKey } from "./input-keys";

const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const fakeIn = (): NodeJS.ReadStream => {
  const s = new PassThrough() as unknown as NodeJS.ReadStream & { setRawMode: () => unknown };
  Object.assign(s, { isTTY: true, setRawMode: () => s, ref: () => s, unref: () => s });
  s.setEncoding("utf8");
  return s;
};
const fakeOut = (): NodeJS.WriteStream => {
  const s = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(s, { isTTY: true, columns: 80, rows: 24 });
  s.on("data", () => {}); // drain the protocol-enable escape writes
  return s;
};

/** Render a probe that records the (input, key) Ink decodes for each written sequence. */
async function decode(sequences: string[]): Promise<Array<{ input: string; key: Key }>> {
  const seen: Array<{ input: string; key: Key }> = [];
  function Probe() {
    useInput((input, key) => { seen.push({ input, key }); });
    return <Text>hi</Text>;
  }
  const stdin = fakeIn();
  const app = render(<Probe />, { stdin, stdout: fakeOut(), exitOnCtrlC: false, patchConsole: false });
  await sleep(30);
  for (const seq of sequences) { stdin.write(seq); await sleep(40); }
  app.unmount();
  await sleep(20);
  return seen;
}

test("Ink decodes kitty CSI-u sequences into the expected Key shape", async () => {
  const [enter, shiftEnter, ctrlJ, esc, ctrlC, shiftTab] = await decode([
    "\r",          // plain Enter (stays legacy even under the protocol)
    "\x1b[13;2u",  // Shift+Enter
    "\x1b[106;5u", // Ctrl+J
    "\x1b[27u",    // Esc
    "\x1b[99;5u",  // Ctrl+C
    "\x1b[9;2u",   // Shift+Tab
  ]);
  expect(enter!.key.return).toBe(true);
  expect(shiftEnter!.key.return).toBe(true);
  expect(shiftEnter!.key.shift).toBe(true);       // ← the distinction a bare \r could never carry
  expect(ctrlJ!.input).toBe("j"); expect(ctrlJ!.key.ctrl).toBe(true);
  expect(esc!.key.escape).toBe(true);             // App's cancel/quit reads key.escape
  expect(ctrlC!.input).toBe("c"); expect(ctrlC!.key.ctrl).toBe(true); // App's quit reads ctrl + 'c'
  expect(shiftTab!.key.shift).toBe(true); expect(shiftTab!.key.tab).toBe(true); // focus mode
});

test("classifyKey maps the decoded kitty keys correctly (Shift+Enter & Ctrl+J → newline)", async () => {
  const [shiftEnter, ctrlJ, ctrlC, esc] = await decode(["\x1b[13;2u", "\x1b[106;5u", "\x1b[99;5u", "\x1b[27u"]);
  expect(classifyKey(shiftEnter!.input, shiftEnter!.key).kind).toBe("newline");
  expect(classifyKey(ctrlJ!.input, ctrlJ!.key).kind).toBe("newline");
  expect(classifyKey(ctrlC!.input, ctrlC!.key).kind).toBe("noop"); // Ctrl+C is owned by App, not the editor
  expect(classifyKey(esc!.input, esc!.key).kind).toBe("noop");     // Esc is owned by App, not the editor
});

test("with exitOnCtrlC:false, a ctrl+'c' handler fires under BOTH the legacy and kitty encodings", async () => {
  async function fires(seq: string): Promise<boolean> {
    let hit = false;
    function App() {
      useInput((input, key) => { if (key.ctrl && input === "c") hit = true; });
      return <Text>hi</Text>;
    }
    const stdin = fakeIn();
    const app = render(<App />, { stdin, stdout: fakeOut(), exitOnCtrlC: false, patchConsole: false });
    await sleep(30);
    stdin.write(seq);
    await sleep(100);
    app.unmount();
    await sleep(20);
    return hit;
  }
  expect(await fires("\x03")).toBe(true);        // legacy Ctrl+C
  expect(await fires("\x1b[99;5u")).toBe(true);  // kitty Ctrl+C — Ink's built-in exitOnCtrlC would MISS this
});
