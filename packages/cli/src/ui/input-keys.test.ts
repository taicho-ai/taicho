import { test, expect } from "bun:test";
import { classifyKey } from "./input-keys";
import type { Key } from "ink";

// A blank Key with everything false; override the fields a test cares about.
const K = (o: Partial<Key> = {}): Key => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false, ...o,
});

test("printable input inserts; Enter submits", () => {
  expect(classifyKey("a", K())).toEqual({ kind: "insert", text: "a" });
  expect(classifyKey("", K({ return: true }))).toEqual({ kind: "submit" });
});

test("newline: Shift+Enter, Alt+Enter, and Ctrl+J (both encodings); plain Enter still submits", () => {
  expect(classifyKey("", K({ return: true, shift: true })).kind).toBe("newline"); // Shift+Enter (kitty proto)
  expect(classifyKey("", K({ return: true, meta: true })).kind).toBe("newline");  // Alt/Option+Enter
  expect(classifyKey("\n", K())).toEqual({ kind: "newline" });                    // Ctrl+J legacy → raw linefeed
  expect(classifyKey("j", K({ ctrl: true })).kind).toBe("newline");               // Ctrl+J under kitty → j+ctrl
  expect(classifyKey("", K({ return: true })).kind).toBe("submit");               // plain Enter
});

test("plain motions + deletes", () => {
  expect(classifyKey("", K({ leftArrow: true })).kind).toBe("left");
  expect(classifyKey("", K({ rightArrow: true })).kind).toBe("right");
  expect(classifyKey("", K({ backspace: true })).kind).toBe("backspace");
  expect(classifyKey("", K({ delete: true })).kind).toBe("del");
  expect(classifyKey("", K({ home: true })).kind).toBe("home");
  expect(classifyKey("", K({ end: true })).kind).toBe("end");
});

test("history on plain ↑/↓", () => {
  expect(classifyKey("", K({ upArrow: true })).kind).toBe("historyPrev");
  expect(classifyKey("", K({ downArrow: true })).kind).toBe("historyNext");
});

test("Option/Alt word navigation (meta + arrow, and meta+b/f)", () => {
  expect(classifyKey("", K({ meta: true, leftArrow: true })).kind).toBe("wordLeft");
  expect(classifyKey("", K({ meta: true, rightArrow: true })).kind).toBe("wordRight");
  expect(classifyKey("b", K({ meta: true })).kind).toBe("wordLeft");   // Alt+b
  expect(classifyKey("f", K({ meta: true })).kind).toBe("wordRight");  // Alt+f
});

test("delete-word: Option+Backspace, Alt+d forward, and the Ctrl+W fallback", () => {
  expect(classifyKey("", K({ meta: true, backspace: true })).kind).toBe("deleteWordBack");
  expect(classifyKey("", K({ meta: true, delete: true })).kind).toBe("deleteWordForward");
  expect(classifyKey("d", K({ meta: true })).kind).toBe("deleteWordForward"); // Alt+d
  expect(classifyKey("w", K({ ctrl: true })).kind).toBe("deleteWordBack");    // Ctrl+W
});

test("control/navless combos are ignored, not inserted", () => {
  expect(classifyKey("c", K({ ctrl: true })).kind).toBe("noop"); // Ctrl+C handled elsewhere
  expect(classifyKey("", K({ tab: true })).kind).toBe("noop");   // Tab handled by the suggester
});
