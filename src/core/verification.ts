/** The delegation checker (Plan 06). When a delegate_task carries acceptance `criteria`, the
 *  child's output is judged by ONE independent model call — not the parent's self-assessment and
 *  not the child grading itself — against the criteria, before the result reaches the parent's
 *  context. The verdict is `{ pass, reasons[] }`. A fail triggers exactly one bounded retry
 *  (orchestrated in tools.ts); a second fail surfaces the result WITH the failed verdict attached. */
import { runLoop } from "./loop";
import type { AgentDef } from "../schemas/agent";
import { VerificationVerdict } from "../schemas/trace";

/** The checker uses the SAME model plumbing the loop uses — passed in by run.ts (the delegating
 *  agent's resolved model), so verification is symmetric with the work it checks. */
type CheckerModel = Parameters<typeof runLoop>[0]["model"];

export const VERIFIER_SYSTEM =
  "You are an impartial acceptance checker. You receive a GOAL, the ACCEPTANCE CRITERIA a delegated " +
  "worker's output had to satisfy, and the CANDIDATE OUTPUT it produced. Judge ONLY whether the output " +
  "meets the criteria — do NOT do the task yourself, and do NOT be charitable about missing requirements. " +
  'Respond with ONLY a single-line JSON object: {"pass": <boolean>, "reasons": [<short strings>]}. ' +
  "When pass is false, each reason names one unmet criterion. When pass is true, reasons may be empty.";

/** Extract the {pass, reasons} verdict from the checker's text. Lenient: strips code fences and
 *  parses the first {...} object. On any parse failure it returns a NON-blocking pass with a note —
 *  the checker is advisory quality tooling, not a hard gate, so a flaky/garbled verifier must never
 *  wedge delegation or burn a retry on its own bug. */
export function parseVerdict(text: string): VerificationVerdict {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = VerificationVerdict.safeParse(JSON.parse(cleaned.slice(start, end + 1)));
      if (parsed.success) return parsed.data;
    } catch { /* fall through to the non-blocking default */ }
  }
  return { pass: true, reasons: [`verifier output was unparseable, treated as pass: ${text.slice(0, 120)}`] };
}

/** Run one independent checker call. Reuses runLoop with an empty toolset so it inherits the exact
 *  same model plumbing (codex streaming, idle-timeout guard, token/cost metering, abort) as a normal
 *  agent turn; with no tools the loop returns after the first response. */
export async function runChecker(params: {
  model: CheckerModel;
  agent: AgentDef;                 // only its budgets bound the (single) checker call
  subscription: boolean;           // Codex backend ⇒ stream + instructions, and cost is unpriced
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
  captureProviderCost?: boolean;
  signal?: AbortSignal;
  goal: string;
  criteria: string;
  output: string;
}): Promise<{ verdict: VerificationVerdict; tokens: number; costUsd: number | null; costNote?: string }> {
  const user =
    `GOAL:\n${params.goal}\n\n` +
    `ACCEPTANCE CRITERIA:\n${params.criteria}\n\n` +
    `CANDIDATE OUTPUT:\n${params.output}\n\n` +
    `Does the candidate output satisfy every acceptance criterion? Reply with ONLY the JSON verdict.`;
  const result = await runLoop({
    model: params.model,
    agent: params.agent,
    system: VERIFIER_SYSTEM,
    messages: [{ role: "user", content: user }],
    tools: {},
    signal: params.signal,
    priceUsd: params.priceUsd,
    codexBackend: params.subscription,
    captureProviderCost: params.captureProviderCost,
  });
  // We read only result.text, never result.error: a checker that NEVER RAN (transport error/timeout ⇒
  // result.text like "[error]"/"[timed out]") parses to the SAME non-blocking advisory PASS as a
  // garbled verdict. Deliberate for now — the checker is advisory, never a hard gate — so a broken or
  // unreachable verifier must not wedge delegation. Louder surfacing of a never-ran verifier is a follow-up.
  // Cost honesty (mirrors run.ts/loop.ts): a subscription checker has NO measurable USD, so costUsd is
  // null + costNote:"subscription" — never a fabricated 0 that claims an unmeasured price. Tokens always meter.
  return {
    verdict: parseVerdict(result.text),
    tokens: result.tokens,
    costUsd: params.subscription ? null : result.costUsd,
    costNote: params.subscription ? "subscription" : undefined,
  };
}
