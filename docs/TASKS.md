# taicho — backlog / future tasks

A running list of work we've deliberately deferred to pick up later. Each item is a one-liner; when it
has a full design, the link points there. This is a human backlog — NOT taicho's runtime task queue
(`tasks/*.json`, the `/tasks` command), which is for live agent work.

## Open

### Session management

Today taicho has exactly ONE conversation per agent, keyed by agent id — `conversations/<agent>/ledger.jsonl`
(truth) + `agents/<agent>/thread.jsonl` (derived replay cache). Boot hydration resumes it (`ui/transcript-hydrate.ts`,
seeded via `index.tsx`'s `loadThread(ws, "root")`); `/clear` archives + resets it (`store/conversation.ts`
`clearConversation` → `conversations/.archive/<agent>-<ts>/`). These three items add a session layer on top of that.

- **Name a session** — let a conversation carry a human name instead of the implicit single per-agent thread.
  Needs a session-id layer (name → conversation/thread files), create/switch UX (e.g. `/session new <name>`,
  `/session <name>`), and threading the active session id through the audit seam (`core/turn-audit.ts`), the
  thread cache (`store/thread.ts`), and boot hydration. This is the enabler for the other two.
- **Recover a session** — browse and restore a previous conversation, including ones `/clear` archived (currently
  inert dirs under `conversations/.archive/` with no way back). A `/sessions` list + restore that re-hydrates the
  chosen ledger/thread into the live view. Best built on top of *Name a session*.
- **`--new` / `--fresh` launch flag** — a CLI parameter to skip boot-resume and start a fresh chat. Independent of
  the two above and shippable on its own (wire into `index.tsx`'s REPL launch before `loadThread`). Open design
  fork to settle first: (a) archive-and-fresh — run `clearConversation` at boot, recoverable; (b) non-destructive
  skip — pass `rootThread: []`, leave the persisted conversation intact so a normal launch still resumes it;
  (c) fully ephemeral — never persist this session to the ledger (most invasive; touches the run/audit engine).

- **SuperGrok / xAI OAuth subscription support** — drive Grok from a SuperGrok / X Premium+
  subscription over xAI's public OAuth device-code flow (no `XAI_API_KEY`, `costUsd: null`), built as a
  twin of the ChatGPT/Codex backend. Researched, not scheduled, not built.
  → Spec: [`superpowers/specs/2026-07-15-supergrok-xai-oauth-design.md`](superpowers/specs/2026-07-15-supergrok-xai-oauth-design.md)

## Done

_(none yet)_
