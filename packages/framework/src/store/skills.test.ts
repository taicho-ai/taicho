import { test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { paths } from "./files";
import { Skill } from "@taicho-ai/contracts/skill";
import { serializeSkill, parseSkill, writeSkill, readSkill, listSkills, deleteSkill, reindexSkills, getActiveSkills, mkSkillId } from "./skills";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-skill-"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mk = (over: any = {}) => Skill.parse({ id: mkSkillId(), name: "n", description: "d", body: "step 1", created: new Date().toISOString(), ...over });

test("serialize/parse round-trips a skill", () => {
  const s = mk({ name: "deploy", description: "how to deploy", tags: ["ops"], body: "1. do x" });
  const back = parseSkill(serializeSkill(s));
  expect(back.name).toBe("deploy");
  expect(back.body).toBe("1. do x");
  expect(back.tags).toEqual(["ops"]);
});

test("writeSkill persists the file + row; readSkill reads it back", () => {
  const w = ws(); const db = openDb(w);
  writeSkill(w, db, mk({ id: "skill_a", name: "alpha" }));
  expect(existsSync(paths.skillFile(w, "skill_a"))).toBe(true);
  expect(readSkill(w, "skill_a")?.name).toBe("alpha");
  expect(getActiveSkills(db).map((r) => r.id)).toContain("skill_a");
});

test("getActiveSkills excludes draft skills", () => {
  const w = ws(); const db = openDb(w);
  writeSkill(w, db, mk({ id: "skill_on", status: "active" }));
  writeSkill(w, db, mk({ id: "skill_off", status: "draft" }));
  expect(getActiveSkills(db).map((r) => r.id)).toEqual(["skill_on"]);
});

test("reindexSkills rebuilds the table from files; deleteSkill removes file + row", () => {
  const w = ws(); const db = openDb(w);
  writeSkill(w, db, mk({ id: "skill_a", name: "alpha", tags: ["x"] }));
  db.exec("DELETE FROM skills");
  expect(getActiveSkills(db).length).toBe(0);
  reindexSkills(w, db);
  expect(getActiveSkills(db).map((r) => r.id)).toEqual(["skill_a"]);
  expect(getActiveSkills(db)[0]!.tags).toEqual(["x"]); // tags round-trip through the index
  expect(deleteSkill(w, db, "skill_a")).toBe(true);
  expect(existsSync(paths.skillFile(w, "skill_a"))).toBe(false);
  expect(getActiveSkills(db).length).toBe(0);
});
