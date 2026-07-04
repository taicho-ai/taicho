/** Per-agent toolset. Every tool carries an execute fn so the AI SDK includes tool RESULTS in
 *  response.messages (the manual loop pushes those back). execute closes over the RunContext,
 *  which is how create_agent awaits captain approval and delegate_task spawns child runs. */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { AgentDef } from "../schemas/agent";
import type { RunContext } from "./run";
import type { McpManager } from "./mcp/manager";
import { paths } from "../store/files";
import { readTaskState } from "../store/task-state";
import { saveArtifact, readArtifact, readArtifactBody, listArtifacts } from "../store/artifacts";
import { artifactHandle } from "../schemas/artifact";
import { mergeDraft } from "./draft";
import { scrapeUrl } from "./firecrawl";
import { McpServerConfig } from "../store/config";
import { addMcpServer } from "../store/mcp-store";
import { KbNode } from "../schemas/knowledge";
import { writeNode, mkKbId, nodeExists, forgetNodes, reindexKnowledge, reembedAll } from "../store/knowledge";
import { putVector } from "../store/vectors";
import { searchKnowledge } from "../knowledge/retrieval";
import { getActiveSkills, mkSkillId, writeSkill } from "../store/skills";
import { rankSkills } from "../skills/retrieval";
import { Skill } from "../schemas/skill";
import { classifyCommand, runShell } from "./command-guard";

// read_artifact body cap: default returns metadata + summary only; a body read is capped so an
// uncapped read can't funnel a large payload back into context (the pollution this plan exists to kill).
const READ_ARTIFACT_CAP = 4000;
const READ_ARTIFACT_HARD_MAX = 20000;

