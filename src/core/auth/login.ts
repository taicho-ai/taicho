/** OAuth (PKCE authorization-code) login flow for ChatGPT subscription sign-in.
 *  Pure/exchange units are unit-tested; runLoginFlow (callback server + browser) is manual E2E. */
import { OPENAI_CODEX_AUTH } from "./constants";
import { generateCodeVerifier, codeChallenge } from "./pkce";
import type { AuthProfile } from "./profile";

interface TokenResponse { access_token: string; refresh_token: string; id_token?: string; expires_in: number; }

export async function buildAuthorizeUrl(verifier: string, state: string): Promise<string> {
  const u = new URL(OPENAI_CODEX_AUTH.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", OPENAI_CODEX_AUTH.clientId);
  u.searchParams.set("redirect_uri", OPENAI_CODEX_AUTH.redirectUri);
  u.searchParams.set("scope", OPENAI_CODEX_AUTH.scopes);
  u.searchParams.set("code_challenge", await codeChallenge(verifier));
  u.searchParams.set("code_challenge_method", OPENAI_CODEX_AUTH.codeChallengeMethod);
  u.searchParams.set("state", state);
  u.searchParams.set("originator", OPENAI_CODEX_AUTH.originator);
  return u.toString();
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("invalid jwt: no payload segment");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function accountIdFrom(idToken: string | undefined): string {
  if (!idToken) return "";
  try {
    const payload = decodeJwtPayload(idToken);
    const ns = payload[OPENAI_CODEX_AUTH.accountIdClaim.namespace] as Record<string, unknown> | undefined;
    return (ns?.[OPENAI_CODEX_AUTH.accountIdClaim.field] as string)
      ?? (payload[OPENAI_CODEX_AUTH.accountIdClaim.field] as string)
      ?? "";
  } catch { return ""; }
}

export async function exchangeCode(
  opts: { code: string; verifier: string },
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<AuthProfile> {
  const res = await fetchImpl(OPENAI_CODEX_AUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: OPENAI_CODEX_AUTH.redirectUri,
      client_id: OPENAI_CODEX_AUTH.clientId,
      code_verifier: opts.verifier,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  const t = (await res.json()) as TokenResponse;
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: now() + t.expires_in * 1000,
    account_id: accountIdFrom(t.id_token),
  };
}

export interface LoginDeps {
  openBrowser?: (url: string) => void;
  onUrl?: (url: string) => void; // so the REPL can print the URL for the paste fallback
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Interactive: open the browser, run a localhost callback server, exchange the code. Manual E2E. */
export async function runLoginFlow(deps: LoginDeps = {}): Promise<AuthProfile> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const verifier = generateCodeVerifier();
  const state = generateCodeVerifier();
  const url = await buildAuthorizeUrl(verifier, state);

  let resolveCode!: (code: string) => void;
  let rejectFlow!: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => { resolveCode = res; rejectFlow = rej; });

  const server = Bun.serve({
    port: OPENAI_CODEX_AUTH.callbackPort,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === OPENAI_CODEX_AUTH.callbackPath) {
        if (u.searchParams.get("state") !== state) { rejectFlow(new Error("OAuth state mismatch")); return new Response("state mismatch", { status: 400 }); }
        const code = u.searchParams.get("code");
        if (code) { resolveCode(code); return new Response("taicho: signed in — you can close this tab."); }
      }
      return new Response("not found", { status: 404 });
    },
  });

  const timer = setTimeout(() => rejectFlow(new Error("login timed out — run /login openai again")), deps.timeoutMs ?? 120_000);
  deps.onUrl?.(url);
  (deps.openBrowser ?? defaultOpen)(url);
  try {
    const code = await codePromise;
    return await exchangeCode({ code, verifier }, fetchImpl);
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}

function defaultOpen(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" }); } catch { /* fall back to the printed URL */ }
}
