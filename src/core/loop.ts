/** The agent loop. Model proposes (what); config disposes (how much): budgets + caps come from
 *  AgentDef/config — model-supplied budget params are ignored. The loop is the single meter for
 *  spend (tokens + advisory USD) and the single place caps + cancellation are enforced. */
import { generateText, streamText, type ModelMessage, type ToolSet } from "ai";
import type { Tracer } from "@opentelemetry/api";
import { trace as otelTrace, context as otelContext, SpanStatusCode, chatMessageAttrs, type Span } from "./otel";
import type { AgentDef } from "../schemas/agent";
import type { StepInfo } from "./step-events";
import { steerMarker } from "./prompt";
import { ceilingHit, type SpendLedger } from "../store/spend-ledger";
import { compactMessages, estimateContextTokens, type CompactionSummary } from "./compaction";
import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from "./providers/request-timeout";

/** Plan 05: how many recent tool round-trips the compaction fold keeps VERBATIM (the system prompt +
 *  the original brief are kept separately). The oldest round-trips beyond this window are folded. */
const DEFAULT_COMPACT_KEEP_RECENT = 3;

// Plan 12: there is NO model-call watchdog here anymore. The old `guardModelCall` idle timer wrapped
// `consumeStream`, but the AI SDK runs tools INSIDE `consumeStream` — so it timed our own tool
// execution (the shot-planner bug) and only abandoned the wedged promise (leak). A hung request is
// now bounded at the TRANSPORT layer instead: a per-request deadline on the provider fetch
// (providers/request-timeout.ts) that can only ever see one model turn's HTTP exchange, never tool
// execution. On a genuine hang it surfaces a retryable error routed through the AI SDK's own
// maxRetries; the loop just consumes the stream directly and lets errors/cancellation flow normally.

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
  /** Plan 05: the high-water-mark estimated context size (system + messages, chars/4) actually sent
   *  to the model across the run — post-compaction, so it reflects what was really in each call. */
  contextTokens: number;
  /** Plan 05: how many times the loop folded oldest round-trips this run (0 ⇒ never crossed the
   *  threshold). Advisory; the per-iteration `compaction` transcript events are the full record. */
  compactions: number;
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
   *  `instructions` field, with store:false. Every other provider (api.openai.com / Anthropic /
   *  OpenRouter) sends a normal `system` prompt. All providers stream (Plan 07). */
  codexBackend?: boolean;
  /** OpenRouter (usage:{include:true}) returns the authoritative per-call cost in
   *  providerMetadata.openrouter.usage.cost — prefer it over the static token pricer when set. */
  captureProviderCost?: boolean;
  /** Plan 05: the estimated-token threshold at which the loop folds the oldest tool round-trips into
   *  one compact summary (config-disposed — computed from the per-model window table + defaults.compactAt
   *  by run.ts). Undefined ⇒ compaction is off (the context size is still measured + recorded). */
  compactThresholdTokens?: number;
  /** Plan 05: how many recent round-trips the fold keeps verbatim. Default DEFAULT_COMPACT_KEEP_RECENT. */
  compactKeepRecent?: number;
  /** Plan 04 Phase 5: called for EACH transcript event as it happens, so evidence flushes
   *  incrementally (a crash mid-run leaves a legible transcript.jsonl) instead of only at run end.
   *  Also feeds Plan 02's live-mode waterfall. */
  onEvent?: (event: { ts: string; kind: string; iteration?: number; data?: unknown }) => void;
  /** Plan 04 Phase 5: called once per iteration with the loop's message array — its only real state.
   *  Persisted as a resume checkpoint so an interrupted run can (later) restart from the last
   *  completed iteration. */
  checkpoint?: (state: { iteration: number; messages: ModelMessage[] }) => void;
  /** Plan 09: deck-WIDE spend ceilings, enforced HERE — the single meter, the same place per-run caps
   *  are (model proposes, config disposes). The ledger is a DB-backed rolling counter that spans
   *  sessions: before each call we refuse if a running total has crossed a ceiling, and after each
   *  call we commit that call's spend. Subscription calls commit 0 USD (unmeasurable) but still count
   *  tokens, so a USD ceiling never fabricates spend. Undefined ⇒ no deck ceilings configured. */
  spendLedger?: SpendLedger;
  /** Plan 12 (reopened): per-request transport deadline (ms) for the model fetch. A genuinely hung
   *  request (open socket, zero tokens) becomes a retryable error routed through the AI SDK's maxRetries,
   *  instead of the deleted loop-level idle watchdog. Config-disposed; defaults to 120s. Also used to
   *  bound consumeStream() in case the underlying stream ignores the abort signal. */
  modelRequestTimeoutMs?: number;
  /** Plan 16: OpenTelemetry. When set, each model iteration opens taicho's OWN `chat <model>` span
   *  (named + carrying gen_ai.* attrs and, when captureContent, the prompt/completion) made ACTIVE
   *  around the call so tool spans nest under it. onModelCall feeds the token/duration/cost metrics.
   *  We emit our own spans rather than the AI SDK's generic `ai.streamText.doStream` ones so the trace
   *  reads meaningfully in any backend. Undefined ⇒ no telemetry, zero overhead. */
  telemetry?: {
    tracer: Tracer;
    captureContent: boolean;
    model: string;
    provider: string;
    agent: string;
    onModelCall: (m: { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number }) => void;
  };
}): Promise<LoopResult> {
  const counts: Record<string, number> = {};
  const transcript: LoopResult["transcript"] = [];
  // Push a transcript event AND flush it live (onEvent) so evidence isn't buffered until run end.
  const emit = (event: { ts: string; kind: string; iteration?: number; data?: unknown }) => {
    transcript.push(event);
    opts.onEvent?.(event);
  };
  let tokens = 0, inputTokens = 0, outputTokens = 0, costUsd = 0, iterations = 0;
  // Plan 05: `messages` is reassigned when compaction folds it, so it is `let`, not `const`. The
  // original input (the brief / prior conversation) is kept VERBATIM as the fold's head — capture its
  // length up front so a later fold never touches it.
  let messages = [...opts.messages];
  const keepHead = messages.length;
  const keepRecent = opts.compactKeepRecent ?? DEFAULT_COMPACT_KEEP_RECENT;
  let contextTokens = 0; // high-water mark of the estimated context actually sent to the model
  let compactions = 0;
  const cap = opts.agent.budgets;

  const done = (over: Partial<LoopResult> & { text: string }): LoopResult => ({
    toolCalls: counts, transcript, tokens, inputTokens, outputTokens, costUsd, iterations,
    exhausted: false, aborted: false, contextTokens, compactions, ...over,
  });

  for (; iterations < cap.maxIterationsPerRun; iterations++) {
    if (opts.signal?.aborted) return done({ text: "[cancelled]", aborted: true });
    if (cap.maxTokensPerRun != null && tokens >= cap.maxTokensPerRun) return done({ text: "[budget exhausted]", exhausted: true });
    if (cap.maxCostPerRunUsd != null && costUsd >= cap.maxCostPerRunUsd) return done({ text: "[budget exhausted]", exhausted: true });
    // Deck-wide ceilings (Plan 09) — checked against the running cross-session total, alongside the
    // per-run caps above. Refuses the next call once any configured ceiling is crossed.
    if (opts.spendLedger) {
      const hit = ceilingHit(opts.spendLedger.current(), opts.spendLedger.ceilings);
      if (hit) return done({ text: `[deck budget exhausted: ${hit}]`, exhausted: true });
    }

    const steer = opts.pollSteer?.();
    if (steer) messages.push({ role: "user", content: steerMarker(steer) });

    // Plan 05: MEASURE then (config-permitting) COMPACT before the call. Estimate the next call's
    // context (system + messages, chars/4); if it crosses the config threshold, deterministically fold
    // the oldest tool round-trips into one summary — the system prompt, the original brief (keepHead),
    // and the most recent keepRecent round-trips stay verbatim. The fold is emitted as a `compaction`
    // event so it is never invisible in the trace. No model call: predictable, free, testable.
    let ctxTokens = estimateContextTokens(opts.system, messages);
    let compactedThisIter: CompactionSummary | undefined;
    if (opts.compactThresholdTokens != null && ctxTokens > opts.compactThresholdTokens) {
      const folded = compactMessages({ messages, keepHead, keepTailRoundTrips: keepRecent });
      if (folded) {
        messages = folded.messages;
        compactions += 1;
        compactedThisIter = folded.summary;
        const after = estimateContextTokens(opts.system, messages);
        emit({
          ts: new Date().toISOString(), kind: "compaction", iteration: iterations + 1,
          data: {
            before: ctxTokens, after, threshold: opts.compactThresholdTokens,
            foldedRoundTrips: folded.summary.foldedRoundTrips, foldedMessages: folded.summary.foldedMessages,
            tools: folded.summary.tools, summary: folded.text,
          },
        });
        ctxTokens = after;
      }
    }
    contextTokens = Math.max(contextTokens, ctxTokens);

    // Checkpoint the message array before this iteration's call — the resume point if we die here.
    opts.checkpoint?.({ iteration: iterations + 1, messages });

    // `generateText` is retained only for its RESULT TYPE — the aggregated fields streamText drains
    // to are identical, so this keeps the ModelOut shape exact while the runtime path is streaming.
    type GenResult = Awaited<ReturnType<typeof generateText>>;
    type ModelOut = {
      text: string;
      usage: GenResult["usage"];
      toolCalls: GenResult["toolCalls"];
      responseMessages: GenResult["response"]["messages"];
      providerMetadata: GenResult["providerMetadata"];
    };
    let out: ModelOut;
    let callStart = 0; // set right before streamText; read after the call for the OTel duration metric
    let chatSpan: Span | undefined; // Plan 16: taicho's own model-call span (named + carries I/O)
    try {
      // emit() (Plan 04) flushes the transcript event live via onEvent; onStep model_start (Plan 02/10)
      // drives the live "thinking" status. Keep both.
      emit({ ts: new Date().toISOString(), kind: "model_request", iteration: iterations + 1, data: { messageCount: messages.length, contextTokens: ctxTokens, compacted: compactedThisIter != null } });
      opts.onStep?.({ phase: "model_start" }); // → "thinking" until a delta or the response arrives
      // Plan 07: ONE streaming path for EVERY provider. streamText streams deltas so the live markdown
      // UI lights up for all providers (previously only the Codex subscription path streamed;
      // Anthropic/OpenAI/OpenRouter went through generateText and rendered nothing live). We drain the
      // stream to completion and read the same aggregated fields generateText returned (text, usage,
      // toolCalls, response messages, providerMetadata), so the rest of the loop is unchanged.
      // Plan 12 (reopened): an idle timer that resets per stream chunk AND is disarmed during tool
      // execution. Tools execute INSIDE consumeStream(), so a simple Promise.race would kill any tool
      // longer than the deadline (the original watchdog bug). Instead:
      // - The timer resets on each chunk (text-delta, tool-start, tool-end, etc.)
      // - The timer is DISARMED when a tool-start chunk arrives (tool execution begins)
      // - The timer is RE-ARMED when a tool-end chunk arrives (tool execution completes)
      // - If no chunks arrive for `timeoutMs` while the timer is armed, the stream is hung
      // This catches a genuinely hung stream (no chunks, no tool execution) without killing long tools.
      let streamErr: unknown;
      let toolExecuting = false;
      const timeoutMs = opts.modelRequestTimeoutMs ?? DEFAULT_MODEL_REQUEST_TIMEOUT_MS;
      // Timer state — per-run, not global (concurrency-safe)
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let rejectIdle: ((err: Error) => void) | null = null;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (toolExecuting) return; // disarmed during tool execution
        idleTimer = setTimeout(() => {
          const err = new Error(`model stream idle for ${timeoutMs}ms (no chunks, no tool execution)`);
          (err as Error & { code?: string }).code = "ETIMEDOUT";
          rejectIdle?.(err);
        }, timeoutMs);
      };
      const setToolExecuting = (executing: boolean) => {
        toolExecuting = executing;
        if (executing && idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        } else if (!executing) {
          resetIdleTimer();
        }
      };
      // Create a promise that rejects when the idle timer fires
      const idleTimeoutPromise = new Promise<never>((_, reject) => {
        rejectIdle = reject;
        resetIdleTimer();
      });
      // Plan 16: open taicho's OWN model-call span, named `chat <model>` and made ACTIVE around the
      // stream — so the tool spans (opened in tools.ts) nest under it, and it carries the prompt/
      // completion in the keys backends read (via ioAttrs) instead of the AI SDK's opaque `ai.*` keys.
      const tel = opts.telemetry;
      if (tel) {
        chatSpan = tel.tracer.startSpan(`chat ${tel.model} · iter ${iterations + 1}`, {
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.system": tel.provider,
            "gen_ai.request.model": tel.model,
            "taicho.agent": tel.agent,
            "taicho.iteration": iterations + 1,
            // The prompt as a proper GenAI message list (system + conversation), rendered by backends
            // as a conversation — NOT a JSON dump. System is message 0 so the instructions are visible.
            ...(tel.captureContent
              ? chatMessageAttrs("gen_ai.prompt", [{ role: "system", content: opts.system }, ...(messages as { role: string; content: unknown }[])])
              : {}),
          },
        });
      }
      callStart = performance.now();
      const s = streamText({
        model: opts.model,
        messages,
        tools: opts.tools,
        abortSignal: opts.signal,
        // Codex backend (subscription) requires the system prompt in the top-level `instructions`
        // field with store:false ("Instructions are required") — NOT a system message. Every other
        // provider takes a normal `system` prompt. (SSE streaming — "Stream must be set to true" —
        // is now the shared path, so there is no codex-specific streaming toggle anymore.)
        ...(opts.codexBackend
          ? { providerOptions: { openai: { instructions: opts.system, store: false } } }
          : { system: opts.system }),
        onError: ({ error }) => { streamErr = error; },
        // Surface each chunk so the UI can render the response live as it streams (instead of all
        // at once when the run returns). Also reset the idle timer on each chunk.
        onChunk: ({ chunk }) => {
          resetIdleTimer();
          if (chunk.type === "text-delta") {
            opts.onStep?.({ phase: "delta", delta: chunk.text, text: chunk.text });
          } else if (chunk.type === "tool-call") {
            // Tool execution is about to start — disarm the idle timer
            setToolExecuting(true);
          } else if (chunk.type === "tool-result") {
            // Tool execution completed — re-arm the idle timer
            setToolExecuting(false);
          }
        },
      });
      // Race consumeStream() against the idle timeout — with the chat span ACTIVE so the tool spans
      // opened during tool execution (inside consumeStream) nest under this model call.
      const consume = () => Promise.race([s.consumeStream(), idleTimeoutPromise]);
      await (chatSpan
        ? otelContext.with(otelTrace.setSpan(otelContext.active(), chatSpan), consume)
        : consume());
      // Clean up the timer
      if (idleTimer) clearTimeout(idleTimer);
      if (streamErr) throw streamErr;
      out = {
        text: await s.text,
        usage: await s.usage,
        toolCalls: await s.toolCalls,
        responseMessages: (await s.response).messages,
        // OpenRouter (usage:{include:true}) reports the authoritative per-call cost here on the
        // streamed path too (aggregated from the finish part); captureProviderCost reads it below.
        providerMetadata: await s.providerMetadata,
      };
      // Finalize the chat span: usage + finish reason, and (when capture is on) the completion text
      // (the assistant's reply, or a JSON of the tool calls it decided to make).
      if (chatSpan && tel) {
        const fin = await s.finishReason;
        chatSpan.setAttributes({
          "gen_ai.usage.input_tokens": out.usage?.inputTokens ?? 0,
          "gen_ai.usage.output_tokens": out.usage?.outputTokens ?? 0,
          "gen_ai.response.finish_reasons": String(fin),
        });
        if (tel.captureContent) {
          // The completion as an assistant message — its reply text, or the tool calls it decided to
          // make rendered as `→ tool(args)` lines — again a message, not a JSON dump.
          const content = out.text?.trim()
            ? out.text
            : (out.toolCalls ?? []).map((tc) => `→ ${tc.toolName}(${safeJson(tc.input)})`).join("\n");
          chatSpan.setAttributes(chatMessageAttrs("gen_ai.completion", [{ role: "assistant", content }]));
        }
        chatSpan.end();
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (chatSpan) { chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: error }); chatSpan.end(); }
      emit({ ts: new Date().toISOString(), kind: "model_error", iteration: iterations + 1, data: { error } });
      if (opts.signal?.aborted) return done({ text: "[cancelled]", aborted: true });
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
    const callTokens = usage?.totalTokens ?? inTok + outTok;
    tokens += callTokens;
    // Prefer a provider-reported cost (OpenRouter) when available; else the static token pricer.
    const provCost = opts.captureProviderCost ? openrouterCostUsd(providerMetadata) : undefined;
    const callCost = provCost ?? opts.priceUsd?.({ inputTokens: inTok, outputTokens: outTok }) ?? 0;
    costUsd += callCost;
    // Plan 16: feed this call's usage to the OTel metrics (gen_ai token + duration histograms, cost
    // counter). The gen_ai span itself was emitted by the AI SDK; this is the aggregate-metrics half.
    opts.telemetry?.onModelCall({ inputTokens: inTok, outputTokens: outTok, costUsd: callCost, durationMs: performance.now() - callStart });
    // Commit this call's spend to the deck ledger (Plan 09). Tokens always count; USD only for priced
    // runs — a subscription (codex backend) call has no measurable USD, so it commits 0 (honest: the
    // token ceiling still bounds it, the USD ceiling never sees a fabricated figure).
    opts.spendLedger?.add({ tokens: callTokens, costUsd: opts.codexBackend ? 0 : callCost });

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

/** Best-effort JSON for span I/O attributes (never throws on a circular/odd value). */
function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
}

/** Read the authoritative USD cost OpenRouter returns under providerMetadata.openrouter.usage.cost.
 *  Returns undefined when absent/non-finite so the caller can fall back to the token pricer. */
function openrouterCostUsd(meta: unknown): number | undefined {
  const cost = (meta as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}
