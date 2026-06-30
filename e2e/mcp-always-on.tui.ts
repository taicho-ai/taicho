/** Verifies the "always running" MCP wiring on the REAL binary: booted in this workspace (whose
 *  taicho.yaml has an `mcp.servers` entry), taicho spawns the server at startup. server-everything
 *  prints "Starting default (STDIO) server..." to stderr when launched, which proves the binary
 *  auto-started it at boot, before the REPL rendered. */
import { test, expect } from "@microsoft/tui-test";
import { join } from "node:path";

const bin = join(process.cwd(), "dist", "taicho");
test.use({ program: { file: bin }, columns: 100, rows: 30 });

test("the always-on MCP server is launched at boot", async ({ terminal }) => {
  await expect(terminal.getByText("Starting default (STDIO) server")).toBeVisible(); // server spawned
  await expect(terminal.getByText("taicho —")).toBeVisible();                          // REPL then rendered
});
