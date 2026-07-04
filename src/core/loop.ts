/** The agent loop. Model proposes (what); config disposes (how much): budgets + caps come from
 *  AgentDef/config — model-supplied budget params are ignored. The loop is the single meter for
 *  spend (tokens + advisory USD) and the single place caps + cancellation are enforced. */
import { generateText, streamText, type ModelMessage, type ToolSet } from "ai";
import type { AgentDef } from "../schemas/agent";
import type { StepInfo } from "./step-events";
import { steerMarker } from "./prompt";

const DEFAULT_MODEL_IDLE_TIMEOUT_MS = 120_000;
/** After abort, how long a call may keep running to settle cleanly before we abandon it. Lets a call
 *  that HONORS the abort wind down (e.g. a parent mid tool-execution recording a cascaded child run)
 *  while bounding how long a WEDGED one (ignores abort, never settles) keeps the captain waiting. */
const ABORT_GRACE_MS = 1_000;

/** Thrown by guardModelCall when a model call produces no output for the idle window. */
class ModelStalledError extends Error {
  constructor(ms: number) {
    super(`model produced no output for ${ms}ms (backend stalled or connection dropped)`);
    this.name = "ModelStalledError";
  }
}

/** Await a model call but NEVER hang on it. Settles when the call finishes, or after a window of no
 *  progress() pings — `idleMs` normally, shrunk to ABORT_GRACE_MS once the abort signal fires. The
 *  AI-SDK/bun fetch stream can wedge on a dropped connection (never erroring, never closing, not
 *  honoring abort), so we can rely on neither the call settling NOR the abort reaching it; this
 *  guarantees control returns to the loop. We do NOT reject the instant abort fires — an in-flight
 *  call may be mid tool-execution whose side effects (child runs, delegatedOut) must finish — so a
 *  cleanly-aborting call settles via `ok`/`fail` and the loop's top-of-iteration check stops it next.
 *  The wedged underlying promise is abandoned; any later rejection is swallowed. */
function guardModelCall<T>(
  work: (progress: () => void) => Promise<T>,
  signal: AbortSignal | undefined,
  idleMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    let window = idleMs;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    const ok = (v: T) => { if (done) return; done = true; cleanup(); resolve(v); };
    const fail = (e: unknown) => { if (done) return; done = true; cleanup(); reject(e); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => fail(new ModelStalledError(window)), window); };
    const onAbort = () => { window = Math.min(window, ABORT_GRACE_MS); arm(); };
    const bump = () => arm(); // progress (a stream chunk) resets the idle window
    if (signal?.aborted) window = Math.min(window, ABORT_GRACE_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    arm();
    work(bump).then(ok, fail);
  });
}

export interface LoopResult {
  text: string;
  toolCalls: Record<string, number>;
  transcript: { ts: string; kind: string; iteration?: number; data?: unknown }[];
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  iterations: number;
  exhausted: boolean;
  aborted: boolean;
  error?: string;
}

