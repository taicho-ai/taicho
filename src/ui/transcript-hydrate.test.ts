import { test, expect, describe } from "bun:test";
import type { ModelMessage } from "ai";
import { threadToLines } from "./transcript-hydrate";

describe("threadToLines", () => {
  test("a fresh conversation hydrates nothing", () => {
    expect(threadToLines([])).toEqual([]);
  });

  test("user/assistant turns become user + agent lines, bracketed by a resumed header and rule", () => {
    const thread: ModelMessage[] = [
      { role: "user", content: "draft the Q3 update" },
      { role: "assistant", content: "Done — saved as update@v1." },
    ];
    const lines = threadToLines(thread);
    // header + 2 turns + closing rule
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ kind: "system" });
    expect(lines[0].text).toContain("resumed conversation");
    expect(lines[1]).toEqual({ kind: "user", text: "draft the Q3 update" });
    expect(lines[2]).toEqual({ kind: "agent", from: "root", text: "Done — saved as update@v1.", rendered: true });
    expect(lines[lines.length - 1]).toMatchObject({ kind: "system" }); // closing rule
  });

  test("the compaction head becomes a 'condensed' marker, not a raw summary dump", () => {
    const thread: ModelMessage[] = [
      { role: "user", content: "[CONVERSATION COMPACTION] 5 earlier turns: the user planned a launch…" },
      { role: "user", content: "now write the email" },
      { role: "assistant", content: "Sent draft." },
    ];
    const lines = threadToLines(thread);
    expect(lines[0].text).toContain("condensed");
    // the raw summary text is NOT rendered as its own line
    expect(lines.some((l) => l.text.includes("the user planned a launch"))).toBe(false);
    // the real recent turns still come through
    expect(lines.some((l) => l.kind === "user" && l.text === "now write the email")).toBe(true);
    expect(lines.some((l) => l.kind === "agent" && l.text === "Sent draft.")).toBe(true);
  });

  test("without a compaction head the header omits 'condensed'", () => {
    const lines = threadToLines([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]);
    expect(lines[0].text).toContain("resumed conversation");
    expect(lines[0].text).not.toContain("condensed");
  });

  test("system/tool roles and empty turns are skipped", () => {
    const thread: ModelMessage[] = [
      { role: "system", content: "you are root" },
      { role: "user", content: "   " }, // whitespace only
      { role: "user", content: "real question" },
    ];
    const lines = threadToLines(thread);
    expect(lines.filter((l) => l.kind === "user")).toHaveLength(1);
    expect(lines.some((l) => l.text.includes("you are root"))).toBe(false);
  });

  test("structured content parts are flattened to their text", () => {
    const thread = [
      { role: "assistant", content: [{ type: "text", text: "part one " }, { type: "text", text: "part two" }] },
    ] as unknown as ModelMessage[];
    const lines = threadToLines(thread);
    expect(lines.some((l) => l.kind === "agent" && l.text === "part one part two")).toBe(true);
  });
});
