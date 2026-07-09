import { test, expect } from "bun:test";
import { parseInput } from "./input";

test("classifies slash commands", () => {
  expect(parseInput("/costs writer")).toEqual({ kind: "slash", cmd: "costs", arg: "writer" });
  expect(parseInput("/agents")).toEqual({ kind: "slash", cmd: "agents", arg: "" });
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
