import { test, expect } from "bun:test";
import { buildAuthorizeUrl, exchangeCode, decodeJwtPayload } from "./login";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("buildAuthorizeUrl includes PKCE + client + redirect + scope + state", async () => {
  const url = new URL(await buildAuthorizeUrl("verifier123", "state-abc"));
  expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  expect(url.searchParams.get("state")).toBe("state-abc");
  expect(url.searchParams.get("scope")).toContain("offline_access");
});

test("exchangeCode posts the PKCE verifier and extracts account_id from the id_token", async () => {
  const idToken = `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_xyz" } })}.sig`;
  let sentBody = "";
  const mockFetch = (async (_url: string, init: { body: BodyInit }) => {
    sentBody = init.body.toString();
    return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", id_token: idToken, expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
  const profile = await exchangeCode({ code: "CODE", verifier: "VER" }, mockFetch, () => 1_000_000);
  expect(sentBody).toContain("code_verifier=VER");
  expect(sentBody).toContain("grant_type=authorization_code");
  expect(profile.access_token).toBe("AT");
  expect(profile.refresh_token).toBe("RT");
  expect(profile.account_id).toBe("acct_xyz");
  expect(profile.expires_at).toBe(1_000_000 + 3600 * 1000);
});

test("exchangeCode throws on a non-OK token response", async () => {
  const mockFetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
  await expect(exchangeCode({ code: "x", verifier: "y" }, mockFetch)).rejects.toThrow();
});

test("decodeJwtPayload parses the base64url payload segment", () => {
  expect(decodeJwtPayload(`${b64({})}.${b64({ a: 1 })}.x`)).toEqual({ a: 1 });
});

test("exchangeCode throws when the id_token lacks the account_id claim", async () => {
  const idTokenNoAcct = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url")}.sig`;
  const mockFetch = (async () => new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", id_token: idTokenNoAcct, expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
  await expect(exchangeCode({ code: "c", verifier: "v" }, mockFetch)).rejects.toThrow(/account_id/);
});
