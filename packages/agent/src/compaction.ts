/** Plan 05 — Context Compaction (deterministic, in-run).
 *
 *  Nothing else in taicho ever makes context SMALLER. The loop appends every model response + tool
 *  round-trip to `messages` for up to `maxIterationsPerRun` iterations, dragging every earlier tool
 *  result into every later model call — pure cost, and eventually a context-window overflow the loop
 *  has no answer to. This module is the in-run half of the fix:
 *
 *    1. MEASURE — a cheap `chars/4` token estimate over the assembled system prompt + messages. It
 *       gates behaviour, it does not bill, so an exact tokenizer is YAGNI here (Phase 0 decision).
 *    2. THRESHOLD — a per-model context-window table + a config override (`defaults.compactAt`,
 *       default ~70%). model-proposes / config-disposes: the threshold is CONFIG, never model-supplied.
 *    3. FOLD — deterministically collapse the OLDEST tool round-trips into ONE compact summary
 *       message. No LLM call (predictable, free, testable). The system prompt, the original brief, and
 *       the most recent N iterations are kept VERBATIM by the caller; only the middle is condensed.
 *
 *  Cross-turn (boot-replay) compaction is core/conversation-replay.ts (Plan 05 Ph3), hooked into the
 *  turn-audit seam (core/turn-audit.ts) by run.ts — built; it reuses this module's estimator. */
import type { ModelMessage } from "ai";

/** chars/4 heuristic — a gate, not a bill. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Serialize a message's content to a string for estimation: a string is itself; an array of parts
 *  (tool-calls, tool-results, text) is JSON — good enough to size the payload deterministically. */
function contentText(m: ModelMessage): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) n += estimateTokens(contentText(m));
  return n;
}

/** The estimated size of the NEXT model call: assembled system prompt + the whole message array. */
export function estimateContextTokens(system: string, messages: ModelMessage[]): number {
  return estimateTokens(system) + estimateMessagesTokens(messages);
}

/** Per-model context windows (tokens). A GATE table, not billing — advisory + deliberately
 *  conservative. An unknown model falls back to DEFAULT_WINDOW so compaction still bounds growth.
 *  Matched exactly first, then by substring so an OpenRouter `vendor/model` slug still resolves its
 *  base model (e.g. `anthropic/claude-sonnet-4-6`). */
const MODEL_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-8": 200_000,
  "gpt-5.5": 400_000,
  "gpt-5": 400_000,
};
/** Fallback window for a model NOT in the table (e.g. an arbitrary OpenRouter slug). Deliberately
 *  SMALL (~32k): the whole point of the fallback is to still BOUND an unknown model's context growth,
 *  and a genuinely-small model (a 32k slug) overflows well before a generous 128k default would ever
 *  trip compaction — so its threshold would fire only AFTER the real window blew. A conservative 32k
 *  errs toward compacting a touch early on a large unknown model (harmless: cheaper calls) rather than
 *  never bounding a small one (fatal: overflow). Known first-party models keep their real windows above. */
export const DEFAULT_WINDOW = 32_000;
export const DEFAULT_COMPACT_AT = 0.7;

export function modelWindow(modelId?: string): number {
  if (!modelId) return DEFAULT_WINDOW;
  if (MODEL_WINDOWS[modelId]) return MODEL_WINDOWS[modelId];
  for (const [k, v] of Object.entries(MODEL_WINDOWS)) if (modelId.includes(k)) return v;
  return DEFAULT_WINDOW;
}

/** The token count above which the loop folds the oldest round-trips. `compactAt` (0..1, from
 *  `defaults.compactAt`) overrides the ~70% default; the window comes from the per-model table. */
export function compactionThreshold(modelId?: string, compactAt?: number): number {
  const frac = compactAt != null && compactAt > 0 && compactAt <= 1 ? compactAt : DEFAULT_COMPACT_AT;
  return Math.floor(modelWindow(modelId) * frac);
}

export interface CompactionSummary {
  foldedRoundTrips: number;                    // how many assistant+tool groups collapsed
  foldedMessages: number;                      // how many messages collapsed
  tools: { name: string; count: number }[];    // tool-call histogram over the folded region
}

export interface CompactionResult {
  messages: ModelMessage[];   // head (verbatim) + one summary message + recent tail (verbatim)
  summary: CompactionSummary;
  text: string;               // the compact summary message body (also carried in the transcript event)
}

const SUMMARY_MARKER = "[CONTEXT COMPACTION]";
const MAX_SUMMARY_CHARS = 2000;
const MAX_RESULT_SNIPPETS = 6;
const SNIPPET_CHARS = 160;
const MAX_NOTES_CHARS = 600;

/** Round-trip invariant guard. In a provider message array every assistant `tool-call` MUST be
 *  answered by a `tool-result` bearing the same `toolCallId`, and vice versa — an orphaned pairing is
 *  a hard error most providers reject. Compaction folds WHOLE round-trips, so its own output is always
 *  paired FOR A CALLER THAT PASSES `keepHead` ON A ROUND-TRIP BOUNDARY. A future caller (Phase-3
 *  boot-replay) that slices `keepHead` MID round-trip — keeping an assistant tool-call in the verbatim
 *  head while its tool-result falls into the folded region — would silently orphan the call. We refuse
 *  to emit such an array: this throws so the bug surfaces at the source instead of at the model call. */
