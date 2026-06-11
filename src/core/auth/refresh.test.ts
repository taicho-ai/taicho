import { test, expect } from "bun:test";
import { createRefresher, refreshToken, AuthExpiredError } from "./refresh";

const profile = { access_token: "old", refresh_token: "RT", expires_at: 0, account_id: "a" };

test("refreshToken posts grant_type=refresh_token and returns a new access token", async () => {
  let body = "";
  const f = (async (_u: string, init: { body: BodyInit }) => { body = init.body.toString(); return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
  const out = await refreshToken(profile, f, () => 1000);
  expect(body).toContain("grant_type=refresh_token");
  expect(body).toContain("refresh_token=RT");
  expect(out.access_token).toBe("new");
  expect(out.refresh_token).toBe("RT"); // preserved when the server doesn't rotate it
  expect(out.expires_at).toBe(1000 + 3600 * 1000);
});

test("a revoked refresh token throws AuthExpiredError", async () => {
  const f = (async () => new Response("revoked", { status: 400 })) as unknown as typeof fetch;
  await expect(refreshToken(profile, f)).rejects.toBeInstanceOf(AuthExpiredError);
});

test("createRefresher coalesces concurrent refreshes into ONE fetch (single-flight)", async () => {
  let calls = 0;
  const f = (async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return new Response(JSON.stringify({ access_token: "x", expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
  let saved = 0;
  const refresh = createRefresher({ load: () => profile, save: () => { saved++; }, fetchImpl: f, now: () => 0 });
  await Promise.all([refresh(), refresh(), refresh(), refresh()]);
  expect(calls).toBe(1);
  expect(saved).toBe(1);
});

test("createRefresher throws AuthExpiredError when no profile is stored", async () => {
  const refresh = createRefresher({ load: () => null, save: () => {} });
  await expect(refresh()).rejects.toBeInstanceOf(AuthExpiredError);
});
