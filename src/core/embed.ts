/** The KB embedder: turns text into a vector for semantic recall. Two optional, null-degrading
 *  backends (→ keyword+graph when absent): a LOCAL model (transformers.js all-MiniLM-L6-v2 — no API
 *  key) and OpenAI text-embedding-3-small (needs OPENAI_API_KEY). Config-selected; both loaded via
 *  RUNTIME dynamic import so neither is statically bundled into the single binary.
 *
 *  The local backend runs the native ONNX model, which CANNOT bundle into a `bun build --compile`
 *  binary (native `onnxruntime-node` fails `dlopen` from bunfs). So it has two paths, tried in order:
 *   1. IN-PROCESS  — `import(pkg)` resolves from an ambient node_modules (i.e. `bun run dev`/source).
 *   2. SIDECAR     — the shipped binary has no node_modules, so we self-install the package into
 *      `~/.taicho/runtime` (once) and run the model in a spawned `bun`/`node` worker over stdin/stdout
 *      — exactly how taicho already spawns MCP servers. Native resolution works in a normal runtime.
 *  Any failure (no package manager, offline, spawn error) rejects → callers fall back to keyword+graph.
 *  Model weights cache in ~/.taicho/models; the sidecar package installs into ~/.taicho/runtime. */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

export interface Embedder {
  model: string;
  dim: number;
  embed: (text: string) => Promise<Float32Array>;
  embedMany: (texts: string[]) => Promise<Float32Array[]>;
}

export type EmbedProvider = "off" | "local" | "openai";

const LOCAL = { pkg: "@huggingface/transformers", version: "4.2.0", model: "Xenova/all-MiniLM-L6-v2", dim: 384 };
const OPENAI = { pkg: "@ai-sdk/openai", model: "text-embedding-3-small", dim: 1536 };
const WORKER_FILE = "embed-worker.mjs";
const READY_TIMEOUT_MS = 180_000; // first start self-installs + downloads weights; generous, then fast.

/** Build the configured embedder, or null (→ keyword+graph). Default: openai when OPENAI_API_KEY is
 *  set, else local. Never throws — an unavailable backend degrades at embed()-time. */
export function createEmbedder(opts: { provider?: EmbedProvider; env?: Record<string, string | undefined>; home?: string } = {}): Embedder | null {
  const env = opts.env ?? process.env;
  const provider: EmbedProvider = opts.provider ?? (env.OPENAI_API_KEY ? "openai" : "local");
  if (provider === "off") return null;
  if (provider === "openai") return env.OPENAI_API_KEY ? openaiEmbedder() : null;
  const home = opts.home ?? join(homedir(), ".taicho");
  return localEmbedder(join(home, "models"), join(home, "runtime"));
}

function openaiEmbedder(): Embedder {
  const embedMany = async (texts: string[]): Promise<Float32Array[]> => {
    const { openai } = await import(OPENAI.pkg);         // installed; dynamic keeps it out of the hot path
    const { embedMany: aiEmbedMany } = await import("ai");
    const { embeddings } = await aiEmbedMany({ model: openai.embedding(OPENAI.model), values: texts });
    return embeddings.map((e: number[]) => new Float32Array(e));
  };
  return { model: OPENAI.model, dim: OPENAI.dim, embed: async (t) => (await embedMany([t]))[0]!, embedMany };
}

// --- local backend selection helpers (pure; unit-tested) --------------------------------------

/** Runtime to run the sidecar worker in — prefer bun, else node. null ⇒ neither on PATH. */
export function pickRuntime(which: (cmd: string) => string | null): "bun" | "node" | null {
  return which("bun") ? "bun" : which("node") ? "node" : null;
}

/** Package manager to self-install the embedder — prefer bun, else npm. null ⇒ neither on PATH. */
export function pickPackageManager(which: (cmd: string) => string | null): "bun" | "npm" | null {
  return which("bun") ? "bun" : which("npm") ? "npm" : null;
}

export function installArgs(pm: "bun" | "npm", spec: string): string[] {
  return pm === "bun" ? ["add", spec] : ["install", spec, "--no-save", "--no-audit", "--no-fund"];
}

/** The sidecar worker: a standalone ESM module that loads the model and serves embeddings over
 *  stdin/stdout as newline-delimited JSON ({id,text} → {id,vec} | {id,error}). Runs in a normal
 *  bun/node process (native onnxruntime resolves), NOT inside the compiled binary. */
export const WORKER_SOURCE = `import { createInterface } from "node:readline";
import { pipeline, env } from "@huggingface/transformers";
if (process.env.TAICHO_MODELS_DIR) env.cacheDir = process.env.TAICHO_MODELS_DIR;
env.allowRemoteModels = true;
const extractor = await pipeline("feature-extraction", process.env.TAICHO_EMBED_MODEL);
process.stdout.write("READY\\n");
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const t = line.trim();
  if (!t) continue;
  const { id, text } = JSON.parse(t);
  try {
    const out = await extractor(text, { pooling: "mean", normalize: true });
    process.stdout.write(JSON.stringify({ id, vec: Array.from(out.data) }) + "\\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ id, error: String(e && e.message || e) }) + "\\n");
  }
}
`;

