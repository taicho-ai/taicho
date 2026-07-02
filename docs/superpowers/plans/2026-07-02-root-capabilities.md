# Root Capabilities — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two root-only tools that route risk through taicho's existing approval card — `propose_skill` (root drafts a skill; captain approves → it's saved active) and `run_command` (root runs a shell command; the dcg guard decides auto-run vs ask).

**Architecture:** A tiny `command-guard.ts` shells to `dcg --robot test` for an allow/block verdict (fail-safe to "block" when dcg is absent). Two new `ApprovalRequest` kinds + two `proposalView` cards + two `ROOT_TOOLS` entries wire the tools to the existing `requestApproval` flow, mirroring `create_agent`/`add_mcp`. `run_command`'s guard + shell-runner are injectable via optional `RunContext` seams so tests are deterministic without dcg or real shell side effects.

**Tech Stack:** Bun + TypeScript, `Bun.spawnSync`, React 19 / Ink 7, zod, `bun:test`.

## Global Constraints

- **Runtime:** Bun. Tests: `bun test` (no `test` npm script). Typecheck: `bun run typecheck`. Build: `bun run build`.
- **Both tools are ROOT-ONLY** — add to `ROOT_TOOLS` (`src/store/roster.ts`); gate each with `agent.tools.includes(...)`.
- **dcg contract (verbatim):** `dcg --robot test "<command>"` → **exit 0 = allow, exit 1 (or non-zero) = block**; JSON on stdout with a `reason` field. Command passed as an argv. **dcg missing / spawn error / parse error ⇒ `block`** (fail safe → ask the human).
- **`propose_skill` on approve writes `status: "active"`** (the approval IS the review). On reject, write nothing.
- **`run_command` routing:** `block` verdict → `requestApproval`; run only on approve. `allow` verdict → run directly. Output capped (10 000 chars/stream) + 60s timeout; `cwd` defaults to the workspace.
- **No allowlist / sandbox / policy / LLM judge in v1** (spec §2). dcg verdict → run or ask. That's it.
- **zod for schemas; colocated `*.test.ts`.** Ink/UI wiring gets Layer-1 `ink-testing-library` coverage per `TESTING.md` where the approval card is involved.

---

### Task 1: `command-guard.ts` — dcg verdict + shell runner

**Files:**
- Create: `src/core/command-guard.ts`
- Test: `src/core/command-guard.test.ts`

**Interfaces:**
- Produces:
  - `interface Verdict { decision: "allow" | "block"; reason?: string }`
  - `classifyCommand(command: string, run?: (command: string) => { code: number; stdout: string }): Verdict` — asks dcg; `run` is injected for tests, defaults to spawning dcg; any throw ⇒ `block` "unavailable".
  - `runShell(command: string, cwd: string): { exitCode: number; stdout: string; stderr: string }` — runs via `bash -lc`, captures + caps output, 60s timeout.

- [ ] **Step 1: Write the failing test** — `src/core/command-guard.test.ts`:

```ts
import { test, expect } from "bun:test";
import { classifyCommand, runShell } from "./command-guard";

test("classifyCommand: dcg exit 0 → allow", () => {
  expect(classifyCommand("ls", () => ({ code: 0, stdout: "{}" }))).toEqual({ decision: "allow" });
});

test("classifyCommand: dcg exit 1 → block with the reason from JSON", () => {
  const v = classifyCommand("rm -rf /", () => ({ code: 1, stdout: JSON.stringify({ reason: "destructive rm" }) }));
  expect(v.decision).toBe("block");
  expect(v.reason).toBe("destructive rm");
});

test("classifyCommand: guard throwing (dcg absent) → block, unavailable", () => {
  const v = classifyCommand("ls", () => { throw new Error("ENOENT"); });
  expect(v.decision).toBe("block");
  expect(v.reason).toMatch(/unavailable/);
});

test("runShell runs a harmless command and captures stdout", () => {
  const r = runShell("echo taicho-guard-test", process.cwd());
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("taicho-guard-test");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/command-guard.test.ts`
Expected: FAIL — `Cannot find module './command-guard'`.

- [ ] **Step 3: Implement** — `src/core/command-guard.ts`:

