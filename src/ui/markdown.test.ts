import { test, expect } from "bun:test";
import { renderMarkdown } from "./markdown";

test("bold: strips ** markers, keeps the word", () => {
  const out = renderMarkdown("**bold**");
  expect(out).toContain("bold");
  expect(out).not.toContain("**");
  expect(out).not.toBe("bold"); // some ANSI styling was applied
});

test("heading: strips the # marker, keeps the text", () => {
  const out = renderMarkdown("# Title");
  expect(out).toContain("Title");
  expect(out).not.toContain("# Title");
});

test("unordered list: renders items without literal '- ' markers", () => {
  const out = renderMarkdown("- one\n- two");
  expect(out).toContain("one");
  expect(out).toContain("two");
  expect(out).not.toContain("- one");
});

test("fenced code block: keeps the code, drops the backticks fence", () => {
  const out = renderMarkdown("```ts\nconst x = 1;\n```");
  expect(out).toContain("const x = 1;");
  expect(out).not.toContain("```");
});

test("plain text is returned (no trailing newline)", () => {
  const out = renderMarkdown("just words");
  expect(out).toContain("just words");
  expect(out.endsWith("\n")).toBe(false);
});

test("memoized: same input returns an identical string", () => {
  expect(renderMarkdown("**x**", 80)).toBe(renderMarkdown("**x**", 80));
});
