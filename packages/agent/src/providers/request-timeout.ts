/** Plan 12: the transport-level deadline for ONE model HTTP request.
 *
 *  Background — the bug this replaces: the old `guardModelCall` watchdog wrapped `streamText` +
 *  `consumeStream`, but the AI SDK executes tools INSIDE `consumeStream`, AFTER the model's HTTP
 *  stream has closed. A 156s delegation produced no stream chunks for 120s, so the idle timer fired
 *  at exactly `tool_start + 120000ms` — timing our OWN tool, not the model — and only ABANDONED the
 *  promise (never aborted), leaking the wedged stream + its whole closure.
 *
 *  A deadline belongs on the FETCH, where it can only ever see the HTTP exchange of ONE model turn
 *  (request -> response headers -> the streamed body). Tool execution runs after the body closes, so
 *  a fetch deadline structurally CANNOT fire on a tool. On a genuinely hung request (open socket,
 *  zero tokens) the deadline aborts the underlying fetch — REAL teardown of the connection, not the
 *  old abandon-the-promise leak. Before response headers arrive it surfaces a RETRYABLE `ETIMEDOUT`
 *  error, so the AI SDK's OWN `maxRetries` handles it (we hand-roll no retry); on exhaustion the run
 *  fails with the REAL transport error, like any other provider failure. A user abort always wins and
 *  propagates unchanged so cancellation still cancels. */

/** Default per-request transport deadline (ms). Config-disposed via `defaults.modelRequestTimeoutMs`
 *  (see store/config.ts) — this is only the fallback when the config leaves it unset. */
export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 120_000;

/** Wrap a `fetch` so every request it makes is bounded by `timeoutMs`. The timeout is armed fresh per
 *  call and combined with any caller-supplied `signal`, so aborting either tears the real request
 *  down. `timeoutMs <= 0` disables the deadline (returns the base fetch unchanged). */
export function withRequestTimeout(
  baseFetch: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
): typeof fetch {
  if (!(timeoutMs > 0)) return baseFetch;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const upstream = init?.signal ?? undefined;
    // A fresh deadline per request. Combined with the caller's signal so a user cancel AND the
    // deadline both tear the underlying fetch (and its response body stream) down for real.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = upstream ? AbortSignal.any([upstream, timeoutSignal]) : timeoutSignal;
    try {
      return await baseFetch(input, { ...init, signal });
    } catch (err) {
      // The deadline (not a user abort) elapsed before the request could produce a response: surface a
      // RETRYABLE network timeout so the AI SDK's `maxRetries` treats it like any transient transport
      // failure. A user abort propagates unchanged (so the loop reports cancellation, not a timeout).
      if (timeoutSignal.aborted && !upstream?.aborted) {
        const e = new Error(
          `model request exceeded the ${timeoutMs}ms transport deadline (no response)`,
        ) as Error & { code?: string };
        // "ETIMEDOUT" is one of the AI SDK's retryable network-error codes (isBunNetworkError), so this
        // routes through maxRetries instead of being short-circuited like an AbortError/TimeoutError.
        e.code = "ETIMEDOUT";
        throw e;
      }
      throw err;
    }
  }) as typeof fetch;
}
