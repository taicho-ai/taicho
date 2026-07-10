#!/usr/bin/env bun
/** Layer-4 observability proof: stand up a REAL OTLP/HTTP endpoint, drive the REAL compiled binary
 *  through a plan + team delegation, and assert the spans that arrive over the wire.
 *
 *  This is deliberately not the in-memory exporter seam (core/otel.test.ts covers that). It answers a
 *  different question: does a shipped taicho, booted from `dist/taicho` with nothing but the standard
 *  OTEL_* env vars, actually export what we think it exports? Everything between initTelemetry and the
 *  network — the BatchSpanProcessor, the exit-path flush, the OTLP JSON encoding — is only exercised here.
 *
 *  Run:  bun scripts/otel-verify.ts
 *  Exits non-zero on the first failed assertion, and prints the span tree it received either way. */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 4318;

interface Span {
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId: string;
  attributes: Record<string, unknown>;
}

const attrValue = (v: Record<string, unknown>): unknown =>
  v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : undefined) ?? v.doubleValue ?? v.boolValue;

function flattenSpans(body: Record<string, unknown>): Span[] {
  const out: Span[] = [];
  for (const rs of (body.resourceSpans ?? []) as Record<string, unknown>[]) {
    for (const ss of (rs.scopeSpans ?? []) as Record<string, unknown>[]) {
      for (const s of (ss.spans ?? []) as Record<string, unknown>[]) {
        const attributes: Record<string, unknown> = {};
        for (const a of (s.attributes ?? []) as { key: string; value: Record<string, unknown> }[])
          attributes[a.key] = attrValue(a.value);
        out.push({
          name: String(s.name), spanId: String(s.spanId), traceId: String(s.traceId),
          parentSpanId: s.parentSpanId ? String(s.parentSpanId) : undefined,
          attributes,
        });
      }
    }
  }
  return out;
}

const spans: Span[] = [];
let metricPosts = 0;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/traces") {
      spans.push(...flattenSpans(await req.json()));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/v1/metrics") {
      metricPosts += 1;
      await req.text();
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  },
});

// A fresh workspace — never the repo root, which `bun run dev` makes the LIVE squad.
const ws = mkdtempSync(join(tmpdir(), "taicho-otel-verify-"));
mkdirSync(join(ws, "teams", "news"), { recursive: true });
mkdirSync(join(ws, "agents", "reporter"), { recursive: true });
writeFileSync(join(ws, "taicho.yaml"), "mcp:\n  enabled: false\nauth:\n  chatgpt_signin: false\n");
writeFileSync(
  join(ws, "teams", "news", "team.md"),
  `---\nid: news\ncharter: covers breaking stories and files copy on deadline\ntools:\n  grant: []\n  deny: []\ncreated: 2026-07-10T00:00:00.000Z\n---\nAccurate before fast.\n`,
);
writeFileSync(
  join(ws, "agents", "reporter", "agent.md"),
  `---\nid: reporter\nrole: files stories on deadline\ntools:\n  - save_artifact\n  - read_artifact\nteam: news\ncanSee:\n  - team:news\ncanDelegateTo: []\nisRoot: false\ncreated: 2026-07-10T00:00:00.000Z\n---\nYou file stories.\n`,
);

const binary = join(import.meta.dir, "..", "dist", "taicho");
console.log(`otel-verify: OTLP receiver on :${PORT}`);
console.log(`otel-verify: workspace ${ws}`);
console.log(`otel-verify: running ${binary} run "…" (TAICHO_E2E_MODEL=plan-teams)\n`);

