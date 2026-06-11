# ChatGPT Subscription Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **This is security-sensitive (OAuth + token storage) — do not fabricate endpoints/secrets; pin exact constants from the real Codex CLI source (Task 0).**

**Goal:** `/login openai` signs in with a ChatGPT subscription via OAuth (PKCE) and routes model calls through the Codex backend at the subscription's flat rate — zero API key required. Implements `docs/superpowers/specs/2026-06-11-chatgpt-subscription-auth-design.md`.

**Architecture:** A new `src/core/auth/` module (PKCE, profile store, OAuth login, refresh) + a `src/core/providers/openai-codex.ts` AI-SDK-compatible provider whose custom `fetch` injects the Bearer token + Codex headers and owns a single-flight refresh-on-401 loop. `resolveConfig` precedence extends to `env keys > stored OAuth profile > none`. Subscription runs record `costUsd: null` + `costNote:"subscription"` (the advisory cost system must not lie). Behind config flag `auth.chatgpt_signin` (default on).

**Branch:** `feat-chatgpt-signin` (off `main`, which now has Phases 1+2).

---

## Researched constants (confirmed from live sources — see References)
- `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`
- `AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"`
- `TOKEN_URL = "https://auth.openai.com/oauth/token"`
- `CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"` (model calls → `/v1/responses`)
- Localhost callback default port **1455**; PKCE method **S256**; refresh when token within ~5 min of expiry.
- Profile path (taicho's own, per spec — NOT `~/.codex`): `~/.taicho/auth-profiles/openai-codex.json`, mode `0600`.

## ⚠️ Task 0: PIN the remaining exact constants from the Codex CLI source (DO FIRST, do not guess)
Read the open-source Codex CLI auth/login code (github.com/openai/codex — the login/OAuth module) and record the EXACT values into `src/core/auth/constants.ts`:
- [ ] `REDIRECT_URI` (exact path, e.g. `http://localhost:1455/auth/callback` — confirm path).
- [ ] `SCOPES` (exact scope string, e.g. `openid profile email offline_access` — confirm).
- [ ] Token-response shape + where `account_id` comes from (likely a claim in the `id_token` JWT — confirm the exact claim path).
- [ ] The EXACT headers the Codex backend requires on model requests (Authorization: Bearer; and account/session headers such as `chatgpt-account-id`, `OpenAI-Beta`, `originator`, `session_id` — confirm names/values).
- [ ] Device-auth (`--device-auth`) endpoint/flow if implementing the headless fallback.
Commit `constants.ts` with a comment citing the source commit/file. **Every later task imports from here; if a value is unknown, mark it `// UNVERIFIED` and the live-auth tasks stay behind the config flag until confirmed.**

## Task breakdown (each its own TDD task, committed)
1. **PKCE utils** (`src/core/auth/pkce.ts`) — `code_verifier` (43–128 char base64url) + S256 `code_challenge`; pure; unit tests (verifier charset/length, challenge = base64url(sha256(verifier))).
2. **Profile store** (`src/core/auth/profile.ts`) — read/write/delete `~/.taicho/auth-profiles/openai-codex.json` at mode 0600; `AuthProfile` zod schema `{access_token, refresh_token, expires_at, account_id, plan?}`; tests (write→chmod 0600 asserted via stat, read round-trip, delete, absent→null). Never log tokens.
3. **OAuth login** (`src/core/auth/login.ts`) — build authorize URL (constants + PKCE + state), start localhost:1455 listener (ephemeral-port fallback) with a paste-the-redirect fallback for headless, exchange code→tokens, persist via the store. 120s timeout → friendly cancel. Integration test against a **mock OAuth server** (no real network).
4. **Refresh + errors** (`src/core/auth/refresh.ts`) — single-flight refresh (a shared in-flight Promise / mutex so concurrent agent runs trigger exactly ONE refresh), typed `AuthExpiredError`; tests (N concurrent expiries → 1 refresh call; revoked refresh → AuthExpiredError).
5. **Codex provider** (`src/core/providers/openai-codex.ts`) — AI-SDK OpenAI-compatible provider with `baseURL = CODEX_BASE_URL` + custom `fetch` that injects Authorization + Codex headers, redacts Authorization in any debug output, and on 401 → single-flight refresh → retry once → else throw `AuthExpiredError`. Tests with a mock fetch (401→refresh→retry; redaction).
6. **Auth resolution + cost + flag** — extend `resolveConfig`/a new `resolveAuth` so precedence is `TAICHO_PROVIDER` → env API keys → OAuth profile → none; gate behind `config.auth?.chatgpt_signin !== false`; map Codex-served models to **`costUsd: null` + `costNote:"subscription"`** (extend `RunTrace`: `costUsd: number | null`, add `costNote?: string`); token metering unchanged (caps still work). Tests: precedence matrix; subscription run → `costUsd:null`+costNote; token caps still enforced.
7. **REPL/onboarding** (`src/ui/App.tsx` + `src/ui/slash` + `index.tsx`) — no-credentials boot offers `(a)` API-key path or `(b)` `/login openai`; `/login openai` (browser+paste fallback) usable anytime, success names the plan if exposed; `/logout openai` deletes the profile; `/status` shows auth source (`env:anthropic`, `oauth:openai-codex (expires …)`); expired→ "ChatGPT session expired — `/login openai`" (no stack trace). Pure parts (status formatting, no-cred message) unit-tested; interactive login is manual E2E.
8. **Full green + review + manual E2E** — `bun test` + `tsc` + build; adversarial review (refresh single-flight correctness, token redaction, no token logging, precedence, cost-never-lies); **manual E2E on a real Plus account is the user's** (login → run demo squad → trace shows `costUsd:null` + real token counts → `/status` → logout → expired-session message).

## Compliance / security guardrails (from spec §2, §3.4)
- Individual use of one's own subscription only. **No** profile export/pooling/multi-user/proxy commands. One profile per machine-user.
- Profile is user-global (`~/.taicho/`), never inside a workspace — workspaces stay committable with zero secrets.
- Never log/echo tokens; redact `Authorization`. Anthropic/Google subscription OAuth explicitly **out of scope** (not permitted) — Anthropic path stays API-key-only.
- Kill-switch: `auth.chatgpt_signin: false` hard-disables if upstream policy changes.

## References (source of constants — re-verify at build)
- OpenAI Codex auth docs: https://developers.openai.com/codex/auth
- Codex CLI (OSS, OAuth constants + flow): https://github.com/openai/codex
- Reference impl: https://github.com/EvanZhouDev/openai-oauth
