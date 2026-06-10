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

## Development

Requires [Bun](https://bun.sh).

```
bun install
bun run src/index.tsx     # dev REPL
bun run build             # compile single binary → dist/taicho
```

License: MIT