const proc = Bun.spawn([binary, "run", "ship the notifier"], {
  cwd: ws,
  env: {
    ...process.env,
    TAICHO_E2E_MODEL: "plan-teams",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${PORT}`,
    OTEL_BSP_SCHEDULE_DELAY: "200",
    // Deliberately NOT setting OTEL_TAICHO_CAPTURE_CONTENT: content capture is opt-OUT now, and the
    // assertions below prove the conversation shows up without anyone asking for it.
  },
  stdout: "pipe",
  stderr: "pipe",
});
const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
console.log("--- taicho stdout ---\n" + out.trim());
if (err.trim()) console.log("--- taicho stderr ---\n" + err.trim());

// The binary awaits telemetry.shutdown() on every exit path, so the BatchSpanProcessor has flushed by
// the time the process exits. Give the receiver a beat to finish handling the last POST.
await Bun.sleep(500);
server.stop(true);

// ---- assertions -----------------------------------------------------------------------------------

const failures: string[] = [];
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failures.push(label); }
};

console.log(`\n--- ${spans.length} span(s) received over the wire, ${metricPosts} metric POST(s) ---`);
const byId = new Map(spans.map((s) => [s.spanId, s]));
for (const s of spans) {
  const depth = (function d(x: Span, n = 0): number { const p = x.parentSpanId && byId.get(x.parentSpanId); return p ? d(p, n + 1) : n; })(s);
  console.log(`${"  ".repeat(depth)}• ${s.name}`);
}

console.log("\n--- assertions ---");
check("the run exited 0", code === 0, `exit ${code}`);
check("spans arrived at a real OTLP endpoint", spans.length > 0);

const rootRun = spans.find((s) => s.name === "root · user turn");
check("root's run span was exported", !!rootRun);

const childRun = spans.find((s) => s.name.startsWith("reporter ·"));
check("the TEAM was routed to `reporter`, and its child run span exported", !!childRun);

if (rootRun && childRun)
  check("the delegation is ONE distributed trace (child shares root's traceId)", childRun.traceId === rootRun.traceId,
    `${childRun.traceId} vs ${rootRun.traceId}`);

if (rootRun) {
  check("taicho.plan.handle is on the run span", rootRun.attributes["taicho.plan.handle"] === "p_ship-the-notifier@v1",
    String(rootRun.attributes["taicho.plan.handle"]));
  check("taicho.plan.items.total = 2", rootRun.attributes["taicho.plan.items.total"] === 2, String(rootRun.attributes["taicho.plan.items.total"]));
  check("taicho.plan.items.done = 2 (one ticked by the model, one by the ENGINE)",
    rootRun.attributes["taicho.plan.items.done"] === 2, String(rootRun.attributes["taicho.plan.items.done"]));
  check("taicho.plan.items.open = 0", rootRun.attributes["taicho.plan.items.open"] === 0, String(rootRun.attributes["taicho.plan.items.open"]));
  check("taicho.run.outcome = completed", rootRun.attributes["taicho.run.outcome"] === "completed", String(rootRun.attributes["taicho.run.outcome"]));
}

check("gen_ai model-call spans nest under the runs", spans.some((s) => s.name.startsWith("ai.streamText") || s.name.startsWith("chat ")));
check("the delegate_task tool span was exported", spans.some((s) => s.name.startsWith("delegate_task")));
check("the write_plan tool span was exported", spans.some((s) => s.name.startsWith("write_plan")));
check("metrics were exported too", metricPosts > 0);

// A trace you cannot read the conversation out of is a trace that answers no question anyone asks. This
// was missed once: the harness passed on a run whose spans carried structure and no content at all.
if (rootRun) {
  check("the run span records WHAT THE USER SAID", String(rootRun.attributes["gen_ai.prompt"] ?? "").includes("ship the notifier"),
    String(rootRun.attributes["gen_ai.prompt"]).slice(0, 60));
  check("the run span records WHAT THE AGENT ANSWERED", String(rootRun.attributes["gen_ai.completion"] ?? "").includes("Plan complete"),
    String(rootRun.attributes["gen_ai.completion"]).slice(0, 60));
}
if (childRun)
  check("the delegated child records its own brief and reply",
    String(childRun.attributes["gen_ai.prompt"] ?? "").length > 0 && String(childRun.attributes["gen_ai.completion"] ?? "").includes("Filed the announcement"));

const firstChat = spans.find((s) => s.name.includes("iter 1") && s.name.startsWith("chat "));
if (firstChat) {
  check("the model-call span carries the chat messages as a role/content list",
    firstChat.attributes["gen_ai.prompt.0.role"] === "system" && firstChat.attributes["gen_ai.prompt.1.role"] === "user");
  check("iteration 1 carries NO plan slot (no plan yet ⇒ zero overhead)",
    !Object.values(firstChat.attributes).some((v) => String(v).includes("CURRENT PLAN")));
}

const lastChat = [...spans].filter((s) => s.name.startsWith("chat ") && s.name.includes("iter 4")).pop();
if (lastChat) {
  const msgs = Object.entries(lastChat.attributes).filter(([k]) => /^gen_ai\.prompt\.\d+\.content$/.test(k));
  const planSlots = msgs.filter(([, v]) => String(v).includes("CURRENT PLAN"));
  check("the plan slot is injected exactly ONCE per call (flat context, never cumulative)", planSlots.length === 1,
    `${planSlots.length} slots`);
  const lastIdx = Math.max(...msgs.map(([k]) => Number(k.split(".")[2])));
  check("the plan slot is the LAST message the model reads before it acts",
    String(lastChat.attributes[`gen_ai.prompt.${lastIdx}.content`]).includes("CURRENT PLAN"));
  check("the plan slot marks the delegated item (engine-owned) and already ticked",
    planSlots.some(([, v]) => String(v).includes("(engine-owned)") && String(v).includes("2/2 done")));
}

rmSync(ws, { recursive: true, force: true });

if (failures.length) {
  console.log(`\notel-verify: FAILED — ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("\notel-verify: PASS — a shipped binary exports plan + team activity to a real OTLP backend");
