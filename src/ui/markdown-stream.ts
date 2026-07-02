/** Incremental markdown streaming: given the accumulated buffer, report which top-level markdown
 *  blocks are COMPLETE (safe to render) vs the still-growing tail. Uses marked's lexer — every
 *  content token except the last is stable; the last may still grow (an open code fence / list is a
 *  single token that stays in `tail` until it closes). Pure + deterministic. */
import { Marked } from "marked";

const lexerMd = new Marked();

export interface BlockSplit { blocks: string[]; tail: string }

export function splitCompletedBlocks(buffer: string): BlockSplit {
  if (!buffer.trim()) return { blocks: [], tail: buffer };
  const tokens = lexerMd.lexer(buffer).filter((t) => t.type !== "space"); // drop blank-line tokens
  if (tokens.length <= 1) return { blocks: [], tail: buffer };
  return {
    blocks: tokens.slice(0, -1).map((t) => t.raw),
    tail: tokens[tokens.length - 1]!.raw,
  };
}