export async function runLoop(opts: {
  model: Parameters<typeof generateText>[0]["model"];
  agent: AgentDef;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  onStep?: (info: StepInfo) => void;
  pollSteer?: () => string | null;
  signal?: AbortSignal;
  priceUsd?: (u: { inputTokens: number; outputTokens: number }) => number;
  /** ChatGPT/Codex-backend shape: the subscription endpoint rejects requests whose system prompt
   *  is sent as an `input` message ("Instructions are required") — it must arrive in the top-level
   *  `instructions` field, with store:false. The env (api.openai.com / Anthropic) path uses `system`. */
  codexBackend?: boolean;
  /** OpenRouter (usage:{include:true}) returns the authoritative per-call cost in
   *  providerMetadata.openrouter.usage.cost — prefer it over the static token pricer when set. */
  captureProviderCost?: boolean;
  /** Idle deadline (ms) for a single model call: if no output arrives for this long, the call is
   *  abandoned and the run fails. Guards against a backend/stream that wedges without erroring,
   *  closing, or honoring abort — which would otherwise hang the loop forever. Default 120s. */
  modelCallTimeoutMs?: number;
  /** Plan 04 Phase 5: called for EACH transcript event as it happens, so evidence flushes
   *  incrementally (a crash mid-run leaves a legible transcript.jsonl) instead of only at run end.
   *  Also feeds Plan 02's live-mode waterfall. */
  onEvent?: (event: { ts: string; kind: string; iteration?: number; data?: unknown }) => void;
  /** Plan 04 Phase 5: called once per iteration with the loop's message array — its only real state.
   *  Persisted as a resume checkpoint so an interrupted run can (later) restart from the last
   *  completed iteration. */
  checkpoint?: (state: { iteration: number; messages: ModelMessage[] }) => void;
}): Promise<LoopResult> {
  const counts: Record<string, number> = {};
  const transcript: LoopResult["transcript"] = [];
  // Push a transcript event AND flush it live (onEvent) so evidence isn't buffered until run end.
  const emit = (event: { ts: string; kind: string; iteration?: number; data?: unknown }) => {
    transcript.push(event);
    opts.onEvent?.(event);
  };
  let tokens = 0, inputTokens = 0, outputTokens = 0, costUsd = 0, iterations = 0;
  const messages = [...opts.messages];
  const cap = opts.agent.budgets;

  const done = (over: Partial<LoopResult> & { text: string }): LoopResult => ({
    toolCalls: counts, transcript, tokens, inputTokens, outputTokens, costUsd, iterations,
    exhausted: false, aborted: false, ...over,
  });

  for (; iterations < cap.maxIterationsPerRun; iterations++) {
    if (opts.signal?.aborted) return done({ text: "[cancelled]", aborted: true });
    if (cap.maxTokensPerRun != null && tokens >= cap.maxTokensPerRun) return done({ text: "[budget exhausted]", exhausted: true });
    if (cap.maxCostPerRunUsd != null && costUsd >= cap.maxCostPerRunUsd) return done({ text: "[budget exhausted]", exhausted: true });

    const steer = opts.pollSteer?.();
    if (steer) messages.push({ role: "user", content: steerMarker(steer) });

    // Checkpoint the message array before this iteration's call — the resume point if we die here.
    opts.checkpoint?.({ iteration: iterations + 1, messages });

    type GenResult = Awaited<ReturnType<typeof generateText>>;
    type ModelOut = {
      text: string;
      usage: GenResult["usage"];
      toolCalls: GenResult["toolCalls"];
      responseMessages: GenResult["response"]["messages"];
      providerMetadata: GenResult["providerMetadata"];
    };
    let out: ModelOut;
    try {
      // emit() (Plan 04) flushes the transcript event live via onEvent; onStep model_start (Plan 02/10)
      // drives the live "thinking" status. Keep both.
      emit({ ts: new Date().toISOString(), kind: "model_request", iteration: iterations + 1, data: { messageCount: messages.length } });
      opts.onStep?.({ phase: "model_start" }); // → "thinking" until a delta or the response arrives
      // guardModelCall wraps the call so a wedged stream (no bytes/close/error, abort ignored) can't
      // hang the loop: it returns on completion, on abort, OR after an idle timeout. onChunk pings the
      // idle watchdog so a long-but-progressing response is never falsely killed.
      out = await guardModelCall<ModelOut>(async (progress) => {
        if (opts.codexBackend) {
          // The ChatGPT/Codex backend requires SSE streaming ("Stream must be set to true") plus the
          // system prompt in the top-level `instructions` field with store:false ("Instructions are
          // required"). streamText sends stream:true; we drain it to completion and read the same
          // aggregated fields generateText would return, so the rest of the loop is identical.
          let streamErr: unknown;
          const s = streamText({
            model: opts.model, messages, tools: opts.tools, abortSignal: opts.signal,
            providerOptions: { openai: { instructions: opts.system, store: false } },
            onError: ({ error }) => { streamErr = error; },
            // Each chunk both pings the idle watchdog AND surfaces the text delta so the UI can
            // render the response live as it streams (instead of all at once when the run returns).
            onChunk: ({ chunk }) => { progress(); if (chunk.type === "text-delta") opts.onStep?.({ phase: "delta", delta: chunk.text, text: chunk.text }); },
          });
          await s.consumeStream();
          if (streamErr) throw streamErr;
          return { text: await s.text, usage: await s.usage, toolCalls: await s.toolCalls, responseMessages: (await s.response).messages, providerMetadata: undefined };
        }
        const r = await generateText({ model: opts.model, system: opts.system, messages, tools: opts.tools, abortSignal: opts.signal });
        return { text: r.text, usage: r.usage, toolCalls: r.toolCalls, responseMessages: r.response.messages, providerMetadata: r.providerMetadata };
      }, opts.signal, opts.modelCallTimeoutMs ?? DEFAULT_MODEL_IDLE_TIMEOUT_MS);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      emit({ ts: new Date().toISOString(), kind: "model_error", iteration: iterations + 1, data: { error } });
      if (opts.signal?.aborted) return done({ text: "[cancelled]", aborted: true });
      if (e instanceof ModelStalledError) return done({ text: "[timed out]", error: e.message });
      return done({ text: "[error]", error });
    }
    const { text, usage, toolCalls, responseMessages, providerMetadata } = out;
    emit({
      ts: new Date().toISOString(),
      kind: "model_response",
      iteration: iterations + 1,
      data: { text, usage, toolCalls, responseMessages },
    });

    const inTok = usage?.inputTokens ?? 0, outTok = usage?.outputTokens ?? 0;
    inputTokens += inTok;
    outputTokens += outTok;
    tokens += usage?.totalTokens ?? inTok + outTok;
    // Prefer a provider-reported cost (OpenRouter) when available; else the static token pricer.
    const provCost = opts.captureProviderCost ? openrouterCostUsd(providerMetadata) : undefined;
    costUsd += provCost ?? opts.priceUsd?.({ inputTokens: inTok, outputTokens: outTok }) ?? 0;

    if (toolCalls.length === 0) {
      opts.onStep?.({ phase: "final", text });
      return done({ text, iterations: iterations + 1 });
    }
    // Tool start/end (real timing, argsPreview) come from the tool execute() wrapper in tools.ts —
    // the single seam Plan 02 (spans) and Plan 10 (live status) share. Here we only keep the counts
    // + the post-hoc tool_call transcript record (full args, for the drill-in).
    for (const tc of toolCalls) {
      counts[tc.toolName] = (counts[tc.toolName] ?? 0) + 1;
      // emit() flushes live (Plan 04). Tool start/end onStep now comes from the tools.ts execute()
      // wrapper (Plan 02/10 phase:"tool_start"/"tool_end"), so the loop no longer emits onStep({tool}).
      emit({ ts: new Date().toISOString(), kind: "tool_call", iteration: iterations + 1, data: tc });
    }
    messages.push(...responseMessages);
  }
  return done({ text: "[budget exhausted]", exhausted: true });
}

/** Read the authoritative USD cost OpenRouter returns under providerMetadata.openrouter.usage.cost.
 *  Returns undefined when absent/non-finite so the caller can fall back to the token pricer. */
function openrouterCostUsd(meta: unknown): number | undefined {
  const cost = (meta as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}
