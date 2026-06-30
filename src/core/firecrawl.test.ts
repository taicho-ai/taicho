import { test, expect } from "bun:test";
import { scrapeUrl } from "./firecrawl";

const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

test("scrapeUrl returns markdown on success", async () => {
  const r = await scrapeUrl("https://x/docs", { apiKey: "k", fetchImpl: ok({ success: true, data: { markdown: "# Install" } }) });
  expect(r).toEqual({ markdown: "# Install" });
});

test("scrapeUrl errors on a non-2xx response", async () => {
  const fetchImpl = (async () => new Response("payment required", { status: 402 })) as unknown as typeof fetch;
  const r = await scrapeUrl("https://x", { apiKey: "k", fetchImpl });
  expect("error" in r && r.error).toContain("402");
});

test("scrapeUrl errors (no network) when the api key is missing", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response("", { status: 200 }); }) as unknown as typeof fetch;
  const r = await scrapeUrl("https://x", { apiKey: "", fetchImpl });
  expect("error" in r && /FIRECRAWL_API_KEY/.test(r.error)).toBe(true);
  expect(called).toBe(false); // bailed before any fetch
});

test("scrapeUrl errors when firecrawl returns no markdown", async () => {
  const r = await scrapeUrl("https://x", { apiKey: "k", fetchImpl: ok({ success: true, data: {} }) });
  expect("error" in r).toBe(true);
});
