/** Merge a proposal card's edited field strings over the original draft (non-empty overrides only). */
export function mergeDraft<T extends Record<string, unknown>>(original: T, edits: Record<string, string>): T {
  const out: Record<string, unknown> = { ...original };
  for (const [k, v] of Object.entries(edits)) if (v != null && v !== "") out[k] = v;
  return out as T;
}
