import { test, expect } from "bun:test";
import { readMcpStore, addMcpServer, removeMcpServer } from "./mcp-store";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-mcp-"));

test("empty store reads as {}", () => {
  expect(readMcpStore(ws())).toEqual({});
});

test("add then read round-trips a stdio and an http server", () => {
  const w = ws();
  addMcpServer(w, "web", { command: "npx", args: ["-y", "tavily-mcp"] });
  addMcpServer(w, "docs", { url: "https://mcp.example.com/mcp", auth: "oauth" });
  const all = readMcpStore(w);
  expect(Object.keys(all).sort()).toEqual(["docs", "web"]);
  expect(all.web).toEqual({ command: "npx", args: ["-y", "tavily-mcp"] });
  expect(all.docs).toEqual({ url: "https://mcp.example.com/mcp", auth: "oauth" });
});

test("a malformed entry is skipped; valid entries survive", () => {
  const w = ws();
  mkdirSync(join(w, "agents", ".mcp"), { recursive: true });
  writeFileSync(join(w, "agents", ".mcp", "servers.json"), JSON.stringify({ good: { command: "echo" }, bad: { nonsense: true } }));
  expect(Object.keys(readMcpStore(w))).toEqual(["good"]);
});

test("remove deletes a server and reports hit/miss", () => {
  const w = ws();
  addMcpServer(w, "web", { command: "echo" });
  expect(removeMcpServer(w, "web")).toBe(true);
  expect(removeMcpServer(w, "web")).toBe(false); // already gone
  expect(readMcpStore(w)).toEqual({});
});
