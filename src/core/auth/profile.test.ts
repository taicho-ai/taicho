import { test, expect } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProfile, readProfile, deleteProfile, profilePath } from "./profile";

const sample = { access_token: "at", refresh_token: "rt", expires_at: 1750000000000, account_id: "acct_1" };

test("write -> read round-trips and the file is mode 0600", () => {
  const home = mkdtempSync(join(tmpdir(), "taicho-home-"));
  writeProfile(sample, home);
  expect(readProfile(home)).toEqual(sample);
  expect(statSync(profilePath(home)).mode & 0o777).toBe(0o600);
});

test("absent profile reads as null; delete removes it", () => {
  const home = mkdtempSync(join(tmpdir(), "taicho-home-"));
  expect(readProfile(home)).toBeNull();
  writeProfile(sample, home);
  expect(deleteProfile(home)).toBe(true);
  expect(readProfile(home)).toBeNull();
  expect(deleteProfile(home)).toBe(false);
});
