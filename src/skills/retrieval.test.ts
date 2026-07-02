import { test, expect } from "bun:test";
import { rankSkills } from "./retrieval";
import type { SkillRow } from "../store/skills";

const row = (over: Partial<SkillRow>): SkillRow => ({ id: "s", name: "n", description: "d", tags: [], status: "active", body: "b", ...over });

test("ranks by name/description/tag overlap and caps at k", () => {
  const rows: SkillRow[] = [
    row({ id: "s1", name: "deploy-service", description: "ship to prod", tags: ["ops"] }),
    row({ id: "s2", name: "write-artifact", description: "produce a clean document", tags: ["writing"] }),
    row({ id: "s3", name: "delegate", description: "hand off a goal to another agent", tags: [] }),
  ];
  const hits = rankSkills(rows, "how do I deploy to prod", 2);
  expect(hits[0]!.id).toBe("s1");
  expect(hits.length).toBeLessThanOrEqual(2);
});

test("excludes draft skills and returns [] for an empty query", () => {
  const rows: SkillRow[] = [row({ id: "s1", name: "deploy", status: "draft" })];
  expect(rankSkills(rows, "deploy", 5)).toEqual([]);
  expect(rankSkills([row({ id: "s2", name: "deploy", status: "active" })], "", 5)).toEqual([]);
});
