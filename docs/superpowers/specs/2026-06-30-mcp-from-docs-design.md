# Add MCP servers from a docs URL (self-extending squad)

- **Date:** 2026-06-30
- **Status:** Approved design — ready for implementation plan
- **Topic:** Let the root agent connect a new MCP server when the captain points it at a documentation page.

## Goal

The captain says, e.g. *"add the Tavily MCP — docs at https://docs.tavily.com/mcp"*. The root agent:

1. **reads** the docs page,
2. **infers** a valid MCP server config from it,
3. asks the captain for any required secret (API key) it can't supply,
4. **proposes** the config and waits for captain approval,
5. **connects + persists** the server and **verifies** its tools came up,
6. **reports** success (or the error, and retries with a corrected guess).

The "intelligence" (docs → config) is the model's job. We provide the small mechanical pieces around it: a way to read a URL as clean markdown, an approval-gated connect tool, and the prompt that ties them together.

## Non-goals (this iteration)

- **No in-house scraper.** Firecrawl owns JS-rendering + content extraction; we never parse raw HTML ourselves.
- **No Playwright / bundled browser.** Considered and rejected for weight; `read_url` is swappable if we revisit.
- **Local `npx` app-server docs-inference is not the focus** (those docs live in GitHub READMEs and are a later phase). The config schema still *supports* stdio servers; we just optimize the prompt/flow for **remote/hosted** servers (url + key/oauth).
- **No editing of existing agents' tool lists.** Root wires a connected server to workers via the existing `create_agent` (`tools: ["mcp:<server>"]`). "Grant tools to an existing agent" is future work.

## Background — what already exists (reused, not rebuilt)

- `McpManager.addServer(name, spec)` — live connect, **interactive** (permits the OAuth browser flow), returns `McpServerStatus { status, toolCount, error }`. (`src/core/mcp/manager.ts`)
- `addMcpServer(ws, name, spec)` — persists to `<ws>/agents/.mcp/servers.json` so it survives restart. (`src/store/mcp-store.ts`)
- `McpServerConfig` — zod union of stdio `{command, args?, env?}` and http `{url, auth?, headers?}`, with `${ENV}` interpolation (`interpolateEnv`). (`src/store/config.ts`)
- `toolsForRef` / `mcp:<server>` refs — agents already consume MCP tools, resolved at run time. (`manager.ts`, `tools.ts`)
- The **propose → captain approves** grammar: `ctx.requestApproval(req)` → `ProposalCard` → `{approve|reject|edit}`. (`run.ts`, `ui/ProposalCard.tsx`, `ui/App.tsx`)
- `ask_human` tool for asking the captain a question mid-run. (`tools.ts`)

## Design

### Component 1 — `read_url` tool (Firecrawl-backed)

- New pure helper `scrapeUrl(url, { fetch?, apiKey? })` in `src/core/firecrawl.ts`:
  - `POST https://api.firecrawl.dev/v1/scrape`, header `Authorization: Bearer <FIRECRAWL_API_KEY>`, body `{ url, formats: ["markdown"] }`.
  - Returns `{ markdown }` on success, `{ error }` on failure (no key, non-2xx, network).
  - `fetch` is injectable (default global `fetch`) so tests mock Firecrawl — **no network in tests**.
- New agent tool `read_url` in `tools.ts`, gated by `agent.tools.includes("read_url")`. Input `{ url: string }`. Reads `FIRECRAWL_API_KEY` from env; if unset, returns an actionable error (`"set FIRECRAWL_API_KEY to read web pages"`). Otherwise returns `{ markdown }` or `{ error }`.
- Credentials are env-only (repo convention) — the key is never written to `taicho.yaml` or the store.

### Component 2 — `add_mcp_server` tool (approval-gated)

- New agent tool in `tools.ts`, gated by `agent.tools.includes("add_mcp_server")` **and** only registered when an `McpManager` is present (else MCP is disabled).
- Input: `{ name }` + the `McpServerConfig` fields (reuse the existing zod schema; remote `{url, auth?, headers?}` or stdio `{command, args?, env?}`).
- `execute`:
  1. Build `spec` from input.
  2. `const decision = await ctx.requestApproval({ kind: "add_mcp", name, spec })`.
  3. `reject` → `{ rejected: true }`.
  4. `edit` → merge the captain's string overrides (name / command / url / env values) into `spec`.
  5. Persist `addMcpServer(ctx.ws, name, finalSpec)` **and** connect `await mcp.addServer(name, finalSpec)`.
  6. Return `{ name, status, toolCount, error? }` from the resulting `McpServerStatus`.
