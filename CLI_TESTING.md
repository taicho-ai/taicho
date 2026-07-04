# CLI Testing

This document tracks how we test Taicho through the compiled CLI binary. The goal is to prove real user workflows through `dist/taicho`, not just unit tests, component tests, or synthetic screenshots.

## What This Layer Must Prove

A useful CLI test must exercise the same path a user exercises:

1. Build the executable with `bun run build`.
2. Start the compiled binary, `dist/taicho`, inside a real PTY.
3. Type prompts into the Taicho terminal UI.
4. Approve interactive tool cards when needed.
5. Verify the files and run records that the binary produced.

For the agent workflow, the minimum acceptable test is:

1. Prompt Taicho to create an agent.
2. Approve the proposed agent.
3. Verify the agent file exists.
4. Prompt Taicho again to use that agent.
5. Verify the root run delegated to the child agent.
6. Verify the child agent completed and its output was rolled up into the root answer.
7. Verify the conversation ledger preserved the user prompts and assistant replies.

Anything less is only a smoke test.

## Current Real-Binary E2E

The current focused test is:

```bash
bun run build
bunx @microsoft/tui-test --trace e2e/agent-flow.tui.ts
```

The test file is [e2e/agent-flow.tui.ts](/Users/rajeshsharma/Documents/Works/Personal/agents/taicho/e2e/agent-flow.tui.ts). It resolves the binary as:

```ts
const bin = join(repo, "dist", "taicho");
```

It then starts that binary through `@microsoft/tui-test` in a real terminal PTY and drives this flow:

```text
create a proof worker agent
approve with y
use the proof worker to prove delegation works
```

The test uses `TAICHO_E2E_MODEL=agent-flow`. That is a deterministic model hook used only for repeatable CLI testing. It avoids network and LLM variability while still driving the compiled binary, real terminal UI, real tool approval, real run execution, and real persistence.

## Assertions

`e2e/agent-flow.tui.ts` verifies:

- `agents/proof-agent/agent.md` exists.
- `runs/root/2026-07-03-run2.json` has `outcome: "completed"`.
- the second root run has `delegatedOut` pointing at `proof-agent/...`.
- the child `proof-agent` run completed.
- root conversation ledger contains the second user prompt.
- root run companion evidence contains `child-runs.json`.
- child `final.md` contains `proof-agent completed delegated work`.

This proves the binary can create an agent and later use that created agent.

## Recording Evidence

The current recorder is:

```bash
expect e2e/record-agent-flow.expect "$PWD" "$WORKSPACE" "$PWD/artifacts/taicho-binary-agent-flow.raw.log"
```

It spawns:

```text
dist/taicho
```

and records the real ANSI terminal output to:

```text
artifacts/taicho-binary-agent-flow.raw.log
```

The current generated MP4 is:

```text
artifacts/taicho-binary-agent-flow.mp4
```

Important limitation: this MP4 is not yet a clean live screen recording of the terminal. It is a watchable evidence video rendered from the binary-run terminal log plus the files produced by that same run. The raw log is real; the video is a presentation of that log and evidence.

## Current Evidence Artifacts

After a recording run, check:

```bash
cat artifacts/taicho-binary-video-workspace.txt
```

Then inspect the workspace from that file:

```bash
ws=$(cat artifacts/taicho-binary-video-workspace.txt)
jq '{outcome, delegatedOut}' "$ws/runs/root/2026-07-03-run2.json"
cat "$ws/runs/root/2026-07-03-run2/final.md"
cat "$ws/runs/proof-agent/2026-07-03-run1/final.md"
tail -n 4 "$ws/conversations/root/ledger.jsonl"
```

Expected evidence:

```text
outcome=completed
delegatedOut=proof-agent/2026-07-03-run1
Root used proof-agent: proof-agent completed delegated work
proof-agent completed delegated work
```

## Known Problems

- `@microsoft/tui-test` is early and can be timing-sensitive. The agent-flow test waits for typed text to render before sending Enter to avoid a flaky submit race.
- Raw `expect` driving can be unreliable with Ink `TextInput` if Enter or approval keys are sent before the UI is ready.
- The existing video artifact is acceptable as a starting evidence artifact, but it is not the final desired form. The desired artifact is a clean live recording of the binary terminal session.

## Next Improvements

1. Add a single script, for example `scripts/record-cli-agent-flow.ts`, that builds the binary, creates the temp workspace, runs the PTY driver, validates produced files, and emits the raw log plus video.
2. Replace the rendered evidence MP4 with a true terminal-session recording if we can get stable capture from the PTY.
3. Add a CI-safe command for the deterministic binary test.
4. Keep real-model CLI tests separate because they require credentials, network, and token spend.

