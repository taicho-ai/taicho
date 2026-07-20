# Taicho package and repository split

Taicho is developed as a Bun workspace so a change that crosses package boundaries can be tested
atomically. Every directory under `packages/` is also a repository boundary: it owns its manifest,
public API, tests, build output, and dependencies, and must not import another package's private
source path.

## Package responsibilities

| Package | Owns | May depend on |
| --- | --- | --- |
| `@taicho-ai/contracts` | Stable runtime schemas and shared domain types | `zod` |
| `@taicho-ai/telemetry` | OpenTelemetry SDK setup, OTLP exporters, GenAI attributes, metrics, context propagation | OpenTelemetry packages only |
| `@taicho-ai/agent` | One-agent model loop, prompt/compaction, tool execution ports, provider-neutral run API | contracts, telemetry |
| `@taicho-ai/graph` | Workflow schema and deterministic graph executor; all effects are injected ports | contracts |
| `@taicho-ai/framework` | Multi-agent composition, delegation, persistence adapters, teams, knowledge, coaching, scheduling, graph-to-agent adapter | contracts, telemetry, agent, graph |
| `@taicho-ai/cli` | Command parsing, process lifecycle, Ink UI, and wiring of framework adapters | all public packages |

The dependency direction is one way:

```text
contracts     telemetry
    |             |
    +------ agent-+
    |         |
    +-- graph |
          \   |
          framework
              |
             cli
```

`telemetry` is deliberately a separate package, but not a separate sidecar or proprietary telemetry
service. It emits standard OpenTelemetry signals over OTLP and can be replaced or omitted by library
consumers. The framework passes trace context through the agent and graph ports, so a graph run,
delegated child agent, model call, and tool call remain one distributed trace. No package defines a
second trace protocol.

## Repository independence

The monorepo is the integration source of truth for now. Package boundaries are enforced by public
imports and per-package manifests. A package can later be shipped as its own repository by filtering
its directory while preserving history (for example, `git filter-repo --path packages/graph/`) and
then replacing workspace dependency versions with released versions. Cross-package changes should
use compatible version ranges and changesets before independent publishing begins.

The repository includes a repeatable history-preserving command:

```sh
./scripts/split-package.sh graph
git push <graph-repository> split/graph:main
```

Run it from a clean main branch. It creates a local split branch and never pushes by itself. The
resulting branch has the selected package at repository root, including its manifest and README.

Until publishing is enabled, packages remain private and use workspace dependencies. Enabling a
release consists of removing `private`, choosing the registry/access policy, building declarations
and JavaScript into `dist`, and publishing in dependency order. No runtime code should need to move
at that point.

## Boundary rules

1. Import another package only by its package name; never through `../../packages/...`.
2. Contracts contain no filesystem, database, model-provider, UI, or OpenTelemetry SDK code.
3. Telemetry contains no Taicho domain or storage imports and remains disabled without a standard
   OTLP endpoint (or an injected test exporter).
4. The graph executor performs no filesystem, database, model, or UI work. Those operations enter
   through typed ports.
5. The agent package runs exactly one agent. Delegation and team routing are framework concerns.
6. The CLI contains no reusable business logic; it composes packages and owns process shutdown.
