/** Black-box E2E against the REAL compiled binary (dist/taicho), driven in a real xterm pty by
 *  @microsoft/tui-test. Complements the in-process ink-testing-library suite (src/ui/App.test.tsx):
 *  this proves the actual binary boots, renders under a raw-mode TTY, and responds to keystrokes —
 *  the layer ink-testing-library can't reach. */
import { test, expect } from "@microsoft/tui-test";
import { join } from "node:path";

const bin = join(process.cwd(), "dist", "taicho");
test.use({ program: { file: bin }, columns: 100, rows: 30 });

// The banner line starts "taicho — …" (em dash) in every credential state; the subscription notice
// uses "taicho:" (colon), so "taicho —" uniquely identifies the rendered app banner.
const READY = "taicho —";

test("boots and renders the app banner in a real terminal", async ({ terminal }) => {
  await expect(terminal.getByText(READY)).toBeVisible();
});

test("typing / opens the slash suggester", async ({ terminal }) => {
  await expect(terminal.getByText(READY)).toBeVisible();   // wait until the REPL is up
  terminal.write("/");
  await expect(terminal.getByText("/help")).toBeVisible();
});

test("/help runs and lists the command grammar", async ({ terminal }) => {
  await expect(terminal.getByText(READY)).toBeVisible();   // wait until the REPL is up
  terminal.submit("/help");                                 // types /help + Enter
  await expect(terminal.getByText("/agents")).toBeVisible();
});
