import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { draftPolicy, persistApprovedPolicy } from "./teach";
import { readPolicy } from "../store/policy";
import type { DeckLedger } from "../store/deck-budget";

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } } as const;

const draftModel = () => new MockLanguageModelV3({
  doGenerate: (async () => ({ content: [{ type: "text", text: JSON.stringify({ when: "writing a brief", do: "cite sources", scope: "agent" }) }], finishReason: { unified: "stop", raw: "stop" }, usage })) as any,
});

/** A minimal in-memory deck ledger that just records what was committed — no DB needed here. */
function spyLedger(): { ledger: DeckLedger; committed: { tokens: number; costUsd: number } } {
  const committed = { tokens: 0, costUsd: 0 };
  const ledger: DeckLedger = {
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

test("draftPolicy meters its distiller call into the deck ledger (Plan 09) — priced USD when a pricer is present", async () => {
  const { ledger, committed } = spyLedger();
  await draftPolicy(draftModel(), "writer", "always cite", { deckLedger: ledger, priceUsd: ({ inputTokens, outputTokens }) => inputTokens + outputTokens });
  expect(committed.tokens).toBeGreaterThan(0); // the coaching call counts against the deck ceiling
  expect(committed.costUsd).toBeGreaterThan(0); // priced ⇒ real USD committed
});

test("draftPolicy is cost-honest for subscription (no pricer): tokens counted, USD stays 0 (never fabricated)", async () => {
  const { ledger, committed } = spyLedger();
  await draftPolicy(draftModel(), "writer", "always cite", { deckLedger: ledger }); // no priceUsd ⇒ subscription/unpriced
  expect(committed.tokens).toBeGreaterThan(0);
  expect(committed.costUsd).toBe(0);
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
