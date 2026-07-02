import { test, expect } from "bun:test";
import { splitCompletedBlocks } from "./markdown-stream";

test("empty / whitespace buffer → nothing completed", () => {
  expect(splitCompletedBlocks("")).toEqual({ blocks: [], tail: "" });
  expect(splitCompletedBlocks("   ")).toEqual({ blocks: [], tail: "   " });
});

test("a single in-progress paragraph stays in the tail", () => {
  const r = splitCompletedBlocks("hello world");
  expect(r.blocks).toEqual([]);
  expect(r.tail).toContain("hello world");
});

test("first paragraph completes once a second block begins", () => {
  const r = splitCompletedBlocks("para one\n\npara two");
  expect(r.blocks.length).toBe(1);
  expect(r.blocks[0]).toContain("para one");
  expect(r.tail).toContain("para two");
});

test("an open code fence keeps everything in the tail until it closes", () => {
  const open = splitCompletedBlocks("intro\n\n```ts\nconst x = 1;");
  expect(open.blocks.length).toBe(1);          // only the intro paragraph completed
  expect(open.blocks[0]).toContain("intro");
  expect(open.tail).toContain("```ts");         // the whole unclosed fence is the tail
  const closed = splitCompletedBlocks("intro\n\n```ts\nconst x = 1;\n```\n\nnext");
  expect(closed.blocks.some((b) => b.includes("```ts"))).toBe(true); // fence now a completed block
  expect(closed.tail).toContain("next");
});

test("a paragraph/heading completes the instant a trailing blank line proves it closed", () => {
  // A finished block followed by a blank line is final — reveal it now, don't wait for the next
  // block to begin. This is what makes the stream break block-by-block without showing a raw tail.
  const para = splitCompletedBlocks("all done.\n\n");
  expect(para.blocks.length).toBe(1);
  expect(para.blocks[0]).toContain("all done.");
  expect(para.tail).toBe("");
  const heading = splitCompletedBlocks("# Plan\n\n");
  expect(heading.blocks.length).toBe(1);
  expect(heading.blocks[0]).toContain("# Plan");
  expect(heading.tail).toBe("");
});

test("a paragraph with no trailing blank line is still in progress (soft-wrap may continue it)", () => {
  const r = splitCompletedBlocks("one line\n");   // single newline, not a blank-line separator
  expect(r.blocks).toEqual([]);
  expect(r.tail).toContain("one line");
});

test("a list is NOT committed on a blank line — a later item would merge into it", () => {
  // "- a\n\n" then "- b" is ONE loose list; committing "- a" early would shift its boundary when
  // "- b" arrives. So a growable block (list/blockquote) stays in the tail until a different block
  // begins after it.
  const oneItem = splitCompletedBlocks("- a\n\n");
  expect(oneItem.blocks).toEqual([]);
  expect(oneItem.tail).toContain("- a");
  const twoItems = splitCompletedBlocks("- a\n\n- b\n\n");
  expect(twoItems.blocks).toEqual([]);            // still one growing list — held in the tail
  const listThenPara = splitCompletedBlocks("- a\n\n- b\n\nafter");
  expect(listThenPara.blocks.length).toBe(1);     // the list finally completes now a paragraph follows
  expect(listThenPara.blocks[0]).toContain("- a");
  expect(listThenPara.blocks[0]).toContain("- b");
  expect(listThenPara.tail).toContain("after");
});

test("committed block boundaries only grow — never shift or shrink as deltas arrive", () => {
  // The UI commits blocks by index and assumes earlier blocks are stable. Feed a heading+paragraph
  // reply delta-by-delta and assert blocks.length is monotonic non-decreasing and block 0 is stable.
  const deltas = ["# Pl", "# Plan\n\n", "# Plan\n\nFirst step", "# Plan\n\nFirst step done.\n\n", "# Plan\n\nFirst step done.\n\nThen more."];
  let count = 0;
  let firstBlock: string | undefined;
  for (const buf of deltas) {
    const { blocks } = splitCompletedBlocks(buf);
    expect(blocks.length).toBeGreaterThanOrEqual(count);   // monotonic
    count = blocks.length;
    if (blocks.length >= 1) {
      if (firstBlock === undefined) firstBlock = blocks[0];
      expect(blocks[0]).toBe(firstBlock);                  // block 0 never mutates once committed
    }
  }
});
