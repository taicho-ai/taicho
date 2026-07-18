/** Pure REPL line classifier: slash command, @address, or bare chat (-> root). */
export type ParsedInput =
  | { kind: "slash"; cmd: string; arg: string }
  | { kind: "address"; to: string; text: string }
  | { kind: "chat"; text: string };

export function parseInput(value: string): ParsedInput {
  const t = value.trim();
  if (t.startsWith("/")) {
    const [cmd, ...rest] = t.slice(1).split(/\s+/);
    return { kind: "slash", cmd, arg: rest.join(" ") };
  }
  if (t.startsWith("@")) {
    const m = /^@([a-z][a-z0-9-]*)\s*([\s\S]*)$/.exec(t);
    if (m) return { kind: "address", to: m[1], text: m[2] };
  }
  return { kind: "chat", text: t };
}
