import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "../core/mock-model"; // Plan 07: auto-streaming mock
import { draftPolicy, persistApprovedPolicy } from "./teach";
import { readPolicy } from "../store/policy";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;

test("draftPolicy parses a JSON draft from the model", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: (async () => ({ content: [{ type: "text", text: JSON.stringify({ when: "writing a brief", do: "cite sources", scope: "agent" }) }], finishReason: { unified: "stop", raw: "stop" }, usage })) as any,
  });
  const draft = await draftPolicy(model, "writer", "always cite");
  expect(draft.do).toBe("cite sources");
  expect(draft.scope).toBe("agent");
});

test("persistApprovedPolicy writes an approved note to disk", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-teach-"));
  const note = persistApprovedPolicy(ws, { when: "w", do: "d", scope: "agent" }, "writer");
  expect(note.status).toBe("approved");
  expect(note.agent).toBe("writer");
  expect(readPolicy(ws, "writer", note.id)?.do).toBe("d");
});

test("persistApprovedPolicy rejects an invalid scope (fails loud, not silently dropped)", () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-teach-"));
  expect(() => persistApprovedPolicy(ws, { when: "w", do: "d", scope: "agnt" } as never, "writer")).toThrow();
});
