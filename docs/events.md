# Event schema & headless observation

This is the reference for **external / headless observers** — the on-disk event stream a run leaves
behind, plus the `taicho.log` diagnostic file and the `taicho tail` affordance. Before this, the
e2e harness polled these files by hand; this documents the contract so tooling can rely on it.

Two independent streams:

1. **Per-run event stream** (`runs/<agent>/<recordId>/…`) — *what an agent did*. Machine-readable,
   append-only, one directory per run. This is the observable surface for evidence + tailing.
2. **`taicho.log`** — *leveled process diagnostics* (a run failed, a policy file was skipped, a
   codex 4xx). One file in the workspace root, written by `packages/framework/src/core/logger.ts`. It does **not**
   fight the Ink TUI (which corrupts/swallows stray `console.*`), and it **never** contains auth
   material — every line is passed through `redact()` (Bearer tokens + `sk-…` keys + token fields).

---

## 1. Run record layout

A run id is `"<agent>/<recordId>"`, e.g. `root/2026-07-04-run2`. Each run writes:

| Path | Written by | Contents |
|------|-----------|----------|
| `runs/<agent>/<recordId>.json`        | `store/trace.ts` (`writeTrace`)        | The `RunTrace` summary (§3). |
| `runs/<agent>/<recordId>/input.json`  | `store/run-transcript.ts` (`writeRunInput`) | The prompt handed to the model (§2a). |
| `runs/<agent>/<recordId>/transcript.jsonl` | `appendRunTranscript`             | The event stream — one JSON object per line (§2b). |
| `runs/<agent>/<recordId>/final.md`    | `writeRunFinal`                        | The run's final text (or `error: …`). |
| `runs/<agent>/<recordId>/failure.md`  | `writeRunFailure`                      | Only for non-`completed` outcomes — a human failure digest. |
| `runs/<agent>/<recordId>/child-runs.json` | `writeChildRuns`                   | Compact rows for each delegated child run. |

### 1a. Flush timing

Since Plan 04 Phase 5 the transcript flushes **live, per event**: the loop emits each event through
`onEvent`, which `run.ts` wires straight to `appendRunTranscript`, so `transcript.jsonl` grows while
the run executes. The loop also checkpoints the message array **per iteration**
(`checkpoint.json`), so a crashed run is legible. Two exceptions land at run end: the tool/approval
*span* events (`tool_start`/`tool_end`/`approval_start`/`approval_end`, buffered so they can be
merged by timestamp) and `verification` records.

- `taicho tail <runId> --follow` therefore streams an **in-flight** run's events as they happen.

---

## 2. Event shapes

### 2a. `input.json`

```jsonc
{
  "runId": "root/2026-07-04-run2",
  "triggeredBy": "user",            // "user" | delegating run id | task id (background dispatch) | "schedule:<id>"
  "agent": "root",
  "task": "prove delegation works", // brief goal, or "(chat)"
  "messagesPassedToModel": [ /* ModelMessage[] actually sent */ ],
  "parentRunId": "root/2026-07-04-run1"  // present only for delegated child runs
}
```

### 2b. `transcript.jsonl` — the event stream

Every line shares one envelope (`RunTranscriptEvent`):

```ts
{ ts: string /* ISO-8601 */, kind: string, iteration?: number, data?: unknown }
```

`kind` values emitted today (loop iterations are 1-based):

| `kind` | Emitted by | `data` |
|--------|-----------|--------|
| `model_request`  | `loop.ts` before each model call | `{ messageCount, contextTokens, compacted }` |
| `model_response` | `loop.ts` after each model call  | `{ text, usage, toolCalls, responseMessages }` |
| `model_error`    | `loop.ts` on a call failure      | `{ error }` |
| `tool_call`      | `loop.ts` per proposed tool call | the AI-SDK tool call: `{ toolName, toolCallId, input, … }` |
| `compaction`     | `loop.ts` when in-run compaction folds (Plan 05) | `{ before, after, threshold, foldedRoundTrips, foldedMessages, tools, summary }` |
| `tool_start` / `tool_end` | `tools.ts`'s `instrument()` wrapper (buffered, merged at run end) | `{ tool, callId, argsPreview, args }` (`tool_end` adds the result/error preview) |
| `approval_start` / `approval_end` | `run.ts`'s approval wrapper (buffered, merged at run end) | `{ kind, label }` |
| `verification`   | `run.ts` after a delegation checker | a `VerificationRecord` (§3): `{ criteria, verdict:{pass,reasons}, runId, retried, tokens, costUsd, costNote }` |

