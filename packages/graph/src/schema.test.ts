import { test, expect } from "bun:test";
import { parseWorkflowDef, loadWorkflowDefText } from "./schema";

const base = { id: "daily-brief", team: "news", version: 1 };

test("an agent step (run:) normalizes to kind:agent with consumes defaulted to []", () => {
  const wf = parseWorkflowDef({ ...base, steps: [{ id: "research", run: "@researcher", produces: "sources" }] });
  expect(wf.steps[0]).toMatchObject({ kind: "agent", id: "research", run: "@researcher", produces: "sources", consumes: [] });
});

test("a check step (check:) normalizes to kind:check with max_attempts defaulted to 2", () => {
  const wf = parseWorkflowDef({ ...base, steps: [{ id: "verify", check: "≥3 sources", on_fail: "research" }] });
  expect(wf.steps[0]).toMatchObject({ kind: "check", id: "verify", check: "≥3 sources", on_fail: "research", max_attempts: 2 });
});

test("a human step (human:) normalizes to kind:human with default choices approve/reject", () => {
  const wf = parseWorkflowDef({ ...base, steps: [{ id: "signoff", human: "editor sign-off" }] });
  expect(wf.steps[0]).toMatchObject({ kind: "human", id: "signoff", choices: ["approve", "reject"], routes: {} });
});

test("a parallel step (over:/join:) normalizes to kind:parallel", () => {
  const wf = parseWorkflowDef({ ...base, steps: [{ id: "fan", over: "items", join: "@merger", produces: "report" }] });
  expect(wf.steps[0]).toMatchObject({ kind: "parallel", id: "fan", over: "items", join: "@merger", produces: "report" });
});

test("a branch step (branch:) normalizes to kind:branch", () => {
  const wf = parseWorkflowDef({ ...base, steps: [{ id: "triage", branch: "@classifier", routes: { bug: "fix", question: "answer" } }] });
  expect(wf.steps[0]).toMatchObject({ kind: "branch", id: "triage", branch: "@classifier", routes: { bug: "fix", question: "answer" } });
});

test("a step carrying two kind-keys is rejected, naming the step id", () => {
  expect(() => parseWorkflowDef({ ...base, steps: [{ id: "bad", run: "@a", check: "x" }] })).toThrow(/bad/);
});

test("a step carrying no kind-key is rejected, naming the step id", () => {
  expect(() => parseWorkflowDef({ ...base, steps: [{ id: "bad", produces: "x" }] })).toThrow(/bad/);
});

test("an invalid step id (uppercase) is rejected", () => {
  expect(() => parseWorkflowDef({ ...base, steps: [{ id: "Bad Id", run: "@a" }] })).toThrow();
});

test("loadWorkflowDefText parses steps from frontmatter, injects team, ignores the prose lanes", () => {
  const text = [
    "---",
    "workflow: daily-brief",
    "version: 3",
    'brief: "morning market brief"',
    "steps:",
    "  - id: research",
    '    run: "@researcher"',
    "    produces: sources",
    "  - id: signoff",
    '    human: "editor sign-off"',
    "    choices: [approve, revise]",
    "    routes: { revise: research }",
    "---",
    "",
    "## researcher",
    "do the research",
    "",
  ].join("\n");
  const wf = loadWorkflowDefText(text, "news");
  expect(wf).not.toBeNull();
  expect(wf).toMatchObject({ id: "daily-brief", team: "news", version: 3, brief: "morning market brief" });
  expect(wf!.steps).toHaveLength(2);
  expect(wf!.steps[0].kind).toBe("agent");
  expect(wf!.steps[1]).toMatchObject({ kind: "human", id: "signoff", routes: { revise: "research" } });
});

test("loadWorkflowDefText returns null for a Plan 23 prose-only file (no steps: block)", () => {
  const text = "---\nworkflow: x\n---\n## seat\nlane\n";
  expect(loadWorkflowDefText(text, "news")).toBeNull();
});

test("loadWorkflowDefText returns null when there is no frontmatter at all", () => {
  expect(loadWorkflowDefText("## seat\nlane", "news")).toBeNull();
});
