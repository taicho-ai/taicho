import { test, expect } from "bun:test";
import { runSlash, COMMANDS, suggestCommands, cycleIndex, parseMcpCommand, formatMcpStatus } from "./slash";
import { parseKbCommand } from "./slash";
import type { RunTrace } from "../schemas/trace";

const roster = [{ id: "root", role: "orch", is_root: 1 }, { id: "w", role: "writes", is_root: 0 }];
const trace = (id: string): RunTrace => ({
  id, agent: id.split("/")[0], task: "t", triggeredBy: "user",
  ledger: { retrieved: [], applied: [], skipped: [], knowledge: [], skills: [] },
  toolCalls: [{ tool: "write_artifact", count: 1 }], artifacts: ["a.md"], inputArtifacts: [], outputArtifacts: [], delegatedOut: [], verification: [],
  outcome: "completed", tokens: 5, contextTokens: 0, costUsd: 0.01, verifierTokens: 0, verifierCostUsd: 0, notes: [], durationMs: 1, started: "2026-06-11T00:00:00.000Z",
});
const deps = {
  roster,
  listTraces: (a?: string) => (a ? [trace(`${a}/2026-06-11-run1`)] : [trace("root/2026-06-11-run1"), trace("w/2026-06-11-run1")]),
  readTrace: (id: string) => { if (id === "missing") throw new Error("nope"); return trace(id); },
  listPolicies: (a: string) => a === "w" ? [{ id: "pol_1", agent: "w", when: "x", do: "y", scope: "agent", status: "approved", taughtBy: "user", created: "2026-06-11T00:00:00.000Z", expanded: [] } as any] : [],
  deletePolicy: (_a: string, p: string) => p === "pol_1",
  approvePolicy: (p: string) => p === "pol_1" ? ({ id: "pol_1", agent: "w", when: "x", do: "y", scope: "agent", status: "approved", taughtBy: "verification", created: "2026-06-11T00:00:00.000Z", expanded: [] } as any) : null,
};

test("/help lists the grammar", () => { expect(runSlash("help", "", deps).map(l => l.text).join("\n")).toContain("/agents"); });
test("/agents lists roster with root marked", () => {
  const out = runSlash("agents", "", deps).map((l) => l.text);
  expect(out.some((t) => t.includes("* root"))).toBe(true);
  expect(out.some((t) => t.includes("- w"))).toBe(true);
});
test("/runs lists all; /runs <agent> filters", () => {
  expect(runSlash("runs", "", deps).length).toBe(2);
  expect(runSlash("runs", "w", deps).length).toBe(1);
});
test("/runs rows include a duration (the waterfall picker)", () => {
  expect(runSlash("runs", "", deps)[0].text).toMatch(/\d+\.\d+s/);
});
test("/runs with no runs -> message", () => {
  expect(runSlash("runs", "", { ...deps, listTraces: () => [] })[0].text).toContain("no runs");
});
// `/trace` is now interactive (App.tsx opens the TraceInspector) — no longer a pure one-liner here.
test("unknown command -> message", () => { expect(runSlash("frob", "", deps)[0].text).toContain("unknown command"); });

test("/policies lists an agent's notes; empty -> message", () => {
  expect(runSlash("policies", "w", deps)[0].text).toContain("pol_1");
  expect(runSlash("policies", "none", deps)[0].text).toContain("no policies");
});
test("/forget deletes by id; missing -> message; bad usage -> hint", () => {
  expect(runSlash("forget", "w pol_1", deps)[0].text).toContain("forgot");
  expect(runSlash("forget", "w nope", deps)[0].text).toContain("no such policy");
  expect(runSlash("forget", "w", deps)[0].text).toContain("usage");
});
test("/policies approve <id> flips a proposed note (via approvePolicy); unknown id / no id -> message", () => {
  expect(runSlash("policies", "approve pol_1", deps)[0].text).toContain("approved pol_1");
  expect(runSlash("policies", "approve nope", deps)[0].text).toContain("no proposed policy");
  expect(runSlash("policies", "approve", deps)[0].text).toContain("usage");
  // the list path still works and is not shadowed by the approve subcommand
  expect(runSlash("policies", "w", deps)[0].text).toContain("pol_1");
});

