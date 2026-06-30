# Add MCP Servers From a Docs URL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the root agent connect a new MCP server when the captain points it at a documentation URL — read the page (Firecrawl), infer the config, get captain approval, connect + verify.

**Architecture:** Two new agent tools on root — `read_url` (Firecrawl-backed scrape → markdown) and `add_mcp_server` (approval-gated connect+persist+verify). The model does the docs→config inference between them. Everything reuses the existing MCP manager, store, and propose→approve grammar.

**Tech Stack:** Bun + TypeScript, `ai` SDK tools (zod schemas), `bun:test` with mocks (no network), Ink TUI.

## Global Constraints

- Credentials are read from the environment only — never written to `taicho.yaml` or the MCP store. Secrets in configs are `${ENV}` refs.
- No network in tests — inject `fetch` / mock the `McpManager`.
- Run `bun run typecheck` AND `bun test` before each commit; the model/provider-adjacent nature means also `bun run build` at the end.
- Tools are gated by `agent.tools.includes("<name>")`; never overwrite an existing tool key.
- Connecting a server is captain-approved — the agent never connects unilaterally.

---

## File Structure

- **Create** `src/core/firecrawl.ts` — `scrapeUrl(url, opts)` Firecrawl REST client (pure, injectable fetch).
- **Create** `src/core/firecrawl.test.ts` — tests for `scrapeUrl`.
- **Modify** `src/core/tools.ts` — add `read_url` and `add_mcp_server` tools.
- **Modify** `src/core/tools.test.ts` — tests for both tools.
- **Modify** `src/core/run.ts` — add the `add_mcp` variant to `ApprovalRequest`.
- **Modify** `src/store/roster.ts` — root gets the two tools; reconcile existing roots; prompt nudge.
- **Modify** `src/ui/App.tsx` — render the `add_mcp` approval via `ProposalCard`.
- **Modify** `src/ui/App.test.tsx` — end-to-end add_mcp card test.

---

## Task 1: `scrapeUrl` — Firecrawl client

**Files:**
- Create: `src/core/firecrawl.ts`
- Test: `src/core/firecrawl.test.ts`

**Interfaces:**
- Produces: `scrapeUrl(url: string, opts?: { apiKey?: string; fetchImpl?: typeof fetch }): Promise<{ markdown: string } | { error: string }>`

- [ ] **Step 1: Write the failing tests**

Create `src/core/firecrawl.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { scrapeUrl } from "./firecrawl";

const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

test("scrapeUrl returns markdown on success", async () => {
  const r = await scrapeUrl("https://x/docs", { apiKey: "k", fetchImpl: ok({ success: true, data: { markdown: "# Install" } }) });
  expect(r).toEqual({ markdown: "# Install" });
});

test("scrapeUrl errors on a non-2xx response", async () => {
  const fetchImpl = (async () => new Response("payment required", { status: 402 })) as unknown as typeof fetch;
  const r = await scrapeUrl("https://x", { apiKey: "k", fetchImpl });
  expect("error" in r && r.error).toContain("402");
});

test("scrapeUrl errors (no network) when the api key is missing", async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response("", { status: 200 }); }) as unknown as typeof fetch;
  const r = await scrapeUrl("https://x", { apiKey: "", fetchImpl });
  expect("error" in r && /FIRECRAWL_API_KEY/.test(r.error)).toBe(true);
  expect(called).toBe(false); // bailed before any fetch
});

test("scrapeUrl errors when firecrawl returns no markdown", async () => {
  const r = await scrapeUrl("https://x", { apiKey: "k", fetchImpl: ok({ success: true, data: {} }) });
  expect("error" in r).toBe(true);
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `bun test src/core/firecrawl.test.ts`
Expected: FAIL — `Cannot find module './firecrawl'`.

- [ ] **Step 3: Implement `scrapeUrl`**

Create `src/core/firecrawl.ts`:

```typescript
/** Firecrawl scrape client: turn a URL into clean markdown. Used by the read_url agent tool so the
 *  model can read MCP setup docs. fetch is injectable for tests; the API key comes from the env only. */
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";

