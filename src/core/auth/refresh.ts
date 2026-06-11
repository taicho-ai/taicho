/** Access-token refresh + single-flight coalescing. A failed/revoked refresh -> AuthExpiredError. */
import { OPENAI_CODEX_AUTH } from "./constants";
import type { AuthProfile } from "./profile";

export class AuthExpiredError extends Error {
  constructor(message = "ChatGPT session expired — run /login openai") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

interface RefreshResponse { access_token: string; refresh_token?: string; expires_in: number; }

export async function refreshToken(
  profile: AuthProfile,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<AuthProfile> {
  const res = await fetchImpl(OPENAI_CODEX_AUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: profile.refresh_token,
      client_id: OPENAI_CODEX_AUTH.clientId,
    }),
  });
  if (!res.ok) throw new AuthExpiredError();
  const t = (await res.json()) as RefreshResponse;
  return {
    ...profile,
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? profile.refresh_token,
    expires_at: now() + t.expires_in * 1000,
  };
}

/** Returns a refresh() that shares one in-flight refresh across concurrent callers. */
export function createRefresher(opts: {
  load: () => AuthProfile | null;
  save: (p: AuthProfile) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): () => Promise<AuthProfile> {
  let inFlight: Promise<AuthProfile> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const current = opts.load();
      if (!current) throw new AuthExpiredError();
      const refreshed = await refreshToken(current, opts.fetchImpl ?? fetch, opts.now ?? Date.now);
      opts.save(refreshed);
      return refreshed;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
}
