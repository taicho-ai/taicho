/** Codex-backed (ChatGPT subscription) provider. Built on the AI-SDK OpenAI provider with the
 *  Codex baseURL + a custom fetch that injects the OAuth Bearer token and refreshes on 401.
 *  Tokens are NEVER logged; use redactAuthHeader for any debug output. */
import { createOpenAI } from "@ai-sdk/openai";
import type { AuthProfile } from "../auth/profile";
import { AuthExpiredError } from "../auth/refresh";
import { OPENAI_CODEX_AUTH, codexHeaders } from "../auth/constants";

export function redactAuthHeader(value: string | null): string {
  if (!value) return "";
  return value.replace(/Bearer\s+\S+/i, "Bearer ***");
}

interface AuthFetchDeps {
  load: () => AuthProfile | null;
  refresh: () => Promise<AuthProfile>;
  baseFetch?: typeof fetch;
}

/** Wrap fetch to inject Codex auth headers; on 401, refresh once (single-flight upstream) + retry. */
export function makeAuthFetch(deps: AuthFetchDeps): typeof fetch {
  const base = deps.baseFetch ?? fetch;
  const send = (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], profile: AuthProfile) => {
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(codexHeaders(profile.access_token, profile.account_id))) headers.set(k, v);
    return base(input, { ...init, headers });
  };
  return (async (input, init) => {
    const profile = deps.load();
    if (!profile) throw new AuthExpiredError();
    const res = await send(input, init, profile);
    if (res.status !== 401) return res;
    const refreshed = await deps.refresh(); // throws AuthExpiredError if refresh fails
    return send(input, init, refreshed);
  }) as typeof fetch;
}

/** An AI-SDK provider whose model calls hit the Codex backend with the subscription token.
 *  apiKey is a placeholder — real auth is the Authorization header set by makeAuthFetch. */
export function createCodexProvider(deps: AuthFetchDeps) {
  return createOpenAI({
    baseURL: `${OPENAI_CODEX_AUTH.codexBaseUrl}/v1`,
    apiKey: "codex-oauth",
    fetch: makeAuthFetch(deps),
  });
}
