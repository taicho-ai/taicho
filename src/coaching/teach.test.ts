import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3, simulateReadableStream } from "../core/mock-model"; // Plan 07: auto-streaming mock (re-exports simulateReadableStream for the direct-doStream Codex case)
import { draftPolicy, persistApprovedPolicy } from "./teach";
import { readPolicy } from "../store/policy";
import type { SpendLedger } from "../store/spend-ledger";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;
const DRAFT_JSON = JSON.stringify({ when: "writing a brief", do: "cite sources", scope: "agent" });

// Env (api-key) path: the distiller uses generateText (doGenerate).
const draftModel = () => new MockLanguageModelV3({
  doGenerate: (async () => ({ content: [{ type: "text", text: DRAFT_JSON }], finishReason: { unified: "stop", raw: "stop" }, usage })) as any,
});

// Codex subscription path: the backend rejects non-streaming, so the distiller must stream (doStream).
const draftStreamModel = () => new MockLanguageModelV3({
  doStream: (async () => ({
    stream: simulateReadableStream({
      initialDelayInMs: 0, chunkDelayInMs: 0,
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: DRAFT_JSON },
        { type: "text-end", id: "1" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ],
    }),
  })) as any,
});

/** A minimal in-memory squad ledger that just records what was committed — no DB needed here. */
function spyLedger(): { ledger: SpendLedger; committed: { tokens: number; costUsd: number } } {
  const committed = { tokens: 0, costUsd: 0 };
  const ledger: SpendLedger = {
    ceilings: {},
    current: () => ({ dayTokens: 0, weekTokens: 0, dayCostUsd: 0, weekCostUsd: 0 }),
    add: (d) => { committed.tokens += d.tokens; committed.costUsd += d.costUsd; },
  };
  return { ledger, committed };
}

test("draftPolicy parses a JSON draft from the model", async () => {
  const draft = await draftPolicy(draftModel(), "writer", "always cite");
  expect(draft.do).toBe("cite sources");
  expect(draft.scope).toBe("agent");
});

test("draftPolicy meters its distiller call into the squad ledger (Plan 09) — priced USD when a pricer is present", async () => {
  const { ledger, committed } = spyLedger();
  await draftPolicy(draftModel(), "writer", "always cite", { spendLedger: ledger, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  expect(committed.tokens).toBeGreaterThan(0); // the coaching call counts against the squad ceiling
  expect(committed.costUsd).toBeGreaterThan(0); // priced ⇒ real USD committed
});

test("draftPolicy is cost-honest for subscription (no pricer): tokens counted, USD stays 0 (never fabricated)", async () => {
  const { ledger, committed } = spyLedger();
  await draftPolicy(draftModel(), "writer", "always cite", { spendLedger: ledger }); // no priceUsd ⇒ subscription/unpriced
  expect(committed.tokens).toBeGreaterThan(0);
  expect(committed.costUsd).toBe(0);
});

test("Codex subscription path (Plan 07): draftPolicy STREAMS and routes system -> providerOptions.openai.instructions (+ store:false), still returns a valid draft", async () => {
  // Before the fix, draftPolicy called generateText (non-streaming) — which the Codex backend 400s
  // ("Stream must be set to true" / "Instructions are required"), so a signed-in subscription user's
  // /teach failed. It must now stream with the system prompt in `instructions`, like the agent loop.
  const model = draftStreamModel();
  const draft = await draftPolicy(model, "writer", "always cite", { codexBackend: true });
  expect(draft.do).toBe("cite sources");               // the streamed text was aggregated + parsed
  const call = (model as any).doStreamCalls[0];         // it used streamText (doStream), not doGenerate
  expect((model as any).doGenerateCalls?.length ?? 0).toBe(0);
  expect(call.providerOptions?.openai?.instructions).toContain("standing instruction"); // system → instructions
  expect(call.providerOptions?.openai?.store).toBe(false);
  expect(JSON.stringify(call.prompt)).not.toContain("standing instruction"); // NOT duplicated as a system message
});

test("Codex subscription path also meters its streamed usage into the squad ledger", async () => {
  const { ledger, committed } = spyLedger();
  await draftPolicy(draftStreamModel(), "writer", "always cite", { codexBackend: true, spendLedger: ledger });
  expect(committed.tokens).toBeGreaterThan(0); // usage read off the streamed result, committed to the ceiling
  expect(committed.costUsd).toBe(0);           // subscription ⇒ no pricer ⇒ honest 0 USD
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
