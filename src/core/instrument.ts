/** Pure helpers for the instrumentation seam: a one-line, redacted, length-capped render of tool
 *  args ("read_url https://foo…", "run_command bun test") plus a capped JSON for the waterfall
 *  drill-in. Transparency WITHOUT payload dumping, and NEVER logs auth material (mirrors the
 *  redactAuthHeader discipline). No I/O — unit-tested in isolation. */

const PREVIEW_CAP = 80;
const JSON_CAP = 2000;
/** Keys whose values are secrets/auth material and must never surface in a preview or a stored arg. */
const SECRET_KEY = /(^|_|-)(token|secret|password|passwd|authorization|auth|bearer|api[_-]?key|apikey|key|credential|cookie|session)s?($|_|-)/i;
const REDACTED = "‹redacted›";

/** Cap a string to `n` chars, collapsing whitespace/newlines to single spaces first (one-liner). */
export function oneLine(s: string, n = PREVIEW_CAP): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** True when a key names auth/secret material we must redact. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Deep-redact secret-keyed values in a plain object/array (returns a new value). Non-plain values
 *  (strings, numbers) pass through unchanged. */
export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = isSecretKey(k) ? REDACTED : redactValue(v);
    return out;
  }
  return value;
}

/** A stable one-line preview of a tool's args. Known tools get a hand-picked field; everything else
 *  falls back to a redacted `k=v` join. Always redacted, always ≤ PREVIEW_CAP chars. */
export function argsPreview(tool: string, args: unknown): string {
  const a = (args && typeof args === "object" ? (args as Record<string, unknown>) : {}) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  let picked: string | undefined;
  switch (tool) {
    case "read_url": picked = str("url"); break;
    case "run_command": picked = str("command"); break;
    case "delegate_task":
    case "dispatch_task": picked = [str("to"), str("goal")].filter(Boolean).join(": "); break;
    case "read_artifact": picked = str("id"); break;
    case "save_artifact":
    case "write_artifact": picked = str("title") ?? str("topicSlug"); break;
    case "list_artifacts": picked = str("q") ?? str("type") ?? str("producer"); break;
    case "create_agent": picked = str("id"); break;
    case "find_agents":
    case "find_skills":
    case "recall": picked = str("query"); break;
    case "use_skill": picked = str("name"); break;
    case "ask_human": picked = str("question"); break;
    case "remember": picked = str("title"); break;
    case "add_mcp_server": picked = str("name"); break;
  }
  if (picked && picked.trim()) return oneLine(picked);
  // Generic fallback: redacted scalar k=v pairs.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (isSecretKey(k)) { parts.push(`${k}=${REDACTED}`); continue; }
    if (v == null || typeof v === "object") continue; // skip nested/empty in the one-liner
    parts.push(`${k}=${String(v)}`);
  }
  return parts.length ? oneLine(parts.join(" ")) : "";
}

/** A capped, redacted JSON render of a value for the waterfall drill-in (args in / result out). */
export function capJson(value: unknown, cap = JSON_CAP): string {
  let s: string;
  try { s = JSON.stringify(redactValue(value)); } catch { s = String(value); }
  if (s == null) return "";
  return s.length > cap ? s.slice(0, cap) + `…[+${s.length - cap} chars]` : s;
}
