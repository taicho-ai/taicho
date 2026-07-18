import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpManager } from "./manager";

// Many hosted MCP servers carry their key in the URL query string (?key=${VAR}), not a header.
// interpolateEnv must expand ${VAR} in the server URL — not only in env/headers — or the literal
// placeholder is sent and the server rejects it.
test("interpolates ${VAR} in the server URL, not just env/headers", async () => {
  process.env.TAICHO_TEST_MCP_KEY = "supersecret123";
  let capturedUrl = "";
  const server = Bun.serve({ port: 0, fetch: (req) => { capturedUrl = req.url; return new Response("not an mcp server", { status: 500 }); } });
  try {
    const ws = mkdtempSync(join(tmpdir(), "taicho-mcp-"));
    const url = "http://127.0.0.1:" + server.port + "/mcp?key=${TAICHO_TEST_MCP_KEY}"; // double-quoted: ${...} is literal
    await createMcpManager({ ws, servers: { tp: { url } } });
    expect(capturedUrl).toContain("supersecret123");          // the resolved env value reached the server
    expect(capturedUrl).not.toContain("TAICHO_TEST_MCP_KEY");  // the ${...} placeholder was expanded, not sent literally
  } finally {
    server.stop(true);
    delete process.env.TAICHO_TEST_MCP_KEY;
  }
});
