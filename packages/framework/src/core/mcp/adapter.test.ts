import { test, expect } from "bun:test";
import { mcpToolToAiTool, flattenMcpResult } from "./adapter";

test("flattenMcpResult joins text content blocks", () => {
  expect(flattenMcpResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
});

test("flattenMcpResult falls back to structuredContent when no text", () => {
  expect(flattenMcpResult({ content: [], structuredContent: { x: 1 } })).toBe('{"x":1}');
});

test("flattenMcpResult prefixes Error: when isError is set", () => {
  expect(flattenMcpResult({ content: [{ type: "text", text: "boom" }], isError: true })).toBe("Error: boom");
});

test("mcpToolToAiTool wires description + inputSchema and executes via call", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const t = mcpToolToAiTool(
    async (name, args) => { calls.push([name, args]); return { content: [{ type: "text", text: "hi " + (args.q ?? "") }] }; },
    { name: "search", description: "web search", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  );
  expect(t.description).toBe("web search");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await t.execute!({ q: "x" }, { toolCallId: "1", messages: [] } as any);
  expect(out).toBe("hi x");
  expect(calls).toEqual([["search", { q: "x" }]]);
});

test("mcpToolToAiTool defaults description to the tool name", () => {
  const t = mcpToolToAiTool(async () => ({ content: [] }), { name: "noargs" });
  expect(t.description).toBe("noargs");
});
