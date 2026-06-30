import { defineConfig } from "@microsoft/tui-test";

// Real-binary E2E: tui-test spawns the compiled dist/taicho in a real (xterm) pty and asserts on the
// actual rendered terminal. Kept separate from the bun suite — tui-test runs only e2e/*.tui.ts here;
// `bun test` owns the src test files. Run with `bun run test:e2e` (builds the binary first).
export default defineConfig({
  testMatch: "e2e/**/*.tui.ts",
  retries: 1,
});
