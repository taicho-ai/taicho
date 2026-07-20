# taicho

**隊長** (*taichō*) — squad captain. You're the captain; the agents are the squad.

A standalone, conversational CLI for running a team of persistent, stateful agents:
they discover each other, delegate work, and produce artifacts — and you can enter
the system at any agent, at any time: inspect its runs, steer it mid-flight,
re-task it, and make corrections stick.

```
curl -fsSL https://taicho.ai/install.sh | bash
```

Status: pre-alpha, under active development. Design docs live in `docs/superpowers/specs/`.

## Install from npm

Requires [Bun](https://bun.sh) — the packages ship TypeScript source and the CLI runs on Bun.

```
bun add -g @taicho-ai/cli     # the `taicho` command
```

Or use the pieces as libraries:

| Package | What you get |
|---|---|
| [`@taicho-ai/cli`](https://www.npmjs.com/package/@taicho-ai/cli) | The `taicho` terminal app (Ink REPL) |
| [`@taicho-ai/framework`](https://www.npmjs.com/package/@taicho-ai/framework) | Multi-agent composition: delegation, teams, storage, coaching, MCP, scheduling |
| [`@taicho-ai/agent`](https://www.npmjs.com/package/@taicho-ai/agent) | One-agent execution kernel: model loop, prompts, compaction, step events |
| [`@taicho-ai/graph`](https://www.npmjs.com/package/@taicho-ai/graph) | Deterministic workflow schema + executor |
| [`@taicho-ai/contracts`](https://www.npmjs.com/package/@taicho-ai/contracts) | Shared zod schemas and domain types |
| [`@taicho-ai/telemetry`](https://www.npmjs.com/package/@taicho-ai/telemetry) | OpenTelemetry/OTLP setup + GenAI signal helpers |

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

Agents can use [MCP](https://modelcontextprotocol.io) tools. **Grants are per-agent, least
privilege**: an agent only gets a server's tools if its tool list carries `mcp:<server>` (the whole
server) or `mcp:<server>/<tool>` (one tool) — root grants these when creating workers, or you edit
`agents/<id>/agent.md`. Manage servers with `/mcp` (`/mcp add <name> <command…>`, `/mcp list`,
`/mcp remove <name>`).

**Firecrawl is built in.** Set a [Firecrawl](https://firecrawl.dev) key and the Firecrawl MCP
server (scrape / crawl / search / map / extract) connects on every squad — grant `mcp:firecrawl`
to the agents that should use it (root's own `read_url` docs reader uses the same key directly):

```
export FIRECRAWL_API_KEY=fc-...     # the Firecrawl MCP server + root's docs reader
```

**Add a server from its docs.** Point root at a setup page — it reads the page (via its
`read_url` docs reader), infers the config, and connects it, *after you approve the exact
command/URL on a card*:

> *"add the Tavily MCP — docs at https://docs.tavily.com/mcp"*

Secrets a server needs stay in your environment — reference them as `${VAR}` in the config
(in `env`, `headers`, or the URL), never inline.

## Teams

Group agents into teams and address the team, not its members:

```
teams/news/team.md      # charter, an optional lead, a tool policy
agents/reporter/agent.md  ->  team: news
```

`delegate_task(to: "news")` routes to the team's `lead` if it has one, or to whichever member best fits
the goal. Root's prompt then lists teams instead of sixty agents. `/teams` shows them.

```yaml
# taicho.yaml — resolution walks agent -> team -> defaults
teams:
  trading:
    model: claude-opus-4-8
    ceilings: { dailyCostUsd: 25 }   # this team's own spend cap
```

A team's tool policy (grant extra tools to members, or deny some) lives in the team's charter file
`teams/<id>/team.md`, not in `taicho.yaml`.

## Knowledge (shared squad memory)

The squad shares a **knowledgebase** — a graph of typed nodes (facts, decisions, entities) linked by
typed edges. Any agent granted `remember` / `recall` can save durable knowledge and search it by
**meaning** (semantic) and by **relationship** (graph traversal); relevant knowledge is also
auto-injected into an agent's prompt (like coaching notes). Nodes are files (`kb/nodes/*.md`,
git-diffable); the SQLite index rebuilds from them.

**Semantic search** auto-detects its embedder: `openai` (text-embedding-3-small) when
`OPENAI_API_KEY` is set, otherwise a local model — `all-MiniLM-L6-v2` via transformers.js, **no API
key**. Configure explicitly in `taicho.yaml`:

```
embeddings:
  provider: local    # local (no key) | openai (needs OPENAI_API_KEY) | off (keyword+graph only)
```

The local model runs the native ONNX runtime, which can't bundle into the single binary — so on first
use the binary self-installs the model runtime into `~/.taicho/runtime` (needs `bun` or `node` on
PATH — the same toolchain MCP servers use) and runs it in a spawned worker; model weights cache in
`~/.taicho/models`. From source (`bun run dev`) it loads in-process. If neither is available (no
package manager, offline) it degrades to keyword + graph search, so the KB works under any provider.

### Authoring source documents

Write markdown/text into `kb/sources/`. Run `/kb sync` and the **librarian** agent reads each
changed doc, extracts entities + typed relationships, and files them into the graph (stamped
`sources/<file>@<hash>`). Editing a doc and re-syncing replaces exactly that doc's subgraph — the
content hash drives it. On boot, taicho notes how many sources changed since the last sync.

### Curating

- `/kb list [kind=… | source=…]` — inspect nodes.
- `/kb forget kind=decision` — prune all decisions (cascade: nodes + edges + vectors).
- `/kb forget source=worker-x:` — wipe everything a given assistant remembered.
- `/kb reindex` — rebuild the graph from files and refresh semantic vectors after hand-edits.

You can also just ask root to "clear all X" — it delegates to the librarian, which runs the same
`forget` under the hood. Agent-written memory (`remember`) stays write-through and immediately
recallable; only pruning is admin-driven.

## Skills (reusable procedures)

Agents share a library of **skills** — reviewed, step-by-step procedures for repeatable operations,
so the squad does common tasks the right way with fewer mistakes. Each skill is a file
(`skills/<id>.md`, YAML frontmatter + a markdown procedure); files are canon and a SQLite table
indexes them. Every agent can `find_skills(query)` and `use_skill(name)` (load the full procedure),
and the most relevant skills auto-inject (name + when-to-use) into each run's prompt.

Author skills by creating/editing `skills/*.md` and running `/skills reindex` (a few starters ship
by default). Manage them with `/skills list`, `/skills show <id|name>`, `/skills remove <id>`. Set a
skill's `status: draft` to keep it out of agents' context while you work on it.

## Root: proposing skills & running commands

The root orchestrator has two extra, captain-gated powers:

- **`propose_skill`** — root can draft a reusable skill; you approve it on a card, and on approval it's
  saved `active` and the whole squad can `use_skill` it.
- **`run_command`** — root can run shell commands. This is always on: `run_command` is a built-in
  root tool that every squad's root gets on boot, not something you enable per squad. Each command is
  checked by the external [`dcg`](https://github.com/Dicklesworthstone/destructive_command_guard)
  guard, then runs **sandbox-first**: dcg-cleared commands execute inside a macOS Seatbelt sandbox
  (deny-by-default — no network, writes confined to the workspace); a command the sandbox can't
  complete, anything dcg flags, or any command at all if `dcg`/the sandbox aren't available, escalates
  to you for approval first. If an agent has read untrusted content (web pages, MCP results) earlier
  in the run, every `run_command` requires approval — prompt-injection can't silently reach the shell.
  Output is captured (capped) and returned.

Root holds both by default; like every privileged tool they are grant-gated, so root can extend
`run_command` to a worker it creates (you approve the agent card that grants it). The Seatbelt
sandbox, the guard, the injection taint-check, and your approval on anything escalated are the
guardrails.

## Observability

taicho emits **standard OpenTelemetry over OTLP** — spans for every run, model call, tool (including
MCP), and verification, plus token/cost/latency metrics. It bundles no dashboard; you point it at your
own backend with the standard `OTEL_*` env vars. Off by default (no endpoint ⇒ no-op).

```
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"   # your collector / backend
```

Copy-paste configs for LangSmith, Langfuse, Jaeger, Grafana Tempo, Honeycomb, Datadog, and generic
collectors — plus the content-capture privacy flag — are in **[`docs/observability.md`](docs/observability.md)**.

## Development

Requires [Bun](https://bun.sh).

The repository is a workspace of independently buildable packages:

| Package | Purpose |
| --- | --- |
| `@taicho-ai/contracts` | Shared schemas and domain types |
| `@taicho-ai/telemetry` | Standard OpenTelemetry/OTLP integration |
| `@taicho-ai/agent` | Reusable single-agent execution kernel |
| `@taicho-ai/graph` | Deterministic workflow graph and file journal |
| `@taicho-ai/framework` | Multi-agent runtime, persistence, teams, knowledge, and scheduling |
| `@taicho-ai/cli` | Taicho process entry point and Ink interface |

Each package has its own manifest, tests, and build. See
[`docs/architecture/package-split.md`](docs/architecture/package-split.md) for dependency rules and
the path to separate repositories or future publication.

```
bun install
bun run dev               # REPL with hot reload (restarts on file change)
bun run start             # REPL, no watch
bun run check:boundaries  # enforce one-way package dependencies
bun run build:packages    # independently bundle every package
bun run test              # full package suite
bun run build             # compile single binary → dist/taicho
```

License: MIT
