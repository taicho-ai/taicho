/** OAuth for remote MCP servers. A file-backed OAuthClientProvider (the SDK drives discovery, PKCE,
 *  and dynamic client registration) + a loopback-callback connect helper that mirrors taicho's
 *  ChatGPT OAuth (core/auth/login.ts): a Bun.serve on localhost catches the redirect code. Tokens
 *  persist per server under agents/.mcp/ (gitignored) at mode 0600 and are never logged. */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthTokens, OAuthClientMetadata, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";

export const MCP_OAUTH_PORT = 1456; // distinct from the ChatGPT login port (1455)
export const MCP_OAUTH_PATH = "/oauth/callback";
export const mcpRedirectUrl = (port = MCP_OAUTH_PORT): string => `http://localhost:${port}${MCP_OAUTH_PATH}`;

/** Thrown (instead of opening a browser) when a connect needs interactive auth in a non-interactive
 *  context (boot). The user then runs `/mcp login <server>`. */
export class McpAuthRequiredError extends Error {
  constructor(public server: string) { super(`MCP server "${server}" needs sign-in — run /mcp login ${server}`); }
}

interface OAuthState { tokens?: OAuthTokens; clientInformation?: OAuthClientInformationMixed; codeVerifier?: string }

const stateDir = (ws: string): string => join(ws, "agents", ".mcp");
const statePath = (ws: string, server: string): string => join(stateDir(ws), `${server}-oauth.json`);

function readState(ws: string, server: string): OAuthState {
  const f = statePath(ws, server);
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")) as OAuthState; } catch { return {}; }
}
function writeState(ws: string, server: string, patch: Partial<OAuthState>): void {
  mkdirSync(stateDir(ws), { recursive: true });
  writeFileSync(statePath(ws, server), JSON.stringify({ ...readState(ws, server), ...patch }, null, 2), { mode: 0o600 });
}

/** Build the provider. `redirectToAuthorization` is injected so boot can refuse (throw
 *  McpAuthRequiredError) while `/mcp login` opens the browser. Storage is shared via files, so
 *  provider instances are interchangeable across attempts. */
export function createMcpOAuthProvider(opts: {
  ws: string;
  serverName: string;
  redirectToAuthorization: (url: URL) => void;
  redirectPort?: number;
}): OAuthClientProvider {
  const { ws, serverName } = opts;
  return {
    get redirectUrl() { return mcpRedirectUrl(opts.redirectPort); },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "taicho",
        redirect_uris: [mcpRedirectUrl(opts.redirectPort)],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation() { return readState(ws, serverName).clientInformation; },
    saveClientInformation(info) { writeState(ws, serverName, { clientInformation: info }); },
    tokens() { return readState(ws, serverName).tokens; },
    saveTokens(t) { writeState(ws, serverName, { tokens: t }); },
    redirectToAuthorization(url) { opts.redirectToAuthorization(url); },
    saveCodeVerifier(v) { writeState(ws, serverName, { codeVerifier: v }); },
    codeVerifier() {
      const v = readState(ws, serverName).codeVerifier;
      if (!v) throw new Error("no PKCE code_verifier saved for MCP OAuth");
      return v;
    },
  };
}

/** Interactive flow: start the loopback server, connect (the SDK opens the browser via
 *  redirectToAuthorization), capture the code, finishAuth, then RECONNECT WITH A FRESH TRANSPORT.
 *  The reconnect must use a new transport: the first connect started the original one, and the
 *  StreamableHTTP transport's close() aborts but never clears its started flag, so reusing it
 *  throws "already started". `makeTransport` produces a fresh transport each call; `connect`
 *  reconnects the same Client (its transport was cleared by the failed connect's close()). */
export async function runMcpOAuth(opts: {
  makeTransport: () => StreamableHTTPClientTransport;
  connect: (transport: StreamableHTTPClientTransport) => Promise<void>;
  redirectPort?: number;
  timeoutMs?: number;
}): Promise<void> {
  const port = opts.redirectPort ?? MCP_OAUTH_PORT;
  let resolveCode!: (c: string) => void;
  let rejectFlow!: (e: Error) => void;
  const codeP = new Promise<string>((res, rej) => { resolveCode = res; rejectFlow = rej; });
  const server = Bun.serve({
    port,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === MCP_OAUTH_PATH) {
        const err = u.searchParams.get("error");
        if (err) { rejectFlow(new Error(u.searchParams.get("error_description") ?? err)); return new Response("authorization failed", { status: 400 }); }
        const code = u.searchParams.get("code");
        if (code) { resolveCode(code); return new Response("taicho: MCP server authorized — you can close this tab."); }
      }
      return new Response("not found", { status: 404 });
    },
  });
  const timer = setTimeout(() => rejectFlow(new Error("MCP OAuth timed out")), opts.timeoutMs ?? 120_000);
  try {
    const first = opts.makeTransport();
    try { await opts.connect(first); return; } catch (e) { if (!(e instanceof UnauthorizedError)) throw e; }
    const code = await codeP;
    await first.finishAuth(code); // exchanges code -> tokens (persisted via the provider); HTTP only
    await opts.connect(opts.makeTransport()); // fresh transport; tokens now on disk
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}

export function defaultOpenBrowser(url: string): void {
  // `start` is a cmd.exe builtin, so on Windows it must be invoked via `cmd /c start "" <url>`.
  const argv = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try { Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }); } catch { /* fall back to the printed URL */ }
}
