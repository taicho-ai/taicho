/** Plan 23: hand the terminal to the captain's OWN editor to edit a file, then return control to Ink.
 *
 *  The old approach (spawn detached, stdio:"ignore") could never work for a TERMINAL editor — Ink owns
 *  the tty (raw mode + full-screen render loop), so nano/vim never got it, and with no $EDITOR set it
 *  just dead-ended on "no $EDITOR". Ink 7.1.0's `suspendTerminal()` fixes this properly: it releases the
 *  terminal to a child process, then restores Ink's state and repaints. We wait for the editor to EXIT
 *  before resuming, so the browser (which re-reads files on render) shows the saved changes on return.
 *
 *  Editor precedence: $EDITOR → $VISUAL → nano → vi. In a non-interactive context (tests, pipes) there
 *  is no tty to hand off, so we skip the spawn and report the path — a test never launches a real editor. */
import { spawn } from "node:child_process";

/** The callback form of Ink 7.1.0's `useApp().suspendTerminal` — restores the terminal even on throw. */
export type SuspendTerminal = (callback: () => void | Promise<void>) => Promise<void>;

/** Runs the chosen editor over the file and resolves when it EXITS (rejects on spawn error, e.g. ENOENT).
 *  Injectable so tests never launch a real process — the real one inherits the tty (stdio:"inherit"). */
export type RunEditor = (cmd: string, args: string[]) => Promise<void>;

const spawnEditor: RunEditor = (cmd, args) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", () => resolve());
  });

export interface EditResult { ok: boolean; note: string }

/** The editor to hand off to: $EDITOR → $VISUAL → nano (the near-universal terminal default). May carry
 *  flags (e.g. "code --wait"); the caller splits it. */
export function pickEditor(): string {
  return process.env.EDITOR || process.env.VISUAL || "nano";
}

export async function editFileInTerminal(suspendTerminal: SuspendTerminal, path: string, run: RunEditor = spawnEditor): Promise<EditResult> {
  const editor = pickEditor();
  const name = path.split("/").pop() ?? path;
  // No interactive terminal to hand off (tests, headless, a pipe) → don't launch anything.
  if (!process.stdin.isTTY) return { ok: false, note: `not an interactive terminal — open it yourself: ${path}` };
  try {
    await suspendTerminal(() => {
      // $EDITOR may carry flags ("code --wait", "code -w"); split so the command + its args are honored.
      const [cmd, ...args] = editor.split(/\s+/).filter(Boolean);
      return run(cmd!, [...args, path]);
    });
    return { ok: true, note: `✓ ${name} saved — reloaded` };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return { ok: false, note: `⚠ couldn't open "${editor}"${code ? ` (${code})` : ""} — set $EDITOR, or open: ${path}` };
  }
}
