/** Incremental markdown streaming: given the accumulated buffer, report which top-level markdown
 *  blocks are COMPLETE (safe to render) vs the still-growing tail. Uses marked's lexer — every
 *  content token except the last is stable; the last may still grow (an open code fence / list is a
 *  single token that stays in `tail` until it closes). Pure + deterministic. */
import { Marked } from "marked";

const lexerMd = new Marked();

// Block types that can still GROW by absorbing a following block across a blank line (a loose list
// gains items; a blockquote gains lazy lines; html gains lines). Committing one on a trailing blank
// line would let a later delta shift its boundary — so these stay in the tail until a different
// block begins after them. Every other type (heading, paragraph, closed code fence, hr, table) is
// final the moment a blank line follows it.
const MERGEABLE = new Set(["list", "blockquote", "html"]);

export interface BlockSplit { blocks: string[]; tail: string }

export function splitCompletedBlocks(buffer: string): BlockSplit {
  if (!buffer.trim()) return { blocks: [], tail: buffer };
  const tokens = lexerMd.lexer(buffer).filter((t) => t.type !== "space"); // drop blank-line tokens
  if (tokens.length === 0) return { blocks: [], tail: buffer };
  const last = tokens[tokens.length - 1]!;
  // A block is complete when a later block already follows it — OR when it is the last block but a
  // trailing blank line proves it closed AND its type can't later absorb the next block. This lets a
  // finished heading/paragraph/fence reveal as soon as its blank line lands, instead of waiting for
  // the next block's first token (so the stream breaks on blocks, never showing a raw partial line).
  if (/\n[ \t]*\n[ \t]*$/.test(buffer) && !MERGEABLE.has(last.type))
    return { blocks: tokens.map((t) => t.raw), tail: "" };
  if (tokens.length === 1) return { blocks: [], tail: buffer };
  return { blocks: tokens.slice(0, -1).map((t) => t.raw), tail: last.raw };
}
