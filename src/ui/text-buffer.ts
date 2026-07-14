/** Plan 24: pure cursor/edit model for the message buffer (may contain `\n` — see the multi-line section
 *  at the bottom). `cursor` is a code-unit index in [0, value.length]. The word-boundary algorithm
 *  (wordLeftIndex/wordRightIndex) is the heart of the
 *  Option/Alt word-nav: skip whitespace in the direction of travel, then skip the maximal run of
 *  same-CLASS chars (a run of word chars, or a run of non-space non-word chars). That matches how most
 *  editors stop at punctuation. No Ink, no React — fully unit-testable. */
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

// ── multi-line (Plan 24) — line motion for ↑/↓ inside a message with newlines ────────────────────

/** Start index of the line the cursor is on (0, or one past the previous newline). */
function lineStart(value: string, cursor: number): number {
  return value.lastIndexOf("\n", cursor - 1) + 1;
}
/** End index of the line the cursor is on (the next newline, or end of value). */
function lineEnd(value: string, cursor: number): number {
  const nl = value.indexOf("\n", cursor);
  return nl === -1 ? value.length : nl;
}
export function isOnFirstLine(value: string, cursor: number): boolean {
  return value.lastIndexOf("\n", cursor - 1) === -1;
}
export function isOnLastLine(value: string, cursor: number): boolean {
  return value.indexOf("\n", cursor) === -1;
}

/** Move the cursor up one line, keeping its column (clamped to the shorter line). No-op on the first line. */
export function lineUp(b: Buf): Buf {
  const start = lineStart(b.value, b.cursor);
  if (start === 0) return b;
  const col = b.cursor - start;
  const prevStart = lineStart(b.value, start - 1);
  const prevLen = start - 1 - prevStart; // chars on the previous line (excluding its trailing \n)
  return { ...b, cursor: prevStart + Math.min(col, prevLen) };
}
/** Move the cursor down one line, keeping its column. No-op on the last line. */
export function lineDown(b: Buf): Buf {
  const end = lineEnd(b.value, b.cursor);
  if (end === b.value.length) return b;
  const col = b.cursor - lineStart(b.value, b.cursor);
  const nextStart = end + 1;
  const nextLen = lineEnd(b.value, nextStart) - nextStart;
  return { ...b, cursor: nextStart + Math.min(col, nextLen) };
}
