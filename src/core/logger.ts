/** Leveled, file-captured logging that does NOT fight Ink.
 *
 *  Under the full-screen TUI, a stray console.error/warn write corrupts or vanishes behind the Ink
 *  render — so a run failure or a swallowed error left no trace the user could read. This logger
 *  writes structured lines to a FILE (`taicho.log` in the workspace) instead, so diagnostics survive
 *  a session and are greppable after the fact.
 *
 *  Auth material is NEVER written: every line passes through `redact()`, the same Bearer/token
 *  scrub as `redactAuthHeader` (providers/openai-codex.ts) plus a few common API-key shapes. Kept
 *  dependency-free so it can be imported from any layer (store/, core/, providers/) without pulling
 *  a heavy provider into every module.
 *
 *  A single process-wide default logger (`log`) backs the scattered call sites. Boot calls
 *  `configureLogger({ ws, level })` once it knows the workspace + verbosity (`--verbose` / env).
 *  Tests use `createLogger({ file })` for isolation. */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/** Numeric severity — a message is emitted only when its level >= the logger's threshold. */
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  level: LogLevel;
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

/** Scrub anything that looks like a bearer token or API key BEFORE it reaches disk. Mirrors
 *  `redactAuthHeader` (Bearer <token> → Bearer ***) and adds the common key/secret shapes an error
 *  string or serialized profile might carry. Targeted on purpose — it must not maul ordinary prose.
 *  Beyond Bearer/`sk-`/named-JSON-field shapes it also covers GitHub tokens (`ghp_`/`gho_`/`ghu_`/
 *  `ghs_`/`ghr_` and fine-grained `github_pat_…`) and bare JWTs, so a gh-backed MCP or a new provider
 *  can't leak a credential shape the original three rules miss. Each new rule requires a distinctive
 *  prefix + a long opaque body, so it stays off ordinary text. */
export function redact(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, "sk-***") // OpenAI/Anthropic/OpenRouter: sk-, sk-ant-, sk-proj-, sk-or-
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***") // GitHub fine-grained PAT
    .replace(/\bgh[oprsu]_[A-Za-z0-9]{20,}/g, (m) => m.slice(0, 4) + "***") // GitHub gho_/ghp_/ghr_/ghs_/ghu_ tokens
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "eyJ***") // bare JWT: header.payload.signature
    .replace(/"(access_token|refresh_token|id_token|api[_-]?key|apiKey|authorization)"\s*:\s*"[^"]*"/gi, '"$1":"***"');
}

/** Serialize the optional structured payload for the line tail. Errors render as message + name;
 *  circular structures degrade to "[unserializable]" rather than throwing (logging must not crash). */
function serialize(data: unknown): string {
  if (data === undefined) return "";
  if (data instanceof Error) return `${data.name}: ${data.message}`;
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return "[unserializable]";
  }
}

function format(level: LogLevel, msg: string, data?: unknown): string {
  const tail = serialize(data);
  const line = tail ? `${msg} :: ${tail}` : msg;
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(line)}\n`;
}

class FileLogger implements Logger {
  level: LogLevel;
  private file: string;
  private sink?: (line: string) => void;
  private ensured = false;

  constructor(opts: { file?: string; level?: LogLevel; sink?: (line: string) => void }) {
    this.level = opts.level ?? "info";
    this.file = opts.file ?? defaultFile();
    this.sink = opts.sink;
  }

  /** Re-point the file and/or level after boot resolves the workspace + verbosity. */
  configure(opts: { ws?: string; file?: string; level?: LogLevel; sink?: (line: string) => void }): void {
    if (opts.sink) this.sink = opts.sink;
    if (opts.file) { this.file = opts.file; this.ensured = false; }
    else if (opts.ws) { this.file = join(opts.ws, "taicho.log"); this.ensured = false; }
    if (opts.level) this.level = opts.level;
  }

  private emit(level: LogLevel, msg: string, data?: unknown): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const line = format(level, msg, data);
    if (this.sink) { this.sink(line); return; }
    try {
      if (!this.ensured) { mkdirSync(dirname(this.file), { recursive: true }); this.ensured = true; }
      appendFileSync(this.file, line);
    } catch {
      // Logging must never take down the app. A failed write is silently dropped.
    }
  }

  debug(msg: string, data?: unknown): void { this.emit("debug", msg, data); }
  info(msg: string, data?: unknown): void { this.emit("info", msg, data); }
  warn(msg: string, data?: unknown): void { this.emit("warn", msg, data); }
  error(msg: string, data?: unknown): void { this.emit("error", msg, data); }
}

/** Default file, resolved from env or the cwd (which IS the workspace for the running app). */
function defaultFile(): string {
  return process.env.TAICHO_LOG_FILE ?? join(process.cwd(), "taicho.log");
}

/** The starting level, from env. `TAICHO_LOG_LEVEL` wins; `TAICHO_VERBOSE`/`TAICHO_DEBUG` ⇒ debug.
 *  (Historically only the codex path honored `TAICHO_DEBUG`; it now raises the general log level.) */
export function envLevel(): LogLevel {
  const raw = process.env.TAICHO_LOG_LEVEL?.toLowerCase();
  if (raw && raw in ORDER) return raw as LogLevel;
  if (process.env.TAICHO_VERBOSE || process.env.TAICHO_DEBUG) return "debug";
  return "info";
}

/** Build an isolated logger — used by tests (explicit file) and anywhere a scoped sink is wanted. */
export function createLogger(opts: { file?: string; level?: LogLevel; sink?: (line: string) => void }): Logger {
  return new FileLogger(opts);
}

/** The process-wide default logger every scattered call site imports. Re-pointed at boot. */
export const log = new FileLogger({ level: envLevel() });

/** Re-point the default logger once boot knows the workspace + verbosity. */
export function configureLogger(opts: { ws?: string; file?: string; level?: LogLevel; sink?: (line: string) => void }): void {
  log.configure(opts);
}