`data` is intentionally **payload-agnostic** — treat unknown `kind`s and extra fields as forward-
compatible. `packages/framework/src/core/events.ts` (`readTranscript`, `formatEvent`) is the reference reader; a
partially-flushed trailing line is skipped rather than fatal.

### 2c. `child-runs.json`

```jsonc
[{ "runId", "agent", "task", "outcome", "usableOutput": /* outcome==="completed" */,
   "tokens", "aggregate": { "tokens", "costUsd" }, "artifacts", "delegatedOut" }]
```

---

## 3. `RunTrace` (the run summary JSON)

Authoritative schema: `packages/contracts/src/trace.ts`. Fields:

```ts
{
  id, agent, task,
  triggeredBy,                       // "user" | delegating run id | task id | "schedule:<id>"
  ledger: {                          // the coaching ledger — "why did it do that?"
    retrieved: string[],             // policy ids surfaced
    applied:   string[],             // policy ids applied
    skipped:   { id, reason }[],
    knowledge: string[],             // kb node ids injected
    skills:    string[],             // skill ids injected
  },
  toolCalls: { tool, count }[],
  artifacts: string[],               // handles/paths THIS run produced
  inputArtifacts: string[],          // handles handed DOWN to children (hand-off graph)
  outputArtifacts: string[],         // handles received UP from children
  delegatedOut: string[],            // child run ids
  verification: VerificationRecord[],// criteria → verdict records
  outcome: "completed" | "blocked" | "failed" | "interrupted",
  tokens, costUsd,                   // costUsd null on subscription runs (costNote: "subscription")
  costNote?,
  contextTokens,                     // Plan 05: peak estimated context actually sent (post-compaction)
  verifierTokens, verifierCostUsd,   // Plan 09: this run's OWN delegation-checker spend (no child trace)
  model?,                            // resolved model id — the /costs "by provider" dimension
  plan?, planEvents?,                // Plan 18: plan handle at run end + transitions this run wrote
  aggregate: { tokens, costUsd },    // this run + child runs + verifier calls
  notes: string[],
  durationMs, started,
}
```

`costUsd` / `aggregate.costUsd` are `null` for subscription (Codex) runs — tokens are the honest
meter there; a dollar figure would be fabricated.

---

## 4. `taicho.log` (process diagnostics)

Line format: `<ISO ts> <LEVEL> <message>[ :: <serialized data>]`, e.g.

```
2026-07-04T04:06:28.705Z WARN  no price for model "e2e:agent-flow" — cost reported as 0
2026-07-04T04:06:28.713Z INFO  headless run done :: {"runId":"root/2026-07-04-run1","outcome":"completed","tokens":10}
```

- **Levels**: `debug < info < warn < error < silent`; a message shows only at/above the threshold.
- **Verbosity**: default `info`. Raise to `debug` with `--verbose`/`-v`, `TAICHO_VERBOSE=1`,
  `TAICHO_LOG_LEVEL=debug`, or the historical `TAICHO_DEBUG=1` (previously codex-only; now general).
- **Location**: `taicho.log` in the workspace (`TAICHO_LOG_FILE` overrides). Gitignored.
- **Redaction**: mandatory and central — no call site can leak a token even if it logs an error body
  that echoes an `Authorization` header.

---

## 5. Observing a run

```
taicho run "<goal>"          # headless: drive one run to completion without Ink, print final + status
taicho run "<goal>" -v       # …with debug-level logging
taicho tail                  # print the latest run's events (formatted, redacted)
taicho tail <runId>          # a specific run
taicho tail --follow         # keep printing as new events land (see §1a on flush timing)
```

`taicho run` exits `0` on a `completed` outcome, non-zero otherwise. Approvals default to
**auto-reject** (unattended-safe); `--approve auto` approves everything, `--approve prompt` asks on
stdin. See `packages/framework/src/core/headless.ts`.
