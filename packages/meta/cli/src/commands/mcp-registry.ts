/**
 * `koi mcp` registry-discovery subcommands: search, info, install, uninstall.
 *
 * Layered like the rest of `commands/mcp.ts`: parse flags, call into
 * `@koi/mcp` for the heavy lifting, render text or JSON.
 */

import { resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import type {
  ExternalServerConfig,
  McpToolInfo,
  RegistryClient,
  RegistryServer,
  ResolvedMcpServerConfig,
} from "@koi/mcp";
import {
  computeServerKey,
  createRegistryCache,
  createRegistryClient,
  installMcpServer,
  loadMcpJsonFile,
  pickPackageForInstall,
  uninstallMcpServer,
} from "@koi/mcp";
import { createSecureStorage } from "@koi/secure-storage";
import type { McpFlags } from "../args.js";
import { createOAuthAwareMcpConnection } from "../mcp-connection-factory.js";
import { ExitCode } from "../types.js";

const DEFAULT_SEARCH_LIMIT = 20;

export async function runSearch(flags: McpFlags): Promise<ExitCode> {
  const query = flags.server ?? "";
  const limit = flags.limit ?? DEFAULT_SEARCH_LIMIT;
  const cache = flags.noCache ? undefined : createRegistryCache();
  const cached = await cache?.getSearch(query);

  let result: {
    readonly servers: readonly RegistryServer[];
    readonly nextCursor: string | undefined;
  };
  if (cached !== undefined) {
    result = cached;
  } else {
    const client = createRegistryClient();
    const fetched = await client.searchServers({ query, limit });
    if (!fetched.ok) return failFlags(flags, fetched.error.message);
    result = fetched.value;
    await cache?.putSearch(query, result);
  }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return ExitCode.OK;
  }

  if (result.servers.length === 0) {
    console.log(`No MCP servers found for "${query}".`);
    return ExitCode.OK;
  }

  console.log(`Found ${result.servers.length} server${result.servers.length === 1 ? "" : "s"}:\n`);
  for (const s of result.servers) {
    console.log(`  ${s.name}@${s.version} — ${s.description}`);
  }
  if (result.nextCursor !== undefined) {
    console.log(`\nMore results available. Re-run with a more specific query.`);
  }
  return ExitCode.OK;
}

export async function runInfo(flags: McpFlags): Promise<ExitCode> {
  const name = flags.server ?? "";
  const version = flags.registryVersion;
  const cache = flags.noCache ? undefined : createRegistryCache();
  const cached = await cache?.getServer(name, version);

  let server: RegistryServer;
  if (cached !== undefined) {
    server = cached;
  } else {
    const client: RegistryClient = createRegistryClient();
    const result = await client.getServer(name, version);
    if (!result.ok) return failFlags(flags, result.error.message);
    server = result.value;
    await cache?.putServer(name, server, version);
  }

  if (flags.json) {
    console.log(JSON.stringify(server, null, 2));
    return ExitCode.OK;
  }

  printServerInfo(server);
  return ExitCode.OK;
}

export async function runInstall(flags: McpFlags): Promise<ExitCode> {
  const name = flags.server ?? "";
  const version = flags.registryVersion;
  const client = createRegistryClient();
  const fetched = await client.getServer(name, version);
  if (!fetched.ok) return failFlags(flags, fetched.error.message);
  const server = fetched.value;

  const picked = pickPackageForInstall(server);
  if (!picked.ok) return failFlags(flags, picked.error.message);

  if (!flags.json) {
    printPermissionWarning(server, picked.value);
  }

  if (!flags.yes) {
    const confirmed = await promptYesNo("Continue?");
    if (!confirmed) {
      console.log("Aborted.");
      return ExitCode.FAILURE;
    }
  }

  const configPath = resolve(process.cwd(), ".mcp.json");
  const result = await installMcpServer({
    server,
    configPath,
    skipVerify: flags.skipVerify,
    deps: { verifyConnection: defaultVerifyConnection },
  });
  if (!result.ok) return failFlags(flags, result.error.message);

  if (flags.json) {
    console.log(
      JSON.stringify({ success: true, name: server.name, entry: result.value.entry }, null, 2),
    );
  } else {
    console.log(`Installed "${server.name}" into ${configPath}.`);
    if (picked.value.type === "http" && hasOAuthRequirement(server)) {
      console.log(`Run \`koi mcp auth ${server.name}\` to complete OAuth.`);
    }
  }
  return ExitCode.OK;
}

