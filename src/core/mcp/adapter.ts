/** Adapt an MCP tool (JSON-Schema input + content-block output) into an AI-SDK `tool()` so the
 *  agent loop treats it like any built-in tool. Decoupled from the MCP Client (takes a `call` fn)
 *  to stay trivially testable. */
import { tool, jsonSchema } from "ai";

export interface McpToolInfo { name: string; description?: string; inputSchema?: unknown }

type ContentBlock = { type: string; text?: string; resource?: unknown; [k: string]: unknown };
export interface McpCallResult { content?: ContentBlock[]; isError?: boolean; structuredContent?: unknown }

/** MCP returns an array of content blocks; the model wants plain text. Join text blocks, summarize
 *  non-text ones, and fall back to structuredContent. isError is surfaced inline so the model sees it. */
export function flattenMcpResult(res: McpCallResult): string {
  const parts = (res.content ?? []).map((c) => {
    if (c.type === "text") return c.text ?? "";
    if (c.type === "resource") return typeof c.resource === "string" ? c.resource : JSON.stringify(c.resource ?? c);
    if (c.type === "image" || c.type === "audio") return `[${c.type}]`;
    return JSON.stringify(c);
  });
  let text = parts.join("\n").trim();
  if (!text && res.structuredContent !== undefined) text = JSON.stringify(res.structuredContent);
  return res.isError ? `Error: ${text || "tool call failed"}` : text;
}

export function mcpToolToAiTool(
  call: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>,
  info: McpToolInfo,
) {
  return tool({
    description: info.description ?? info.name,
    inputSchema: jsonSchema((info.inputSchema as object | undefined) ?? { type: "object", properties: {} }),
    execute: async (args) => flattenMcpResult(await call(info.name, (args ?? {}) as Record<string, unknown>)),
  });
}
