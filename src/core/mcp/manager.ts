/** Connects to MCP servers and exposes their tools to agents. Dynamically mutable so the `/mcp`
 *  command works without a restart: add/remove/login/reconnect mutate the live connection map, and
 *  because toolsForAgent reads the manager at run time, changes are picked up on the next run.
 *  A server that fails to connect is recorded (status) and skipped — it never crashes the REPL. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ToolSet } from "ai";
import { isStdioServer, interpolateEnv, type McpServerConfig } from "../../store/config";
import { mcpToolToAiTool, type McpCallResult } from "./adapter";
import { createMcpOAuthProvider, runMcpOAuth, defaultOpenBrowser, McpAuthRequiredError } from "./oauth";

export type McpStatus = "connected" | "error" | "needs-auth";
export interface McpServerStatus { name: string; kind: "stdio" | "http"; status: McpStatus; toolCount: number; error?: string }

export interface McpManager {
  /** Resolve an agent.tools ref ("server" or "server/tool") to namespaced AI-SDK tools. */
  toolsForRef(ref: string): ToolSet;
  /** Every connected server's tools, namespaced (server_tool) — used to grant all agents all MCP tools. */
  allTools(): ToolSet;
  list(): McpServerStatus[];
  addServer(name: string, spec: McpServerConfig): Promise<McpServerStatus>;
  removeServer(name: string): Promise<boolean>;
  login(name: string): Promise<McpServerStatus>;
  reconnect(name: string): Promise<McpServerStatus>;
  closeAll(): Promise<void>;
}

interface Entry { spec: McpServerConfig; kind: "stdio" | "http"; client?: Client; status: McpStatus; toolCount: number; error?: string; set: ToolSet }

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");
// Namespaced + capped at 64 chars (the model-provider tool-name limit) to avoid a call-time 400.
const toolKey = (server: string, tool: string): string => `${sanitize(server)}_${sanitize(tool)}`.slice(0, 64);

export interface McpManagerOptions {
  ws: string;
  servers: Record<string, McpServerConfig>;
  onUrl?: (url: string) => void;             // print the OAuth URL (paste fallback)
  openBrowser?: (url: string) => void;
}

export async function createMcpManager(opts: McpManagerOptions): Promise<McpManager> {
  const entries = new Map<string, Entry>();
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser;

  /** Connect one server. interactive=true permits the OAuth browser flow; false (boot) refuses it. */
  async function connectOne(name: string, spec: McpServerConfig, interactive: boolean): Promise<Entry> {
    const kind: Entry["kind"] = isStdioServer(spec) ? "stdio" : "http";
    const client = new Client({ name: "taicho", version: "0.0.1" }, { capabilities: {} });
    try {
      if (isStdioServer(spec)) {
        const env = Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, interpolateEnv(v)]));
        await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: { ...getDefaultEnvironment(), ...env } }));
      } else if (spec.auth === "oauth") {
        // Fresh provider+transport per attempt — the OAuth reconnect after finishAuth needs a new
        // transport (the first one is already started), so runMcpOAuth calls makeTransport twice.
        const makeTransport = () => new StreamableHTTPClientTransport(new URL(interpolateEnv(spec.url)), {
          authProvider: createMcpOAuthProvider({
            ws: opts.ws,
            serverName: name,
            redirectToAuthorization: interactive
              ? (url) => { opts.onUrl?.(url.toString()); openBrowser(url.toString()); }
              : () => { throw new McpAuthRequiredError(name); },
          }),
        });
        if (interactive) await runMcpOAuth({ makeTransport, connect: (t) => client.connect(t) });
        else await client.connect(makeTransport());
      } else {
        const headers = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k, interpolateEnv(v)]));
        await client.connect(new StreamableHTTPClientTransport(new URL(interpolateEnv(spec.url)), { requestInit: { headers } }));
      }
      const { tools } = await client.listTools();
      const set: ToolSet = {};
      for (const t of tools) {
        set[t.name] = mcpToolToAiTool(
          async (n, args) => (await client.callTool({ name: n, arguments: args })) as unknown as McpCallResult,
          { name: t.name, description: t.description, inputSchema: t.inputSchema },
        );
      }
      return { spec, kind, client, status: "connected", toolCount: tools.length, set };
    } catch (e) {
      await client.close().catch(() => {});
      const needsAuth = e instanceof McpAuthRequiredError || e instanceof UnauthorizedError;
      return { spec, kind, status: needsAuth ? "needs-auth" : "error", toolCount: 0, error: e instanceof Error ? e.message : String(e), set: {} };
    }
  }

  async function set(name: string, spec: McpServerConfig, interactive: boolean): Promise<McpServerStatus> {
    const prev = entries.get(name);
    if (prev?.client) await prev.client.close().catch(() => {});
    // Hold a transient (non-connected) slot during the async connect so a concurrent toolsForRef
    // never hands an agent the just-closed client.
    entries.set(name, { spec, kind: isStdioServer(spec) ? "stdio" : "http", status: "error", toolCount: 0, error: "connecting…", set: {} });
    const e = await connectOne(name, spec, interactive);
    entries.set(name, e);
    return statusOf(name, e);
  }

  function statusOf(name: string, e: Entry): McpServerStatus {
    return { name, kind: e.kind, status: e.status, toolCount: e.toolCount, error: e.error };
  }

  // Connect everything concurrently at boot (non-interactive).
  await Promise.all(Object.entries(opts.servers).map(([name, spec]) =>
    connectOne(name, spec, false).then((e) => { entries.set(name, e); })));

  return {
    toolsForRef(ref) {
      const slash = ref.indexOf("/");
      const server = slash === -1 ? ref : ref.slice(0, slash);
      const toolName = slash === -1 ? undefined : ref.slice(slash + 1);
      const e = entries.get(server);
      if (!e || e.status !== "connected") return {};
      if (toolName) return e.set[toolName] ? { [toolKey(server, toolName)]: e.set[toolName] } : {};
      const out: ToolSet = {};
      for (const [n, t] of Object.entries(e.set)) out[toolKey(server, n)] = t;
      return out;
    },
    allTools() {
      const out: ToolSet = {};
      for (const [name, e] of entries) {
        if (e.status !== "connected") continue;
        for (const [n, t] of Object.entries(e.set)) { const k = toolKey(name, n); if (!(k in out)) out[k] = t; }
      }
      return out;
    },
    list() {
      return [...entries.entries()].map(([name, e]) => statusOf(name, e));
    },
    addServer(name, spec) { return set(name, spec, /*interactive*/ true); },
    login(name) {
      const e = entries.get(name);
      if (!e) return Promise.reject(new Error(`no MCP server "${name}"`));
      return set(name, e.spec, /*interactive*/ true);
    },
    reconnect(name) {
      const e = entries.get(name);
      if (!e) return Promise.reject(new Error(`no MCP server "${name}"`));
      return set(name, e.spec, /*interactive*/ false);
    },
    async removeServer(name) {
      const e = entries.get(name);
      if (!e) return false;
      if (e.client) await e.client.close().catch(() => {});
      entries.delete(name);
      return true;
    },
    async closeAll() {
      await Promise.all([...entries.values()].map((e) => e.client?.close().catch(() => {})));
    },
  };
}