```ts
/** The command guard: decide whether a shell command is safe to auto-run (allow) or needs the
 *  captain's approval (block), by delegating to the external `dcg` binary. Fail SAFE — if dcg is
 *  absent or errors, we block (→ ask the human). runShell executes an approved/allowed command with
 *  output caps + a timeout. */
export interface Verdict { decision: "allow" | "block"; reason?: string }

/** Default runner: spawn `dcg --robot test <command>`. Throws if dcg isn't installed (caught below). */
function dcgTest(command: string): { code: number; stdout: string } {
  const p = Bun.spawnSync({ cmd: ["dcg", "--robot", "test", command] });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString() };
}

export function classifyCommand(
  command: string,
  run: (command: string) => { code: number; stdout: string } = dcgTest,
): Verdict {
  try {
    const { code, stdout } = run(command);
    if (code === 0) return { decision: "allow" };
    let reason: string | undefined;
    try { reason = (JSON.parse(stdout) as { reason?: string }).reason; } catch { /* not JSON */ }
    return { decision: "block", reason: reason ?? "flagged by the command guard" };
  } catch {
    return { decision: "block", reason: "command guard (dcg) unavailable — approve manually" };
  }
}

const CAP = 10_000;
export function runShell(command: string, cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const cap = (b: { toString(): string }) => { const s = b.toString(); return s.length > CAP ? s.slice(0, CAP) + "\n…(truncated)" : s; };
  try {
    const p = Bun.spawnSync({ cmd: ["bash", "-lc", command], cwd, timeout: 60_000 });
    return { exitCode: p.exitCode ?? -1, stdout: cap(p.stdout), stderr: cap(p.stderr) };
  } catch (e) {
    return { exitCode: -1, stdout: "", stderr: `failed to run: ${e instanceof Error ? e.message : String(e)}` };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/core/command-guard.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/core/command-guard.ts src/core/command-guard.test.ts
git commit -m "feat(root): command-guard — dcg allow/block verdict (fail-safe) + capped shell runner"
```

---

### Task 2: Approval plumbing — two `ApprovalRequest` kinds, RunContext seams, two cards

**Files:**
- Modify: `src/core/run.ts` (`ApprovalRequest` union + `RunContext` seams)
- Modify: `src/ui/App.tsx` (`proposalView` cards)

**Note:** type/plumbing scaffolding — no behavior yet; verified by `bun run typecheck`. The cards are exercised end-to-end by the Ink tests in Tasks 3–4.

**Interfaces:**
- Consumes: `Verdict` (Task 1).
- Produces: `ApprovalRequest` kinds `propose_skill` / `run_command`; `RunContext.classifyCommand?` / `RunContext.runShell?` optional seams; `proposalView` handles both kinds.

- [ ] **Step 1: Add the ApprovalRequest kinds + RunContext seams** — in `src/core/run.ts`:

Add the import near the top:
```ts
import type { Verdict } from "./command-guard";
```

Extend the `ApprovalRequest` union (add two members):
```ts
  | { kind: "propose_skill"; draft: { name: string; description: string; body: string; tags: string[] } }
  | { kind: "run_command"; command: string; reason?: string };
```

Add two optional seams to the `RunContext` interface (near `embed?`), defaulting to undefined in production (the tool falls back to the real `command-guard` functions):
```ts
  classifyCommand?: (command: string) => Verdict;                                             // test seam
  runShell?: (command: string, cwd: string) => { exitCode: number; stdout: string; stderr: string }; // test seam
```

- [ ] **Step 2: Add the two cards to `proposalView`** — in `src/ui/App.tsx`, inside `proposalView`, before the final `return { title: "New agent — approve?", … }`:

