import { test, expect } from "bun:test";
import { makeAuthFetch, redactAuthHeader, createCodexProvider } from "./openai-codex";
import { AuthExpiredError } from "../auth/refresh";

const p1 = { access_token: "AT1", refresh_token: "RT", expires_at: 0, account_id: "acct" };
const p2 = { ...p1, access_token: "AT2" };

test("auth fetch injects Bearer + account header and retries once on 401 after refresh", async () => {
  let cur = p1, n = 0;
  const seen: { auth: string | null; acct: string | null }[] = [];
  const baseFetch = (async (_u: string, init: { headers?: HeadersInit }) => {
    n++;
    const h = new Headers(init.headers);
    seen.push({ auth: h.get("authorization"), acct: h.get("chatgpt-account-id") });
    return new Response("ok", { status: n === 1 ? 401 : 200 });
  }) as unknown as typeof fetch;
  const refresh = async () => { cur = p2; return p2; };
  const f = makeAuthFetch({ load: () => cur, refresh, baseFetch });
  const res = await f("https://x/v1/responses", { method: "POST" });
  expect(res.status).toBe(200);
  expect(n).toBe(2);                          // exactly one retry
  expect(seen[0].auth).toBe("Bearer AT1");    // first attempt: original token
  expect(seen[0].acct).toBe("acct");
  expect(seen[1].auth).toBe("Bearer AT2");    // retry: refreshed token
});

test("auth fetch throws AuthExpiredError when no profile is stored", async () => {
  const f = makeAuthFetch({ load: () => null, refresh: async () => { throw new Error("unused"); } });
  await expect(f("https://x", {})).rejects.toBeInstanceOf(AuthExpiredError);
});

test("a persistent 401 (refresh didn't help) returns the 401 (caller maps to re-login)", async () => {
  const baseFetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  const f = makeAuthFetch({ load: () => p1, refresh: async () => p2, baseFetch });
  const res = await f("https://x", { method: "POST" });
  expect(res.status).toBe(401);
});

test("redactAuthHeader masks the bearer token", () => {
  expect(redactAuthHeader("Bearer sk-secret-123")).toBe("Bearer ***");
  expect(redactAuthHeader(null)).toBe("");
});

test("createCodexProvider builds a callable provider", () => {
  const provider = createCodexProvider({ load: () => p1, refresh: async () => p1 });
  expect(typeof provider).toBe("function");
});
