# taicho

**隊長** (*taichō*) — squad captain. You're the captain; the agents are the squad.

A standalone, conversational CLI for running a team of persistent, stateful agents:
they discover each other, delegate work, and produce artifacts — and you can enter
the system at any agent, at any time: inspect its runs, steer it mid-flight,
re-task it, and make corrections stick.

```
curl -fsSL https://taicho.ai/install.sh | bash
```

Status: pre-alpha, under active development. See SPEC for design.

## Five control surfaces

1. **Enter anywhere** — talk to any agent directly (`@researcher ...`)
2. **Steer mid-flight** — redirect a working agent without killing its run
3. **Org rules + budgets** — who sees whom, what anything can spend
4. **Traces** — every run inspectable: what fired, what it cost, what it produced
5. **Coaching** — corrections become durable, conditional, approval-gated policy

## Models & providers

taicho reads credentials from the environment. Set one of:

```
export ANTHROPIC_API_KEY=sk-ant-...     # Anthropic   (default model: claude-sonnet-4-6)
export OPENAI_API_KEY=sk-...            # OpenAI      (default model: gpt-5.5)
export OPENROUTER_API_KEY=sk-or-...     # OpenRouter  (model REQUIRED — see below)
```

Or sign in with a **ChatGPT subscription** (no API key, runs on the Codex backend):

```
/login openai
```

**OpenRouter** needs an explicit, namespaced (`vendor/model`) model — it has no default.
Set it via `TAICHO_MODEL` or `taicho.yaml`, and browse slugs at <https://openrouter.ai/models>:

```
export OPENROUTER_API_KEY=sk-or-...
export TAICHO_MODEL=anthropic/claude-sonnet-4.5
```

OpenRouter runs report their real per-call cost; other env-key runs use an advisory price
table; subscription runs report `subscription` instead of a dollar cost.

**Selection & precedence.** A signed-in subscription is preferred over env keys. Otherwise
the provider is auto-detected (Anthropic → OpenAI → OpenRouter). Force a specific one with
`TAICHO_PROVIDER` = `anthropic` | `openai` | `openrouter` | `openai-codex` (subscription).
Override the model with `TAICHO_MODEL`. For per-agent providers/models and budgets, use a
`taicho.yaml` in the workspace root — API keys are never read from that file.

## MCP servers

Agents can use [MCP](https://modelcontextprotocol.io) tools. **Every agent automatically gets
every connected server's tools** — the built-in defaults plus anything you add. Manage servers
with `/mcp` (`/mcp add <name> <command…>`, `/mcp list`, `/mcp remove <name>`).

**Firecrawl is built in.** Set a [Firecrawl](https://firecrawl.dev) key and the Firecrawl MCP
(scrape / crawl / search / map / extract) connects on every deck, available to all agents:

```
export FIRECRAWL_API_KEY=fc-...     # the Firecrawl MCP server + root's docs reader
```

**Add a server from its docs.** Point root at a setup page — it reads the page (via its
`read_url` docs reader), infers the config, and connects it, *after you approve the exact
command/URL on a card*:

> *"add the Tavily MCP — docs at https://docs.tavily.com/mcp"*

Secrets a server needs stay in your environment — reference them as `${VAR}` in the config
(in `env`, `headers`, or the URL), never inline.

## Knowledge (shared deck memory)

The squad shares a **knowledgebase** — a graph of typed nodes (facts, decisions, entities) linked by
typed edges. Any agent granted `remember` / `recall` can save durable knowledge and search it by
**meaning** (semantic) and by **relationship** (graph traversal); relevant knowledge is also
auto-injected into an agent's prompt (like coaching notes). Nodes are files (`kb/nodes/*.md`,
git-diffable); the SQLite index rebuilds from them.

**Semantic search** uses a local model by default — `all-MiniLM-L6-v2` via transformers.js, **no API
key**. Configure in `taicho.yaml`:

```
embeddings:
  provider: local    # local (default, no key) | openai (needs OPENAI_API_KEY) | off (keyword+graph only)
```

The local model runs the native ONNX runtime, which can't bundle into the single binary — so on first
use the binary self-installs the model runtime into `~/.taicho/runtime` (needs `bun` or `node` on
PATH — the same toolchain MCP servers use) and runs it in a spawned worker; model weights cache in
`~/.taicho/models`. From source (`bun run dev`) it loads in-process. If neither is available (no
package manager, offline) it degrades to keyword + graph search, so the KB works under any provider.

## Development

Requires [Bun](https://bun.sh).

```
bun install
bun run dev               # REPL with hot reload (restarts on file change)
bun run start             # REPL, no watch
bun run build             # compile single binary → dist/taicho
```

License: MIT
