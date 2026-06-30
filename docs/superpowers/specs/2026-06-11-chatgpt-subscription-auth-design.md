# taicho · ChatGPT Subscription Sign-In (Design)

**Date:** 2026-06-11
**Status:** proposed
**Roadmap home:** post-Phase-2 (needs the Phase 2 `modelFor(agentDef)` seam; independent of Phase 3 coaching)

---

## 1. Goal

`taicho` can be driven by a **ChatGPT Plus/Pro/Team subscription with zero API keys**: a `/login openai` flow performs OAuth (PKCE) against the user's ChatGPT account and routes model calls through the Codex backend at the subscription's flat rate. This deletes the credit-card/API-key step from onboarding — the single biggest install-funnel killer for an OSS agent CLI.

**Definition of done:**

1. Fresh machine, no env keys: boot shows the no-credentials message offering `(a)` paste an API key path or `(b)` `/login openai`.
2. `/login openai` prints an auth URL (and tries to open the browser); completing it stores a profile at `~/.taicho/auth-profiles/openai-codex.json` (mode 0600); the REPL becomes immediately usable without restart.
3. Tokens auto-refresh during use; an expired/revoked refresh token degrades to the state-aware "session expired — `/login openai` again" message, never a stack trace.
4. Runs served by subscription record `costUsd: null` + `costNote: "subscription"` in traces (never a fake $0 — the advisory cost system must not lie).
5. Explicit API keys (env) take precedence over a stored OAuth profile; `TAICHO_PROVIDER` can force either.
6. `taicho logout openai` deletes the profile.
7. Feature is behind a config flag (`auth.chatgpt_signin: true` default) so it can be remotely-documented off if OpenAI's policy changes.

## 2. Is this allowed? (compliance position)

- **Yes for individual use of one's own subscription.** OpenAI publicly endorsed third-party subscription sign-in (Altman, May 2026, re: OpenClaw: "you can sign in to openclaw with your chatgpt account now and use your subscription there!"; OpenAI: "We want people to be able to use Codex, and their ChatGPT subscription, wherever they like.")
- **Not covered:** account pooling, credential sharing, proxying many users through one subscription, resale. taicho must not facilitate these: one profile per machine-user, no profile export command, docs state the boundary.
- **Policy risk is real:** Anthropic (Apr 2026) and Google (Gemini CLI) removed equivalents. Hence the kill-switch flag (DoD #7) and hence **Claude-subscription OAuth is explicitly out of scope** — Anthropic does not permit it; taicho's Anthropic path stays API-key-only.
- Quotas are OpenAI's (e.g. weekly Codex hours on Plus); taicho surfaces quota errors honestly (§3.5).

## 3. Design

### 3.1 Flow (PKCE, mirrors Codex CLI / OpenClaw)

1. Generate `code_verifier` + S256 `code_challenge`; start a localhost callback listener on an ephemeral port (fallback: paste-the-redirect-URL mode for headless/SSH, same as `codex login --device-auth` UX).
2. Open the authorization URL (Codex OAuth client; same published client id Codex CLI uses — crib exact constants from the open-source Codex CLI / OpenClaw implementations at build time, do not hardcode from this spec).
3. Exchange code → `{ access_token, refresh_token, expires_at, account_id }`.
4. Persist to `~/.taicho/auth-profiles/openai-codex.json`, chmod 600. (`~/.taicho/` is the user-global home — auth is per-user, NOT per-workspace; workspaces stay shareable/committable with zero secrets.)

### 3.2 Provider wiring

- New module `src/core/providers/openai-codex.ts`: an AI-SDK-compatible provider built on the OpenAI provider with `baseURL` pointed at the Codex responses endpoint and a custom `fetch` that injects `Authorization: Bearer <access_token>` (+ required Codex session headers, per reference implementations).
- The custom fetch owns the refresh loop: on 401 → single-flight refresh (mutex — concurrent agent runs must not stampede the refresh endpoint) → retry once → on failure, throw a typed `AuthExpiredError` the REPL maps to the re-login message.
- `resolveConfig()` precedence: `TAICHO_PROVIDER` override → env API keys → stored OAuth profiles → none (state-aware no-credentials boot). Phase 2's `modelFor(agentDef)` consumes this unchanged — per-agent model selection works identically for subscription-backed models.
- Model ids exposed: the Codex-served GPT-5.x set; map into the existing pricing table as `subscription` (no USD rate) → trace `costUsd: null`, `costNote: "subscription"`. Token metering unchanged (tokens stay the hard budget — caps work identically regardless of auth path).

### 3.3 REPL / onboarding integration

- Boot, no credentials (extends today's fixed message): deterministic text offering env-key instructions **or** `/login openai`. Still zero LLM calls below the credential line.
- `/login openai` works at any time; success message names the plan if the token response exposes it.
- `/status` (exists or trivial) shows auth source: `env:anthropic`, `oauth:openai-codex (expires …)`, etc.

### 3.4 Storage & security

- Plaintext JSON file, 0600, in `~/.taicho/auth-profiles/` — matches Codex CLI (`~/.codex/auth.json`) and OpenClaw precedent. OS keychain integration = post-v1 nice-to-have, not a blocker.
- Never log tokens; redact `Authorization` in any debug/trace output (add a redaction helper to the provider fetch).
- `.gitignore` irrelevant (file is outside workspaces by design — see §3.1.4).

### 3.5 Failure modes

| Failure | Behavior |
|---|---|
| User abandons browser flow | listener times out (120s) → friendly cancel message |
| Refresh token revoked/expired | typed error → REPL: "ChatGPT session expired — `/login openai`" |
| Subscription quota exhausted | surface OpenAI's quota error verbatim + "resets weekly; or set an API key for overflow" |
| Endpoint/policy shut off upstream | provider errors mapped to: "subscription sign-in unavailable — see docs; use an API key"; config flag allows hard-disable |
| Clock skew / expires_at in past | always trust 401-triggered refresh over local expiry math |

## 4. Out of scope

- Anthropic/Google subscription OAuth (not permitted by those providers).
- Account pooling, multi-user profiles, CI/headless service use of a personal subscription.
- Proxying or re-exposing the subscription to taicho's own agents-as-API.
- OS keychain storage (post-v1).

## 5. Test plan

- **Unit:** PKCE verifier/challenge generation; profile read/write + chmod; precedence matrix (env beats profile beats none); refresh single-flight (N concurrent 401s → exactly one refresh call); redaction helper.
- **Integration (mock OAuth server):** full login → store → call → 401 → refresh → retry; revoked-refresh path → typed error; quota-error mapping.
- **Manual E2E (gated, real account):** login on a real Plus account, run the demo squad, confirm trace shows `costUsd: null` + correct token counts; logout; expired-session message.

## 6. References

- OpenAI Codex auth docs: developers.openai.com/codex/auth
- Codex CLI (open source — OAuth constants + flow): github.com/openai/codex
- OpenClaw OpenAI provider (reference implementation): docs.openclaw.ai/providers/openai · github.com/openclaw/openclaw
- Policy receipts: Altman announcement re: OpenClaw sign-in (May 2026); OpenAI statement "use Codex and your ChatGPT subscription wherever they like"; TNW coverage of Anthropic blocking the equivalent (Apr 2026).