export async function scrapeUrl(
  url: string,
  opts: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ markdown: string } | { error: string }> {
  const apiKey = opts.apiKey ?? process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return { error: "FIRECRAWL_API_KEY is not set — set it to let agents read web pages." };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url, formats: ["markdown"] }),
    });
    if (!res.ok) return { error: `firecrawl ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const json = (await res.json()) as { data?: { markdown?: string } };
    const markdown = json.data?.markdown;
    return markdown ? { markdown } : { error: "firecrawl returned no markdown for this page" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `bun test src/core/firecrawl.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/firecrawl.ts src/core/firecrawl.test.ts
git commit -m "feat(mcp): scrapeUrl — Firecrawl-backed URL→markdown client"
```

---

## Task 2: `read_url` tool

**Files:**
- Modify: `src/core/tools.ts`
- Test: `src/core/tools.test.ts`

**Interfaces:**
- Consumes: `scrapeUrl` (Task 1); `toolsForAgent(agent, ctx, mcp?)` (existing).
- Produces: tool `read_url`, input `{ url: string }`, output `{ markdown: string } | { error: string }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/tools.test.ts` (top imports already include `toolsForAgent`, `agent`, `ctx`):

```typescript
test("read_url: present only when granted", () => {
  expect("read_url" in toolsForAgent(agent(["read_url"]), ctx)).toBe(true);
  expect("read_url" in toolsForAgent(agent(["write_artifact"]), ctx)).toBe(false);
});

test("read_url: returns an actionable error when FIRECRAWL_API_KEY is unset", async () => {
  const prev = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  try {
    const set = toolsForAgent(agent(["read_url"]), ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (set.read_url as any).execute({ url: "https://docs.example.com" });
    expect(out.error).toMatch(/FIRECRAWL_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.FIRECRAWL_API_KEY = prev;
  }
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `bun test src/core/tools.test.ts -t read_url`
Expected: FAIL — `read_url` not in the set (first test), `set.read_url` undefined (second).

- [ ] **Step 3: Implement the `read_url` tool**

In `src/core/tools.ts`, add the import near the top:

```typescript
import { scrapeUrl } from "./firecrawl";
```

Add inside `toolsForAgent`, after the `find_agents` block (before the MCP merge loop):

```typescript
  if (agent.tools.includes("read_url"))
    set.read_url = tool({
      description: "Fetch a web page (e.g. an MCP server's setup docs) and return it as clean markdown. Requires FIRECRAWL_API_KEY in the environment.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        const r = await scrapeUrl(url);
        return "markdown" in r ? { markdown: r.markdown } : { error: r.error };
      },
    });
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `bun test src/core/tools.test.ts -t read_url`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/tools.ts src/core/tools.test.ts
git commit -m "feat(mcp): read_url tool (Firecrawl) for reading setup docs"
```

---

## Task 3: `add_mcp` approval kind + `add_mcp_server` tool

**Files:**
- Modify: `src/core/run.ts` (add `add_mcp` to `ApprovalRequest`)
- Modify: `src/core/tools.ts` (the tool)
- Test: `src/core/tools.test.ts`

**Interfaces:**
- Consumes: `ctx.requestApproval`, `ctx.ws`, the `McpManager.addServer(name, spec)` (returns `{ status, toolCount, error }`), `addMcpServer(ws, name, spec)`, `McpServerConfig`.
- Produces: `ApprovalRequest` variant `{ kind: "add_mcp"; name: string; spec: McpServerConfig }`; tool `add_mcp_server`, output `{ name, status, toolCount, error? } | { rejected: true } | { error: string }`.

- [ ] **Step 1: Add the `add_mcp` ApprovalRequest variant**

In `src/core/run.ts`, add the import (with the other store imports):

```typescript
import type { McpServerConfig } from "../store/config";
```

Extend the `ApprovalRequest` union:

```typescript
export type ApprovalRequest =
  | { kind: "create_agent"; draft: NewAgentDraft }
  | { kind: "propose_coaching"; draft: ProposalDraft }
  | { kind: "ask_human"; question: string; options: string[] }
  | { kind: "add_mcp"; name: string; spec: McpServerConfig };
```

- [ ] **Step 2: Write the failing tests**

Add to `src/core/tools.test.ts`. First add imports at the top of the file:

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMcpStore } from "../store/mcp-store";
```

Then the tests:

```typescript
test("add_mcp_server: absent without an MCP manager", () => {
  expect("add_mcp_server" in toolsForAgent(agent(["add_mcp_server"]), ctx)).toBe(false);
});

test("add_mcp_server: granted + manager present → approve connects and persists", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-tools-"));
  const added: Array<[string, unknown]> = [];
  const mcp = {
    toolsForRef: () => ({}),
    addServer: async (n: string, spec: unknown) => { added.push([n, spec]); return { name: n, kind: "http", status: "connected", toolCount: 3 }; },
  } as unknown as McpManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = { ws, requestApproval: async () => ({ type: "approve" }) } as any;
  const set = toolsForAgent(agent(["add_mcp_server"]), c, mcp);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (set.add_mcp_server as any).execute({ name: "tavily", url: "https://api.tavily.com/mcp", auth: "oauth" });
  expect(out).toMatchObject({ name: "tavily", status: "connected", toolCount: 3 });
  expect(added[0][0]).toBe("tavily");
  expect(readMcpStore(ws).tavily).toEqual({ url: "https://api.tavily.com/mcp", auth: "oauth" });
});

test("add_mcp_server: reject → does not connect", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-tools-"));
  let connected = false;
  const mcp = {
    toolsForRef: () => ({}),
    addServer: async () => { connected = true; return { name: "x", kind: "http", status: "connected", toolCount: 0 }; },
  } as unknown as McpManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = { ws, requestApproval: async () => ({ type: "reject" }) } as any;
  const set = toolsForAgent(agent(["add_mcp_server"]), c, mcp);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (set.add_mcp_server as any).execute({ name: "x", url: "https://x.example.com/mcp" });
  expect(out).toEqual({ rejected: true });
  expect(connected).toBe(false);
});

test("add_mcp_server: a failed connect is returned (not thrown) so the model can retry", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-tools-"));
  const mcp = {
    toolsForRef: () => ({}),
    addServer: async (n: string) => ({ name: n, kind: "stdio", status: "error", toolCount: 0, error: "npx: package not found" }),
  } as unknown as McpManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = { ws, requestApproval: async () => ({ type: "approve" }) } as any;
  const set = toolsForAgent(agent(["add_mcp_server"]), c, mcp);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (set.add_mcp_server as any).execute({ name: "bad", command: "npx", args: ["-y", "nope"] });
  expect(out).toMatchObject({ name: "bad", status: "error" });
  expect(out.error).toContain("not found");
});
```

- [ ] **Step 3: Run the tests — verify they fail**

Run: `bun test src/core/tools.test.ts -t add_mcp_server`
Expected: FAIL — `add_mcp_server` not in the set.

- [ ] **Step 4: Implement the `add_mcp_server` tool**

In `src/core/tools.ts`, add imports:

```typescript
import { McpServerConfig } from "../store/config";
import { addMcpServer } from "../store/mcp-store";
```

Add inside `toolsForAgent`, after the `read_url` block (note the `mcp &&` guard — only registered when a manager exists):

```typescript
  if (mcp && agent.tools.includes("add_mcp_server"))
    set.add_mcp_server = tool({
      description: "Connect a NEW MCP server for the captain to approve. Provide a `url` for a remote/hosted server (with auth:'oauth' or headers), or a `command`/`args` for a local stdio server. Put secrets as ${ENV_VAR} refs (ask_human for the var name first). Returns the connection status + tool count; on error, fix the config and call again.",
      inputSchema: z.object({
        name: z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id: letters, digits, hyphens"),
        url: z.string().url().optional(),
        auth: z.literal("oauth").optional(),
        headers: z.record(z.string(), z.string()).optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
      execute: async ({ name, url, auth, headers, command, args, env }) => {
        const raw = url
          ? { url, ...(auth ? { auth } : {}), ...(headers ? { headers } : {}) }
          : command
            ? { command, ...(args ? { args } : {}), ...(env ? { env } : {}) }
            : null;
        if (!raw) return { error: "provide a `url` (remote server) or a `command` (local stdio server)" };
        const parsed = McpServerConfig.safeParse(raw);
        if (!parsed.success) return { error: `invalid server config: ${parsed.error.issues[0]?.message ?? "unknown"}` };
        const spec = parsed.data;
        const decision = await ctx.requestApproval({ kind: "add_mcp", name, spec });
        if (decision.type !== "approve") return { rejected: true };
        addMcpServer(ctx.ws, name, spec);
        const status = await mcp.addServer(name, spec);
        return { name, status: status.status, toolCount: status.toolCount, error: status.error };
      },
    });
```

- [ ] **Step 5: Run the tests — verify they pass**

Run: `bun test src/core/tools.test.ts -t add_mcp_server`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add src/core/run.ts src/core/tools.ts src/core/tools.test.ts
git commit -m "feat(mcp): add_mcp_server tool + add_mcp approval kind (connect/verify/persist)"
```

---

## Task 4: Root gets the tools + reconcile existing roots + prompt

**Files:**
- Modify: `src/store/roster.ts`

**Interfaces:**
- Consumes: `loadAgent(ws, "root")`, `serializeAgent`, `paths.agentFile` (all existing in roster.ts).
- Produces: root agents (new and existing) carry `read_url` + `add_mcp_server`.

- [ ] **Step 1: Write the failing test**

Add to `src/store/roster.test.ts` (if it exists; otherwise create it with this content and the imports it needs — check the file first):

```typescript
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspace } from "./files";
import { seedRoot, loadAgent } from "./roster";

test("seedRoot gives root the MCP tools, and reconciles an older root that lacks them", async () => {
  const ws = mkdtempSync(join(tmpdir(), "taicho-roster-"));
  await ensureWorkspace(ws);
  await seedRoot(ws);
  let root = await loadAgent(ws, "root");
  expect(root.tools).toContain("read_url");
  expect(root.tools).toContain("add_mcp_server");

  // Simulate an older root missing the new tools, then re-seed (boot) and confirm reconcile.
  root.tools = ["create_agent", "delegate_task", "find_agents"];
  await Bun.write(join(ws, "agents", "root", "agent.md"), (await import("./roster")).serializeAgent(root));
  await seedRoot(ws);
  const reconciled = await loadAgent(ws, "root");
  expect(reconciled.tools).toContain("read_url");
  expect(reconciled.tools).toContain("add_mcp_server");
  expect(reconciled.tools).toContain("create_agent"); // existing tools preserved
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test src/store/roster.test.ts -t "MCP tools"`
Expected: FAIL — root.tools lacks `read_url`/`add_mcp_server`.

- [ ] **Step 3: Implement — canonical tool list + reconcile in `seedRoot`**

In `src/store/roster.ts`, add a constant near the top (after imports):

```typescript
/** Root's built-in capabilities. Kept in one place so existing roots get reconciled to the current
 *  set on boot (older roots drift — e.g. predate ask_human / the MCP tools). */
export const ROOT_TOOLS = ["create_agent", "delegate_task", "find_agents", "ask_human", "read_url", "add_mcp_server"];
```

Replace the early-return in `seedRoot` with a reconcile, and use `ROOT_TOOLS` for new roots:

```typescript
export async function seedRoot(ws: string, defaults?: TaichoConfig["defaults"]): Promise<void> {
  const file = paths.agentFile(ws, "root");
  if (await Bun.file(file).exists()) {
    // Reconcile: ensure an existing root carries the current built-in tools (preserve any extras).
    const root = await loadAgent(ws, "root");
    const missing = ROOT_TOOLS.filter((t) => !root.tools.includes(t));
    if (missing.length) {
      root.tools = [...root.tools, ...missing];
      await writeFile(file, serializeAgent(root));
    }
    return;
  }
  const root = AgentDef.parse({
    id: "root",
    role: "Orchestrator — interviews the captain, proposes and coordinates worker agents",
    identity: ROOT_IDENTITY,
    tools: ROOT_TOOLS,
    canSee: ["*"], canDelegateTo: ["*"], isRoot: true,
    created: new Date().toISOString(),
    budgets: defaults?.budgets,
  });
  await mkdir(paths.agentDir(ws, "root"), { recursive: true });
  await writeFile(file, serializeAgent(root));
}
```

- [ ] **Step 4: Add the prompt nudge**

In `src/store/roster.ts`, find the `ROOT_IDENTITY` string and append this bullet to its guidance list (keep the existing text; add at the end of the bulleted capabilities):

```
- When the captain points you at an MCP server's setup docs, call read_url on that page, infer the server config from it (a `url` for hosted servers, or a `command` for local ones), and propose it with add_mcp_server for approval. If it needs a secret, ask_human for the env-var name and tell the captain to set it, then reference it as ${VAR}. If the connect fails, read the error and retry a corrected config. Once connected, offer to create_agent a worker wired to `mcp:<server>`.
```

- [ ] **Step 5: Run the test + typecheck — verify pass**

Run: `bun test src/store/roster.test.ts -t "MCP tools"` → PASS
Run: `bun run typecheck` → clean

- [ ] **Step 6: Commit**

```bash
git add src/store/roster.ts src/store/roster.test.ts
git commit -m "feat(mcp): root gets read_url + add_mcp_server; reconcile existing roots; prompt"
```

---

## Task 5: Render the `add_mcp` approval card

**Files:**
- Modify: `src/ui/App.tsx`
- Test: `src/ui/App.test.tsx`

**Interfaces:**
- Consumes: `ApprovalRequest` (`add_mcp` variant from Task 3), `ProposalCard`, `CardField`, `cardKeyRef` (existing).
- Produces: the `add_mcp` pending request renders a `ProposalCard` titled "Add MCP server — approve?".

- [ ] **Step 1: Write the failing test**

Add to `src/ui/App.test.tsx` (uses the existing `setup`, `fakeMcp`, `send`, `waitFor`, `usage`, `finalText`, `ENTER`):

```typescript
test("add_mcp end-to-end: agent proposes a server, the card renders, captain approves, run resumes", async () => {
  const addCall = {
    content: [{ type: "tool-call", toolCallId: "c1", toolName: "add_mcp_server", input: JSON.stringify({ name: "tavily", url: "https://api.tavily.com/mcp", auth: "oauth" }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" }, usage,
  } as unknown as LanguageModelV3GenerateResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model = new MockLanguageModelV3({ doGenerate: mockValues(addCall, finalText("Connected tavily (3 tools)")) as any });
  const connected: string[] = [];
  const mcp = fakeMcp({ addServer: async (n) => { connected.push(n); return { name: n, kind: "http", status: "connected", toolCount: 3 }; } });
  const { props } = await setup({ model, mcp });
  const { stdin, lastFrame } = render(<App {...props} />);
  await send(stdin, "add the tavily mcp from its docs", ENTER);
  await waitFor(lastFrame, "Add MCP server");          // the ProposalCard rendered the proposal
  expect(lastFrame()).toContain("tavily");
  await send(stdin, "y");                               // captain approves
  await waitFor(lastFrame, "Connected tavily");         // connect ran, run resumed
  expect(connected).toEqual(["tavily"]);
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun test src/ui/App.test.tsx -t "add_mcp end-to-end"`
Expected: FAIL — the card renders "New agent — approve?" (add_mcp falls through to the create_agent branch and reads `pending.req.draft`, which is undefined) → timeout / wrong title.

- [ ] **Step 3: Implement — a `proposalView` helper + add_mcp branch**

In `src/ui/App.tsx`, import `CardField` and the config helper/type:

```typescript
import { ProposalCard, type CardField, type CardKeyHandler } from "./ProposalCard";
import { isStdioServer } from "../store/config";
```

(Adjust the existing `ProposalCard` import line to add `type CardField` if not already imported.)

Add this module-scope helper (below `initialLines`, or above the `App` component):

```typescript
/** Title + fields for the non-question approval cards. */
function proposalView(req: Exclude<ApprovalRequest, { kind: "ask_human" }>): { title: string; fields: CardField[] } {
  if (req.kind === "propose_coaching")
    return { title: "New coaching note — approve?", fields: [
      { label: "when", value: req.draft.when }, { label: "do", value: req.draft.do }, { label: "scope", value: req.draft.scope },
    ] };
  if (req.kind === "add_mcp") {
    const transport = isStdioServer(req.spec) ? `${req.spec.command} ${(req.spec.args ?? []).join(" ")}`.trim() : req.spec.url;
    const env = isStdioServer(req.spec) ? Object.keys(req.spec.env ?? {}).join(", ") : (req.spec.auth ?? Object.keys(req.spec.headers ?? {}).join(", "));
    return { title: "Add MCP server — approve?", fields: [
      { label: "name", value: req.name }, { label: "transport", value: transport }, { label: "env", value: env || "—" },
    ] };
  }
  return { title: "New agent — approve?", fields: [
    { label: "id", value: req.draft.id }, { label: "role", value: req.draft.role }, { label: "identity", value: req.draft.identity },
  ] };
}
```

Replace the `ProposalCard` JSX in the `pending` render (the `else` of the `ask_human` check) with:

```tsx
        ) : (
          <ProposalCard
            title={proposalView(pending.req).title}
            fields={proposalView(pending.req).fields}
            keyHandlerRef={cardKeyRef}
            onDecision={(d) => { const r = pending.resolve; cardKeyRef.current = null; setPending(null); r(d); }}
          />
        )
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun test src/ui/App.test.tsx -t "add_mcp end-to-end"`
Expected: PASS.

- [ ] **Step 5: Full verification + commit**

```bash
bun run typecheck
bun test
bun run build
git add src/ui/App.tsx src/ui/App.test.tsx
git commit -m "feat(mcp): render the add_mcp approval card; add_mcp end-to-end test"
```

Expected: typecheck clean; full suite green; build ok.

---

## Self-Review

**Spec coverage:**
- read_url (Firecrawl) → Task 1 (`scrapeUrl`) + Task 2 (tool). ✓
- add_mcp_server (approval-gated connect/persist/verify/retry) → Task 3. ✓
- add_mcp approval card → Task 3 (kind) + Task 5 (render). ✓
- Root gets tools + prompt → Task 4. ✓
- Migration/reconcile of existing roots → Task 4 (the spec flagged it; Task 4 implements it). ✓
- Secrets env-only / `${ENV}` → enforced by config interpolation + the tool's description + the prompt; no literal-secret path introduced. ✓
- Remote-first scope; stdio still supported → `add_mcp_server` accepts both `url` and `command`. ✓
- Testing (firecrawl, tools, app) → Tasks 1/2/3/5. ✓

**Placeholder scan:** No TBD/TODO; every code step has full code and exact run/commit commands. ✓

**Type consistency:** `scrapeUrl` return `{markdown}|{error}` used consistently in Task 2. `add_mcp` variant `{kind,name,spec}` defined in Task 3, consumed by `proposalView` in Task 5. `ROOT_TOOLS` defined and used in Task 4. `McpServerConfig` reused (not redefined). `McpServerStatus` fields (`status`,`toolCount`,`error`) match manager.ts. ✓

**Deviation from spec (noted):** the card supports approve/reject in v1 (`decision.type !== "approve"` → rejected); the spec's "edit merges string overrides" is deferred — editing a union spec via flat fields is non-trivial and not needed for the core flow. Captain rejects → root re-proposes.
