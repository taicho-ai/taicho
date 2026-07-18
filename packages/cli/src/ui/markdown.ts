/** Markdown → ANSI for the terminal REPL. A thin, owned wrapper over marked + marked-terminal
 *  (we don't use the dormant ink-markdown package). Pure + synchronous + memoized, so it's cheap to
 *  call from render. One Marked instance per width (marked-terminal wraps to a fixed width). */
import { Marked } from "marked";
import chalk from "chalk";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// @ts-ignore marked-terminal has no types, but the API is stable
import { markedTerminal } from "marked-terminal";

const byWidth = new Map<number, Marked>();
function mdFor(width: number): Marked {
  let m = byWidth.get(width);
  if (!m) {
    // reflowText makes paragraphs wrap to `width`; unescape keeps entities readable.
    // showSectionPrefix: false removes the markdown markers from output (e.g., # from headings).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m = new Marked(markedTerminal({ width, reflowText: true, unescape: true, showSectionPrefix: false }) as any);
    byWidth.set(width, m);
  }
  return m;
}

const cache = new Map<string, string>();

export function renderMarkdown(text: string, width = 80): string {
  const key = `${width}:${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // marked-terminal both styles text AND strips markdown markers (**bold**, `-` lists, `#`) via chalk.
  // When chalk auto-detects NO color (level 0 — common in a compiled binary / non-TTY / the Ink
  // runtime) it returns the markdown almost RAW, markers intact — so agent replies show as literal
  // `**text**`. taicho is a color TUI, so force a color level for the SYNCHRONOUS render and restore
  // it immediately (a scoped, self-undoing bump — not a permanent global mutation). Respect NO_COLOR.
  const prevLevel = chalk.level;
  if (prevLevel === 0 && !process.env.NO_COLOR) chalk.level = 3;
  let out: string;
  try {
    out = (mdFor(width).parse(text) as string).replace(/\n+$/, "");
  } finally {
    chalk.level = prevLevel;
  }
  if (cache.size > 500) cache.clear(); // bound the memo; a REPL session shouldn't hoard forever
  cache.set(key, out);
  return out;
}
