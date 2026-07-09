# Plan 17 — Retire the internal `/trace` waterfall (OTel-only observability)

**Status:** shipped 2026-07-09.
**Driver:** with Plan 16 (OpenTelemetry) in place, the bespoke in-terminal trace waterfall is duplicated
effort. The user's decision: **zero internal observability apart from OpenTelemetry**, keeping only a
plain execution log for correlation. Reasoning: (1) OTel is portable to existing systems, (2) frees us
to build features not observability, (3) OTel backends give the *agents* a queryable API to self-diagnose.

## Scope (locked with the user)

Three things were welded together as "tracing"; only one is redundant with OTel.

**REMOVED — the trace VISUALIZATION (Layer 1):**
- `src/core/trace-tree.ts` (`deriveTrace`/`deriveTaskTrace`), `trace-layout.ts`, `live-trace.ts` (+ tests)
- `src/ui/TraceInspector.tsx`, `src/ui/LiveWaterfall.tsx`
- the `/trace` + `/runs` slash commands, the `/view waterfall` mode (`prefs.ts` `VIEW_MODES`),
  `resolveLayout`'s `showWaterfall`, and all the inspector/live-waterfall wiring in `App.tsx`
- the `· /trace to inspect` post-run breadcrumb hint

**KEPT — not visualization, load-bearing product data/UX:**
- Run-evidence substrate: `RunTrace` (`store/trace.ts`) + `transcript.jsonl` (`store/run-transcript.ts`)
  → powers `/costs`, coaching (`turn-audit.ts`), tasks, `memory.ts`, crash-recovery.
- `gatherConversationArtifacts` → **extracted** to `src/core/conversation-artifacts.ts` (Plan 15
  artifact browser; it's not tracing).
- The live squad view: `StatusBar` + `SquadPanes` + `AgentBlock` + `OperationView`, fed by the `onStep`
  stream (`agent-status.ts`). This is the captain's LIVE steering wheel — external post-hoc OTel
  backends can't replace it, so it stays.

**ADDED — the execution log becomes OTel-correlatable:**
- `core/logger.ts` `format()` stamps each `taicho.log` line with the active `trace_id`/`span_id`
  (`trace.getSpanContext(context.active())`), so a log line lines up with the exact span in the backend.
  No-op outside a run / when telemetry is off.

## Deferred (a separate, explicit project — NOT this cleanup)

Moving `/costs` + coaching + recovery off `RunTrace` onto OTel metrics/logs is a rewrite of working
subsystems; it's the logical next step under the OTel-only philosophy but deserves its own plan.

## Verification

`bun run typecheck` + full `bun test` (1092 pass; ~41 waterfall UI tests + 3 module test files removed) +
`bun run build`, all green. A new `logger.test.ts` case asserts the trace-id correlation. A real
headless run confirms the engine, `RunTrace` evidence, and `/costs` data are intact.
