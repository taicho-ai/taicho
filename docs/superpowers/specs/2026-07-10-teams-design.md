# Plan 19 — Teams

**Date:** 2026-07-10
**Status:** shipped (branch `plan-19-teams`)
**Topic:** The squad organizes into teams. You call the team; the team decides who takes it.

## 1. Naming, decided first

`taicho` is 隊長 — chief (長) of a *tai* (隊, a unit). Root leads **the squad**: every agent in the
workspace. The squad organizes into **teams**: news, trading, programming.

"deck" retires. It named the workspace and its agents indiscriminately, and its only concrete code was
`DeckLedger`, which counts money. `desk` was rejected: `deck` and `desk` are one character apart and
would have sat as load-bearing nouns in adjacent lines of `/costs` output. That is a legibility bug in
the product, not a style preference.

The retirement is NOT a mechanical rename. `scope: "deck"` is a **persisted value** — the `kb_nodes`
column default, what `remember()` writes, and the frontmatter of every knowledge file on disk. Hence
migration v7 + a `KbScope` preprocess + `reconcileKbScope` boot backfill. Ph1a (the pure `SpendLedger`
rename, 129 occurrences, no data) ships separately from Ph1b (the concept rename, which touches state).

## 2. What a team is

`teams/<id>/team.md` — charter, optional `lead`, tool policy. A file scan, no `teams` table (the call
`schedules.ts` already made). Captain-owned: there is deliberately **no `create_team` tool**, because a
team grants capability to its members.

**Membership has one source of truth.** The agent declares `team: <id>` in its own frontmatter; a team's
roster is derived by grouping `registry.team`. Listing members in `team.md` too would let them drift.

## 3. Routing (`src/core/team-routing.ts`, pure)

`delegate_task(to:"news")` — ids share one namespace, so a bare name is unambiguous; `team:news` is
accepted too. A team with a `lead` routes to it (one delegation level, one model call). A **leadless**
team is routed by the engine to the best-ranked member via `rankAgents`, for free. Leadless is the default.

**RESOLVE first, then cycle-check the RESOLVED AGENT.** Checking the team id would let
`root → news → editor → news → editor` loop forever, because a team id never appears in `ancestry`.

Three guards: a lead may not address its own team; ancestors are never routing candidates; an empty team
is an actionable error, not an ENOENT inside `loadAgent`. The retry path re-guards against the resolved
agent, or a leadless team could hand a verification retry — carrying feedback about the first agent's
mistakes — to a different member.

The pick is never silent: `rankAgents` is a keyword match and will sometimes choose badly. The decision
rides `ctx.emit` and lands on `trace.notes`.

## 4. The roster stops being flat

`prompt.ts` inlined ≤30 agents and past that printed "too many to list". Both branches are bad. Root's
roster now shows **teams and direct reports**; a sixty-agent squad renders as five lines. A squad with no
teams renders **byte-identically** to before — asserted, because silently reshaping every existing prompt
would be a real regression.

## 5. Boundaries, config, spend

A team is a **legibility** boundary, not a security one. Root keeps `canDelegateTo: ["*"]` and *could*
name a member; it won't, because its roster shows teams. Narrow the ACL by hand for the hard version.

ACL grammar gains one production: `"*"` | exact id | `team:<id>`. Additive — no id contains a colon.

Config walks **agent → team → defaults** (provider, model). `team.md` is canon for capability;
`taicho.yaml` overrides model and budgets — the same division agents already have.

Tool policy: `grant` ADDS, `deny` REMOVES and wins over both. A `deny` intersecting
`DEFAULT_WORKER_TOOLS` is rejected at team LOAD, naming the tool: Plan 14's floor is not a team's to
punch through.

Spend: **one meter, two scopes.** `squad` bounds every agent, `team:<id>` bounds one team. The loop tests
every scope a run belongs to and commits to all in one transaction. A delegated child meters against ITS
team; the Plan 06 checker against the DELEGATING agent's; the coaching distiller against `squad` alone.
The exhaustion message names the scope that tripped.

## 6. The gotcha worth remembering

`registry` is created by `db.ts`'s baseline `CREATE TABLE IF NOT EXISTS`, which **cannot add a column to
a table that already exists**. `team` is therefore declared in BOTH the baseline (fresh workspaces) and a
guarded `ALTER` in migration v8 (existing ones). Either alone is a bug. `migrate.test.ts`'s `rewindToV6`
rebuilds a pre-migration DB on purpose, because a test against a fresh `openDb()` would pass while every
real workspace broke on upgrade.

## 7. Testing

`store/teams.test.ts`, `core/registry.test.ts`, `core/team-routing.test.ts`, `core/run.test.ts` (routing
end-to-end through `executeRun`), `core/prompt.test.ts` (the byte-identical no-teams path),
`store/spend-ledger.test.ts` + `core/loop.test.ts` (a team ceiling stopping a run the squad would allow),
`ui/slash.test.ts` + `ui/App.test.tsx` (`/teams`), `store/migrate.test.ts` (a legacy v6 DB).

Gates: `bun run typecheck` · `bun test` (693 at Ph7) · `bun run build` — all green.
