/** OAuth profile store: a token bundle persisted per-user (NOT per-workspace) at
 *  ~/.taicho/auth-profiles/openai-codex.json, mode 0600. Never logged. */
import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";

export const AuthProfile = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(), // epoch ms
  account_id: z.string(),
  plan: z.string().optional(),
});
export type AuthProfile = z.infer<typeof AuthProfile>;

export function authDir(home = homedir()): string { return join(home, ".taicho", "auth-profiles"); }
export function profilePath(home = homedir()): string { return join(authDir(home), "openai-codex.json"); }

export function writeProfile(p: AuthProfile, home = homedir()): void {
  mkdirSync(authDir(home), { recursive: true, mode: 0o700 });
  const f = profilePath(home);
  writeFileSync(f, JSON.stringify(AuthProfile.parse(p), null, 2), { mode: 0o600 });
  chmodSync(f, 0o600); // guarantee 0600 even if the file pre-existed with a looser mode
}

export function readProfile(home = homedir()): AuthProfile | null {
  const f = profilePath(home);
  if (!existsSync(f)) return null;
  try { return AuthProfile.parse(JSON.parse(readFileSync(f, "utf8"))); } catch { return null; }
}

export function deleteProfile(home = homedir()): boolean {
  const f = profilePath(home);
  if (!existsSync(f)) return false;
  rmSync(f);
  return true;
}
