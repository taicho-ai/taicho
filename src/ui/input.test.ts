import { test, expect } from "bun:test";
import { parseInput } from "./input";

test("classifies slash commands", () => {
  expect(parseInput("/runs writer")).toEqual({ kind: "slash", cmd: "runs", arg: "writer" });
  expect(parseInput("/trace")).toEqual({ kind: "slash", cmd: "trace", arg: "" });
});

test("classifies @address with remaining text", () => {
  expect(parseInput("@writer draft the intro")).toEqual({ kind: "address", to: "writer", text: "draft the intro" });
});

test("bare text is chat", () => {
  expect(parseInput("I need a researcher")).toEqual({ kind: "chat", text: "I need a researcher" });
});

test("@ with no valid id falls back to chat", () => {
  expect(parseInput("@ hello")).toEqual({ kind: "chat", text: "@ hello" });
});
