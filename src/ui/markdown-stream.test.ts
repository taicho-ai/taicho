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
