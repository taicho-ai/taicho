/** Shared scenario types for Layer-4 evidence runs (Plan 11).
 *
 *  A scenario = a VHS tape (drives the compiled binary through a real user flow) + a set of
 *  workspace-file assertions (decide pass/fail; the video is evidence, never the assertion).
 *  `scripts/e2e-evidence.ts` consumes these; per-scenario specs (e.g. `agent-flow.ts`) implement them.
 */

export interface AssertionResult {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
}

export interface Scenario {
  name: string;
  e2eModelMode: string;
  /** The video filename this scenario's tape writes with `Output`. RELATIVE (VHS 0.11.0 can't lex a
   *  leading `/` — see CLI_TESTING.md's VHS-path gotcha). The wrapper copies it out of the temp ws
   *  into evidence/<scenario>/ and records it as the manifest `video`. */
  video: string;
  /** The screenshot filenames this scenario's tape writes with `Screenshot` (also RELATIVE). The
   *  wrapper copies each out and records them as the manifest `screenshots`. Declaring artifacts
   *  here (rather than hardcoding names in the wrapper) keeps the wrapper scenario-generic. */
  screenshots: string[];
  /** Full .tape source. `binary` is the absolute path to dist/taicho (fine inside a Type string).
   *  Output/Screenshot paths are RELATIVE — see CLI_TESTING.md's VHS-path gotcha. */
  tape: (p: { binary: string; evidenceDir: string }) => string;
  assertions: (ws: string) => Promise<AssertionResult[]>;
}