```tsx
  if (req.kind === "propose_skill")
    return { title: "New skill — approve?", fields: [
      { label: "name", value: req.draft.name },
      { label: "when", value: req.draft.description },
      { label: "procedure", value: req.draft.body },
    ] };
  if (req.kind === "run_command")
    return { title: "Run command — approve?", fields: [
      { label: "command", value: req.command },
      { label: "flagged", value: req.reason ?? "the guard flagged this command" },
    ] };
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: clean. (`proposalView`'s parameter is `Exclude<ApprovalRequest, { kind: "ask_human" }>`; the two new kinds are now handled before the create_agent fallback.)

- [ ] **Step 4: Commit**

```bash
git add src/core/run.ts src/ui/App.tsx
git commit -m "feat(root): approval plumbing — propose_skill/run_command request kinds, RunContext seams, cards"
```

---

### Task 3: `propose_skill` tool

**Files:**
- Modify: `src/core/tools.ts` (tool + imports), `src/store/roster.ts` (`ROOT_TOOLS` + identity)
- Test: `src/core/tools.test.ts`

**Interfaces:**
- Consumes: `ctx.requestApproval` (kind `propose_skill`, Task 2); `Skill`/`mkSkillId`/`writeSkill`/`getActiveSkills`.
- Produces: `propose_skill({ name, description, body, tags? })` → `{ id }` on approve, `{ rejected: true }` on reject.

- [ ] **Step 1: Write the failing test** — append to `src/core/tools.test.ts` (extend imports: `getActiveSkills` is already imported; add `readSkill`, `mkSkillId` if needed — the test uses `getActiveSkills`):

```ts
test("propose_skill: present only when granted; approve writes an active skill; reject writes nothing", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-ps-"));
  const db = openDb(w);
  const approve = { requestApproval: async () => ({ type: "approve" }) } as unknown as RunContext;
  const ctx = { ...approve, ws: w, db } as unknown as RunContext;
  expect(toolsForAgent(agent(["write_artifact"]), ctx).propose_skill).toBeUndefined();

  const set = toolsForAgent(agent(["propose_skill"]), ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await set.propose_skill!.execute!({ name: "deploy", description: "how to deploy", body: "1. build\n2. ship", tags: ["ops"] }, { toolCallId: "1", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((out as any).id).toMatch(/^skill_/);
  expect(getActiveSkills(db).map((s) => s.name)).toContain("deploy");

  const rejectCtx = { requestApproval: async () => ({ type: "reject" }), ws: w, db } as unknown as RunContext;
  const set2 = toolsForAgent(agent(["propose_skill"]), rejectCtx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out2 = await set2.propose_skill!.execute!({ name: "nope", description: "x", body: "y", tags: [] }, { toolCallId: "2", messages: [] } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((out2 as any).rejected).toBe(true);
  expect(getActiveSkills(db).map((s) => s.name)).not.toContain("nope");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/tools.test.ts`
Expected: FAIL — `propose_skill` not defined.

- [ ] **Step 3: Implement the tool** — in `src/core/tools.ts`, add imports (extend the existing `../store/skills` import to add `mkSkillId, writeSkill`, and add the `Skill` import):

```ts
import { Skill } from "../schemas/skill";
import { getActiveSkills, mkSkillId, writeSkill } from "../store/skills";
```

Add the tool inside `toolsForAgent` (after the `remember`/`recall` block, before the universal skills tools or the MCP merge):

```ts
  if (agent.tools.includes("propose_skill"))
    set.propose_skill = tool({
      description: "Propose a reusable skill (a reviewed step-by-step procedure for a repeatable operation) for the captain to approve. On approval it's saved and every agent can use it via use_skill.",
      inputSchema: z.object({
        name: z.string(),
        description: z.string().describe("when to use this skill"),
        body: z.string().describe("the step-by-step procedure"),
        tags: z.array(z.string()).default([]),
      }),
      execute: async ({ name, description, body, tags }) => {
        const draft = { name, description, body, tags: tags ?? [] };
        const d = await ctx.requestApproval({ kind: "propose_skill", draft });
        if (d.type !== "approve") return { rejected: true };
        const skill = Skill.parse({ id: mkSkillId(), name, description, body, tags: draft.tags, status: "active", created: new Date().toISOString() });
        writeSkill(ctx.ws, ctx.db, skill);
        ctx.notes.push(`proposed skill ${skill.id}`);
        return { id: skill.id };
      },
    });
```

(If `ctx.notes` isn't set in the test ctx, the test builds it — but to be safe, the test's ctx objects should include `notes: []`. Add `notes: [] as string[]` to both ctx objects in the Step-1 test.)

- [ ] **Step 4: Grant it to root + mention it in the identity** — in `src/store/roster.ts`:

Add `"propose_skill"` to `ROOT_TOOLS`:
```ts
export const ROOT_TOOLS = ["create_agent", "delegate_task", "find_agents", "ask_human", "read_url", "add_mcp_server", "remember", "recall", "propose_skill"];
```

Append one line to `ROOT_IDENTITY` (inside the identity template string, in the bulleted list):
```
- When the captain teaches a repeatable procedure worth reusing, call propose_skill to codify it as a reviewed skill (the captain approves before it's saved).
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test src/core/tools.test.ts && bun test src/store/roster.test.ts && bun run typecheck`
Expected: PASS. (If a roster test pins the exact `ROOT_TOOLS` array, update it to include `propose_skill`.)

- [ ] **Step 6: Commit**

```bash
git add src/core/tools.ts src/store/roster.ts src/core/tools.test.ts
git commit -m "feat(root): propose_skill tool — root drafts a skill, captain approves → saved active"
```

---

### Task 4: `run_command` tool

**Files:**
- Modify: `src/core/tools.ts` (tool + import), `src/store/roster.ts` (`ROOT_TOOLS`)
- Test: `src/core/tools.test.ts`

**Interfaces:**
- Consumes: `classifyCommand`/`runShell` (Task 1) — via `ctx.classifyCommand`/`ctx.runShell` seams (Task 2) falling back to the real imports; `ctx.requestApproval` (kind `run_command`).
- Produces: `run_command({ command, cwd? })` → `{ exitCode, stdout, stderr }` when run, or `{ rejected: true }` when a blocked command is not approved.

- [ ] **Step 1: Write the failing test** — append to `src/core/tools.test.ts`:

```ts
test("run_command: allow → runs without approval; block → asks then runs on approve; reject → no run", async () => {
  const w = mkdtempSync(join(tmpdir(), "taicho-rc-"));
  const db = openDb(w);
  const fakeRun = () => ({ exitCode: 0, stdout: "OUTPUT", stderr: "" });

  // allow → runs, no approval requested
  const calls: unknown[] = [];
  const allowCtx = { ws: w, db, notes: [] as string[],
    requestApproval: async (r: unknown) => { calls.push(r); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "allow" as const }), runShell: fakeRun } as unknown as RunContext;
  const set = toolsForAgent(agent(["run_command"]), allowCtx);
  expect(set.run_command).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = await set.run_command!.execute!({ command: "echo hi" }, { toolCallId: "1", messages: [] } as any);
  expect(a).toEqual({ exitCode: 0, stdout: "OUTPUT", stderr: "" });
  expect(calls.length).toBe(0); // allow path never asks

  // block → asks; approve → runs
  const blockCtx = { ws: w, db, notes: [] as string[],
    requestApproval: async (r: unknown) => { calls.push(r); return { type: "approve" }; },
    classifyCommand: () => ({ decision: "block" as const, reason: "danger" }), runShell: fakeRun } as unknown as RunContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = await toolsForAgent(agent(["run_command"]), blockCtx).run_command!.execute!({ command: "rm x" }, { toolCallId: "2", messages: [] } as any);
  expect(b).toEqual({ exitCode: 0, stdout: "OUTPUT", stderr: "" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect((calls[0] as any).kind).toBe("run_command");

  // block → reject → does not run
  let ran = false;
  const rejectCtx = { ws: w, db, notes: [] as string[],
    requestApproval: async () => ({ type: "reject" }),
    classifyCommand: () => ({ decision: "block" as const, reason: "danger" }),
    runShell: () => { ran = true; return { exitCode: 0, stdout: "", stderr: "" }; } } as unknown as RunContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = await toolsForAgent(agent(["run_command"]), rejectCtx).run_command!.execute!({ command: "rm x" }, { toolCallId: "3", messages: [] } as any);
  expect(c).toEqual({ rejected: true });
  expect(ran).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/tools.test.ts`
Expected: FAIL — `run_command` not defined.

- [ ] **Step 3: Implement the tool** — in `src/core/tools.ts`, add the import:

```ts
import { classifyCommand, runShell } from "./command-guard";
```

Add the tool inside `toolsForAgent` (after `propose_skill`):

```ts
  if (agent.tools.includes("run_command"))
    set.run_command = tool({
      description: "Run a shell command in the workspace. Commands the safety guard clears run automatically; anything it flags is sent to the captain for approval first. Returns { exitCode, stdout, stderr }.",
      inputSchema: z.object({ command: z.string(), cwd: z.string().optional() }),
      execute: async ({ command, cwd }) => {
        const classify = ctx.classifyCommand ?? classifyCommand;
        const run = ctx.runShell ?? runShell;
        const v = classify(command);
        if (v.decision === "block") {
          const d = await ctx.requestApproval({ kind: "run_command", command, reason: v.reason });
          if (d.type !== "approve") return { rejected: true };
        }
        return run(command, cwd ?? ctx.ws);
      },
    });
```

- [ ] **Step 4: Grant it to root** — in `src/store/roster.ts`, add `"run_command"` to `ROOT_TOOLS`:

```ts
export const ROOT_TOOLS = ["create_agent", "delegate_task", "find_agents", "ask_human", "read_url", "add_mcp_server", "remember", "recall", "propose_skill", "run_command"];
```

- [ ] **Step 5: Write the Ink Layer-1 end-to-end test** — append to `src/ui/App.test.tsx`. With dcg absent in the test env, `run_command` naturally blocks → the approval card renders → approving runs the (harmless) command. Model it on the existing `create_agent end-to-end` test:

```ts
test("run_command end-to-end: agent runs a command, the guard blocks, the card renders, captain approves", async () => {
  const runCall = {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "run_command", input: JSON.stringify({ command: "echo taicho-e2e" }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
  } as unknown as LanguageModelV3GenerateResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(runCall, finalText("ran it")) as any });
  const { db, props } = await setup({ model });
  // grant root run_command in this workspace (seedRoot reconciles built-ins, but be explicit for the test)
  const { loadAgent } = await import("../store/roster");
  const root = await loadAgent(props.ws, "root");
  if (!root.tools.includes("run_command")) { /* reconciled at boot; setup seeds root so it's present */ }
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "run echo for me", ENTER);
  await waitFor(lastFrame, "Run command");        // the approval card rendered (dcg absent → blocked)
  expect(lastFrame()).toContain("echo taicho-e2e");
  await send(stdin, "y");                           // captain approves
  await waitFor(lastFrame, "ran it");               // command ran, run resumed and replied
});
```

(If `setup()`'s seeded root doesn't carry `run_command`, the reconcile in `seedRoot` adds it on the next seed — `setup` calls `seedRoot`; since `ROOT_TOOLS` now includes it, the seeded root has it. If the test shows the card isn't reached, report it.)

- [ ] **Step 6: Run tests + typecheck + build**

Run: `bun test src/core/tools.test.ts && bun test src/ui/App.test.tsx && bun test && bun run typecheck && bun run build`
Expected: all pass; `dist/taicho` compiles.

- [ ] **Step 7: Commit**

```bash
git add src/core/tools.ts src/store/roster.ts src/core/tools.test.ts src/ui/App.test.tsx
git commit -m "feat(root): run_command tool — dcg verdict routes to auto-run or captain approval"
```

---

### Task 5: Documentation — README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Root capabilities" note** — add after the existing `## Skills (reusable procedures)` section:

```markdown
## Root: proposing skills & running commands

The root orchestrator has two extra, captain-gated powers:

- **`propose_skill`** — root can draft a reusable skill; you approve it on a card, and on approval it's
  saved `active` and the whole squad can `use_skill` it.
- **`run_command`** — root can run shell commands. Each command is checked by the external
  [`dcg`](https://github.com/Dicklesworthstone/destructive_command_guard) guard: commands it clears run
  automatically; anything it flags — or any command at all if `dcg` isn't installed — is sent to you for
  approval first. Output is captured (capped) and returned. Install `dcg` to reduce approval prompts;
  without it, every command asks (fail-safe).

Both are root-only. There's no sandbox in this version — the guard + your approval are the guardrails,
so only enable command execution on decks you trust.
```

- [ ] **Step 2: Verify**

Run: `bun run typecheck && bun test`
Expected: PASS (docs-only).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(root): document propose_skill and guarded run_command"
```

---

## Self-Review

**Spec coverage:** §3 `propose_skill` → Tasks 2 (kind+card) + 3 (tool+grant+identity). §4 `run_command` + dcg guard → Tasks 1 (guard) + 2 (kind+card+seams) + 4 (tool+grant). §5 files — all touched. §6 testing — command-guard unit (T1), propose_skill tool test (T3), run_command tool test + Ink end-to-end (T4), typecheck/build (T4/T5). §7 risks — fail-safe (T1), root-only grant (T3/T4), output cap+timeout (T1).

**Placeholder scan:** none — every code step has complete code; every run step has an exact command + expected result.

**Type consistency:** `Verdict { decision: "allow"|"block"; reason? }` defined in T1, used in T2 (RunContext seams + ApprovalRequest reason) and T4 (tool). `classifyCommand(command, run?) → Verdict` and `runShell(command, cwd) → {exitCode,stdout,stderr}` (T1) match the RunContext seam signatures (T2) and the tool's fallback calls (T4). `ApprovalRequest` kinds `propose_skill {draft:{name,description,body,tags}}` / `run_command {command,reason?}` (T2) match `proposalView` (T2) and the tools' `requestApproval` calls (T3/T4). `propose_skill` writes via `Skill.parse` + `writeSkill` (T3), asserted via `getActiveSkills` (T3). `ROOT_TOOLS` gains `propose_skill` (T3) then `run_command` (T4).
