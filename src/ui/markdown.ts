/** Markdown → ANSI for the terminal REPL. A thin, owned wrapper over marked + marked-terminal
 *  (we don't use the dormant ink-markdown package). Pure + synchronous + memoized, so it's cheap to
 *  call from render. One Marked instance per width (marked-terminal wraps to a fixed width). */
import { Marked } from "marked";
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
  const out = (mdFor(width).parse(text) as string).replace(/\n+$/, "");
  if (cache.size > 500) cache.clear(); // bound the memo; a REPL session shouldn't hoard forever
  cache.set(key, out);
  return out;
}
