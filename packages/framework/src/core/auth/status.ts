/** Pure presentation helpers for auth status / onboarding lines (unit-tested).
 *  No I/O, no token material — safe to call from the REPL render path. */
import type { AuthSource } from "../../store/config";

export function formatAuthStatus(source: AuthSource): string {
  switch (source.kind) {
    case "env": return `env:${source.provider} (${source.model})`;
    case "oauth-openai-codex": {
      const when = new Date(source.expiresAt).toISOString();
      return `oauth:openai-codex (expires ${when})`;
    }
    case "none": return "none — set an API key or run /login openai";
  }
}

export function noCredentialLines(): string[] {
  return [
    "taicho — no credentials configured.",
    "Either set ANTHROPIC_API_KEY / OPENAI_API_KEY and relaunch,",
    "or run /login openai to sign in with your ChatGPT subscription (no API key needed).",
  ];
}

export function authExpiredMessage(): string {
  return "ChatGPT session expired — run /login openai to sign in again.";
}
