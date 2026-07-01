import { test, expect } from "bun:test";
import { createEmbedder } from "./embed";

test("provider 'off' returns null (→ keyword+graph)", () => {
  expect(createEmbedder({ provider: "off", env: { OPENAI_API_KEY: "sk-x" } })).toBeNull();
});

test("openai backend requires OPENAI_API_KEY and reports its model/dim", () => {
  expect(createEmbedder({ provider: "openai", env: {} })).toBeNull();
  const e = createEmbedder({ provider: "openai", env: { OPENAI_API_KEY: "sk-x" } });
  expect(e).toMatchObject({ model: "text-embedding-3-small", dim: 1536 });
  expect(typeof e?.embed).toBe("function");
});

test("local backend is returned regardless of key (self-installing WASM model), dim 384", () => {
  const e = createEmbedder({ provider: "local", env: {} });
  expect(e).toMatchObject({ model: "Xenova/all-MiniLM-L6-v2", dim: 384 });
});

test("default: openai when a key is present, else local", () => {
  expect(createEmbedder({ env: { OPENAI_API_KEY: "sk-x" } })?.model).toBe("text-embedding-3-small");
  expect(createEmbedder({ env: {} })?.model).toBe("Xenova/all-MiniLM-L6-v2");
});
