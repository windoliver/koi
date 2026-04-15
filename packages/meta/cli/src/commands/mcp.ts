/**
 * `koi mcp` — MCP server management.
 *
 * Subcommands: list, auth, logout, debug.
 */

import { resolve } from "node:path";
import type { McpServerConfig, ResolvedMcpServerConfig } from "@koi/mcp";
import {
  computeServerKey,
  createOAuthAuthProvider,
  loadMcpJsonFile,
  resolveServerConfig,
} from "@koi/mcp";
import { createSecureStorage } from "@koi/secure-storage";
import type { CliFlags, McpFlags } from "../args.js";
import { isMcpFlags } from "../args.js";
import { createOAuthAwareMcpConnection } from "../mcp-connection-factory.js";
import { ExitCode } from "../types.js";
import { createCliOAuthRuntime } from "./mcp-oauth-runtime.js";

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function run(flags: CliFlags): Promise<ExitCode> {
  if (!isMcpFlags(flags)) return ExitCode.FAILURE;

  // `subcommand` is optional only on the help/version short-circuit path
  // (see parseMcpFlags). dispatch.ts exits on help/version before run()
  // is invoked, so a non-defined subcommand reaching here means the
  // invocation was already invalid — fail closed.
  switch (flags.subcommand) {
    case "list":
      return runList(flags);
    case "auth":
      return runAuth(flags);
    case "logout":
      return runLogout(flags);
    case "debug":
      return runDebug(flags);
    case undefined:
      process.stderr.write(`error: koi mcp requires a subcommand (list, auth, logout, debug)\n`);
      return ExitCode.FAILURE;
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(flags: McpFlags): Promise<ExitCode> {
  const loaded = await loadConfigs();
  if (loaded === undefined) {
    jsonOut(flags, { error: "No .mcp.json found" });
    if (!flags.json) console.log("No .mcp.json found.");
    return ExitCode.FAILURE;
  }

  const { servers, unsupported } = loaded;

  const entries = servers.map((s) => ({
    name: s.name,
    transport: s.kind,
    oauth: s.kind === "http" && "oauth" in s && s.oauth !== undefined,
  }));

  if (flags.json) {
    console.log(JSON.stringify({ servers: entries, unsupported }, null, 2));
  } else {
    if (entries.length === 0) {
      console.log("No configured MCP servers.");
    } else {
      console.log("Configured MCP servers:\n");
      for (const e of entries) {
        const oauthTag = e.oauth ? " [oauth]" : "";
        console.log(`  ${e.name} (${e.transport})${oauthTag}`);
      }
    }
    if (unsupported.length > 0) {
      console.log(`\nUnsupported: ${unsupported.join(", ")}`);
    }
  }

  return ExitCode.OK;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

async function runAuth(flags: McpFlags): Promise<ExitCode> {
  const serverName = flags.server ?? "";
  const resolved = await resolveServer(serverName);

  if (resolved === undefined) {
    return fail(flags, `Server "${serverName}" not found in .mcp.json`);
  }

  if (resolved.server.kind !== "http") {
    return fail(
      flags,
      `OAuth is only supported for HTTP transport (server "${serverName}" uses ${resolved.server.kind})`,
    );
  }

  const httpConfig = resolved.server;
  if (httpConfig.oauth === undefined) {
    return fail(flags, `Server "${serverName}" does not have OAuth configuration`);
  }

  try {
    const storage = createSecureStorage();
    const runtime = createCliOAuthRuntime();

    const provider = createOAuthAuthProvider({
      serverName,
      serverUrl: httpConfig.url,
      oauthConfig: httpConfig.oauth,
      runtime,
      storage,
    });

    if (!flags.json) {
      console.log(`Authenticating with "${serverName}"...`);
    }

    const success = await provider.startAuthFlow();

    if (success) {
      jsonOut(flags, { success: true, server: serverName });
      if (!flags.json) console.log("Authentication successful!");
      return ExitCode.OK;
    }

    return fail(flags, "OAuth flow failed — could not discover authorization server");
  } catch (e: unknown) {
    return fail(flags, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

async function runLogout(flags: McpFlags): Promise<ExitCode> {
  const serverName = flags.server ?? "";
  const resolved = await resolveServer(serverName);

  if (resolved === undefined) {
    return fail(flags, `Server "${serverName}" not found in .mcp.json`);
  }

  if (resolved.server.kind !== "http") {
    return fail(flags, `Server "${serverName}" is not an HTTP server`);
  }

  try {
    const storage = createSecureStorage();
    const key = computeServerKey(serverName, resolved.server.url);
    const deleted = await storage.delete(key);

    if (deleted) {
      jsonOut(flags, { success: true, server: serverName });
      if (!flags.json) console.log(`Logged out from "${serverName}".`);
    } else {
      jsonOut(flags, { success: false, server: serverName, message: "No tokens found" });
      if (!flags.json) console.log(`No stored tokens for "${serverName}".`);
    }

    return ExitCode.OK;
  } catch (e: unknown) {
    return fail(flags, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// debug
// ---------------------------------------------------------------------------

async function runDebug(flags: McpFlags): Promise<ExitCode> {
  const serverName = flags.server ?? "";
  const resolved = await resolveServer(serverName);

  if (resolved === undefined) {
    return fail(flags, `Server "${serverName}" not found in .mcp.json`);
  }

  const info: Record<string, unknown> = {
    name: serverName,
    transport: resolved.server.kind,
    timeoutMs: resolved.timeoutMs,
    connectTimeoutMs: resolved.connectTimeoutMs,
    maxReconnectAttempts: resolved.maxReconnectAttempts,
  };

  if (resolved.server.kind === "http") {
    info.url = resolved.server.url;
    info.hasOAuth = resolved.server.oauth !== undefined;
    if (resolved.server.oauth !== undefined) {
      info.oauthClientId = resolved.server.oauth.clientId ?? "(auto)";
    }

    // Check if tokens exist
    try {
      const storage = createSecureStorage();
      const key = computeServerKey(serverName, resolved.server.url);
      const hasTokens = (await storage.get(key)) !== undefined;
      info.hasStoredTokens = hasTokens;
    } catch {
      info.hasStoredTokens = false;
      info.storageError = "Secure storage not available";
    }
  }

  if (!flags.json) {
    console.log(`Diagnosing connection to "${serverName}"...\n`);
  }

  const conn = createOAuthAwareMcpConnection(resolved.server);
  const connectResult = await conn.connect();

  if (connectResult.ok) {
    info.state = "connected";
    const toolsResult = await conn.listTools();
    if (toolsResult.ok) {
      info.toolCount = toolsResult.value.length;
      info.tools = toolsResult.value.map((t) => t.name);
    } else {
      info.toolsError = toolsResult.error.message;
    }
  } else {
    info.state = conn.state.kind;
    info.connectError = connectResult.error.message;
  }

  await conn.close();

  if (flags.json) {
    console.log(JSON.stringify(info, null, 2));
  } else {
    for (const [k, v] of Object.entries(info)) {
      if (Array.isArray(v)) {
        console.log(`  ${k}: ${v.join(", ")}`);
      } else {
        console.log(`  ${k}: ${String(v)}`);
      }
    }
  }

  return ExitCode.OK;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LoadedConfig {
  readonly servers: readonly McpServerConfig[];
  readonly unsupported: readonly string[];
}

async function loadConfigs(): Promise<LoadedConfig | undefined> {
  const cwd = process.cwd();
  // Only fall back to home config when the project file is truly absent,
  // not when it exists but is invalid — same logic as shared-wiring.ts.
  const projectResult = await loadMcpJsonFile(resolve(cwd, ".mcp.json"));
  if (projectResult.ok) return projectResult.value;
  const isAbsent = projectResult.error.code === "NOT_FOUND";
  if (isAbsent) {
    const homeResult = await loadMcpJsonFile(resolve(process.env.HOME ?? ".", ".koi", ".mcp.json"));
    if (homeResult.ok) return homeResult.value;
  }
  return undefined;
}

async function resolveServer(name: string): Promise<ResolvedMcpServerConfig | undefined> {
  const loaded = await loadConfigs();
  if (loaded === undefined) return undefined;

  const { servers } = loaded;
  const server = servers.find((s) => s.name === name);
  if (server === undefined) return undefined;

  return resolveServerConfig(server);
}

function jsonOut(flags: McpFlags, data: Record<string, unknown>): void {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function fail(flags: McpFlags, message: string): ExitCode {
  jsonOut(flags, { error: message });
  if (!flags.json) console.error(message);
  return ExitCode.FAILURE;
}
