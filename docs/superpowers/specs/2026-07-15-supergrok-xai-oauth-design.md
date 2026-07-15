# SuperGrok / xAI OAuth Subscription Support

**Date:** 2026-07-15
**Status:** proposed (backlog) — researched, NOT scheduled, NOT built. This is a future task.
**Topic:** Let taicho drive Grok models from a **SuperGrok / X Premium+ subscription** over xAI's
first-party **OAuth device-code flow** — no `XAI_API_KEY`, usage billed against the subscription
(flat, `costUsd: null`). Architecturally a near-twin of the existing ChatGPT/Codex backend.

> **Provenance / confidence.** Everything in §2 was gathered on 2026-07-15 from multiple independent
> open-source implementations (see §10). `x.ai`'s own pages returned HTTP 403 to automated fetches,
> so the primary vendor page is UNconfirmed — but the flow is corroborated by ≥5 independent projects
> (NousResearch Hermes Agent, OpenClaw, Kilo Code, OpenCode, oh-my-pi) and an open-source reference
> plugin. Items still marked **[VERIFY]** must be read out of the reference code before writing taicho code.

---

## 0. Thesis / why this is worth doing

Our cost analysis of run `00000000-0000-0000-2cd2-433f46ee5c59` showed the squad's workload is
input-heavy and cheap on Grok (Grok 4.5 ≈ $0.34/run pay-per-token, and Grok is a strong
tool-caller). A **subscription** removes per-token cost entirely — the same win taicho already gets
from the ChatGPT/Codex backend (`costUsd: null`, `costNote: "subscription"`). SuperGrok gives us a
second flat-rate subscription option, and — unlike Codex — xAI ships a **public** OAuth client, so
this is an officially-shipped path, not a reverse-engineered one.

## 1. What we verified, and how

- **xAI shipped a first-party OAuth flow for subscriptions in ~May 2026.** It authenticates a
  **SuperGrok** (grok.com) or **X Premium+** (linked X account) subscription — no API key.
- **It is an open, reusable flow**, not a private per-app deal: independent agents (Hermes Agent,
  OpenClaw, Kilo Code, OpenCode, oh-my-pi, OmniRoute) all implement it, and there is an open-source
  reference plugin (`ysnock404/opencode-grok-auth`).
- **The OAuth client_id is a public desktop client** — *"not a secret"* — so **no xAI app registration
  or approval is required**. Any app uses the public client.

## 2. The mechanism (from the reference implementations)

**Auth server:** `auth.x.ai` (a.k.a. `accounts.x.ai`)
- Authorization endpoint: `https://auth.x.ai/oauth2/authorize`
- OIDC discovery: `https://auth.x.ai/.well-known/openid-configuration` (use this to resolve token /
  device endpoints rather than hard-coding them)
- **OAuth 2.0 + PKCE** (`code_verifier` / `code_challenge`)
- **Public desktop `client_id`** — **[VERIFY]** exact string + scopes from reference code

**Two login flows** (we want the second for a CLI):
1. **Browser PKCE** — loopback callback `http://127.0.0.1:56121/callback` (random-port fallback).
2. **Device-code** — request a device code from `auth.x.ai`, show the user a URL (`x.ai/device`) +
   short code, poll until approved. **No local callback / port forward needed** → correct for
   headless / SSH / container use. **This is the flow taicho should implement first.**

**Inference:**
- Base URL: **`https://api.x.ai/v1`** (same host as the pay-per-token API)
- Header: **`Authorization: Bearer <access_token>`**
- Transport: **xAI Responses API** (Hermes labels it `codex_responses`). **[VERIFY]** whether this is
  wire-compatible with the AI-SDK OpenAI Responses path taicho's Codex provider already uses.
- Safety guard (adopt this): **refuse to send the OAuth bearer to any host other than `api.x.ai`.**