test("suggestCommands: all on bare slash, prefix-filtered, none past the command or for non-slash", () => {
  expect(suggestCommands("/").length).toBe(COMMANDS.length);
  expect(suggestCommands("/te").map((c) => c.name)).toEqual(["teach"]);
  expect(suggestCommands("/TR").map((c) => c.name)).toEqual(["trace"]); // case-insensitive
  expect(suggestCommands("/zzz")).toEqual([]);
  expect(suggestCommands("/runs ")).toEqual([]); // space -> into args, not completing the name
  expect(suggestCommands("hello")).toEqual([]);
  expect(suggestCommands("")).toEqual([]);
});

test("cycleIndex: wraps both ends, moves in the middle, guards empty", () => {
  expect(cycleIndex(2, 3, +1)).toBe(0); // wrap past the end
  expect(cycleIndex(0, 3, -1)).toBe(2); // wrap before the start
  expect(cycleIndex(0, 3, +1)).toBe(1); // middle move
  expect(cycleIndex(0, 0, +1)).toBe(0); // empty-list guard
});

test("/help is derived from COMMANDS (lists every command)", () => {
  const text = runSlash("help", "", { roster: [], listTraces: () => [], readTrace: () => { throw new Error(); }, listPolicies: () => [], deletePolicy: () => false, approvePolicy: () => null }).map((l) => l.text).join("\n");
  for (const c of COMMANDS) expect(text).toContain(`/${c.name}`);
});

test("parseMcpCommand: bare and explicit list", () => {
  expect(parseMcpCommand("")).toEqual({ kind: "list" });
  expect(parseMcpCommand("list")).toEqual({ kind: "list" });
});
test("parseMcpCommand: add stdio with args", () => {
  expect(parseMcpCommand("add web npx -y tavily-mcp")).toEqual({ kind: "add", name: "web", spec: { command: "npx", args: ["-y", "tavily-mcp"] } });
});
test("parseMcpCommand: add stdio with --env", () => {
  expect(parseMcpCommand("add svc node server.js --env KEY=val")).toEqual({ kind: "add", name: "svc", spec: { command: "node", args: ["server.js"], env: { KEY: "val" } } });
});
test("parseMcpCommand: add http with --oauth", () => {
  expect(parseMcpCommand("add linear https://mcp.linear.app/mcp --oauth")).toEqual({ kind: "add", name: "linear", spec: { url: "https://mcp.linear.app/mcp", auth: "oauth" } });
});
test("parseMcpCommand: add http with a quoted --header (space in value survives)", () => {
  expect(parseMcpCommand('add docs https://x.com/mcp --header "Authorization: Bearer abc"')).toEqual({ kind: "add", name: "docs", spec: { url: "https://x.com/mcp", headers: { Authorization: "Bearer abc" } } });
});
test("parseMcpCommand: remove/login/reconnect take a name", () => {
  expect(parseMcpCommand("remove web")).toEqual({ kind: "remove", name: "web" });
  expect(parseMcpCommand("login linear")).toEqual({ kind: "login", name: "linear" });
  expect(parseMcpCommand("reconnect web")).toEqual({ kind: "reconnect", name: "web" });
});
test("parseMcpCommand: errors on missing pieces and unknown subcommand", () => {
  expect(parseMcpCommand("add").kind).toBe("error");
  expect(parseMcpCommand("add web").kind).toBe("error"); // no command/url
  expect(parseMcpCommand("remove").kind).toBe("error");
  expect(parseMcpCommand("bogus").kind).toBe("error");
});
test("parseMcpCommand: rejects bad names and mismatched transport flags", () => {
  expect(parseMcpCommand("add a/b npx x").kind).toBe("error");                  // `/` in name
  expect(parseMcpCommand("remove a/b").kind).toBe("error");
  expect(parseMcpCommand("add web https://x.com/mcp --env K=V").kind).toBe("error"); // --env on http
  expect(parseMcpCommand("add web npx pkg --oauth").kind).toBe("error");        // --oauth on stdio
});
test("formatMcpStatus renders icons + tool counts", () => {
  const lines = formatMcpStatus([
    { name: "web", kind: "stdio", status: "connected", toolCount: 3 },
    { name: "lin", kind: "http", status: "needs-auth", toolCount: 0 },
    { name: "bad", kind: "http", status: "error", toolCount: 0, error: "boom" },
  ]);
  expect(lines[0]).toContain("web"); expect(lines[0]).toContain("3 tool(s)");
  expect(lines[1]).toContain("needs-auth");
  expect(lines[2]).toContain("boom");
  expect(formatMcpStatus([])[0]).toContain("no MCP servers");
});

