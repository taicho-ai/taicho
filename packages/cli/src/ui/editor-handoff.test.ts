import { test, expect, afterEach } from "bun:test";
import { editFileInTerminal, pickEditor } from "./editor-handoff";

// Snapshot + restore the env/tty flags each test touches.
const saved = { EDITOR: process.env.EDITOR, VISUAL: process.env.VISUAL, isTTY: process.stdin.isTTY };
const setEnv = (k: "EDITOR" | "VISUAL", v?: string) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterEach(() => {
  setEnv("EDITOR", saved.EDITOR);
  setEnv("VISUAL", saved.VISUAL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdin as any).isTTY = saved.isTTY;
});

test("pickEditor: $EDITOR wins, then $VISUAL, then nano", () => {
  setEnv("EDITOR", undefined); setEnv("VISUAL", undefined);
  expect(pickEditor()).toBe("nano");
  setEnv("VISUAL", "vi"); expect(pickEditor()).toBe("vi");
  setEnv("EDITOR", "code --wait"); expect(pickEditor()).toBe("code --wait"); // flags preserved
});

test("without a TTY (tests/pipes) it NEVER launches an editor — just reports the path", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdin as any).isTTY = undefined; // as under `bun test`
  let handedOff = false;
  const r = await editFileInTerminal(async () => { handedOff = true; }, "/tmp/ws/teams/news/workflow.md");
  expect(handedOff).toBe(false);                 // suspendTerminal never invoked → nothing spawned
  expect(r.ok).toBe(false);
  expect(r.note).toContain("/tmp/ws/teams/news/workflow.md");
});

test("interactive: hands off via suspendTerminal with the right editor + path, then reports saved", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdin as any).isTTY = true;
  setEnv("EDITOR", "code --wait"); // multi-token editor: command + flag must be split correctly
  let handedOff = false;
  let ran: { cmd: string; args: string[] } | undefined;
  const suspend = async (cb: () => void | Promise<void>) => { handedOff = true; await cb(); };
  const run = async (cmd: string, args: string[]) => { ran = { cmd, args }; }; // injected — no real process
  const r = await editFileInTerminal(suspend, "/tmp/ws/teams/news/workflow.md", run);
  expect(handedOff).toBe(true);
  expect(ran).toEqual({ cmd: "code", args: ["--wait", "/tmp/ws/teams/news/workflow.md"] });
  expect(r.ok).toBe(true);
  expect(r.note).toContain("saved");
});

test("interactive: a missing editor reports a friendly error, not a crash", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdin as any).isTTY = true;
  setEnv("EDITOR", "definitely-not-an-editor-xyz");
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  const run = async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); };
  const r = await editFileInTerminal(async (cb) => { await cb(); }, "/tmp/ws/teams/news/workflow.md", run);
  expect(r.ok).toBe(false);
  expect(r.note).toContain("couldn't open");
  expect(r.note).toContain("ENOENT");
});
