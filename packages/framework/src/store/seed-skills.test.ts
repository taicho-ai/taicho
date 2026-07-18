import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./files";
import { seedSkills, STARTER_SKILLS } from "./seed-skills";
import { readSkill } from "./skills";

const ws = () => mkdtempSync(join(tmpdir(), "taicho-seed-"));

test("seedSkills writes the starter skills when skills/ is empty", async () => {
  const w = ws();
  await seedSkills(w);
  const files = readdirSync(paths.skillsDir(w)).filter((f) => f.endsWith(".md"));
  expect(files.length).toBe(STARTER_SKILLS.length);
  for (const s of STARTER_SKILLS) expect(readSkill(w, s.id)?.name).toBe(s.name);
});

test("Plan 14: write-a-clear-artifact points at the granted save_artifact, not the dangling write_artifact call", () => {
  const skill = STARTER_SKILLS.find((s) => s.name === "write-a-clear-artifact")!;
  expect(skill.body).toContain("save_artifact");                  // the structured, always-granted tool
  expect(skill.body).not.toMatch(/calling write_artifact/);       // the old dangling reference is gone
});

test("seedSkills is a no-op when skills already exist (doesn't clobber curation)", async () => {
  const w = ws();
  mkdirSync(paths.skillsDir(w), { recursive: true });
  writeFileSync(paths.skillFile(w, "skill_custom"), "---\nid: skill_custom\nname: custom\ndescription: mine\ntags: []\nstatus: active\ncreated: 2026-07-02T00:00:00.000Z\n---\nmy steps\n");
  await seedSkills(w);
  const files = readdirSync(paths.skillsDir(w)).filter((f) => f.endsWith(".md"));
  expect(files).toEqual(["skill_custom.md"]); // starters NOT written
});