function assertRoundTripsIntact(messages: ModelMessage[]): void {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const raw of m.content) {
      const part = raw as Record<string, unknown>;
      if (!part || typeof part !== "object" || typeof part.toolCallId !== "string") continue;
      if (part.type === "tool-call") calls.add(part.toolCallId);
      else if (part.type === "tool-result") results.add(part.toolCallId);
    }
  }
  const orphanCalls = [...calls].filter((id) => !results.has(id));
  const orphanResults = [...results].filter((id) => !calls.has(id));
  if (orphanCalls.length || orphanResults.length) {
    const parts = [
      orphanCalls.length ? `tool-call(s) with no matching tool-result: ${orphanCalls.join(", ")}` : "",
      orphanResults.length ? `tool-result(s) with no matching tool-call: ${orphanResults.join(", ")}` : "",
    ].filter(Boolean);
    throw new Error(
      `compactMessages: round-trip invariant violated — ${parts.join("; ")}. ` +
        `keepHead must fall on a round-trip boundary (never split an assistant tool-call from its tool-result).`,
    );
  }
}

/** Group `rest` into round-trips: a new group starts at each `assistant` message; any leading
 *  non-assistant messages (e.g. a prior compaction summary) form their own first group. This keeps
 *  the KEPT tail beginning on an assistant boundary, so tool-call/tool-result pairing stays valid. */
function groupRoundTrips(rest: ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = [];
  for (const m of rest) {
    if (groups.length === 0 || m.role === "assistant") groups.push([m]);
    else groups[groups.length - 1].push(m);
  }
  return groups;
}

/** Best-effort one-line snippet of a tool-result part's output (shape varies by provider). */
function toolResultSnippet(part: Record<string, unknown>): string {
  const out = part.output ?? (part as { result?: unknown }).result;
  const val = out && typeof out === "object" && "value" in (out as object) ? (out as { value: unknown }).value : out;
  const s = typeof val === "string" ? val : JSON.stringify(val ?? "");
  return s.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
}

/** Walk the folded messages and pull out a deterministic digest: tool-call counts, a few result
 *  snippets, and any assistant/summary text. No model call — pure extraction. */
function extractSummary(folded: ModelMessage[]): {
  toolCounts: Map<string, number>;
  snippets: string[];
  texts: string[];
} {
  const toolCounts = new Map<string, number>();
  const snippets: string[] = [];
  const texts: string[] = [];
  for (const m of folded) {
    const content = m.content;
    if (typeof content === "string") {
      if (content.trim()) texts.push(content.trim());
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const part = raw as Record<string, unknown>;
      if (!part || typeof part !== "object") continue;
      if (part.type === "tool-call" && typeof part.toolName === "string") {
        toolCounts.set(part.toolName, (toolCounts.get(part.toolName) ?? 0) + 1);
      } else if (part.type === "tool-result") {
        const s = toolResultSnippet(part);
        if (s) snippets.push(s);
      } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
      }
    }
  }
  return { toolCounts, snippets, texts };
}

function buildSummaryText(s: CompactionSummary, extracted: ReturnType<typeof extractSummary>): string {
  const lines: string[] = [
    `${SUMMARY_MARKER} Folded ${s.foldedRoundTrips} earlier iteration${s.foldedRoundTrips === 1 ? "" : "s"} ` +
      `(${s.foldedMessages} messages) to stay within the context window. The system prompt, the ` +
      `original task, and the most recent iterations remain verbatim; only the older tool activity ` +
      `was condensed here.`,
  ];
  if (s.tools.length) lines.push(`Tools called: ${s.tools.map((t) => `${t.name}×${t.count}`).join(", ")}.`);
  if (extracted.snippets.length) {
    lines.push("Key results (truncated):");
    for (const sn of extracted.snippets.slice(0, MAX_RESULT_SNIPPETS)) lines.push(`- ${sn}`);
  }
  if (extracted.texts.length) {
    const notes = extracted.texts.join(" ").replace(/\s+/g, " ").trim();
    if (notes) lines.push(`Reasoning/notes: ${notes.slice(0, MAX_NOTES_CHARS)}`);
  }
  return lines.join("\n").slice(0, MAX_SUMMARY_CHARS);
}

/** Deterministically fold the OLDEST tool round-trips into one summary message.
 *
 *  Keeps `messages[0..keepHead)` (the system's job is separate; this is the original brief / prior
 *  conversation) and the last `keepTailRoundTrips` round-trips VERBATIM; everything in between —
 *  including any prior compaction summary, which is simply re-folded — collapses into one `user`
 *  summary message inserted at the boundary. Returns `null` when there is nothing meaningful to fold
 *  (not enough round-trips beyond the kept tail), so the caller leaves `messages` untouched. */
export function compactMessages(opts: {
  messages: ModelMessage[];
  keepHead: number;
  keepTailRoundTrips: number;
}): CompactionResult | null {
  const keepHead = Math.max(0, opts.keepHead);
  const keepTail = Math.max(0, opts.keepTailRoundTrips);
  const head = opts.messages.slice(0, keepHead);
  const rest = opts.messages.slice(keepHead);
  const groups = groupRoundTrips(rest);
  if (groups.length <= keepTail) return null; // nothing beyond the kept tail — leave it alone
  const foldGroups = groups.slice(0, groups.length - keepTail);
  const tail = groups.slice(groups.length - keepTail);
  const foldedMsgs = foldGroups.flat();
  if (foldedMsgs.length === 0) return null;

  const extracted = extractSummary(foldedMsgs);
  const summary: CompactionSummary = {
    foldedRoundTrips: foldGroups.length,
    foldedMessages: foldedMsgs.length,
    tools: [...extracted.toolCounts.entries()].map(([name, count]) => ({ name, count })),
  };
  const text = buildSummaryText(summary, extracted);
  const summaryMsg: ModelMessage = { role: "user", content: text };
  const out = [...head, summaryMsg, ...tail.flat()];
  assertRoundTripsIntact(out); // never emit a message array that orphans a tool-call/tool-result pairing
  return { messages: out, summary, text };
}