export async function runUninstall(flags: McpFlags): Promise<ExitCode> {
  const name = flags.server ?? "";
  const configPath = resolve(process.cwd(), ".mcp.json");

  // Look up the server URL before removal so we can clear stored OAuth tokens.
  let oauthKey: string | undefined;
  const loaded = await loadMcpJsonFile(configPath);
  if (loaded.ok) {
    const entry = loaded.value.servers.find((s) => s.name === name);
    if (entry !== undefined && entry.kind === "http") {
      oauthKey = computeServerKey(name, entry.url);
    }
  }

  const result = await uninstallMcpServer({
    name,
    configPath,
    ...(oauthKey !== undefined
      ? { deps: { clearStoredCredentials: clearOAuthTokensFor(oauthKey) } }
      : {}),
  });
  if (!result.ok) return failFlags(flags, result.error.message);

  if (flags.json) {
    console.log(JSON.stringify({ success: true, name }, null, 2));
  } else {
    console.log(`Removed "${name}" from ${configPath}.`);
  }
  return ExitCode.OK;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function printServerInfo(server: RegistryServer): void {
  console.log(`${server.name}@${server.version}`);
  console.log(`  ${server.description}`);
  if (server.title !== undefined) console.log(`  Title:   ${server.title}`);
  if (server.websiteUrl !== undefined) console.log(`  Website: ${server.websiteUrl}`);
  if (server.repository?.url !== undefined) console.log(`  Repo:    ${server.repository.url}`);
  if (server.status !== undefined) console.log(`  Status:  ${server.status}`);
  if (server.packages !== undefined && server.packages.length > 0) {
    console.log(`  Packages:`);
    for (const p of server.packages) {
      console.log(
        `    - ${p.registryType}: ${p.identifier}${p.version !== undefined ? `@${p.version}` : ""}`,
      );
    }
  }
  if (server.remotes !== undefined && server.remotes.length > 0) {
    console.log(`  Remotes:`);
    for (const r of server.remotes) {
      console.log(`    - ${r.transport?.type ?? "http"}: ${r.url}`);
    }
  }
}

function printPermissionWarning(server: RegistryServer, entry: ExternalServerConfig): void {
  console.log(`\nInstalling: ${server.name}@${server.version}`);
  console.log(`  ${server.description}`);
  if (entry.type === "stdio") {
    const cmd = entry.command ?? "";
    const args = (entry.args ?? []).join(" ");
    console.log("\n  ! Will execute on your machine (stdio transport):");
    console.log(`      ${cmd} ${args}`);
    console.log("    Stdio MCP servers run with your user privileges.");
    console.log("    Only install servers you trust.");
  } else if (entry.type === "http" || entry.type === "sse") {
    console.log(`\n  ! Will connect to: ${entry.url ?? ""}`);
    if (hasOAuthRequirement(server)) {
      console.log("    Server requires OAuth — a browser window will open.");
    }
  }
  if (server._meta !== undefined && Object.keys(server._meta).length > 0) {
    console.log(`  Registry _meta: ${JSON.stringify(server._meta)}`);
  }
  console.log("");
}

function hasOAuthRequirement(server: RegistryServer): boolean {
  // The registry schema does not surface OAuth as a first-class field. We
  // best-effort detect by looking for OAuth hints in `_meta`. If absent,
  // returns false — the connection verify step will surface real auth
  // failures with an actionable error.
  const meta = server._meta;
  if (meta === undefined) return false;
  for (const value of Object.values(meta)) {
    if (typeof value === "object" && value !== null && "oauth" in value) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Side-effecting helpers (kept thin so the bulk is testable in @koi/mcp)
// ---------------------------------------------------------------------------

async function defaultVerifyConnection(
  config: ResolvedMcpServerConfig,
): Promise<Result<readonly McpToolInfo[], KoiError>> {
  // Use the OAuth-aware connection factory so HTTP servers with an `oauth`
  // block (which `pickPackageForInstall` always emits for http remotes)
  // perform Dynamic Client Registration + interactive flow against the
  // CLI runtime instead of failing the dry-run with a 401.
  const conn = createOAuthAwareMcpConnection(config.server);
  try {
    return await conn.listTools();
  } finally {
    await conn.close();
  }
}

function clearOAuthTokensFor(key: string): (name: string) => Promise<void> {
  return async (_name: string): Promise<void> => {
    try {
      const storage = createSecureStorage();
      await storage.delete(key);
    } catch {
      // Best-effort: keychain may be unavailable. Removal of mcp.json entry
      // already succeeded, which is the user-visible part of uninstall.
    }
  };
}

async function promptYesNo(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  for await (const chunk of process.stdin as unknown as AsyncIterable<Buffer>) {
    const answer = chunk.toString("utf8").trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }
  return false;
}

function failFlags(flags: McpFlags, message: string): ExitCode {
  if (flags.json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  return ExitCode.FAILURE;
}
