/** OAuth + Codex-backend constants for ChatGPT subscription sign-in.
 *
 *  Cribbed from the open-source Codex CLI (github.com/openai/codex) and the OpenAI Codex auth
 *  docs (developers.openai.com/codex/auth), per the spec's instruction NOT to hardcode auth
 *  constants from the design doc itself. VERIFIED values are used directly; anything marked
 *  UNVERIFIED keeps live auth behind the `auth.chatgpt_signin` flag until confirmed against the
 *  Codex source. None of these matter for the unit/integration tests, which use a mock OAuth
 *  server + mock fetch — they only govern real end-to-end sign-in.
 */
export const OPENAI_CODEX_AUTH = {
  /** Codex's public OAuth client id (verified). */
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  /** OAuth endpoints (verified). */
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  /** Localhost loopback redirect (verified: Codex default callback server). */
  redirectUri: "http://localhost:1455/auth/callback",
  callbackPort: 1455,
  callbackPath: "/auth/callback",
  /** Authorize params (verified). */
  scopes: "openid profile email offline_access",
  codeChallengeMethod: "S256" as const,
  /** Originator string the Codex CLI sends (header `originator`). VERIFIED against codex-rs:
   *  login/src/auth/default_client.rs → `DEFAULT_ORIGINATOR = "codex_cli_rs"`. The backend
   *  allowlists first-party originators, so a wrong value can be rejected. */
  originator: "codex_cli_rs",

  /** Codex subscription backend (verified, codex-rs model-provider-info: CHATGPT_CODEX_BASE_URL).
   *  The Responses API is served at baseURL + "/responses" (NO /v1 — that's the api.openai.com
   *  convention; the @ai-sdk/openai provider appends "/responses" itself). */
  codexBaseUrl: "https://chatgpt.com/backend-api/codex",
  responsesPath: "/responses",
  defaultModelId: "gpt-5.5", // VERIFIED: current Codex default slug (codex-rs models-manager/models.json)

  /** account_id is extracted from the `id_token` JWT. UNVERIFIED: confirm the exact claim path
   *  (Codex reads a ChatGPT account id from a namespaced auth claim in the id_token). */
  accountIdClaim: { namespace: "https://api.openai.com/auth", field: "chatgpt_account_id" },

  /** Refresh the access token when it is within this many ms of expiry (verified ~5 min). */
  refreshSkewMs: 5 * 60_000, // currently informational only — refresh is 401-driven; proactive refresh is deferred
} as const;

/** Headers attached to every Codex-backend model request.
 *  `Authorization: Bearer <access_token>` + `chatgpt-account-id: <account_id>` are well-attested.
 *  UNVERIFIED: whether an additional `OpenAI-Beta` / `originator` / `session_id` header is
 *  required by the Codex responses endpoint — confirm against the Codex source. */
export function codexHeaders(accessToken: string, accountId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    originator: OPENAI_CODEX_AUTH.originator,
  };
}
