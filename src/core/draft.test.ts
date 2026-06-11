import { test, expect } from "bun:test";
import { mergeDraft } from "./draft";
test("mergeDraft overrides only provided non-empty fields", () => {
  expect(mergeDraft({ id: "a", role: "r", identity: "i" }, { role: "r2" })).toEqual({ id: "a", role: "r2", identity: "i" });
  expect(mergeDraft({ id: "a", role: "r" }, { role: "" })).toEqual({ id: "a", role: "r" });
  expect(mergeDraft({ id: "a" }, {})).toEqual({ id: "a" });
});
