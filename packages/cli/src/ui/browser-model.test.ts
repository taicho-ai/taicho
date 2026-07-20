import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspace } from "@taicho-ai/framework/store/files";
import { saveArtifact, listArtifacts } from "@taicho-ai/framework/store/artifacts";
import { annotateArtifact } from "@taicho-ai/framework/store/annotations";
import { writeTrace } from "@taicho-ai/framework/store/trace";
import { RunTrace } from "@taicho-ai/contracts/trace";
import { artifactHandle } from "@taicho-ai/contracts/artifact";
import {
  resolveScope, latestRunFallback, applyFilters, shelfRows, countLine, artifactRows, badgesFor,
} from "./browser-model";

async function ws(): Promise<string> {
  const w = mkdtempSync(join(tmpdir(), "taicho-browser-"));
  await ensureWorkspace(w);
  return w;
}

const NOW = Date.parse("2026-07-13T12:00:00.000Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

function seed(w: string, over: { id: string; producer?: string; runId?: string; type?: string; title?: string; summary?: string }) {
  return saveArtifact(w, {
    id: over.id, title: over.title ?? over.id, type: over.type ?? "document",
    producer: over.producer ?? "worker", runId: over.runId ?? "root/2026-07-13-run1",
    body: `# ${over.id}\ncontent`, summary: over.summary,
  });
}

function trace(w: string, runId: string, artifacts: string[], delegatedOut: string[] = []) {
  writeTrace(w, RunTrace.parse({
    id: runId, agent: runId.split("/")[0], task: "t", triggeredBy: "user",
    ledger: { retrieved: [], applied: [], skipped: [] },
    toolCalls: [], artifacts, delegatedOut, outcome: "completed",
    tokens: 1, durationMs: 1, started: at(5),
  }));
}

function ledgerTurn(w: string, agent: string, runId: string, timestamp: string) {
  mkdirSync(join(w, "conversations", agent), { recursive: true });
  appendFileSync(join(w, "conversations", agent, "ledger.jsonl"),
    JSON.stringify({ turnId: `t_${runId}`, runId, timestamp, agent, role: "user", content: "x", status: "completed" }) + "\n");
}

test("resolveScope run: walks the delegation subtree only", async () => {
  const w = await ws();
  const a = seed(w, { id: "in-tree", runId: "root/r1" });
  const b = seed(w, { id: "child-out", runId: "worker/r2" });
  seed(w, { id: "elsewhere", runId: "root/r9" });
  trace(w, "worker/r2", [artifactHandle(b)]);
  trace(w, "root/r1", [artifactHandle(a)], ["worker/r2"]);
  const got = resolveScope(w, "run", { rootRunId: "root/r1" }).map((x) => x.id).sort();
  expect(got).toEqual(["child-out", "in-tree"]);
  expect(resolveScope(w, "run", {})).toEqual([]); // no rootRunId ⇒ empty, never a lie
});

test("resolveScope conversation: unions EVERY agent's ledger (an @agent turn audits to that agent)", async () => {
  const w = await ws();
  const a = seed(w, { id: "root-turn-art", runId: "root/r1" });
  const b = seed(w, { id: "at-agent-art", runId: "scout/r2" });
  seed(w, { id: "background-art", runId: "worker/r7" }); // no ledger turn — a task_* run
  trace(w, "root/r1", [artifactHandle(a)]);
  trace(w, "scout/r2", [artifactHandle(b)]);
  ledgerTurn(w, "root", "root/r1", at(30));
  ledgerTurn(w, "scout", "scout/r2", at(10));
  const got = resolveScope(w, "conversation").map((x) => x.id).sort();
  expect(got).toEqual(["at-agent-art", "root-turn-art"]); // background-art is scope-3-only
});

test("resolveScope all: the whole store, latest version per id (manifest construction)", async () => {
  const w = await ws();
  seed(w, { id: "doc" });
  seed(w, { id: "doc" }); // v2
  seed(w, { id: "other" });
  const got = resolveScope(w, "all");
  expect(got.length).toBe(2);
  expect(got.find((a) => a.id === "doc")!.version).toBe(2);
});

test("latestRunFallback: newest ledger turn across agents; undefined on a fresh workspace", async () => {
  const w = await ws();
  expect(latestRunFallback(w)).toBeUndefined();
  ledgerTurn(w, "root", "root/r1", at(60));
  ledgerTurn(w, "scout", "scout/r2", at(5)); // newer
  expect(latestRunFallback(w)).toBe("scout/r2");
});

test("applyFilters: producer, type, q, since — each narrows", async () => {
  const w = await ws();
  seed(w, { id: "alpha", producer: "researcher", type: "dossier", title: "Fusion timeline" });
  seed(w, { id: "beta", producer: "writer", type: "brief", summary: "market brief" });
  const all = listArtifacts(w);
  expect(applyFilters(w, all, { producer: "writer" }, NOW).map((a) => a.id)).toEqual(["beta"]);
  expect(applyFilters(w, all, { type: "dossier" }, NOW).map((a) => a.id)).toEqual(["alpha"]);
  expect(applyFilters(w, all, { q: "fusion" }, NOW).map((a) => a.id)).toEqual(["alpha"]);
  expect(applyFilters(w, all, { q: "market" }, NOW).map((a) => a.id)).toEqual(["beta"]);
  // both just created ⇒ inside every window; a "since" window includes them, "all" is a no-op
  expect(applyFilters(w, all, { since: "24h" }).length).toBe(2);
  expect(applyFilters(w, all, { since: "all" }).length).toBe(2);
});

test("applyFilters + badges: feedback:open and verdict:pass/fail read the annotations ledger", async () => {
  const w = await ws();
  const open = seed(w, { id: "needs-work" });
  const passed = seed(w, { id: "checked-ok" });
  seed(w, { id: "plain" });
  annotateArtifact(w, { target: artifactHandle(open), author: "checker", body: "needs a cost table", verdict: { pass: false, reasons: ["missing table"] } });
  annotateArtifact(w, { target: artifactHandle(passed), author: "checker", body: "ok", verdict: { pass: true, reasons: [] } });
  const all = listArtifacts(w);
  expect(applyFilters(w, all, { feedback: "open" }).map((a) => a.id)).toEqual(["needs-work"]);
  expect(applyFilters(w, all, { verdict: "fail" }).map((a) => a.id)).toEqual(["needs-work"]);
  expect(applyFilters(w, all, { verdict: "pass" }).map((a) => a.id)).toEqual(["checked-ok"]);
  const b = badgesFor(w, open);
  expect(b.openFeedback).toBe(1);
  expect(b.verdict).toBe("fail");
  expect(b.approved).toBe(false);
});

test("badgesFor: an approval-kind annotation marks approved and never inflates the ⚑ count", async () => {
  const w = await ws();
  const a = seed(w, { id: "signed-off" });
  annotateArtifact(w, { target: artifactHandle(a), author: "human", body: "approved by captain", kind: "approval" });
  const b = badgesFor(w, a);
  expect(b.approved).toBe(true);
  expect(b.openFeedback).toBe(0);   // an approval is state, not actionable feedback
});

test("shelfRows all+run: groups by producing run, groups newest-first, headers not selectable", async () => {
  const w = await ws();
  seed(w, { id: "old-a", runId: "root/r1" });
  seed(w, { id: "old-b", runId: "root/r1" });
  seed(w, { id: "new-a", runId: "root/r2" });
  const rows = shelfRows(w, listArtifacts(w), "all", "run", NOW);
  expect(rows[0]!.kind).toBe("header");
  const headers = rows.filter((r) => r.kind === "header");
  expect(headers.length).toBe(2);
  expect(artifactRows(rows).length).toBe(3);
  // header labels carry the short run id + count
  expect((headers[0] as { label: string }).label).toContain("artifact");
});

test("shelfRows flat sorts: time desc; producer asc — no headers", async () => {
  const w = await ws();
  seed(w, { id: "one", producer: "zeta", runId: "root/r1" });
  seed(w, { id: "two", producer: "alpha", runId: "root/r2" });
  const time = shelfRows(w, listArtifacts(w), "all", "time", NOW);
  expect(time.every((r) => r.kind === "artifact")).toBe(true);
  const prod = shelfRows(w, listArtifacts(w), "all", "producer", NOW);
  expect(artifactRows(prod)[0]!.artifact.producer).toBe("alpha");
  // narrower scopes never group
  const run = shelfRows(w, listArtifacts(w), "run", "run", NOW);
  expect(run.every((r) => r.kind === "artifact")).toBe(true);
});

test("countLine: honest about a filtered window", () => {
  expect(countLine(3, 3)).toBe("3 artifacts");
  expect(countLine(1, 1)).toBe("1 artifact");
  expect(countLine(4, 31)).toBe("4 of 31 match");
});