test("parseKbCommand parses subcommands and filters", () => {
  expect(parseKbCommand("sync")).toEqual({ kind: "sync" });
  expect(parseKbCommand("reindex")).toEqual({ kind: "reindex" });
  expect(parseKbCommand("forget kind=decision")).toEqual({ kind: "forget", filter: { kind: "decision" } });
  expect(parseKbCommand("forget source=worker-x:")).toEqual({ kind: "forget", filter: { sourcePrefix: "worker-x:" } });
  expect(parseKbCommand("forget id=kb_a id=kb_b")).toEqual({ kind: "forget", filter: { ids: ["kb_a", "kb_b"] } });
  expect(parseKbCommand("list kind=fact")).toEqual({ kind: "list", filter: { kind: "fact" } });
  expect(parseKbCommand("list")).toEqual({ kind: "list", filter: {} });
  expect(parseKbCommand("forget").kind).toBe("error");   // refuse an empty forget filter
  expect(parseKbCommand("wat").kind).toBe("error");
});

import { parseSkillCommand, parseArtifactsCommand } from "./slash";

test("parseSkillCommand parses subcommands", () => {
  expect(parseSkillCommand("list")).toEqual({ kind: "list" });
  expect(parseSkillCommand("")).toEqual({ kind: "list" }); // bare /skills → list
  expect(parseSkillCommand("reindex")).toEqual({ kind: "reindex" });
  expect(parseSkillCommand("show deploy")).toEqual({ kind: "show", arg: "deploy" });
  expect(parseSkillCommand("remove skill_a")).toEqual({ kind: "remove", id: "skill_a" });
  expect(parseSkillCommand("show").kind).toBe("error");   // needs an arg
  expect(parseSkillCommand("wat").kind).toBe("error");
});

test("parseArtifactsCommand parses subcommands (Plan 01 Ph4 UI)", () => {
  expect(parseArtifactsCommand("")).toEqual({ kind: "list" });               // bare /artifacts → list
  expect(parseArtifactsCommand("list")).toEqual({ kind: "list", q: undefined });
  expect(parseArtifactsCommand("list foo")).toEqual({ kind: "list", q: "foo" });
  expect(parseArtifactsCommand("gc")).toEqual({ kind: "gc" });
  expect(parseArtifactsCommand("show doc@v2")).toEqual({ kind: "show", handle: "doc@v2" });
  expect(parseArtifactsCommand("approve doc")).toEqual({ kind: "approve", handle: "doc" });
  // annotate splits the FIRST token as the handle, the rest (spaces preserved) as the feedback body
  expect(parseArtifactsCommand("annotate doc@v1 add more dates")).toEqual({ kind: "annotate", handle: "doc@v1", body: "add more dates" });
  expect(parseArtifactsCommand("annotate doc").kind).toBe("error");          // needs a body
  expect(parseArtifactsCommand("show").kind).toBe("error");                  // needs a handle
  expect(parseArtifactsCommand("wat").kind).toBe("error");
});