**Tokens:**
- Store locally; refresh **before each session** and **reactively on 401**.
- **Refresh tokens ROTATE on each use** — persist the newest one every refresh, or the next refresh
  fails with `invalid_grant`. (taicho's Codex refresh does not currently assume rotation — handle it.)
- A hard `invalid_grant` / revoked grant is terminal → surface a typed "please re-login" message.

**Models:** `grok-4.3`, `grok-build` (a.k.a. Grok Build). **[VERIFY]** the exact model IDs and which
tiers (SuperGrok vs SuperGrok Heavy) unlock which models + rate limits.

## 3. Design — a `xai-oauth` provider modeled on the Codex backend

This is deliberately a **twin of the Codex path**. Mirror it component-for-component:

| Concern | Codex (existing) | SuperGrok (new) |
|---|---|---|
| Provider factory | `src/core/providers/openai-codex.ts` (`createOpenAI` + custom `fetch` injecting the OAuth bearer + refresh-on-401) | `src/core/providers/xai-grok.ts` — same shape, base `https://api.x.ai/v1`, bearer from the xAI token |
| OAuth login | `src/core/auth/login.ts` `runLoginFlow` | add a xAI **device-code** login flow (new module or a branch) |
| Profile store | `src/core/auth/profile.ts` | store xAI tokens (access + rotating refresh + expiry + account) — separate profile from the ChatGPT one |
| Constants | `src/core/auth/constants.ts` | xAI auth server, discovery URL, public client_id, scopes |
| Provider enum | `src/store/config.ts` `type Provider` + `AuthSource` `oauth-openai-codex` kind | add `"xai-oauth"` + `AuthSource` kind `oauth-xai` |
| Selection | `TAICHO_PROVIDER=openai-codex`; subscription preferred over env keys | `TAICHO_PROVIDER=xai-oauth`; slot into the same precedence |
| `/login` | `onLogin` in `src/index.tsx` | `/login xai` (or `/login grok`) → the device-code flow |

## 4. Wiring points (exact files)

1. `src/core/providers/xai-grok.ts` **(new)** — the provider, cloned from `openai-codex.ts`.
2. `src/core/auth/` — new xAI device-code login + a xAI profile (alongside the ChatGPT profile);
   extend `constants.ts` with the xAI endpoints/client. Reference `src/core/mcp/oauth.ts` too — it is
   a second, independent PKCE implementation already in-tree.
3. `src/store/config.ts` — extend `type Provider`, `AuthSource`, and `resolveAuth`/`resolveConfig`
   precedence so a signed-in SuperGrok subscription is selectable and preferred like Codex.
4. `src/core/model.ts` — `buildModel`/`createModelResolver` learn the `xai-oauth` provider.
5. `src/index.tsx` — `onLogin` handles the xAI flow; boot resolves the xAI auth source.
6. `src/ui/slash.ts` — `/login xai` (+ `/logout xai`), `/status` shows the SuperGrok session.

## 5. Auth flow decision: device-code first

taicho is a terminal app that may run over SSH / in a container, so implement the **device-code**
flow first (no loopback port). The browser-PKCE loopback flow (`127.0.0.1:56121`) can be a later
nicety for local interactive use. This matches taicho's existing headless-friendly posture.

## 6. Cost & metering honesty

Follow the Codex precedent exactly: a SuperGrok run records **`costUsd: null` + `costNote:
"subscription"`**; tokens are still metered (budgets/ceilings enforced). Never fabricate a per-token
price for a subscription run. This keeps `/costs`, the spend ledger, and OTel honest — consistent
with the "Cost honesty" rule in CLAUDE.md.

## 7. Open questions to pin down BEFORE coding (read the reference plugin)

1. **[VERIFY]** exact public `client_id` string + requested scopes (`ysnock404/opencode-grok-auth`).
2. **[VERIFY]** device-code endpoints + polling/interval semantics (via OIDC discovery).
3. **[VERIFY]** Responses-API wire format — can taicho's Codex/AI-SDK Responses path be reused, or
   does xAI need its own request shaping (à la `codexBackend`'s `system → instructions`, `store:false`)?
4. **[VERIFY]** refresh-token rotation handling — confirm we must persist the new refresh token each
   cycle.
5. **[VERIFY]** which models each subscription tier unlocks + rate limits; pick a sensible default.
6. Does the streaming path (taicho streams every provider since Plan 07) work against `api.x.ai/v1`
   under OAuth? Test with the chunk-idle timer + `withRequestTimeout` wrappers.

## 8. Testing

- Unit: auth token lifecycle (login → store → refresh → rotation → 401-reauth → invalid_grant
  terminal) with a mocked auth server; provider builds a model whose `fetch` injects the bearer and
  refuses non-`api.x.ai` hosts.
- Model calls mocked with `MockLanguageModelV3` (no network), per the repo testing rule.
- Manual: a real `/login xai` device-code round-trip against a live SuperGrok account, one real turn,
  confirm `costUsd: null` and that Grok tool-calls/artifacts behave like the gpt-5.5 path.
- Run `bun run build` (single-binary bundle) — provider/auth wiring is exactly the kind of import
  issue tsc misses.

## 9. Caveats / risks

- **ToS / tier:** xAI shipping a public OAuth client + announcing third-party use strongly implies
  this is sanctioned, but taicho is not xAI-blessed by name. Confirm the SuperGrok tier's terms,
  model access, and rate limits before relying on it in production.
- **Undocumented drift:** the flow is corroborated by third parties, not confirmed on `x.ai`
  (403). Endpoints/client could change; keep the discovery-URL indirection so we adapt without a
  code change.
- **Rotation footgun:** mishandling the rotating refresh token bricks the session on the *second*
  call — cover it with a test.

## 10. References

- Open-source reference plugin: `https://github.com/ysnock404/opencode-grok-auth`
- Hermes Agent (NousResearch) xAI OAuth guide: `https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth`
- OpenClaw xAI provider: `https://docs.openclaw.ai/providers/xai`
- Kilo Code xAI: `https://kilo.ai/docs/ai-providers/xai`
- In-tree templates: `src/core/providers/openai-codex.ts`, `src/core/auth/*`, `src/core/mcp/oauth.ts`,
  `src/store/config.ts` (provider/auth resolution).

## 11. Next step when we pick this up

Start with §7 — read `opencode-grok-auth` for the literal client_id/scopes/endpoints and confirm the
Responses-API shape — THEN run the `superpowers:writing-plans` skill to turn this into a task-by-task
implementation plan. Do not begin coding before the §7 `[VERIFY]` items are resolved.
