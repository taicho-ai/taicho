import { test, expect } from "bun:test";
import { createEmbedder, pickRuntime, pickPackageManager, installArgs, WORKER_SOURCE } from "./embed";

test("provider 'off' returns null (→ keyword+graph)", () => {
  expect(createEmbedder({ provider: "off", env: { OPENAI_API_KEY: "sk-x" } })).toBeNull();
});

test("openai backend requires OPENAI_API_KEY and reports its model/dim", () => {
  expect(createEmbedder({ provider: "openai", env: {} })).toBeNull();
  const e = createEmbedder({ provider: "openai", env: { OPENAI_API_KEY: "sk-x" } });
  expect(e).toMatchObject({ model: "text-embedding-3-small", dim: 1536 });
  expect(typeof e?.embed).toBe("function");
});

test("local backend is returned regardless of key (no-key local model), dim 384", () => {
  const e = createEmbedder({ provider: "local", env: {} });
  expect(e).toMatchObject({ model: "Xenova/all-MiniLM-L6-v2", dim: 384 });
});

test("default: openai when a key is present, else local", () => {
  expect(createEmbedder({ env: { OPENAI_API_KEY: "sk-x" } })?.model).toBe("text-embedding-3-small");
  expect(createEmbedder({ env: {} })?.model).toBe("Xenova/all-MiniLM-L6-v2");
});

// --- sidecar helpers (the shipped-binary path) -------------------------------------------------

test("pickRuntime prefers bun, falls back to node, else null", () => {
  expect(pickRuntime((c) => (c === "bun" ? "/bin/bun" : c === "node" ? "/bin/node" : null))).toBe("bun");
  expect(pickRuntime((c) => (c === "node" ? "/bin/node" : null))).toBe("node");
  expect(pickRuntime(() => null)).toBeNull();
});

test("pickPackageManager prefers bun, falls back to npm, else null", () => {
  expect(pickPackageManager((c) => (c === "bun" ? "/bin/bun" : c === "npm" ? "/bin/npm" : null))).toBe("bun");
  expect(pickPackageManager((c) => (c === "npm" ? "/bin/npm" : null))).toBe("npm");
  expect(pickPackageManager(() => null)).toBeNull();
});

test("installArgs maps to each package manager's add/install verb", () => {
  expect(installArgs("bun", "@huggingface/transformers@4.2.0")).toEqual(["add", "@huggingface/transformers@4.2.0"]);
  expect(installArgs("npm", "@huggingface/transformers@4.2.0")[0]).toBe("install");
  expect(installArgs("npm", "x@1")).toContain("--no-save");
});

test("WORKER_SOURCE is a self-contained ESM worker: imports the package, signals READY, reads the model from env", () => {
  expect(WORKER_SOURCE).toContain('from "@huggingface/transformers"');
  expect(WORKER_SOURCE).toContain('"READY\\n"');           // handshake the client waits for
  expect(WORKER_SOURCE).toContain("TAICHO_EMBED_MODEL");   // model injected by env, not hardcoded
  expect(WORKER_SOURCE).toContain("TAICHO_MODELS_DIR");    // weights cache dir injected by env
});
