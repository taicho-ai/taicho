# Root capabilities — skill authoring + guarded CLI

**Date:** 2026-07-02
**Status:** approved (direction — user go-ahead) — driving autonomously
**Topic:** Two additive capabilities for the root orchestrator, both routing risk through the
existing approval card: (1) `propose_skill` — root drafts a skill for the captain to approve; (2)
`run_command` — root runs a shell command, with the **dcg** guard deciding auto-run vs ask.

## 1. Background

taicho already has the halves these features need:
- **Approval mechanism** — `ctx.requestApproval(req)` pops a card and awaits a decision. The
  `ApprovalRequest` union (`src/core/run.ts:44`) has kinds `create_agent | propose_coaching |
  ask_human | add_mcp`; `proposalView` (`src/ui/App.tsx:56`) renders the card fields; the tool's
  `execute` awaits the decision and acts on approve (see `create_agent`, `add_mcp_server` in
  `src/core/tools.ts`).
- **Skills store** — `writeSkill(ws, db, skill)` (`src/store/skills.ts`), the `Skill` schema, and the
  `status: active|draft` field (only `active` are injected/usable).
- **`ROOT_TOOLS`** (`src/store/roster.ts:39`) — root's built-in tool list, reconciled on boot.

Both features are small and mirror the existing `create_agent` / `add_mcp` patterns; no new
subsystem.

## 2. Goals & non-goals

**Goals**
- `propose_skill`: root proposes a skill (name, description, body, tags); the captain approves via the
  card; on approve it's written as an **active** skill and immediately usable by the squad.
- `run_command`: root runs a shell command; the **dcg** guard (`dcg --robot test`) decides — a `block`
  verdict (or dcg unavailable) pops the approval card; an `allow` verdict runs it directly. Output is
  captured, capped, and returned.
- Both are **root-only** (added to `ROOT_TOOLS`) and use the existing approval card.

**Non-goals (this spec)**
- **No allowlist / sandbox / policy-hardening / LLM judge** for `run_command` — v1 is exactly "dcg
  verdict → run or ask." (Sandbox-then-escalate and approve-once-→-policy are noted as future.)
- **No agent-proposed skills for non-root agents** — `propose_skill` is a root capability.
- **No `draft`-queue/`/skills approve` flow** — the approval card *is* the review; approve writes
  `active`.
- **No bundling dcg** — it's an external binary the user installs; taicho fails safe (asks) without it.

## 3. `propose_skill`

- Add `"propose_skill"` to `ROOT_TOOLS`.
- Tool (`src/core/tools.ts`), gated by `agent.tools.includes("propose_skill")`:
  ```
  propose_skill({ name: string, description: string, body: string, tags?: string[] })
  ```
  `execute`: build a draft, `await ctx.requestApproval({ kind: "propose_skill", draft })`; on
  `approve`, `writeSkill(ctx.ws, ctx.db, Skill.parse({ id: mkSkillId(), name, description, body,
  tags: tags ?? [], status: "active", created: new Date().toISOString() }))` and return `{ id }`; on
  reject return `{ rejected: true }`.
- `ApprovalRequest` gains `{ kind: "propose_skill"; draft: { name: string; description: string; body:
  string; tags: string[] } }`.
- `proposalView` renders it: title "New skill — approve?", fields `name`, `description`, `body`
  (the procedure). No `edit` handling needed (binary approve/reject, like `add_mcp`).
- `ROOT_IDENTITY` (`src/store/roster.ts`) gains one line: when the captain teaches a repeatable
  procedure, root may `propose_skill` to codify it (captain approves).

## 4. `run_command` + the dcg guard