// --- local backend orchestration --------------------------------------------------------------

type EmbedFn = (text: string) => Promise<Float32Array>;

function localEmbedder(modelsDir: string, runtimeDir: string): Embedder {
  let backend: Promise<EmbedFn> | null = null;
  const load = () => (backend ??= startLocalBackend(modelsDir, runtimeDir));
  const embed = async (t: string) => (await load())(t);
  return { model: LOCAL.model, dim: LOCAL.dim, embed, embedMany: (ts) => Promise.all(ts.map(embed)) };
}

async function startLocalBackend(modelsDir: string, runtimeDir: string): Promise<EmbedFn> {
  try {
    return await inProcessBackend(modelsDir);            // dev / source run: ambient node_modules
  } catch {
    return await sidecarBackend(modelsDir, runtimeDir);  // shipped binary: self-installed worker
  }
}

/** Load the model in-process. Works wherever the package resolves from an ambient node_modules
 *  (dev). In the compiled binary `import(pkg)` throws (module not found / dlopen) → sidecar path. */
async function inProcessBackend(modelsDir: string): Promise<EmbedFn> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tf: any = await import(LOCAL.pkg);               // variable specifier ⇒ NOT statically bundled
  tf.env.cacheDir = modelsDir;
  tf.env.allowRemoteModels = true;
  const extractor = await tf.pipeline("feature-extraction", LOCAL.model);
  return async (t: string) => {
    const out = await extractor(t, { pooling: "mean", normalize: true });
    return new Float32Array(out.data as Float32Array);
  };
}

/** Self-install the package into runtimeDir (once) + write the worker, then drive it as a subprocess. */
async function sidecarBackend(modelsDir: string, runtimeDir: string): Promise<EmbedFn> {
  await ensureRuntime(runtimeDir);
  const runtime = pickRuntime((c) => Bun.which(c));
  if (!runtime) throw new Error("no bun/node on PATH to run the local embedder");
  const client = await startWorker(runtime, join(runtimeDir, WORKER_FILE), runtimeDir, {
    TAICHO_MODELS_DIR: modelsDir,
    TAICHO_EMBED_MODEL: LOCAL.model,
  });
  return (t) => client.submit(t);
}

/** Ensure runtimeDir has @huggingface/transformers installed and a fresh worker script. The install
 *  is async (Bun.spawn, not spawnSync) so it never blocks the event loop / freezes the Ink TUI. */
async function ensureRuntime(runtimeDir: string): Promise<void> {
  const pkgDir = join(runtimeDir, "node_modules", "@huggingface", "transformers");
  if (!existsSync(pkgDir)) {
    mkdirSync(runtimeDir, { recursive: true });
    const manifest = join(runtimeDir, "package.json");
    if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ name: "taicho-embed-runtime", private: true }) + "\n");
    const pm = pickPackageManager((c) => Bun.which(c));
    if (!pm) throw new Error("no bun/npm on PATH to install the local embedder");
    const proc = Bun.spawn([pm, ...installArgs(pm, `${LOCAL.pkg}@${LOCAL.version}`)], { cwd: runtimeDir, stdout: "ignore", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) throw new Error("local embedder install failed: " + (await new Response(proc.stderr).text()).slice(-300));
  }
  writeFileSync(join(runtimeDir, WORKER_FILE), WORKER_SOURCE); // (re)write so it tracks this build
}

interface WorkerClient { submit: EmbedFn; close: () => void; }

/** Spawn the worker and speak newline-delimited JSON to it. Resolves once the worker signals READY
 *  (model loaded). Correlates concurrent requests by id; a worker exit rejects all pending + future
 *  calls so the embedder degrades to keyword+graph rather than hanging. */
function startWorker(runtime: string, workerPath: string, cwd: string, envVars: Record<string, string>): Promise<WorkerClient> {
  const proc = Bun.spawn([runtime, workerPath], {
    cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...envVars },
  });
  const pending = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let dead: Error | null = null;
  let onReady!: () => void;
  let onReadyFail!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => { onReady = res; onReadyFail = rej; });

  const failAll = (e: Error) => {
    dead = e;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    onReadyFail(e);
  };

  void (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let isReady = false;
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (!isReady) { if (line === "READY") { isReady = true; onReady(); } continue; }
        try {
          const msg = JSON.parse(line) as { id: number; vec?: number[]; error?: string };
          const p = pending.get(msg.id);
          if (!p) continue;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(new Float32Array(msg.vec!));
        } catch { /* ignore non-JSON noise on stdout */ }
      }
    }
  })();

  void proc.exited.then((code) => { if (!dead) failAll(new Error(`embed worker exited (code ${code})`)); });

  const timer = setTimeout(() => { if (!dead) { proc.kill(); failAll(new Error("embed worker did not become ready in time")); } }, READY_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();

  const submit: EmbedFn = (text) => {
    if (dead) return Promise.reject(dead);
    const id = nextId++;
    return new Promise<Float32Array>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, text }) + "\n");
      void proc.stdin.flush();
    });
  };

  return ready.then(() => { clearTimeout(timer); return { submit, close: () => proc.kill() }; });
}
