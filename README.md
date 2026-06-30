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

Agents can use [MCP](https://modelcontextprotocol.io) tools. Manage servers with `/mcp`
(`/mcp add <name> <command…>`, `/mcp list`, `/mcp remove <name>`), and grant an agent a
server's tools by adding `mcp:<server>` (or `mcp:<server>/<tool>`) to its `tools`.

**Add a server from its docs.** Point root at a setup page and it reads the page, infers the
config, and connects it — *after you approve the exact command/URL on a card*:

> *"add the Tavily MCP — docs at https://docs.tavily.com/mcp"*

This needs a [Firecrawl](https://firecrawl.dev) key so root can read the docs page:

```
export FIRECRAWL_API_KEY=fc-...     # enables read_url → "add an MCP from its docs"
```

Without it, the docs-reading step is unavailable; you can still add servers by hand with
`/mcp add`. Secrets a server needs stay in your environment — reference them as `${VAR}` in
the config, never inline.

## Development

Requires [Bun](https://bun.sh).

```
bun install
bun run dev               # REPL with hot reload (restarts on file change)
bun run start             # REPL, no watch
bun run build             # compile single binary → dist/taicho
```

License: MIT
