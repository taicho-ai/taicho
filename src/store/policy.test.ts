import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePolicy, listPolicies, readPolicy, deletePolicy } from "./policy";
import { PolicyNote } from "../schemas/policy";

const note = PolicyNote.parse({
  id: "pol_1", agent: "w", when: "writing a brief", do: "always cite sources",
  scope: "agent", status: "approved", taughtBy: "user", created: "2026-06-11T00:00:00.000Z",
});

test("write -> read round-trips a policy note", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-pol-"));
  writePolicy(ws, note);
  expect(readPolicy(ws, "w", "pol_1")).toEqual(note);
});
test("listPolicies returns an agent's notes; absent -> []", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-pol-"));
  expect(listPolicies(ws, "w")).toEqual([]);
  writePolicy(ws, note);
  expect(listPolicies(ws, "w").map((n) => n.id)).toEqual(["pol_1"]);
});
test("deletePolicy removes it", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-pol-"));
  writePolicy(ws, note);
  expect(deletePolicy(ws, "w", "pol_1")).toBe(true);
  expect(readPolicy(ws, "w", "pol_1")).toBeNull();
  expect(deletePolicy(ws, "w", "pol_1")).toBe(false);
});
test("malformed policy file is skipped by listPolicies", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-pol-"));
  writePolicy(ws, note);
  mkdirSync(join(ws, "agents", "w", "policies"), { recursive: true });
  writeFileSync(join(ws, "agents", "w", "policies", "bad.md"), "no frontmatter");
  expect(listPolicies(ws, "w").length).toBe(1);
});
