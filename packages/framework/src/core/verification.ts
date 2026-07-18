/** The delegation checker (Plan 06). When a delegate_task carries acceptance `criteria`, the
 *  child's output is judged by ONE independent model call — not the parent's self-assessment and
 *  not the child grading itself — against the criteria, before the result reaches the parent's
 *  context. The verdict is `{ pass, reasons[] }`. A fail triggers exactly one bounded retry
 *  (orchestrated in tools.ts); a second fail surfaces the result WITH the failed verdict attached. */
import { runLoop } from "@taicho/agent";
import type { AgentDef } from "@taicho/contracts/agent";
import type { SpendLedger, SpendScope } from "../store/spend-ledger";
import { VerificationVerdict } from "@taicho/contracts/trace";

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
  /** Plan 09: the squad-wide ledger. Threaded through so the verifier's model call is BOTH bounded by
   *  the squad ceiling AND committed to the running total, exactly like a primary agent loop — an
   *  independent checker call is real squad spend, so the ceiling must see it. Undefined ⇒ no ceilings. */
  spendLedger?: SpendLedger;
  /** Plan 19: the delegating agent's scopes — the checker is spend IT caused. */
  spendScopes?: SpendScope[];
  goal: string;
  criteria: string;
  output: string;
}): Promise<{ verdict: VerificationVerdict; tokens: number; costUsd: number | null; costNote?: string; checkerError?: boolean }> {
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
    spendLedger: params.spendLedger, // Plan 09: commit + bound the checker call against the ceilings
    spendScopes: params.spendScopes,
  });
  // Plan 20: a checker that NEVER RAN must not pass. It used to parse "[error]"/"[cancelled]"/
  // "[… budget exhausted …]" into the advisory PASS — a squad relying on criteria got silent passes
  // during a provider outage, and (the more routine trigger) whenever a spend ceiling or per-run cap
  // refused the checker call before it was made. Now it surfaces pass=false + checkerError:true, and
  // tools.ts skips the retry (re-running the CHILD is pointless when the judge can't run) and the
  // annotation/coaching side effects (such a verdict says nothing about the artifact). A GARBLED
  // verdict from a checker that DID run still parses to the advisory pass in parseVerdict — deliberate.
  if (result.error || result.aborted || result.exhausted) {
    const why = result.error ?? (result.aborted ? "cancelled" : result.text || "budget exhausted");
    return {
      verdict: { pass: false, reasons: [`checker unavailable: ${why}`] },
      checkerError: true,
      tokens: result.tokens,
      costUsd: params.subscription ? null : result.costUsd,
      costNote: params.subscription ? "subscription" : undefined,
    };
  }
  // Cost honesty (mirrors run.ts/loop.ts): a subscription checker has NO measurable USD, so costUsd is
  // null + costNote:"subscription" — never a fabricated 0 that claims an unmeasured price. Tokens always meter.
  return {
    verdict: parseVerdict(result.text),
    tokens: result.tokens,
    costUsd: params.subscription ? null : result.costUsd,
    costNote: params.subscription ? "subscription" : undefined,
  };
}
