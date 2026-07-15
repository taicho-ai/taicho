import { test, expect } from "bun:test";
import { readMcpStore, addMcpServer, removeMcpServer, applyMcpEnv } from "./mcp-store";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpolateEnv } from "./config";

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

test("an http server carries `env` (secret saved WITH the entry) and round-trips", () => {
  const w = ws();
  addMcpServer(w, "teleprompter", { url: "https://x.example.com/mcp?key=${TP_TEST_KEY}", env: { TP_TEST_KEY: "s3cr3t" } });
  expect(readMcpStore(w).teleprompter).toEqual({ url: "https://x.example.com/mcp?key=${TP_TEST_KEY}", env: { TP_TEST_KEY: "s3cr3t" } });
});

test("applyMcpEnv loads every stored server's env into process.env so ${VAR} refs resolve", () => {
  const w = ws();
  const KEY = "TAICHO_TEST_MCP_ENV_XZ"; // unique so it can't collide with a real var
  try {
    delete process.env[KEY];
    addMcpServer(w, "tp", { url: "https://x.example.com/mcp?key=${" + KEY + "}", env: { [KEY]: "abc123" } });
    // Before applying, the ref would resolve to empty; after, it resolves to the saved secret.
    expect(interpolateEnv("https://x.example.com/mcp?key=${" + KEY + "}")).toBe("https://x.example.com/mcp?key=");
    const applied = applyMcpEnv(w);
    expect(applied).toContain(KEY);
    expect(process.env[KEY]).toBe("abc123");
    expect(interpolateEnv("https://x.example.com/mcp?key=${" + KEY + "}")).toBe("https://x.example.com/mcp?key=abc123");
  } finally {
    delete process.env[KEY]; // never leak test state into other tests
  }
});
