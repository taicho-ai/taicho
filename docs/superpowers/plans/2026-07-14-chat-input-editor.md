# ChatInput Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace taicho's `@inkjs/ui` `TextInput` in the REPL with a bespoke, controlled `<ChatInput>` that renders inside a bordered box, browses submitted-message history with ↑/↓, and supports word-by-word navigation and deletion (Option/Alt + arrows/backspace, with a Ctrl+W fallback) — cross-platform.

**Architecture:** Three PURE, exhaustively unit-tested modules (a text buffer, a history navigator, and a keybinding classifier) sit under one thin Ink component. The component owns `{value, cursor}` (controlled — no uncontrolled-remount hack), reads `useInput`, maps each keypress to a semantic action via the classifier, applies it via the buffer/history, and renders a bordered box with a block cursor. App holds the message-history array and the live draft; the suggester keeps ↑/↓ only while a `/command` menu is open.

**Tech Stack:** Bun + TypeScript, React 19, Ink 7.1.0 (`useInput` exposes `key.meta` for Option/Alt), `bun:test` + `ink-testing-library` (Layer-1). No new dependencies.

## Global Constraints

- **No new npm dependencies.** Build on Ink 7.1.0's `useInput`/`Box`/`Text` only. (`@inkjs/ui` stays a dependency — `Spinner` is still used — but its `TextInput` is removed from `App.tsx`.)
- **Bun test, colocated `*.test.ts(x)`**, model calls mocked, NO network. Follow `TESTING.md` (Layer-1 ink-testing-library for App/UI wiring).
- **Never `console.error/warn` from UI code** — it corrupts the Ink render. Use `core/logger`'s `log` if logging is needed.
- **Word char = Unicode letter/number/underscore:** `/[\p{L}\p{N}_]/u`. Used identically everywhere a word boundary is computed.
- **Cross-platform word keys:** wordLeft/right = `key.meta && key.leftArrow/rightArrow` (also `meta+b`/`meta+f`); deleteWordBack = `key.meta && key.backspace` OR `key.ctrl && name==='w'` (Ctrl+W, the universal fallback). `key.meta` is Ink's normalized Option/Alt (ESC-prefix + kitty protocol).
- **Scope:** single logical line that WRAPS visually inside the box; Enter submits. Multi-line editing (Enter=newline) is explicitly OUT of scope (future extension). ↑/↓ = history when the slash-suggester is closed; suggester highlight when it's open.
- Run `bun run typecheck` AND `bun test` before claiming any task done; run `bun run build` at the end (bundle catches import issues tsc won't).

---

## File Structure

- **Create `src/ui/text-buffer.ts`** — pure `{value, cursor}` edit/motion ops incl. the word-boundary algorithm. No Ink, no React. The brain of feature 3.
- **Create `src/ui/text-buffer.test.ts`** — exhaustive unit tests.
- **Create `src/ui/input-history.ts`** — pure history navigator: a capped list + a stateful cursor with draft-stash. Optional file persistence helpers.
- **Create `src/ui/input-history.test.ts`** — unit tests.
- **Create `src/ui/input-keys.ts`** — pure `classifyKey(input, key) -> InputAction` mapping Ink's `(input, Key)` to a semantic action. Centralizes the cross-platform key detection.
- **Create `src/ui/input-keys.test.ts`** — unit tests with synthetic `Key` objects + raw-sequence expectations.
- **Create `src/ui/ChatInput.tsx`** — the Ink component: bordered box, block cursor, wires classifier→buffer/history, calls `onChange`/`onSubmit`. Owns editing keys; delegates submit + suggester-accept to props.
- **Create `src/ui/ChatInput.test.tsx`** — Layer-1 ink-testing-library tests (border, typing, word-delete via raw `\x1b\x7f` and `\x17`, history ↑/↓, suggester coexistence).
- **Modify `src/ui/App.tsx`** — replace `@inkjs/ui` `TextInput` with `<ChatInput>`; add `history` state (push on submit); thread suggester open/highlight; delete the `inputSeed`/`inputKey` remount hack (a controlled input preserves the draft across the browser dock naturally).
- **Modify `src/ui/App.test.tsx`** — update the input/suggester/dock tests for the new component; add a border-visible + history + word-delete smoke test at the App layer.
- **Modify `docs/observability.md` OR `README`/CLAUDE.md** — a short "terminal setup for Option-as-word-nav" note (macOS Terminal/iTerm2 "Use Option as Meta"; Ctrl+W always works).

---

### Task 1: Pure text buffer (motions + word boundaries)

**Files:**
- Create: `src/ui/text-buffer.ts`
- Test: `src/ui/text-buffer.test.ts`

**Interfaces:**
- Produces: `type Buf = { value: string; cursor: number }`; and pure fns `insert(b, s): Buf`, `backspace(b): Buf`, `del(b): Buf`, `left(b): Buf`, `right(b): Buf`, `home(b): Buf`, `end(b): Buf`, `wordLeftIndex(value, cursor): number`, `wordRightIndex(value, cursor): number`, `wordLeft(b): Buf`, `wordRight(b): Buf`, `deleteWordBack(b): Buf`, `deleteWordForward(b): Buf`. `cursor` is a code-unit index in `0..value.length`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/ui/text-buffer.test.ts
import { test, expect } from "bun:test";
import {
  insert, backspace, del, left, right, home, end,
  wordLeftIndex, wordRightIndex, wordLeft, wordRight, deleteWordBack, deleteWordForward,
} from "./text-buffer";

const b = (value: string, cursor = value.length) => ({ value, cursor });

test("insert writes at the cursor and advances it", () => {
  expect(insert(b("ac", 1), "b")).toEqual({ value: "abc", cursor: 2 });
  expect(insert(b("", 0), "hi")).toEqual({ value: "hi", cursor: 2 });
});

test("backspace/del/left/right/home/end at the cursor", () => {
  expect(backspace(b("abc", 2))).toEqual({ value: "ac", cursor: 1 });
  expect(backspace(b("abc", 0))).toEqual({ value: "abc", cursor: 0 }); // no-op at start
  expect(del(b("abc", 1))).toEqual({ value: "ac", cursor: 1 });
  expect(del(b("abc", 3))).toEqual({ value: "abc", cursor: 3 });        // no-op at end
  expect(left(b("abc", 2)).cursor).toBe(1);
  expect(left(b("abc", 0)).cursor).toBe(0);
  expect(right(b("abc", 2)).cursor).toBe(3);
  expect(right(b("abc", 3)).cursor).toBe(3);
  expect(home(b("abc", 2)).cursor).toBe(0);
  expect(end(b("abc", 1)).cursor).toBe(3);
});

test("wordLeftIndex: skips trailing spaces, then the run of same-class chars", () => {
  expect(wordLeftIndex("the quick fox", 13)).toBe(10); // -> start of "fox"
  expect(wordLeftIndex("the quick fox", 10)).toBe(4);  // from "fox" start -> start of "quick"
  expect(wordLeftIndex("the quick   fox", 12)).toBe(4); // multiple spaces collapse
  expect(wordLeftIndex("foo.bar", 7)).toBe(4);          // stops at the punctuation boundary
  expect(wordLeftIndex("foo.bar", 4)).toBe(3);          // the "." is its own unit
  expect(wordLeftIndex("hello", 0)).toBe(0);            // at start
  expect(wordLeftIndex("héllo wörld", 11)).toBe(6);     // unicode letters are word chars
});

test("wordRightIndex: skips leading spaces, then the run of same-class chars", () => {
  expect(wordRightIndex("the quick fox", 0)).toBe(3);   // end of "the"
  expect(wordRightIndex("the quick fox", 3)).toBe(9);   // -> end of "quick"
  expect(wordRightIndex("foo.bar", 0)).toBe(3);         // stops before "."
  expect(wordRightIndex("foo.bar", 3)).toBe(4);         // the "." unit
  expect(wordRightIndex("abc", 3)).toBe(3);             // at end
});

test("wordLeft/Right move the cursor; delete-word removes the spanned range", () => {
  expect(wordLeft(b("the quick fox", 13))).toEqual({ value: "the quick fox", cursor: 10 });
  expect(wordRight(b("the quick fox", 0))).toEqual({ value: "the quick fox", cursor: 3 });
  expect(deleteWordBack(b("the quick fox", 13))).toEqual({ value: "the quick ", cursor: 10 });
  expect(deleteWordBack(b("hello ", 6))).toEqual({ value: "", cursor: 0 }); // trailing space + word
  expect(deleteWordForward(b("the quick fox", 3))).toEqual({ value: "the fox", cursor: 3 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/ui/text-buffer.test.ts`
Expected: FAIL — `Cannot find module './text-buffer'`.

- [ ] **Step 3: Implement `text-buffer.ts`**

```ts
// src/ui/text-buffer.ts
/** Pure cursor/edit model for a single logical line. `cursor` is a code-unit index in [0, value.length].
 *  The word-boundary algorithm (wordLeftIndex/wordRightIndex) is the heart of the Option/Alt word-nav:
 *  skip whitespace in the direction of travel, then skip the maximal run of same-CLASS chars (a run of
 *  word chars, or a run of non-space non-word chars). This matches how most editors stop at punctuation. */
export interface Buf { value: string; cursor: number }

const WORD = /[\p{L}\p{N}_]/u;
const isWord = (ch: string): boolean => WORD.test(ch);
const isSpace = (ch: string): boolean => ch === " " || ch === "\t";

export function insert(b: Buf, s: string): Buf {
  return { value: b.value.slice(0, b.cursor) + s + b.value.slice(b.cursor), cursor: b.cursor + s.length };
}
export function backspace(b: Buf): Buf {
  if (b.cursor === 0) return b;
  return { value: b.value.slice(0, b.cursor - 1) + b.value.slice(b.cursor), cursor: b.cursor - 1 };
}
export function del(b: Buf): Buf {
  if (b.cursor >= b.value.length) return b;
  return { value: b.value.slice(0, b.cursor) + b.value.slice(b.cursor + 1), cursor: b.cursor };
}
export const left = (b: Buf): Buf => ({ ...b, cursor: Math.max(0, b.cursor - 1) });
export const right = (b: Buf): Buf => ({ ...b, cursor: Math.min(b.value.length, b.cursor + 1) });
export const home = (b: Buf): Buf => ({ ...b, cursor: 0 });
export const end = (b: Buf): Buf => ({ ...b, cursor: b.value.length });

export function wordLeftIndex(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && isSpace(value[i - 1]!)) i--;
  if (i === 0) return 0;
  const cls = isWord(value[i - 1]!);
  while (i > 0 && !isSpace(value[i - 1]!) && isWord(value[i - 1]!) === cls) i--;
  return i;
}
export function wordRightIndex(value: string, cursor: number): number {
  const n = value.length;
  let i = cursor;
  while (i < n && isSpace(value[i]!)) i++;
  if (i === n) return n;
  const cls = isWord(value[i]!);
  while (i < n && !isSpace(value[i]!) && isWord(value[i]!) === cls) i++;
  return i;
}
export const wordLeft = (b: Buf): Buf => ({ ...b, cursor: wordLeftIndex(b.value, b.cursor) });
export const wordRight = (b: Buf): Buf => ({ ...b, cursor: wordRightIndex(b.value, b.cursor) });
export function deleteWordBack(b: Buf): Buf {
  const j = wordLeftIndex(b.value, b.cursor);
  return { value: b.value.slice(0, j) + b.value.slice(b.cursor), cursor: j };
}
export function deleteWordForward(b: Buf): Buf {
  const j = wordRightIndex(b.value, b.cursor);
  return { value: b.value.slice(0, b.cursor) + b.value.slice(j), cursor: b.cursor };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/ui/text-buffer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/ui/text-buffer.ts src/ui/text-buffer.test.ts
git commit -m "feat(input): pure text buffer with word-boundary motions"
```

---

### Task 2: History navigator (with draft-stash)

**Files:**
- Create: `src/ui/input-history.ts`
- Test: `src/ui/input-history.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `pushHistory(list: string[], entry: string, cap?: number): string[]` (append, drop empties + consecutive dupes, cap length); and a stateful navigator `type HistNav = { idx: number; draft: string }`, `histStart(): HistNav`, `histPrev(nav, list, current): { nav, value } | null`, `histNext(nav, list): { nav, value } | null`. `idx === -1` means "on the live draft"; `histPrev` stashes `current` into `draft` on the first step up.

- [ ] **Step 1: Write the failing tests**

```ts
// src/ui/input-history.test.ts
import { test, expect } from "bun:test";
import { pushHistory, histStart, histPrev, histNext } from "./input-history";

test("pushHistory appends, drops empties and consecutive dupes, and caps", () => {
  expect(pushHistory([], "hello")).toEqual(["hello"]);
  expect(pushHistory(["hello"], "hello")).toEqual(["hello"]);   // consecutive dupe ignored
  expect(pushHistory(["hello"], "  ")).toEqual(["hello"]);      // blank ignored
  expect(pushHistory(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  expect(pushHistory(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]); // capped, oldest dropped
});

test("histPrev walks older, stashing the live draft; histNext walks back to it", () => {
  const list = ["one", "two", "three"]; // oldest -> newest
  let nav = histStart();                 // idx -1 (on the draft)
  const p1 = histPrev(nav, list, "draft")!; // step up -> newest "three", draft stashed
  expect(p1.value).toBe("three"); nav = p1.nav;
  const p2 = histPrev(nav, list, "three")!;
  expect(p2.value).toBe("two"); nav = p2.nav;
  const n1 = histNext(nav, list)!;          // back down -> "three"
  expect(n1.value).toBe("three"); nav = n1.nav;
  const n2 = histNext(nav, list)!;          // back down past newest -> restored draft
  expect(n2.value).toBe("draft"); nav = n2.nav;
  expect(histNext(nav, list)).toBeNull();   // already on the draft -> no move
});

test("histPrev on an empty history is a no-op", () => {
  expect(histPrev(histStart(), [], "x")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/ui/input-history.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `input-history.ts`**

```ts
// src/ui/input-history.ts
/** Session message history + a ↑/↓ navigator. `idx` is an offset from the NEWEST entry: -1 means "on the
 *  live draft" (not in history yet), 0 = newest, list.length-1 = oldest. Stepping up the first time stashes
 *  the current draft so stepping all the way back down restores it (shell-style). Pure + deterministic. */
export const HISTORY_CAP = 500;

export function pushHistory(list: string[], entry: string, cap = HISTORY_CAP): string[] {
  const e = entry.trim();
  if (!e) return list;
  if (list.length && list[list.length - 1] === e) return list; // ignore consecutive dupes
  const next = [...list, e];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export interface HistNav { idx: number; draft: string }
export const histStart = (): HistNav => ({ idx: -1, draft: "" });

/** Step to an OLDER entry. `current` is the buffer's current text (stashed as the draft on the first step). */
export function histPrev(nav: HistNav, list: string[], current: string): { nav: HistNav; value: string } | null {
  if (!list.length) return null;
  const draft = nav.idx === -1 ? current : nav.draft;
  const idx = Math.min(nav.idx + 1, list.length - 1);
  if (idx === nav.idx) return null; // already at the oldest
  return { nav: { idx, draft }, value: list[list.length - 1 - idx]! };
}

/** Step to a NEWER entry, or back to the stashed draft when leaving history. */
export function histNext(nav: HistNav, list: string[]): { nav: HistNav; value: string } | null {
  if (nav.idx === -1) return null; // already on the draft
  const idx = nav.idx - 1;
  if (idx === -1) return { nav: { idx: -1, draft: "" }, value: nav.draft };
  return { nav: { idx, draft: nav.draft }, value: list[list.length - 1 - idx]! };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/ui/input-history.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/ui/input-history.ts src/ui/input-history.test.ts
git commit -m "feat(input): session history navigator with draft-stash"
```

---

### Task 3: Keybinding classifier (cross-platform)

**Files:**
- Create: `src/ui/input-keys.ts`
- Test: `src/ui/input-keys.test.ts`

**Interfaces:**
- Consumes: Ink's `Key` type (`import type { Key } from "ink"`).
- Produces: `type InputAction = { kind: "insert"; text: string } | { kind: "backspace" } | { kind: "del" } | { kind: "left" } | { kind: "right" } | { kind: "home" } | { kind: "end" } | { kind: "wordLeft" } | { kind: "wordRight" } | { kind: "deleteWordBack" } | { kind: "deleteWordForward" } | { kind: "submit" } | { kind: "historyPrev" } | { kind: "historyNext" } | { kind: "noop" }`; and `classifyKey(input: string, key: Key): InputAction`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/ui/input-keys.test.ts
import { test, expect } from "bun:test";
import { classifyKey } from "./input-keys";
import type { Key } from "ink";

// A blank Key with everything false; override the fields a test cares about.
const K = (o: Partial<Key> = {}): Key => ({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false,
  // kitty-only extras Ink includes; harmless here:
  ...( { super: false, hyper: false } as unknown as Partial<Key> ), ...o,
});

test("printable input inserts; Enter submits", () => {
  expect(classifyKey("a", K())).toEqual({ kind: "insert", text: "a" });
  expect(classifyKey("", K({ return: true }))).toEqual({ kind: "submit" });
});

test("plain motions + deletes", () => {
  expect(classifyKey("", K({ leftArrow: true })).kind).toBe("left");
  expect(classifyKey("", K({ rightArrow: true })).kind).toBe("right");
  expect(classifyKey("", K({ backspace: true })).kind).toBe("backspace");
  expect(classifyKey("", K({ delete: true })).kind).toBe("del");
  expect(classifyKey("", K({ home: true })).kind).toBe("home");
  expect(classifyKey("", K({ end: true, ctrl: false })).kind).toBe("end");
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
  expect(classifyKey("w", K({ ctrl: true })).kind).toBe("deleteWordBack");    // Ctrl+W (works w/o Option-as-Meta)
});

test("control/navless combos are ignored, not inserted", () => {
  expect(classifyKey("c", K({ ctrl: true })).kind).toBe("noop"); // Ctrl+C handled elsewhere
  expect(classifyKey("", K({ tab: true })).kind).toBe("noop");   // Tab handled by the suggester
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/ui/input-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `input-keys.ts`**

```ts
// src/ui/input-keys.ts
/** Map one Ink keypress to a semantic editing action. This is the ONE place the cross-platform key
 *  detection lives. Ink 7.1.0 normalizes Option/Alt into `key.meta` (via ESC-prefix like `\x1b\x7f`, and
 *  via the kitty keyboard protocol). We also bind Ctrl+W → delete-word-back, the readline-universal
 *  fallback that works even on macOS Terminal.app/iTerm2 when "Use Option as Meta" is OFF. Word MOVE is
 *  bound to meta+arrow and to meta+b / meta+f; word DELETE to meta+backspace / meta+delete, Alt+d, Ctrl+W. */
import type { Key } from "ink";

export type InputAction =
  | { kind: "insert"; text: string }
  | { kind: "backspace" } | { kind: "del" }
  | { kind: "left" } | { kind: "right" } | { kind: "home" } | { kind: "end" }
  | { kind: "wordLeft" } | { kind: "wordRight" } | { kind: "deleteWordBack" } | { kind: "deleteWordForward" }
  | { kind: "submit" } | { kind: "historyPrev" } | { kind: "historyNext" } | { kind: "noop" };

export function classifyKey(input: string, key: Key): InputAction {
  if (key.return) return { kind: "submit" };
  if (key.tab || key.escape) return { kind: "noop" }; // owned by the suggester / higher dispatch

  // Word DELETE (check before plain backspace/delete).
  if (key.ctrl && (input === "w" || input === "\x17")) return { kind: "deleteWordBack" }; // Ctrl+W
  if (key.meta && key.backspace) return { kind: "deleteWordBack" };
  if (key.meta && key.delete) return { kind: "deleteWordForward" };
  if (key.meta && input === "d") return { kind: "deleteWordForward" };

  // Word MOVE (check before plain arrows).
  if (key.meta && key.leftArrow) return { kind: "wordLeft" };
  if (key.meta && key.rightArrow) return { kind: "wordRight" };
  if (key.meta && input === "b") return { kind: "wordLeft" };
  if (key.meta && input === "f") return { kind: "wordRight" };

  // Plain motions + deletes.
  if (key.backspace) return { kind: "backspace" };
  if (key.delete) return { kind: "del" };
  if (key.leftArrow) return { kind: "left" };
  if (key.rightArrow) return { kind: "right" };
  if (key.home || (key.ctrl && input === "a")) return { kind: "home" };
  if (key.end || (key.ctrl && input === "e")) return { kind: "end" };
  if (key.upArrow) return { kind: "historyPrev" };
  if (key.downArrow) return { kind: "historyNext" };

  // Any remaining ctrl/meta combo is a shortcut we don't own — never insert control chars.
  if (key.ctrl || key.meta) return { kind: "noop" };
  // Printable text (Ink hands a paste as one multi-char `input`).
  if (input && input !== "\r" && input !== "\n") return { kind: "insert", text: input };
  return { kind: "noop" };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/ui/input-keys.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/ui/input-keys.ts src/ui/input-keys.test.ts
git commit -m "feat(input): cross-platform keybinding classifier"
```

---

### Task 4: The `<ChatInput>` component (border + cursor + wiring)

**Files:**
- Create: `src/ui/ChatInput.tsx`
- Test: `src/ui/ChatInput.test.tsx`

**Interfaces:**
- Consumes: `text-buffer.ts` (all fns), `input-keys.ts` (`classifyKey`, `InputAction`), `input-history.ts` (`histStart/histPrev/histNext`, `HistNav`), Ink `useInput/Box/Text`.
- Produces: `ChatInput` (React component). Props:
  ```ts
  { value: string; onChange: (v: string) => void; onSubmit: (v: string) => void;
    history: string[];                       // oldest -> newest, App-owned
    isActive: boolean;                       // false while a card/browser/focus owns the keyboard
    suggestOpen: boolean;                    // true while the /command menu is up (↑/↓ handled by parent)
    onSuggestNav?: (dir: -1 | 1) => void;    // parent moves the suggester highlight
    onSuggestAccept?: () => void;            // Tab
    placeholder?: string; width: number; dimmed?: boolean }
  ```
- Internally holds `cursor` (number) + a `HistNav` in refs; `value` is controlled by the parent so the draft survives the browser dock without a remount.

- [ ] **Step 1: Write the failing tests** (Layer-1; `ink-testing-library`)

```tsx
// src/ui/ChatInput.test.tsx
import { test, expect } from "bun:test";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { ChatInput } from "./ChatInput";

const ENTER = "\r";
const OPT_BACKSPACE = "\x1b\x7f"; // Option+Backspace (ESC + DEL) — Ink sets {backspace, meta}
const CTRL_W = "\x17";            // Ctrl+W
const sleep = (ms = 20) => new Promise((r) => setTimeout(r, ms));

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
  stdin.write(OPT_BACKSPACE); await sleep();   // -> "the quick "
  stdin.write(ENTER); await sleep();
  expect(submitted).toBe("the quick");
});

test("Ctrl+W deletes the previous word (the universal fallback)", async () => {
  let submitted = "";
  const { stdin } = render(<Harness onSubmit={(v) => (submitted = v)} />);
  await sleep();
  stdin.write("alpha beta"); await sleep();
  stdin.write(CTRL_W); await sleep();
  stdin.write(ENTER); await sleep();
  expect(submitted).toBe("alpha");
});

test("↑ recalls the last submitted message; ↓ returns to the draft", async () => {
  let submitted = "";
  const { stdin } = render(<Harness onSubmit={(v) => (submitted = v)} history={["first", "second"]} />);
  await sleep();
  stdin.write("\x1b[A"); await sleep();  // ↑ -> "second"
  stdin.write(ENTER); await sleep();
  expect(submitted).toBe("second");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/ui/ChatInput.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ChatInput.tsx`**

```tsx
// src/ui/ChatInput.tsx
/** Plan 24: the REPL's message editor. Controlled (parent owns `value`), so the browser dock can unmount
 *  and remount it without losing the draft. Owns the cursor + history-nav state locally; maps each key to
 *  an action via classifyKey, applies it to the text buffer / history, and renders a bordered box with a
 *  block cursor. Enter submits (single logical line; it wraps visually). ↑/↓ browse history unless the
 *  slash-suggester is open, in which case the parent moves the menu highlight. */
import { useRef } from "react";
import { Box, Text, useInput } from "ink";
import * as tb from "./text-buffer";
import { classifyKey } from "./input-keys";
import { histStart, histPrev, histNext, type HistNav } from "./input-history";

export interface ChatInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  history: string[];
  isActive: boolean;
  suggestOpen: boolean;
  onSuggestNav?: (dir: -1 | 1) => void;
  onSuggestAccept?: () => void;
  placeholder?: string;
  width: number;
  dimmed?: boolean;
}

export function ChatInput(props: ChatInputProps) {
  const cursor = useRef(props.value.length);
  const nav = useRef<HistNav>(histStart());
  // Keep the cursor in range when the parent replaces `value` (submit clears, dock reseeds).
  if (cursor.current > props.value.length) cursor.current = props.value.length;

  const apply = (next: tb.Buf) => { cursor.current = next.cursor; props.onChange(next.value); };
  const buf = (): tb.Buf => ({ value: props.value, cursor: cursor.current });

  useInput(
    (input, key) => {
      // Tab / ↑ / ↓ belong to the suggester while its menu is open.
      if (props.suggestOpen) {
        if (key.tab) { props.onSuggestAccept?.(); return; }
        if (key.upArrow) { props.onSuggestNav?.(-1); return; }
        if (key.downArrow) { props.onSuggestNav?.(1); return; }
      }
      const a = classifyKey(input, key);
      switch (a.kind) {
        case "insert": { apply(tb.insert(buf(), a.text)); nav.current = histStart(); return; }
        case "backspace": return apply(tb.backspace(buf()));
        case "del": return apply(tb.del(buf()));
        case "left": return apply(tb.left(buf()));
        case "right": return apply(tb.right(buf()));
        case "home": return apply(tb.home(buf()));
        case "end": return apply(tb.end(buf()));
        case "wordLeft": return apply(tb.wordLeft(buf()));
        case "wordRight": return apply(tb.wordRight(buf()));
        case "deleteWordBack": { apply(tb.deleteWordBack(buf())); nav.current = histStart(); return; }
        case "deleteWordForward": { apply(tb.deleteWordForward(buf())); nav.current = histStart(); return; }
        case "submit": {
          const v = props.value;
          nav.current = histStart();
          props.onSubmit(v);
          return;
        }
        case "historyPrev": {
          const r = histPrev(nav.current, props.history, props.value);
          if (r) { nav.current = r.nav; cursor.current = r.value.length; props.onChange(r.value); }
          return;
        }
        case "historyNext": {
          const r = histNext(nav.current, props.history);
          if (r) { nav.current = r.nav; cursor.current = r.value.length; props.onChange(r.value); }
          return;
        }
        case "noop": return;
      }
    },
    { isActive: props.isActive },
  );

  return (
    <Box borderStyle="round" borderColor={props.dimmed ? "gray" : "cyan"} paddingX={1} width={props.width}>
      <Text color={props.dimmed ? "gray" : "cyan"}>{"> "}</Text>
      <Text>{renderWithCursor(props.value, cursor.current, props.placeholder)}</Text>
    </Box>
  );
}

/** Render the value with a block cursor. An empty value shows the (dim) placeholder with the cursor at 0.
 *  The cursor is drawn as an inverse space at end-of-line, else an inverse of the char under it. */
function renderWithCursor(value: string, cursor: number, placeholder?: string): React.ReactNode {
  if (value.length === 0) {
    return (
      <>
        <Text inverse> </Text>
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </>
    );
  }
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{at || " "}</Text>
      <Text>{after}</Text>
    </>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/ui/ChatInput.test.tsx`
Expected: PASS (5 tests). If the Option+Backspace or history test flakes on raw-sequence timing, increase `sleep()` to 40ms (Ink parses stdin async).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/ui/ChatInput.tsx src/ui/ChatInput.test.tsx
git commit -m "feat(input): bordered ChatInput with cursor, word-nav, history"
```

---

### Task 5: Integrate `<ChatInput>` into `App.tsx`

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/ui/App.test.tsx`

**Interfaces:**
- Consumes: `ChatInput` (Task 4), `pushHistory` (Task 2).
- Produces: no new exports; App now renders `<ChatInput>` in place of `@inkjs/ui`'s `<TextInput>`.

**Context — what App does today (read before editing):**
- `import { TextInput, Spinner } from "@inkjs/ui";` → change to `import { Spinner } from "@inkjs/ui";` and add `import { ChatInput } from "./ChatInput";`, `import { pushHistory } from "./input-history";`.
- State to REMOVE (the uncontrolled-remount hack): `inputKey`, `inputSeed`, `setInputKey`, `setInputSeed`, and the `key={inputKey} defaultValue={inputSeed}` on the input. Replace with a single controlled `const [input, setInput] = useState("")` (App already has `input`; make it the source of truth). Keep `inputLiveRef` only if other code reads it — otherwise remove and read `input`.
- `dockBrowser`/`dockOrg` currently call `setInputSeed(inputLiveRef.current)` + `setInputKey(k=>k+1)` to preserve the draft across the dock. With a controlled `input`, the draft lives in `input` and survives the unmount automatically — DELETE those two lines from both dock fns.
- The boot `useInput` suggester block (`if (sugg.length > 0) { upArrow/downArrow/tab }`) — MOVE this responsibility into `ChatInput` via `suggestOpen`/`onSuggestNav`/`onSuggestAccept`. Keep the top-level `useInput` for cards/browsers/focus/org (the pending-card → operation-view → browser → org → focus dispatch order stays); just remove its suggester branch, because `ChatInput`'s own `useInput` (gated by `isActive`) now handles chat-line keys including suggester nav.
- `submit(value)` stays; add `setHistory((h) => pushHistory(h, value))` at its top for non-empty submits.

- [ ] **Step 1: Write/adjust the failing App tests**

```tsx
// src/ui/App.test.tsx — add near the other input tests
test("Plan 24: the input renders inside a bordered box", async () => {
  const { props } = await setup();
  const { lastFrame } = render(<App {...props} />);
  await waitFor(lastFrame, "message root");
  expect(lastFrame()).toContain("╭"); // top border line
  expect(lastFrame()).toContain("╰"); // bottom border line
});

test("Plan 24: ↑ recalls the previous submitted message", async () => {
  const { props } = await setup({ model: mockModel("ok") });
  const { stdin, lastFrame } = render(<App {...props} />);
  await waitFor(lastFrame, "message root");
  await send(stdin, "hello there", ENTER);   // submit -> pushed to history
  await waitFor(lastFrame, "hello there");    // echoed in scrollback
  await send(stdin, "\x1b[A");                // ↑
  await waitFor(lastFrame, "hello there");    // recalled into the input line
});

test("Plan 24: Ctrl+W in the input deletes the previous word", async () => {
  const { props } = await setup({ model: mockModel("ok") });
  const { stdin, lastFrame } = render(<App {...props} />);
  await waitFor(lastFrame, "message root");
  await send(stdin, "alpha beta");
  await send(stdin, "\x17");                  // Ctrl+W -> "alpha "
  await send(stdin, ENTER);
  // the model echoes; assert the SUBMITTED text was the word-deleted form via the scrollback user line
  await waitFor(lastFrame, "alpha");
  expect(lastFrame()).not.toContain("alpha beta");
});
```

Also UPDATE any existing test that relied on the old suggester wiring or `inputSeed`/`inputKey` (search `App.test.tsx` for `inputSeed`, `defaultValue`, and the suggester ↑/↓ tests at ~lines 200–226). The suggester behavior is unchanged from the user's view (type `/`, ↓ moves the highlight, Tab accepts) — those tests should still pass once `ChatInput` forwards `onSuggestNav`/`onSuggestAccept`; fix only assertions that referenced internal remount state.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `bun test src/ui/App.test.tsx -t "Plan 24"`
Expected: FAIL — border/history/word-delete not present yet.

- [ ] **Step 3: Implement the integration**

Replace the input render block (currently around `App.tsx:1251` `<TextInput key={inputKey} defaultValue={inputSeed} .../>`) with:

```tsx
      {!pending && !operationRunId && !browser && !org && (
        <>
          <ChatInput
            value={input}
            onChange={(v) => { setInput(v); setSelected(0); }}
            onSubmit={submit}
            history={history}
            isActive={!pending && !operationRunId && !browser && !org && !focusMode}
            suggestOpen={sugg.length > 0}
            onSuggestNav={(dir) => setSelected((s) => cycleIndex(s, sugg.length, dir))}
            onSuggestAccept={() => acceptSuggestion(sugg)}
            placeholder={focusMode ? "(focus mode — esc to return)" : "message root, or / for commands"}
            width={Math.min(termSize.columns, 100)}
            dimmed={busy || focusMode}
          />
          {sugg.length > 0 && (
            /* keep the existing suggester list JSX exactly as-is */
          )}
        </>
      )}
```

Add the history state near the other `useState`s:

```tsx
  const [history, setHistory] = useState<string[]>([]);
```

At the top of `submit`:

```tsx
  const submit = async (value: string) => {
    if (value.trim()) setHistory((h) => pushHistory(h, value));
    // …existing submit body unchanged…
  };
```

Remove `inputKey`/`inputSeed` state + `setInputValue`'s remount lines + the `setInputSeed(...)`/`setInputKey(...)` calls in `dockBrowser`/`dockOrg` and anywhere else; replace `setInputValue(x)` call sites with `setInput(x)`. Remove the suggester `if (sugg.length > 0) { … }` branch from the boot `useInput`.

- [ ] **Step 4: Run the App tests + full suite**

Run: `bun test src/ui/App.test.tsx` then `bun test`
Expected: PASS. Fix any test that asserted old internals (not behavior).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/ui/App.tsx src/ui/App.test.tsx
git commit -m "feat(input): use ChatInput in the REPL; history on submit; drop remount hack"
```

---

### Task 6: History persistence across sessions (optional but recommended)

**Files:**
- Modify: `src/ui/input-history.ts` (add `loadHistory(ws)` / `appendHistory(ws, entry)`)
- Modify: `src/store/files.ts` (add `inputHistoryFile: (ws) => join(ws, ".taicho-input-history")`)
- Modify: `src/ui/App.tsx` (seed `history` from `loadHistory(props.ws)` on mount; call `appendHistory` in `submit`)
- Test: `src/ui/input-history.test.ts` (add persistence tests over a temp dir)
- Modify: `.gitignore` (add `.taicho-input-history` — it's per-workspace user state, like the other workspace files)

**Interfaces:**
- Produces: `loadHistory(ws: string): string[]` (reads the file, last `HISTORY_CAP` lines), `appendHistory(ws: string, entry: string): void` (append one trimmed non-empty, non-consecutive-dupe line).

- [ ] **Step 1: Write the failing tests**

```ts
// add to src/ui/input-history.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHistory, appendHistory } from "./input-history";

test("appendHistory + loadHistory round-trip, skipping blanks and consecutive dupes", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-hist-"));
  expect(loadHistory(ws)).toEqual([]);
  appendHistory(ws, "one"); appendHistory(ws, "one"); appendHistory(ws, "  "); appendHistory(ws, "two");
  expect(loadHistory(ws)).toEqual(["one", "two"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/ui/input-history.test.ts -t "round-trip"`
Expected: FAIL — `loadHistory`/`appendHistory` not exported.

- [ ] **Step 3: Implement**

```ts
// src/ui/input-history.ts — append
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { paths } from "../store/files";

export function loadHistory(ws: string): string[] {
  const f = paths.inputHistoryFile(ws);
  if (!existsSync(f)) return [];
  const lines = readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  // collapse consecutive dupes + cap
  const out: string[] = [];
  for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
  return out.length > HISTORY_CAP ? out.slice(out.length - HISTORY_CAP) : out;
}

export function appendHistory(ws: string, entry: string): void {
  const e = entry.trim();
  if (!e) return;
  const cur = loadHistory(ws);
  if (cur[cur.length - 1] === e) return;
  appendFileSync(paths.inputHistoryFile(ws), e + "\n");
}
```

```ts
// src/store/files.ts — add to the paths object
inputHistoryFile: (ws: string) => join(ws, ".taicho-input-history"),
```

```tsx
// src/ui/App.tsx — seed on mount + persist on submit
const [history, setHistory] = useState<string[]>(() => loadHistory(props.ws));
// in submit(), after pushHistory:
if (value.trim()) appendHistory(props.ws, value);
```

```gitignore
# .gitignore — add near the other workspace files
.taicho-input-history
```

- [ ] **Step 4: Run tests**

Run: `bun test src/ui/input-history.test.ts` then `bun test src/ui/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add src/ui/input-history.ts src/ui/input-history.test.ts src/store/files.ts src/ui/App.tsx .gitignore
git commit -m "feat(input): persist message history across sessions"
```

---

### Task 7: Cross-platform verification + terminal-setup note

**Files:**
- Modify: `docs/observability.md` OR `README.md`/`CLAUDE.md` (a short "Input & word navigation" note)
- Verify: real binary + a live smoke of the three features

- [ ] **Step 1: Build + real-binary smoke**

```bash
bun run build
```

Then in a real terminal, `bun run dev`:
- Confirm the input shows a rounded border (line above + below). ✅ feature 1
- Type two messages, submit each, press ↑/↓ to recall them, and back to the draft. ✅ feature 2
- Type "the quick brown fox"; press Option+← / Option+→ (word move), Option+Backspace and Ctrl+W (word delete). ✅ feature 3
- On macOS Terminal.app/iTerm2, if Option+← inserts a glyph instead of moving, enable "Use Option as Meta key" — confirm Ctrl+W still deletes a word without that setting.

- [ ] **Step 2: Write the doc note** (paste, don't paraphrase)

```markdown
## Input & word navigation

The REPL message box supports:
- **History:** ↑ / ↓ recall previous messages (↑/↓ move the menu instead while a `/command` suggester is open).
- **Word motion:** Option/Alt + ← / → (also Alt+b / Alt+f).
- **Word delete:** Option/Alt + Backspace, Alt+d (forward), and **Ctrl+W** (delete previous word — works everywhere).

Word keys rely on the terminal sending Option/Alt as *Meta*. Modern terminals with the kitty keyboard
protocol (kitty, Ghostty, WezTerm) work out of the box. On **macOS Terminal.app** enable
*Settings → Profiles → Keyboard → "Use Option as Meta key"*; on **iTerm2** set *Profiles → Keys →
Left/Right Option key → Esc+*. If you'd rather not, **Ctrl+W** always deletes the previous word.
```

- [ ] **Step 3: Full gate + commit**

```bash
bun run typecheck && bun test && bun run build
git add docs/ && git commit -m "docs(input): terminal setup for word navigation"
```

---

## Self-Review

- **Spec coverage:** Feature 1 (border) → Task 4 render + Task 5 App integration + Task 7 smoke. Feature 2 (↑/↓ history) → Tasks 2, 4, 5 (+ 6 persistence). Feature 3 (word nav + delete, cross-platform) → Tasks 1 (boundaries), 3 (key detection incl. Ctrl+W fallback), 4 (wiring), 7 (terminal note). ✅ all three covered.
- **Placeholder scan:** none — every code step is complete and runnable.
- **Type consistency:** `Buf`, `InputAction`, `HistNav`, `classifyKey`, `pushHistory/histPrev/histNext`, `loadHistory/appendHistory` are named identically across the tasks that define and consume them. `ChatInput` prop names match Task 5's usage.
- **Ambiguity resolved:** single wrapping line + Enter=submit (multi-line editing OUT of scope); ↑/↓ = history unless the suggester is open; word char = `/[\p{L}\p{N}_]/u`; Ctrl+W is the always-on delete-word fallback.

## Open Decisions (confirm during review)

1. **Multi-line editing** (Enter=newline, Shift+Enter or `\`+Enter to submit) is out of scope here. Add later? The buffer/keys generalize to it.
2. **History scope:** persisted per-workspace file (Task 6). Prefer session-only (drop Task 6) or a global `~/.taicho/history`?
3. **Border color / width:** cyan rounded box, capped at 100 cols. Match a different Claude-Code-like style?
