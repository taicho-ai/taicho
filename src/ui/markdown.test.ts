import { test, expect, beforeAll, afterAll } from "bun:test";
import chalk from "chalk";
import { renderMarkdown } from "./markdown";

// Reproduce PRODUCTION's condition, not a masked one: chalk auto-detects NO color (level 0 — what a
// compiled binary / the Ink runtime reports) while the terminal IS color-capable (NO_COLOR unset).
// renderMarkdown must still strip markers + style. The bug that shipped was this test forcing level 3,
// which HID that marked-terminal returns raw markdown at level 0. Do NOT force a level here.
let prevLevel: typeof chalk.level;
let prevNoColor: string | undefined;
beforeAll(() => { prevLevel = chalk.level; prevNoColor = process.env.NO_COLOR; chalk.level = 0; delete process.env.NO_COLOR; });
afterAll(() => { chalk.level = prevLevel; if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor; });

test("bold: strips ** markers, keeps the word", () => {
  const out = renderMarkdown("**bold**");
  expect(out).toContain("bold");
  expect(out).not.toContain("**");
  expect(out).not.toBe("bold"); // some ANSI styling was applied
});

test("bold INSIDE a list item strips markers (the marked-v15 regression that shipped raw)", () => {
  const out = renderMarkdown("- **librarian** — extracts entities\n- **root** — orchestrates");
  expect(out).toContain("librarian");
  expect(out).toContain("root");
  expect(out).not.toContain("**"); // markers gone even inside list items — this was the actual bug
});

test("renderMarkdown does not permanently mutate the global chalk level", () => {
  chalk.level = 0;
  renderMarkdown("**scoped**");
  expect(chalk.level).toBe(0); // the color-forcing is scoped to the render and restored
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