**Guard module** `src/core/command-guard.ts`:
```ts
export interface Verdict { decision: "allow" | "block"; reason?: string }
/** Ask dcg whether a command is safe to auto-run. `run` is injected for tests; production spawns dcg.
 *  dcg contract: `dcg --robot test "<command>"` → exit 0 = allow, exit 1 = block, JSON on stdout with
 *  a `reason`. dcg MISSING or ANY error ⇒ block (fail safe → ask the human). */
export function classifyCommand(command: string, run?: (cmd: string, args: string[]) => { code: number; stdout: string }): Verdict
```
- Default `run` spawns `dcg --robot test <command>` synchronously (Bun's `spawnSync`), reads exit code
  + parses the JSON `reason`. If the binary isn't found, or spawn/parse throws → `{ decision:
  "block", reason: "guard unavailable — approve manually" }`.
- Pure + injectable: tests pass a fake `run` to exercise allow / block / unavailable without dcg.

**Tool** (`src/core/tools.ts`), gated by `agent.tools.includes("run_command")`:
```
run_command({ command: string, cwd?: string })
```
`execute`:
1. `const v = classifyCommand(command)`.
2. If `v.decision === "block"`: `const d = await ctx.requestApproval({ kind: "run_command", command,
   reason: v.reason })`; if `d.type !== "approve"` return `{ rejected: true }`.
3. Run it: spawn via a shell so pipes/`&&` work (`bash -lc <command>` or Bun.$ equivalent), `cwd`
   defaults to `ctx.ws`, with a **timeout** (e.g. 60s) and an **output cap** (e.g. 10 000 chars per
   stream). Return `{ exitCode, stdout, stderr }` (truncated with a "…(truncated)" marker).
4. If `v.decision === "allow"`: run directly (steps 3) with no approval.
- Add `"run_command"` to `ROOT_TOOLS`.
- `ApprovalRequest` gains `{ kind: "run_command"; command: string; reason?: string }`.
- `proposalView` renders it: title "Run command — approve?", fields `command`, `reason`.

**Security posture (v1, explicit):** dcg is a *denylist / default-allow* guard — it catches known
destructive commands and asks; it is not a comprehensive safety boundary. This is the user's chosen
v1. The fail-safe (ask when dcg is absent or errors) and root-only grant are the guardrails.
Sandbox-then-escalate is the documented future hardening.

## 5. Files

- Create: `src/core/command-guard.ts` (+ test).
- Modify: `src/core/run.ts` (two `ApprovalRequest` kinds), `src/core/tools.ts` (two tools + imports),
  `src/store/roster.ts` (`ROOT_TOOLS` += both; one identity line), `src/ui/App.tsx` (`proposalView`
  two cards), `src/core/tools.test.ts` (tool tests), `README.md`.

## 6. Testing

- **`classifyCommand`** (`command-guard.test.ts`): injected `run` returning exit 0 → `allow`; exit 1
  with JSON reason → `block` + reason; a throwing/missing `run` → `block` "guard unavailable".
- **`propose_skill`** (`tools.test.ts`): present only for an agent granted it; on `approve`
  (fake `requestApproval`) writes an active skill (assert via `getActiveSkills`/`readSkill`) and
  returns `{ id }`; on reject returns `{ rejected: true }` and writes nothing.
- **`run_command`** (`tools.test.ts`): with a stubbed guard+runner — an `allow` verdict runs without
  approval and returns captured output; a `block` verdict calls `requestApproval` and only runs on
  approve; a rejected approval returns `{ rejected }` and does NOT run. Output truncation is applied.
  (Inject the guard/runner so no real dcg or shell side effects in tests.)
- **`proposalView`** cards for `propose_skill` / `run_command` (extend the existing add_mcp/coaching
  card test if present).
- Build: `bun run typecheck` + `bun test` green; `bun run build` compiles.

## 7. Risks

- **Executing arbitrary shell is inherently powerful.** Mitigations: dcg guard + fail-safe-to-ask +
  root-only + output cap + timeout. Not a sandbox — flagged as the honest v1 limitation (§4).
- **dcg availability**: absent/old dcg → everything asks (safe, if noisy). Acceptable; a one-time
  install is on the user.
- **`propose_skill` quality**: root could draft a weak skill — but the captain approves each one, and
  a bad approved skill is removable via `/skills remove`.
