import { test, expect } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { withRequestTimeout, DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from "./request-timeout";

// A fake fetch that behaves like a real one: it hangs until its signal aborts, then rejects with the
// signal's abort reason (exactly what a hung fetch does when its AbortSignal fires). `onSignal` lets a
// test capture the signal handed to the underlying fetch so it can assert real teardown.
function hangingFetch(onSignal?: (s: AbortSignal | null | undefined) => void): typeof fetch {
  return ((_input: unknown, init?: { signal?: AbortSignal | null }) =>
    new Promise((_resolve, reject) => {
      const sig = init?.signal;
      onSignal?.(sig);
      if (sig?.aborted) return reject(sig.reason ?? new Error("aborted"));
      sig?.addEventListener("abort", () => reject(sig.reason ?? new Error("aborted")), { once: true });
    })) as typeof fetch;
}

test("a hung request errors after the deadline with a retryable ETIMEDOUT (routes through maxRetries)", async () => {
  // The AI SDK short-circuits AbortError/TimeoutError (no retry) but RETRIES an error whose .code is a
  // network code like ETIMEDOUT (isBunNetworkError → isRetryable). So the deadline must surface
  // ETIMEDOUT for T3 (route through the SDK's own maxRetries) — never a bespoke retry loop here.
  const wrapped = withRequestTimeout(hangingFetch(), 40);
  const err = await wrapped("https://example.test/model").then(
    () => { throw new Error("expected the deadline to reject"); },
    (e) => e as Error & { code?: string },
  );
  expect(err.code).toBe("ETIMEDOUT");
  expect(err.message).toContain("transport deadline");
});

test("real teardown: the deadline aborts the underlying fetch's signal (no abandoned/leaked request)", async () => {
  // The old watchdog only ABANDONED the promise (wedged stream + closure leaked). Here the deadline
  // aborts the signal the underlying fetch is holding — proof the connection is actually torn down.
  let captured: AbortSignal | null | undefined;
  const wrapped = withRequestTimeout(hangingFetch((s) => { captured = s; }), 40);
  await wrapped("https://example.test/model").catch(() => {});
  expect(captured).toBeDefined();
  expect(captured!.aborted).toBe(true); // the underlying fetch saw a real abort, not an abandon
});

test("a user abort propagates unchanged — it is NOT rewritten as a timeout (so the loop cancels)", async () => {
  const controller = new AbortController();
  const wrapped = withRequestTimeout(hangingFetch(), 5_000); // deadline far away; the user aborts first
  const p = wrapped("https://example.test/model", { signal: controller.signal });
  const reason = new DOMException("user cancelled", "AbortError");
  setTimeout(() => controller.abort(reason), 20);
  const err = await p.then(() => { throw new Error("expected the abort to reject"); }, (e) => e as { name?: string; code?: string });
  expect(err.code).not.toBe("ETIMEDOUT"); // a cancel must never masquerade as a transport timeout
  expect(err.name).toBe("AbortError");
});

test("a fast response passes straight through and the deadline never fires", async () => {
  const ok = new Response("ok", { status: 200 });
  const wrapped = withRequestTimeout((async () => ok) as unknown as typeof fetch, 1_000);
  const res = await wrapped("https://example.test/model");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

test("timeoutMs <= 0 disables the deadline (returns the base fetch unchanged)", () => {
  const base = (async () => new Response("x")) as unknown as typeof fetch;
  expect(withRequestTimeout(base, 0)).toBe(base);
  expect(withRequestTimeout(base, -1)).toBe(base);
});

test("exposes a sane default deadline", () => {
  expect(DEFAULT_MODEL_REQUEST_TIMEOUT_MS).toBe(120_000);
});

test("end-to-end: a hung fetch behind a REAL provider is retried by the AI SDK, then fails cleanly (no hang, no leaked stream)", async () => {
  // T3/T6b: the deadline surfaces ETIMEDOUT precisely so the AI SDK's OWN maxRetries handles it — no
  // hand-rolled retry. Build a real provider whose transport hangs; the SDK must re-attempt the model
  // request maxRetries+1 times (proof it routed through retries), then reject cleanly (proof it never
  // hangs / leaks the stream). maxRetries:1 keeps the SDK's 2s backoff to a single wait.
  let fetchCalls = 0;
  const hung = withRequestTimeout(hangingFetch(() => { fetchCalls += 1; }), 30);
  const model = createOpenAI({ apiKey: "test-key", fetch: hung })("gpt-4o-mini");
  // Same shape the loop uses: onError captures, consumeStream drains WITHOUT rejecting (no dangling
  // rejected promises), so the run fails cleanly instead of hanging or leaking the stream.
  let sdkError: unknown;
  const res = streamText({ model, prompt: "hi", maxRetries: 1, onError: ({ error }) => { sdkError = error; } });
  await res.consumeStream();
  expect(fetchCalls).toBe(2);        // initial attempt + exactly one retry → routed through maxRetries
  expect(sdkError).toBeDefined();    // and it FAILED (cleanly) rather than hanging
}, 8000);
