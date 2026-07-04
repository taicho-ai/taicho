import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordVerificationFailure, REPEAT_FAILURE_THRESHOLD } from "./patterns";
import { listPolicies } from "../store/policy";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-patterns-"));

test("a ONE-OFF verification failure proposes nothing (a single miss is noise, not a pattern)", () => {
  const w = ws();
  const r = recordVerificationFailure(w, { targetAgent: "researcher", criteria: "every source dated", runId: "researcher/r1", reasons: ["source 3 undated"] });
  expect(r.proposed).toBeUndefined();
  expect(listPolicies(w, "researcher")).toEqual([]);
});

test("the SAME agent failing the SAME criteria a 2nd time PROPOSES a captain-gated coaching note", () => {
  const w = ws();
  expect(recordVerificationFailure(w, { targetAgent: "researcher", criteria: "every source dated", runId: "researcher/r1", reasons: ["source 3 undated"] }).proposed).toBeUndefined();
  const r2 = recordVerificationFailure(w, { targetAgent: "researcher", criteria: "every source dated", runId: "researcher/r2", reasons: ["source 5 undated"] });
  expect(r2.proposed).toBeDefined();

  const notes = listPolicies(w, "researcher");
  expect(notes.length).toBe(1);
  expect(notes[0].status).toBe("proposed");     // approval-gated — NOT auto-applied (run.ts applies only "approved")
  expect(notes[0].agent).toBe("researcher");    // coaches the failing (producer) agent
  expect(notes[0].scope).toBe("agent");
  expect(notes[0].taughtBy).toBe("verification");
  // the accumulated reasons feed the instruction (raw material → coaching)
  expect(notes[0].do).toContain("source 3 undated");
  expect(notes[0].do).toContain("source 5 undated");
});

test("the threshold constant is honored: proposal fires exactly ON the Nth distinct failure", () => {
  const w = ws();
  expect(REPEAT_FAILURE_THRESHOLD).toBe(2);
  const r1 = recordVerificationFailure(w, { targetAgent: "a", criteria: "c", runId: "a/1" });
  expect(r1.proposed).toBeUndefined();
  const r2 = recordVerificationFailure(w, { targetAgent: "a", criteria: "c", runId: "a/2" });
  expect(r2.proposed).toBeDefined();
});

test("normalization: trivial criteria variation (whitespace/case) still counts as ONE pattern", () => {
  const w = ws();
  recordVerificationFailure(w, { targetAgent: "a", criteria: "Must mention Y", runId: "a/1" });
  const r2 = recordVerificationFailure(w, { targetAgent: "a", criteria: "  must   mention  y ", runId: "a/2" });
  expect(r2.proposed).toBeDefined();            // matched despite case + whitespace differences
});

test("different criteria for the same agent do NOT combine into a false pattern", () => {
  const w = ws();
  recordVerificationFailure(w, { targetAgent: "a", criteria: "criteria one", runId: "a/1" });
  const r2 = recordVerificationFailure(w, { targetAgent: "a", criteria: "criteria two", runId: "a/2" });
  expect(r2.proposed).toBeUndefined();          // two DIFFERENT contracts, each a one-off
  expect(listPolicies(w, "a")).toEqual([]);
});

test("different agents failing the same criteria do NOT combine (pattern is per target agent)", () => {
  const w = ws();
  recordVerificationFailure(w, { targetAgent: "a", criteria: "c", runId: "a/1" });
  const r2 = recordVerificationFailure(w, { targetAgent: "b", criteria: "c", runId: "b/1" });
  expect(r2.proposed).toBeUndefined();
});

test("a duplicate re-record of the SAME failing run neither double-counts nor re-proposes", () => {
  const w = ws();
  recordVerificationFailure(w, { targetAgent: "a", criteria: "c", runId: "a/1" });
  // re-recording run a/1 must not tip the count to the threshold (it is not a distinct failing run)
  const dup = recordVerificationFailure(w, { targetAgent: "a", criteria: "c", runId: "a/1" });
  expect(dup.proposed).toBeUndefined();
  expect(listPolicies(w, "a")).toEqual([]);
  // a genuinely-new second run DOES propose, exactly once…
  const r2 = recordVerificationFailure(w, { targetAgent: "a", criteria: "c", runId: "a/2" });
  expect(r2.proposed).toBeDefined();
  // …and a THIRD failure does not re-nag (already past the threshold)
  const r3 = recordVerificationFailure(w, { targetAgent: "a", criteria: "c", runId: "a/3" });
  expect(r3.proposed).toBeUndefined();
  expect(listPolicies(w, "a").length).toBe(1);
});
