import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspace } from "@taicho-ai/framework/store/files";
import { saveArtifact } from "@taicho-ai/framework/store/artifacts";
import { artifactHandle } from "@taicho-ai/contracts/artifact";
import { readerBodyLines } from "./ArtifactBrowser";

async function ws(): Promise<string> {
  const w = mkdtempSync(join(tmpdir(), "taicho-reader-"));
  await ensureWorkspace(w);
  return w;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("the reader renders a markdown TABLE as a table, not raw pipes (whole-doc, not line-by-line)", async () => {
  const w = await ws();
  const body = "# Report\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |";
  const art = saveArtifact(w, { id: "report", title: "Report", type: "document", producer: "worker", runId: "root/r1", body });

  const out = strip(readerBodyLines(w, artifactHandle(art), 80).join("\n"));

  // Rendered as a real table: box-drawing borders appear and every cell survives…
  expect(out).toContain("┌");
  expect(out).toContain("│");
  expect(out).toContain("Alpha");
  expect(out).toContain("Beta");
  // …and the raw markdown separator row is GONE (it would remain if we rendered line-by-line).
  expect(out).not.toContain("| --- |");
  expect(out).not.toContain("| Name | Value |");
});

test("the reader strips markdown markers (headings, bold) instead of showing them raw", async () => {
  const w = await ws();
  const body = "# Heading\n\nSome **bold** text.";
  const art = saveArtifact(w, { id: "doc", title: "Doc", type: "document", producer: "worker", runId: "root/r1", body });

  const out = strip(readerBodyLines(w, artifactHandle(art), 80).join("\n"));

  expect(out).toContain("Heading");
  expect(out).toContain("bold");
  expect(out).not.toContain("# Heading"); // marker stripped
  expect(out).not.toContain("**bold**"); // marker stripped
});

test("a code fence survives as one block (line-by-line would break the fence)", async () => {
  const w = await ws();
  const body = "Intro\n\n```\nconst x = 1;\nconst y = 2;\n```\n\nOutro";
  const art = saveArtifact(w, { id: "code", title: "Code", type: "document", producer: "worker", runId: "root/r1", body });

  const out = strip(readerBodyLines(w, artifactHandle(art), 80).join("\n"));

  expect(out).toContain("const x = 1;");
  expect(out).toContain("const y = 2;");
  expect(out).not.toContain("```"); // the fence markers are consumed, not shown raw
});
