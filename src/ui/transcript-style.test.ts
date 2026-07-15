import { test, expect, describe } from "bun:test";
import { lineGroup, marginTopFor, classifySystemLine, wrapText, userBarLines } from "./transcript-style";
import type { Line } from "./slash";

const user = (text: string): Line => ({ kind: "user", text });
const sys = (text: string): Line => ({ kind: "system", text });
const agent = (from: string, text: string): Line => ({ kind: "agent", from, text, rendered: true });

describe("lineGroup", () => {
  test("user and system are their own groups; agents group by speaker", () => {
    expect(lineGroup(user("hi"))).toBe("user");
    expect(lineGroup(sys("  ↳ x"))).toBe("system");
    expect(lineGroup(agent("root", "a"))).toBe("agent:root");
    expect(lineGroup(agent("news", "a"))).toBe("agent:news");
  });
});

describe("marginTopFor", () => {
  test("the first line never gets a top margin", () => {
    expect(marginTopFor(undefined, user("hi"))).toBe(0);
  });

  test("a turn/speaker boundary earns a blank line", () => {
    expect(marginTopFor(agent("root", "reply"), user("next turn"))).toBe(1); // reply → new user turn
    expect(marginTopFor(user("hi"), agent("root", "reply"))).toBe(1); // user → agent reply
    expect(marginTopFor(agent("root", "a"), agent("news", "b"))).toBe(1); // speaker change
    expect(marginTopFor(user("hi"), sys("  ↳ tool"))).toBe(1); // content → op stream
  });

  test("an op stream stays tight (no blank line between consecutive breadcrumbs)", () => {
    expect(marginTopFor(sys("  ↳ a → x()"), sys("  ↳ a → y()"))).toBe(0);
  });

  test("paragraphs of one agent reply are spaced so a long answer breathes", () => {
    expect(marginTopFor(agent("root", "para 1"), agent("root", "para 2"))).toBe(1);
  });
});

describe("classifySystemLine", () => {
  test("problems are coloured and NEVER dimmed", () => {
    expect(classifySystemLine("  ⚠ background task failed")).toMatchObject({ isOp: true, color: "yellow", dim: false });
    expect(classifySystemLine("  ⊘ dispatch refused: cap")).toMatchObject({ isOp: true, color: "red", dim: false });
    expect(classifySystemLine("  ✗ run failed")).toMatchObject({ isOp: true, color: "red", dim: false });
  });

  test("routine tool breadcrumbs recede to dim gray", () => {
    expect(classifySystemLine("  ↳ root → read_artifact()")).toMatchObject({ isOp: true, color: "gray", dim: true });
  });

  test("a delegation keeps a scannable dim tint", () => {
    expect(classifySystemLine("  ⇢ dispatched t1 → news")).toMatchObject({ isOp: true, color: "magenta", dim: true });
  });

  test("op lines are left-trimmed so the rail supplies the indent", () => {
    expect(classifySystemLine("  ↳ root → x()").text).toBe("↳ root → x()");
  });

  test("a glyph-less notice is not an op and keeps its verbatim (indented) text", () => {
    const s = classifySystemLine("  taicho — squad ready.");
    expect(s.isOp).toBe(false);
    expect(s.color).toBe("gray");
    expect(s.text).toBe("  taicho — squad ready."); // verbatim, no rail, keeps its own indent
  });

  test("run summary footers are notices, not ops", () => {
    expect(classifySystemLine("  run: abc (completed, 1234 tok)").isOp).toBe(false);
  });
});

describe("wrapText", () => {
  test("wraps on word boundaries within the width", () => {
    expect(wrapText("one two three four", 8)).toEqual(["one two", "three", "four"]);
  });

  test("hard-splits a word longer than the line", () => {
    expect(wrapText("supercalifragilistic", 6)).toEqual(["superc", "alifra", "gilist", "ic"]);
  });

  test("preserves explicit newlines as line breaks", () => {
    expect(wrapText("a\nb", 40)).toEqual(["a", "b"]);
  });

  test("always returns at least one line", () => {
    expect(wrapText("", 40)).toEqual([""]);
  });
});

describe("userBarLines", () => {
  test("every line is padded to the full width so the inverse bar fills edge-to-edge", () => {
    const lines = userBarLines("hello", 40);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(40);
    expect(lines[0].startsWith(" you  hello")).toBe(true);
    expect(lines[0].trimEnd()).toBe(" you  hello"); // the rest is padding
  });

  test("a long message wraps into multiple full-width lines, aligned under the label", () => {
    const lines = userBarLines("summarize today's AI news and save it as a brief", 28);
    expect(lines.length).toBeGreaterThan(1);
    for (const ln of lines) expect(ln).toHaveLength(28); // every row spans the full width
    expect(lines[0].startsWith(" you  ")).toBe(true);
    expect(lines[1].startsWith("      ")).toBe(true); // continuation aligns under the message column
  });

  test("never overflows the width", () => {
    for (const ln of userBarLines("a".repeat(200), 30)) expect(ln.length).toBeLessThanOrEqual(30);
  });
});
