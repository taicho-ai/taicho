/** Scrollback readability (transcript hierarchy). Pure helpers that decide how a `Line` is spaced and
 *  coloured so the REPL reads as distinct turns instead of a low-contrast wall. Three tiers:
 *
 *    content   the user's turn (a full-width inverse ` you ` bar) and agent replies (a bold speaker).
 *    activity  operation breadcrumbs (tool calls, delegations) — a dim `│` rail; routine ops recede.
 *    problems  warnings / refusals / failures — coloured and NEVER dim, so they can't hide in the noise.
 *
 *  Kept pure + separate from App.tsx so the spacing/colour rules are unit-testable (Ink strips styling
 *  from the test frame, but these decisions are plain data). */
import type { Line } from "./slash";

/** Which logical block a scrollback line belongs to. Consecutive lines in the same group are ONE block
 *  (an agent reply is several rendered markdown blocks that share a speaker); a group change is a
 *  turn/speaker/op-stream boundary that earns a blank line above it. */
export function lineGroup(l: Line): string {
  if (l.kind === "agent") return `agent:${l.from ?? ""}`;
  return l.kind; // "user" | "system"
}

/** Blank line above a line: 1 when it OPENS a new block (a turn, a new speaker, or the start of an op
 *  stream), and also between the paragraphs of one agent reply so a long answer breathes. 0 keeps a run
 *  of operation breadcrumbs tight, so they read as a single column rather than sprawling. */
export function marginTopFor(prev: Line | undefined, l: Line): 0 | 1 {
  if (!prev) return 0;
  if (lineGroup(prev) !== lineGroup(l)) return 1; // block boundary
  return l.kind === "agent" ? 1 : 0; // same-reply paragraph spacing; op streams stay tight
}

export interface SpacedLine {
  line: Line;
  marginTop: 0 | 1;
  /** True when this line opens a new block — used to show a speaker label once per agent reply. */
  newBlock: boolean;
}

/** Precompute each line's spacing + block-boundary flag from its predecessor, so a write-once renderer
 *  (Ink `<Static>`, whose callback sees one item at a time with no neighbours) needs no lookup. Prior
 *  lines are frozen, so appending a line never changes an earlier line's result — safe for the log. */
export function annotateSpacing(lines: Line[]): SpacedLine[] {
  return lines.map((line, i) => {
    const prev = lines[i - 1];
    return { line, marginTop: marginTopFor(prev, line), newBlock: !prev || lineGroup(prev) !== lineGroup(line) };
  });
}

export interface SystemLineStyle {
  /** True for an activity breadcrumb (tool call, delegation, warning…) — it gets the `│` rail. False
   *  for a plain notice (boot message, run summary), which renders flush with no rail. */
  isOp: boolean;
  /** Ink colour name; undefined = default foreground. */
  color?: string;
  dim: boolean;
  /** Text to display: op lines are left-trimmed (the rail supplies the indent); notices are verbatim. */
  text: string;
}

interface GlyphStyle {
  color?: string;
  dim: boolean;
}

// Leading glyph → treatment. Problems are bright (never dim) so they surface; routine tool activity
// recedes to dim gray; a delegation keeps a dim magenta tint so it stays scannable amid the tool stream.
const GLYPH_STYLES: Record<string, GlyphStyle> = {
  "⚠": { color: "yellow", dim: false }, // warning / failure — must stay visible
  "⊘": { color: "red", dim: false }, // refused
  "✗": { color: "red", dim: false }, // failed
  "⇢": { color: "magenta", dim: true }, // dispatch / delegation
  "↳": { color: "gray", dim: true }, // tool breadcrumb — routine, recede hard
  "✓": { color: "green", dim: true }, // success
  "⊗": { color: "yellow", dim: true }, // cancelling
  "⏰": { color: "blue", dim: true }, // schedule fired
};

/** Classify a `kind: "system"` line by its leading activity glyph. A line with no known glyph is a
 *  plain notice (kept as the previous medium-gray). The glyph itself is left IN the text — the colour
 *  categorises it, the rail groups it. */
export function classifySystemLine(text: string): SystemLineStyle {
  const trimmed = text.replace(/^\s+/, "");
  for (const glyph in GLYPH_STYLES) {
    if (trimmed.startsWith(glyph)) {
      const s = GLYPH_STYLES[glyph];
      return { isOp: true, color: s.color, dim: s.dim, text: trimmed };
    }
  }
  return { isOp: false, color: "gray", dim: false, text };
}

const USER_BAR_LABEL = " you  ";

/** Greedy word-wrap to `width` columns; a word longer than a line is hard-split so nothing overflows.
 *  Always returns at least one line (an empty string for empty input). */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (let word of para.split(" ")) {
      while (word.length > w) {
        if (cur) { lines.push(cur); cur = ""; }
        lines.push(word.slice(0, w));
        word = word.slice(w);
      }
      if (cur === "") cur = word;
      else if (cur.length + 1 + word.length <= w) cur += " " + word;
      else { lines.push(cur); cur = word; }
    }
    lines.push(cur);
  }
  return lines.length ? lines : [""];
}

/** The user's turn as a FULL-WIDTH highlight bar: a ` you ` label on the first line, the message wrapped
 *  and aligned under it, every line padded to `width` so an inverse render fills the row edge-to-edge
 *  (an inverse `<Text>` only paints the characters it's given — the padding is what makes the bar solid). */
export function userBarLines(text: string, width: number): string[] {
  const label = USER_BAR_LABEL;
  const indent = " ".repeat(label.length);
  const w = Math.max(label.length + 1, width);
  const body = wrapText(text, w - label.length);
  return body
    .map((ln, i) => (i === 0 ? label : indent) + ln)
    .map((ln) => (ln.length >= w ? ln.slice(0, w) : ln.padEnd(w)));
}
