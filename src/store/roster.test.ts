import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeAgent, parseAgent, seedRoot } from "./roster";
import { AgentDef } from "../schemas/agent";

const sample = AgentDef.parse({
  id: "researcher", role: "Covers geopolitics with web search",
  identity: "You are a careful researcher.\nCite sources.",
  tools: ["write_artifact"], canSee: ["*"], canDelegateTo: [], isRoot: false,
  created: "2026-06-11T00:00:00.000Z",
});

test("serialize -> parse round-trips an AgentDef", () => {
  const round = parseAgent(serializeAgent(sample));
  expect(round).toEqual(sample);
});

test("parse rejects a file with no frontmatter", () => {
  expect(() => parseAgent("just text")).toThrow();
});

test("seedRoot writes an isRoot agent.md once and is idempotent", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-"));
  await seedRoot(ws);
  const first = await Bun.file(join(ws, "agents", "root", "agent.md")).text();
  const root = parseAgent(first);
  expect(root.isRoot).toBe(true);
  expect(root.id).toBe("root");
  expect(root.tools).toContain("create_agent");
  await seedRoot(ws); // must not throw or change the file
  expect(await Bun.file(join(ws, "agents", "root", "agent.md")).text()).toBe(first);
});
