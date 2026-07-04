# Reference — Hand-Off Artifacts

Design detail for **Plan 01**. The Phase 0 forks are **closed (2026-07-04, all per
recommendation)** — see §5. This captures the problem, what the code actually does today, the
decided model, and the reasoning behind each decision.

---

## 1. The problem

When you stand up a squad, agents have no clean channel to hand work products to each other. If a
researcher produces a dossier and a writer needs it, the only way that content travels is **as text
through the conversation** — which funnels it into the parent agent's (and ultimately root's, and
the human's) context window. For research or video work, the payloads are large and structured, and
stuffing them through context is both lossy and expensive.

We want **Hand-Off Artifacts**: durable, addressable work products that move *between agents and the
human by reference*, so the context window stays a thin coordination layer and the heavy content
lives on disk.

## 2. Current state (evidence from the code)

- **`write_artifact` is write-only.** `src/core/tools.ts:28` defines `write_artifact` (immutable,
  markdown-only, one file per run at `artifacts/<topicSlug>-<runId>.md`, pushes the path onto
  `ctx.artifacts`). **There is no `read_artifact` and no `list_artifacts`.** An agent can produce an
  artifact but no agent can consume one. Artifacts are a drop-box with no pickup.
- **The de-facto hand-off channel is delegation text.** `delegate_task` (`src/core/tools.ts:65`)
  passes a `context` string down and returns `{ result: child.text }` up. That returned text is the
  context-pollution vector — the child's whole output gets inlined into the parent.
- **The KB is the only real shared store.** `remember` / `recall` (`src/core/tools.ts:154`,
  `:181`) give agents a shared, retrievable pool — but it is scoped to *facts / entities*, not
  work-product hand-off. It proves the "shared store + retrieval, off the context window" pattern
  works in this codebase.
- **`run_command`** (`src/core/tools.ts:257`) lets an agent shell out and write files — the
  unstructured footgun (the same hazard behind the "never clobber the workspace" rule).
- **Trace + policy already reference artifacts.** `RunTrace.artifacts: string[]`
  (`src/schemas/trace.ts:19`) and `policy.artifact` ("immutable artifact path (stable ID)",
  `src/schemas/policy.ts:24`). So an artifact concept already threads through traces and coaching —
  today keyed by *path*.

**Conclusion:** the hand-off channel is structurally absent, not merely awkward. Artifacts are a
one-way drop. Fixing this means adding the read half and making artifacts move by reference.

## 3. Proposed model

### 3a. Structured artifacts (recommended over raw files)
Make the hand-off unit a **structured artifact**, not a raw file:

- **Provenance / lineage for free** — `save_artifact` records producer agent + run + parent
  artifacts, giving a hand-off *graph* that mirrors how `delegatedOut` already builds a run graph.
- **Addressable by ID, not path** — reference `research-foo@v2` in a delegation or a piece of
  feedback, independent of location or revision. Paths are brittle handles.
