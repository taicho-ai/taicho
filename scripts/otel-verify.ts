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
    OTEL_SERVICE_NAME: "taicho-verify",
    OTEL_BSP_SCHEDULE_DELAY: "200",
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

rmSync(ws, { recursive: true, force: true });

if (failures.length) {
  console.log(`\notel-verify: FAILED — ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("\notel-verify: PASS — a shipped binary exports plan + team activity to a real OTLP backend");