- A non-`connected` status (wrong endpoint/package, missing key, auth) is **returned, not thrown**, so the model can adjust and call again. The loop's iteration budget bounds retries.
- New server's tools become available to **subsequent** runs (`toolsForAgent` reads the manager at build time) — same semantics as `/mcp add`.

### Component 3 — `add_mcp` approval card

- New `ApprovalRequest` kind: `{ kind: "add_mcp"; name: string; spec: McpServerConfig }` in `run.ts`.
- Rendered in `App.tsx` via the existing `ProposalCard`, title **"Add MCP server — approve?"**, fields: `name`, `transport` (the `command + args` or `url`), and `env` (key **names** only — values are `${ENV}` refs, never literal secrets). Captain `[y]es [n]o [e]dit`.
- This is the safety gate: the agent proposes an arbitrary `npx …` command or remote URL, and **nothing connects until the captain approves the exact spec**.

### Component 4 — Root gets the tools + a prompt nudge

- Add `read_url` and `add_mcp_server` to root's built-in tools (`seedRoot` in `roster.ts`).
- **Migration:** an already-seeded root on disk won't gain the tools automatically. `seedRoot` (or boot) must **reconcile** the root's built-in tool list so existing workspaces pick up new root capabilities. (Preferred over a manual `agent.md` edit.)
- Add a section to root's identity/prompt: *when the captain points you at MCP docs → `read_url` the page → infer the server config → if it needs a secret, `ask_human` for the env var name and tell the captain to set it → propose via `add_mcp_server` → if the connect fails, read the error and retry a corrected config → on success, optionally `create_agent` a worker with `tools: ["mcp:<server>"]`.*

## Data flow

```
captain: "add Tavily MCP, docs: <url>"
  └─ root.read_url(url) ──Firecrawl──▶ markdown
  └─ (model infers {name, url|command, auth, env-keys} from markdown)
  └─ [needs key?] root.ask_human("set TAVILY_API_KEY in your env?") ──▶ captain
  └─ root.add_mcp_server({name, url, auth, env:{TAVILY_API_KEY:"${TAVILY_API_KEY}"}})
        └─ requestApproval(add_mcp) ──▶ ProposalCard ──▶ captain [y]
        └─ addMcpServer(persist) + mcp.addServer(connect, may open OAuth browser)
        └─ returns {status:"connected", toolCount: N}   // or {status:"error", error} → model retries
  └─ root reports: "Connected tavily (3 tools). Want a researcher wired to it?"
```

## Error handling

| Failure | Behavior |
|---|---|
| `FIRECRAWL_API_KEY` unset | `read_url` returns an actionable error; root relays "set FIRECRAWL_API_KEY". |
| Firecrawl non-2xx / network | `read_url` returns `{ error }`; root can retry or report. |
| Captain rejects the card | `add_mcp_server` → `{ rejected: true }`; root stops. |
| Connect fails (bad spec / missing key / auth) | `{ status, error }` returned; model corrects and retries within the iteration budget. |
| MCP manager absent (disabled) | `add_mcp_server` not registered / returns "MCP is disabled". |

## Testing (bun:test, no network)

- `firecrawl.test.ts` — `scrapeUrl` with an injected mock fetch: success → markdown; non-2xx → error; missing key → error.
- `tools.test.ts` — `read_url` returns markdown / no-key error; `add_mcp_server`: approve → `addServer` + persist called with the spec and status returned; reject → no-op; connect-error → surfaced (not thrown) for retry. Mock `McpManager` and `requestApproval`.
- (Optional) `App.test.tsx` — `add_mcp` renders the `ProposalCard` with the spec fields.

## Future / explicitly deferred

- Bundle Firecrawl **as an MCP server** (toggle) instead of a native tool — dogfood-y, more surface; not now.
- Playwright-in-stack `read_url` for sites Firecrawl can't reach.
- `attach_mcp_tools` — grant a connected server's tools to an **existing** agent (needs edit-agent-tools + reindex).
- Docs-inference tuned for local `npx` app-servers (GitHub READMEs).