export function toolsForAgent(agent: AgentDef, ctx: RunContext, mcp?: McpManager): ToolSet {
  const set: ToolSet = {};

  // Legacy simple-markdown write, kept as a back-compat wrapper over the structured store (per the
  // plan: save_artifact "replaces/wraps" it). Prefer save_artifact for provenance + hand-off.
  if (agent.tools.includes("write_artifact"))
    set.write_artifact = tool({
      description: "Write a simple markdown artifact and return its path. Prefer save_artifact for structured, versioned, provenance-tracked outputs you hand off by reference.",
      inputSchema: z.object({
        topicSlug: z.string().regex(/^[a-z0-9-]+$/, "lowercase, digits, hyphens only"),
        markdown: z.string(),
      }),
      execute: async ({ topicSlug, markdown }) => {
        const a = saveArtifact(ctx.ws, {
          id: topicSlug, title: topicSlug, type: "document", role: "output",
          producer: ctx.agentId, runId: ctx.runId, body: markdown,
        });
        const path = a.location.kind === "file" ? a.location.path : artifactHandle(a);
        ctx.artifacts.push(artifactHandle(a)); // hand off by handle (id@vN) like save_artifact — an absolute path is un-resolvable to the parent
        return { path };                       // model still gets the concrete path for back-compat
      },
    });

  if (agent.tools.includes("save_artifact"))
    set.save_artifact = tool({
      description: "Save a work product to the shared artifact store as a structured, versioned, addressable artifact — the way to hand work to other agents (and the human) BY REFERENCE instead of dumping it into the conversation. Your identity + this run are recorded as provenance automatically. Give a `body` (local content) OR an `external` locator (a URI/ref into a system an MCP server fronts). Reusing an existing `id` saves a NEW immutable version. Returns the handle (id@vN) — pass it in delegate_task's inputArtifacts to hand it off.",
      inputSchema: z.object({
        title: z.string(),
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase, digits, hyphens").optional().describe("stable logical id/slug; omit to derive from the title; reuse an existing id to save a new version"),
        type: z.string().default("document").describe("free-form tag (e.g. dossier, script, dataset, notion-page) — NOT an enforced taxonomy"),
        role: z.enum(["output", "input", "resource"]).default("output").describe("output = you produced it; input/resource = human- or ingest-provided"),
        summary: z.string().optional().describe("a short summary of what this artifact is; readers see it before they pull the body"),
        body: z.string().optional().describe("the artifact's local content (stored as bytes on disk)"),
        external: z.string().optional().describe("a locator (URI/ref) when the work product lives in an external system; use INSTEAD of body"),
        ext: z.string().optional().describe("file extension for the body (default md)"),
        parents: z.array(z.string()).default([]).describe("handles of artifacts this one derives from (lineage)"),
      }),
      execute: async ({ title, id, type, role, summary, body, external, ext, parents }) => {
        if (body === undefined && !external) return { error: "provide a `body` (local content) or an `external` locator" };
        try {
          const a = saveArtifact(ctx.ws, { id, title, type, role, summary, body, external, ext, parents, producer: ctx.agentId, runId: ctx.runId });
          const handle = artifactHandle(a);
          ctx.artifacts.push(handle);
          ctx.notes.push(`saved artifact ${handle}`);
          return { id: a.id, version: a.version, handle, location: a.location };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    });

  if (agent.tools.includes("read_artifact"))
    set.read_artifact = tool({
      description: "Fetch an artifact by handle ('id' for the latest version, or 'id@vN'). Returns metadata + summary by DEFAULT (cheap — keeps context thin). Pass includeBody:true to pull the body, which is size-capped and truncated with a marker; never dump a whole large artifact into context.",
      inputSchema: z.object({
        id: z.string().describe("artifact handle: 'id' (latest) or 'id@vN'"),
        includeBody: z.boolean().default(false).describe("pull the body too (size-capped) — off by default"),
        maxChars: z.number().int().positive().max(READ_ARTIFACT_HARD_MAX).default(READ_ARTIFACT_CAP).describe(`body cap in characters (max ${READ_ARTIFACT_HARD_MAX})`),
      }),
      execute: async ({ id, includeBody, maxChars }) => {
        const a = readArtifact(ctx.ws, id);
        if (!a) return { error: `no artifact "${id}"` };
        const meta = {
          id: a.id, version: a.version, handle: artifactHandle(a), title: a.title,
          type: a.type, role: a.role, producer: a.producer, runId: a.runId,
          parents: a.parents, summary: a.summary ?? null, location: a.location,
        };
        if (!includeBody) return { ...meta, bodyOmitted: true };
        if (a.location.kind === "external")
          return { ...meta, external: a.location.uri, note: "external artifact — its body lives in the fronting system; use that system's tools to fetch it" };
        const buf = readArtifactBody(ctx.ws, id);
        if (!buf) return { ...meta, error: "body bytes missing" };
        const cap = Math.min(maxChars, READ_ARTIFACT_HARD_MAX);
        const text = buf.toString("utf8");
        const truncated = text.length > cap;
        return {
          ...meta, bytes: buf.length, truncated,
          body: truncated
            ? text.slice(0, cap) + `\n…[truncated ${text.length - cap} of ${text.length} chars — raise maxChars up to ${READ_ARTIFACT_HARD_MAX} or read a narrower artifact]`
            : text,
        };
      },
    });

  if (agent.tools.includes("list_artifacts"))
    set.list_artifacts = tool({
      description: "Discover artifacts in the shared store (the latest version of each). Filter by producer (agent id), type (free-form tag), role (output|input|resource), or q (substring over id/title/summary). Returns handles + summaries — read one with read_artifact.",
      inputSchema: z.object({
        producer: z.string().optional(),
        type: z.string().optional(),
        role: z.enum(["output", "input", "resource"]).optional(),
        q: z.string().optional().describe("substring over id/title/summary"),
        k: z.number().int().positive().max(50).default(20),
      }),
      execute: async ({ producer, type, role, q, k }) => ({
        artifacts: listArtifacts(ctx.ws, { producer, type, role, q }).slice(0, k).map((a) => ({
          handle: artifactHandle(a), id: a.id, version: a.version, title: a.title,
          type: a.type, role: a.role, producer: a.producer, summary: a.summary ?? null,
        })),
      }),
    });

  if (agent.tools.includes("create_agent"))
    set.create_agent = tool({
      description: "Propose a NEW worker agent for the captain to approve. Give it a clear id, a one-line role, and an identity that defines its point of view.",
      inputSchema: z.object({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/),
        role: z.string(),
        identity: z.string(),
        tools: z.array(z.string()).optional(),
      }),
      execute: async (draft) => {
        const decision = await ctx.requestApproval({ kind: "create_agent", draft });
        if (decision.type === "reject") return { rejected: true, reason: "reject" };
        const finalDraft = decision.type === "edit" ? mergeDraft(draft, decision.draft) : draft;
        try {
          const created = await ctx.createAgent(finalDraft);
          return { created: created.id, role: created.role };
        } catch {
          return { error: `agent "${finalDraft.id}" already exists or could not be created` };
        }
      },
    });

  if (agent.tools.includes("delegate_task"))
    set.delegate_task = tool({
      description:
        "Delegate a goal to another agent by id. Hand work over BY REFERENCE via `inputArtifacts` " +
        "(artifact handles the child reads with read_artifact) rather than pasting content into `context`; " +
        "you get back the child's output artifact handles + a short summary — not its full text. " +
        "Optionally pass `criteria` — a plain-language contract for what 'done' means (e.g. \"a markdown " +
        "dossier with ≥5 cited, dated sources\"). When you set criteria, the child's output is judged by an " +
        "independent check before you get it; a failing check triggers one automatic retry with feedback, " +
        "and a still-failing result comes back with its failed verdict attached so you can see the caveat. " +
        "Set criteria whenever the output has concrete requirements you'd otherwise have to re-check by hand.",
      inputSchema: z.object({
        to: z.string(),
        goal: z.string(),
        context: z.string().optional(),
        criteria: z.string().optional().describe("acceptance criteria the output must meet; enables an independent check + one retry"),
        inputArtifacts: z.array(z.string()).optional().describe("artifact handles ('id' or 'id@vN') to hand to the child by reference"),
      }),
      execute: async ({ to, goal, context, criteria, inputArtifacts }) => {
        const budgetMsg = () => `work item budget (${agent.budgets.maxWorkItemsPerRequest}) exhausted`;
        // Each delegation (initial AND the verification retry) consumes one work item — config
        // disposes, so the retry is no new runaway vector.
        ctx.workItems.n += 1;
        if (ctx.workItems.n > agent.budgets.maxWorkItemsPerRequest) {
          ctx.notes.push(`delegate refused: ${budgetMsg()}`);
          return { error: budgetMsg() };
        }
        const guard = ctx.delegationGuard(to);
        if (!guard.ok) { ctx.notes.push(`delegate refused: ${guard.error}`); return { error: guard.error }; }

        // resolve input handles; drop (and note) any that don't exist rather than passing a dead ref.
        const resolved: string[] = [], dropped: string[] = [];
        for (const h of inputArtifacts ?? []) (readArtifact(ctx.ws, h) ? resolved : dropped).push(h);
        if (dropped.length) ctx.notes.push(`delegate: dropped unknown input artifact(s) ${dropped.join(", ")}`);

        // Spawn one child run (initial OR the verification retry). Both get the SAME input handles BY
        // REFERENCE, and each spawn folds its spend + produced handles into this run's aggregate/graph.
        const spawn = async (childContext?: string) => {
          const child = await ctx.runChild({ to, goal, context: childContext, criteria, inputArtifacts: resolved });
          ctx.delegatedOut.push(child.runId);
          ctx.childTraces.push(child.trace);
          ctx.outputArtifacts.push(...child.trace.artifacts); // hand-off graph: handles the child produced
          const agg = child.trace.aggregate ?? { tokens: child.trace.tokens, costUsd: child.trace.costUsd };
          ctx.childSpend.tokens += agg.tokens;
          ctx.childSpend.costUsd += agg.costUsd ?? 0;
          return child;
        };

        try {
          let child = await spawn(context);
          ctx.inputArtifacts.push(...resolved); // hand-off graph: handles I sent down (same set for any retry)

          // No criteria ⇒ no check ⇒ today's trust-everything behavior, zero extra cost.
          // Parent context gets handles + a summary, NOT the child's full body (the pollution vector).
          if (!criteria) return { to, runId: child.runId, outputArtifacts: child.trace.artifacts, summary: child.text };

          // Independent checker call, BEFORE the result reaches the parent's context. Its spend is
          // real model spend this run caused → fold it into the aggregate (like child-run spend).
          const first = await ctx.checkCriteria({ goal, criteria, output: child.text });
          ctx.verifierSpend.tokens += first.tokens;
          ctx.verifierSpend.costUsd += first.costUsd ?? 0; // null (subscription) folds as 0 in the sum; recorded value stays null
          ctx.verifications.push({ criteria, verdict: first.verdict, runId: child.runId, retried: false, tokens: first.tokens, costUsd: first.costUsd, costNote: first.costNote });
          let verdict = first.verdict;

          if (!verdict.pass) {
            ctx.emit?.({ note: `↻ ${to} output failed verification: ${verdict.reasons.join("; ")} — retrying once` });
            // Exactly ONE bounded retry — consumes a work item like any delegation.
            ctx.workItems.n += 1;
            const overBudget = ctx.workItems.n > agent.budgets.maxWorkItemsPerRequest;
            const retryGuard = ctx.delegationGuard(to);
            if (overBudget || !retryGuard.ok) {
              const why = overBudget ? budgetMsg() : !retryGuard.ok ? retryGuard.error : "retry blocked";
              ctx.notes.push(`verification retry refused: ${why}`);
              ctx.emit?.({ note: `⚠ ${to} result surfaced WITHOUT a passing verification (retry blocked: ${why})` });
              return { to, runId: child.runId, outputArtifacts: child.trace.artifacts, summary: child.text, verification: verdict };
            }
            const feedback = "Your previous attempt did NOT meet the acceptance criteria. Fix these before returning:\n" +
              verdict.reasons.map((r) => `- ${r}`).join("\n");
            // Retry-spawn ALSO threads inputArtifacts (via the closure's `resolved`) so the retried
            // child still receives the same input handles by reference.
            const retry = await spawn(context ? `${context}\n\n${feedback}` : feedback);
            const second = await ctx.checkCriteria({ goal, criteria, output: retry.text });
            ctx.verifierSpend.tokens += second.tokens;
            ctx.verifierSpend.costUsd += second.costUsd ?? 0; // null (subscription) folds as 0 in the sum; recorded value stays null
            ctx.verifications.push({ criteria, verdict: second.verdict, runId: retry.runId, retried: true, tokens: second.tokens, costUsd: second.costUsd, costNote: second.costNote });
            child = retry;
            verdict = second.verdict;
            if (verdict.pass) ctx.emit?.({ note: `✓ ${to} passed verification after one retry` });
            else ctx.emit?.({ note: `⚠ ${to} still failed verification after retry: ${verdict.reasons.join("; ")} — surfacing result with the failed verdict` });
          }

          // Criteria was set: always attach the verdict so the parent (and captain) sees the caveat.
          return { to, runId: child.runId, outputArtifacts: child.trace.artifacts, summary: child.text, verification: verdict };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ctx.notes.push(`delegate failed: ${msg}`);
          return { error: msg };
        }
      },
    });

  // Plan 04 — background delegation. dispatch_task fires-and-forgets (returns a taskId immediately);
  // check_task / await_task follow up. Results come back BY REFERENCE (summary + handles), never the
  // inlined payload. Requires a host scheduler (the REPL wires ctx.dispatchTask); when unwired the
  // tool cleanly reports it (a headless/unit context has no background runner).
  if (agent.tools.includes("dispatch_task"))
    set.dispatch_task = tool({
      description:
        "Kick a goal off to another agent in the BACKGROUND and keep working — fire-and-forget. Returns " +
        "a taskId immediately; the task runs off-turn. Use this (instead of delegate_task, which BLOCKS " +
        "until the child returns) when you don't need the result right now — e.g. long research you'll " +
        "check on later. Follow up with check_task(taskId) for status or await_task(taskId) to block on " +
        "it when you finally need it. Results come back BY REFERENCE (a summary + artifact handles), never " +
        "inlined. Hand inputs over with `inputArtifacts` and set `criteria` exactly as for delegate_task.",
      inputSchema: z.object({
        to: z.string(),
        goal: z.string(),
        context: z.string().optional(),
        criteria: z.string().optional().describe("acceptance criteria the output must meet; enables an independent check + one retry"),
        inputArtifacts: z.array(z.string()).optional().describe("artifact handles ('id' or 'id@vN') to hand to the task by reference"),
      }),
      execute: async ({ to, goal, context, criteria, inputArtifacts }) => {
        if (!ctx.dispatchTask) return { error: "background dispatch is not available in this context — use delegate_task instead" };
        const budgetMsg = () => `work item budget (${agent.budgets.maxWorkItemsPerRequest}) exhausted`;
        // A dispatch consumes a work item like a delegation — config disposes fan-out either way.
        ctx.workItems.n += 1;
        if (ctx.workItems.n > agent.budgets.maxWorkItemsPerRequest) {
          ctx.notes.push(`dispatch refused: ${budgetMsg()}`);
          return { error: budgetMsg() };
        }
        const guard = ctx.delegationGuard(to);
        if (!guard.ok) { ctx.notes.push(`dispatch refused: ${guard.error}`); return { error: guard.error }; }
        // Resolve input handles up front; drop (and note) dead refs rather than dispatch a broken brief.
        const resolved: string[] = [], dropped: string[] = [];
        for (const h of inputArtifacts ?? []) (readArtifact(ctx.ws, h) ? resolved : dropped).push(h);
        if (dropped.length) ctx.notes.push(`dispatch: dropped unknown input artifact(s) ${dropped.join(", ")}`);
        const r = await ctx.dispatchTask({ to, goal, context, criteria, inputArtifacts: resolved });
        if ("error" in r) { ctx.notes.push(`dispatch failed: ${r.error}`); return r; }
        ctx.notes.push(`dispatched ${r.taskId} → ${to}`);
        return { taskId: r.taskId, status: "queued", to, note: `running in background — check_task("${r.taskId}") for status, or await_task to block on it` };
      },
    });

  if (agent.tools.includes("check_task"))
    set.check_task = tool({
      description: "Check a background task (from dispatch_task) WITHOUT blocking: returns its status (queued/running/completed/failed/interrupted/cancelled) plus a short summary and result handle when done. Reference-only — never the full payload; pull artifacts with read_artifact.",
      inputSchema: z.object({ taskId: z.string() }),
      execute: async ({ taskId }) => {
        const t = readTaskState(ctx.ws, taskId);
        if (!t) return { error: `no task "${taskId}"` };
        return { taskId, status: t.status, to: t.agent, summary: t.summary ?? null, resultRef: t.resultRef ?? null, runId: t.rootRunId || null };
      },
    });

  if (agent.tools.includes("await_task"))
    set.await_task = tool({
      description: "BLOCK until a background task settles (bounded by a timeout), then return its final status + summary + result handle. Use when you dispatched work earlier and now genuinely need it before continuing. Reference-only — never the inlined payload.",
      inputSchema: z.object({
        taskId: z.string(),
        timeoutMs: z.number().int().positive().max(600000).optional().describe("give up waiting after this many ms (default 120000)"),
      }),
      execute: async ({ taskId, timeoutMs }) => {
        if (!ctx.awaitTask) {
          // No scheduler wired: fall back to reading the record (already-settled tasks still resolve).
          const t = readTaskState(ctx.ws, taskId);
          if (!t) return { error: `no task "${taskId}"` };
          return { taskId, status: t.status, summary: t.summary ?? null, resultRef: t.resultRef ?? null };
        }
        return { taskId, ...(await ctx.awaitTask(taskId, timeoutMs)) };
      },
    });

  if (agent.tools.includes("find_agents"))
    set.find_agents = tool({
      description: "Search the squad for agents whose role matches a capability. Returns top matches.",
      inputSchema: z.object({ query: z.string(), k: z.number().int().positive().max(20).default(8) }),
      execute: async ({ query, k }) => ({ matches: ctx.findAgents(query, k) }),
    });

  if (agent.tools.includes("read_url"))
    set.read_url = tool({
      description: "Fetch a web page (e.g. an MCP server's setup docs) and return it as clean markdown. Requires FIRECRAWL_API_KEY in the environment.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        const r = await scrapeUrl(url);
        return "markdown" in r ? { markdown: r.markdown } : { error: r.error };
      },
    });

  if (mcp && agent.tools.includes("add_mcp_server"))
    set.add_mcp_server = tool({
      description: "Connect a NEW MCP server for the captain to approve. Provide a `url` for a remote/hosted server (with auth:'oauth' or headers), or a `command`/`args` for a local stdio server. Put secrets as ${ENV_VAR} refs (ask_human for the var name first). Returns the connection status + tool count; on error, fix the config and call again.",
      inputSchema: z.object({
        name: z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase id: letters, digits, hyphens"),
        url: z.string().url().optional(),
        auth: z.literal("oauth").optional(),
        headers: z.record(z.string(), z.string()).optional(),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
      execute: async ({ name, url, auth, headers, command, args, env }) => {
        const raw = url
          ? { url, ...(auth ? { auth } : {}), ...(headers ? { headers } : {}) }
          : command
            ? { command, ...(args ? { args } : {}), ...(env ? { env } : {}) }
            : null;
        if (!raw) return { error: "provide a `url` (remote server) or a `command` (local stdio server)" };
        const parsed = McpServerConfig.safeParse(raw);
        if (!parsed.success) return { error: `invalid server config: ${parsed.error.issues[0]?.message ?? "unknown"}` };
        const spec = parsed.data;
        const decision = await ctx.requestApproval({ kind: "add_mcp", name, spec });
        if (decision.type !== "approve") return { rejected: true };
        addMcpServer(ctx.ws, name, spec);
        const status = await mcp.addServer(name, spec);
        return { name, status: status.status, toolCount: status.toolCount, error: status.error };
      },
    });

  if (agent.tools.includes("ask_human"))
    set.ask_human = tool({
      description: "Ask the human captain a clarifying question with 2-4 options when intent is ambiguous. The captain picks an option or types their own answer; you receive { answer } and continue.",
      inputSchema: z.object({
        question: z.string().describe("a single clear question"),
        options: z.array(z.string()).min(2).max(4).describe("2-4 concrete choices"),
      }),
      execute: async ({ question, options }) => {
        const d = await ctx.requestApproval({ kind: "ask_human", question, options });
        return d.type === "answered" ? { answer: d.answer } : { cancelled: true };
      },
    });

  if (agent.tools.includes("remember"))
    set.remember = tool({
      description: "Save a durable fact / decision / entity to the squad's shared knowledgebase, optionally linking it to existing nodes with typed edges (rel e.g. relates_to, depends_on, contradicts). Returns the node id — recall first to get ids to link to.",
      inputSchema: z.object({
        title: z.string(),
        content: z.string(),
        kind: z.string().default("fact"),
        summary: z.string().optional(),
        edges: z.array(z.object({ to: z.string(), rel: z.string().default("relates_to") })).default([]),
      }),
      execute: async ({ title, content, kind, summary, edges }) => {
        const requested = edges ?? [];
        const valid = requested.filter((e) => nodeExists(ctx.db, e.to)); // drop dangling edge targets
        const node = KbNode.parse({
          id: mkKbId(), title, content, kind, summary, scope: "deck",
          source: ctx.ingestSource ?? `${ctx.agentId}:${ctx.runId}`, edges: valid, created: new Date().toISOString(),
        });
        writeNode(ctx.ws, ctx.db, node);
        if (ctx.embed) {
          try { putVector(ctx.db, node.id, "kb", await ctx.embed(`${node.title}\n${node.summary ?? ""}\n${node.content}`)); }
          catch { /* semantic index is best-effort; keyword+graph still works */ }
        }
        ctx.notes.push(`remembered ${node.id}`);
        return { id: node.id, edgesAdded: valid.length, edgesDropped: requested.length - valid.length };
      },
    });

  if (agent.tools.includes("recall"))
    set.recall = tool({
      description: "Search the squad's shared knowledgebase and its typed-edge graph. Returns matching nodes plus their linked neighbors — by meaning (semantic when available) and by relationship.",
      inputSchema: z.object({
        query: z.string(),
        k: z.number().int().positive().max(20).default(6),
        hops: z.number().int().min(0).max(2).default(1),
        rels: z.array(z.string()).optional(),
      }),
      execute: async ({ query, k, hops, rels }) => {
        const r = await searchKnowledge({ db: ctx.db, query, embed: ctx.embed, k, hops, rels });
        return { mode: r.mode, hits: r.hits.map((h) => ({ id: h.id, title: h.title, summary: h.summary, via: h.via, score: +h.score.toFixed(3) })) };
      },
    });

  if (agent.tools.includes("read_source"))
    set.read_source = tool({
      description: "Read an admin-authored source document from kb/sources/ so you can extract entities from it. `path` is like \"sources/architecture.md\" or \"architecture.md\".",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const name = path.replace(/^sources\//, "");
        const dir = paths.kbSourceDir(ctx.ws);
        const full = resolve(dir, name);
        if (full !== dir && !full.startsWith(dir + sep)) return { error: "path must be a file under kb/sources/" };
        try { return { content: await readFile(full, "utf8") }; }
        catch { return { error: `no such source: ${name}` }; }
      },
    });

  if (agent.tools.includes("forget"))
    set.forget = tool({
      description: "Prune the knowledgebase: cascade-delete nodes matching a filter, plus their edges and vectors. Filter by `kind` (e.g. decision), `sourcePrefix` (e.g. \"worker-x:\" for one assistant's memory, or \"sources/foo.md@\" for a doc), and/or explicit `ids`. At least one clause is required.",
      inputSchema: z.object({
        ids: z.array(z.string()).optional(),
        kind: z.string().optional(),
        sourcePrefix: z.string().optional(),
      }),
      execute: async ({ ids, kind, sourcePrefix }) => {
        if (!ids?.length && !kind && !sourcePrefix) return { error: "provide at least one of ids, kind, or sourcePrefix" };
        const r = forgetNodes(ctx.ws, ctx.db, { ids, kind, sourcePrefix });
        ctx.notes.push(`forgot ${r.removedNodes} node(s)`);
        return r;
      },
    });

  if (agent.tools.includes("reindex_knowledge"))
    set.reindex_knowledge = tool({
      description: "Rebuild the knowledge graph index from the canonical node files and refresh semantic vectors. Use after bulk hand-edits.",
      inputSchema: z.object({}),
      execute: async () => {
        reindexKnowledge(ctx.ws, ctx.db);
        const embedded = ctx.embed ? await reembedAll(ctx.db, ctx.embed) : 0;
        return { reindexed: true, embedded };
      },
    });

  if (agent.tools.includes("propose_skill"))
    set.propose_skill = tool({
      description: "Propose a reusable skill (a reviewed step-by-step procedure for a repeatable operation) for the captain to approve. On approval it's saved and every agent can use it via use_skill.",
      inputSchema: z.object({
        name: z.string(),
        description: z.string().describe("when to use this skill"),
        body: z.string().describe("the step-by-step procedure"),
        tags: z.array(z.string()).default([]),
      }),
      execute: async ({ name, description, body, tags }) => {
        const draft = { name, description, body, tags: tags ?? [] };
        const d = await ctx.requestApproval({ kind: "propose_skill", draft });
        if (d.type !== "approve") return { rejected: true };
        const skill = Skill.parse({ id: mkSkillId(), name, description, body, tags: draft.tags, status: "active", created: new Date().toISOString() });
        writeSkill(ctx.ws, ctx.db, skill);
        ctx.notes.push(`proposed skill ${skill.id}`);
        return { id: skill.id };
      },
    });

  if (agent.tools.includes("run_command"))
    set.run_command = tool({
      description: "Run a shell command in the workspace. Commands the safety guard clears run automatically; anything it flags is sent to the captain for approval first. Returns { exitCode, stdout, stderr }.",
      inputSchema: z.object({ command: z.string(), cwd: z.string().optional() }),
      execute: async ({ command, cwd }) => {
        const classify = ctx.classifyCommand ?? classifyCommand;
        const run = ctx.runShell ?? runShell;
        const v = classify(command);
        if (v.decision !== "allow") {
          const d = await ctx.requestApproval({ kind: "run_command", command, reason: v.reason });
          if (d.type !== "approve") return { rejected: true };
        }
        return run(command, cwd ?? ctx.ws);
      },
    });

  // Skills are a universal agent capability (like the MCP-tools grant): every agent can discover and
  // load reviewed procedures. Not gated by agent.tools; built-ins still win over MCP tools below.
  set.find_skills = tool({
    description: "Search the deck's reusable skills (reviewed procedures for repeatable operations) by what you're trying to do. Returns matching skill names + when to use them; call use_skill to load the full procedure.",
    inputSchema: z.object({ query: z.string(), k: z.number().int().positive().max(20).default(6) }),
    execute: async ({ query, k }) => ({ matches: rankSkills(getActiveSkills(ctx.db), query, k).map((h) => ({ id: h.id, name: h.name, description: h.description })) }),
  });

  set.use_skill = tool({
    description: "Load the full step-by-step procedure for a skill by name, then follow it. Use this for repeatable operations so you do them the reviewed way with fewer mistakes.",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const rows = getActiveSkills(ctx.db);
      const s = rows.find((r) => r.name === name) ?? rows.find((r) => r.id === name);
      return s ? { name: s.name, body: s.body } : { error: `no skill "${name}" — call find_skills to discover available skills` };
    },
  });

  // Every agent gets every connected MCP server's tools (global defaults like Firecrawl + any
  // deck-added server) — no per-agent opt-in for now; gatekeeping can come later. Built-ins already
  // in `set` win (first-wins), so an MCP tool can't shadow a privileged built-in (e.g. a server
  // "create" with a tool "agent" namespacing to create_agent).
  if (mcp)
    for (const [k, v] of Object.entries(mcp.allTools()))
      if (!(k in set)) set[k] = v;

  return set;
}