- **Safety** — a generic `write_file`/`read_file` over the workspace re-opens the clobber footgun.
  Structured artifacts stay **immutable-per-version**; a revision is a new version, never an
  overwrite. (Today's artifacts are already immutable — keep that.)
- **Slots into what exists** — traces list artifacts, policy keys on them, the KB does retrieval.
  Structured artifacts extend all three instead of forking a parallel `resources/` world.

Tools: **`save_artifact`**, **`read_artifact`**, **`list_artifacts`** over an addressable,
versioned, provenance-tracked store that *is* today's `artifacts/`, evolved.

Two guardrails on the read half and the store, so the fix doesn't recreate the disease:

- **`read_artifact` is size-capped and summary-first.** Default return = metadata + summary;
  the body comes by explicit ask and is truncated with a marker past a cap. An uncapped read of a
  large artifact funnels the payload straight back into the context window — the exact pollution
  this plan exists to kill. (Same shape as KB auto-recall: titles + summaries, `recall` for more.)
- **Retention / GC.** Immutable-per-version plus heavy media (research dossiers, video work) is
  unbounded disk. Policy: keep-latest-N-versions + age-based archive, config-disposed; GC removes
  only versions unreferenced by any trace, policy, or task. (Phase 4b in the task index.)

### 3b. Topology — shared store + explicit handles (both, layered)
Two things pull in different directions ("artifacts moving between agents" = hand-off by reference;
"write to a resources folder" = shared pool). The answer is both:

- **Shared addressable store** — any agent can `list_artifacts` / `read_artifact(id)`, like the KB:
  a shared pool that never touches the context window.
- **Explicit hand-off references** — `delegate_task` gains `inputArtifacts: [id]`, and a child
  returns `outputArtifacts: [id] + summary`. Coordination stays legible and the parent's context
  carries **handles + summaries, not payloads**.

Target: root's context reads like a hand-off graph —
`researcher → research-foo(v2) · writer(input: research-foo) → script-bar(v1)` —
not a transcript of everything both agents produced.

### 3c. Resources vs artifacts
One genuine sub-distinction: inputs the human (or an ingest) drops in — a brief, reference footage,
source docs — vs outputs agents produce. Recommendation: **one store, role-tagged**
(`input`/`resource` vs `output`), readable by all agents. Avoids a second competing folder while
keeping the mental model clean.

### 3d. Feedback & revision (next layer, not v1 core)
Versioning + annotations: the human or an agent leaves feedback *on* an artifact, and that feedback
becomes the input to a revision run (new version, parent-linked). This is where hand-off meets the
existing **coaching/policy** system (`policy.artifact` moves from path to id). Recommendation: ship
read + hand-off first; layer feedback once the store and references are proven.

This is also where **Plan 06 (delegation verification)** plugs in: a verification verdict on a
delegated hand-off is an annotation like any other — machine feedback and human feedback converge
on the same annotation → revision mechanism (see `delegation-verification.md` §3c).

## 4. Synthesis with the context-hygiene work

The ledger/context/task work (see `context-hygiene-audit.md`) is about *what re-enters the context
window*. Hand-off artifacts are *how heavy content stays out of it and moves by reference*. **Two
halves of one philosophy:** context becomes a thin coordination layer; artifacts carry the weight.
Phase 5 is where they meet — replayed context should carry artifact handles, not payloads.

## 5. Phase 0 decisions (closed 2026-07-04)

| # | Decision | Decided |
|---|----------|---------|
| 1 | Structured artifacts vs raw files | **Structured** — provenance, addressability, safety, integration. Payload-agnostic per §5b. |
| 2 | Topology | **Shared store + explicit delegation handles**, layered. |
| 3 | Resources vs artifacts | **One store, role-tagged.** |
| 4 | Feedback in v1? | **No — read + hand-off first, feedback next.** |

## 5b. Payload-agnostic by principle (decision note, 2026-07-04)

Clarified with the user: the squad must be able to work with **any data, any shape, any tool** —
including teams organized entirely around a few MCP servers. Consequences for the design:

- **The store never interprets the payload.** Structure lives in the envelope only; the body is
  opaque bytes. `type`/`kind` is a free-form tag, never an enforced taxonomy.
- **`path` generalizes to `location`.** Sometimes the work product lives in an external system an
  MCP server fronts (a Notion page, a ClickUp task). Forcing a copy into `artifacts/` is wrong
  there — an artifact's body may be a **locator** (external URI/ref) instead of local bytes. The
  envelope (provenance, versioning, summary, handle-based hand-off) works identically either way.
  Decide the local-file-or-external-ref shape in Phase 0/1 — cheap now, a retrofit later.

## 6. Explicitly out of scope / YAGNI (for now)
- A separate `resources/` folder competing with `artifacts/`.
- Arbitrary `read_file`/`write_file` over the whole workspace (footgun; use structured artifacts +
  existing `run_command` for genuine scratch).
- Content-type–aware behavior in the store (renderers, converters, per-type validation) — the
  store stays payload-agnostic per §5b; v1 *tooling* only needs to read/summarize text bodies, but
  the schema must not assume text.
