/**
 * `koi mcp` registry-discovery subcommands: search, info, install, uninstall.
 *
 * Layered like the rest of `commands/mcp.ts`: parse flags, call into
 * `@koi/mcp` for the heavy lifting, render text or JSON.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AuthCompleteNotification,
  AuthFailureNotification,
  AuthRequiredNotification,
  KoiError,
  OAuthChannel,
  Result,
} from "@koi/core";
import type {
  ExternalServerConfig,
  McpToolInfo,
  RegistryClient,
  RegistryServer,
  ResolvedMcpServerConfig,
} from "@koi/mcp";
import {
  clearAllOAuthState,
  createRegistryCache,
  createRegistryClient,
  installMcpServer,
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
  // Cache key includes limit so two searches with different limits don't
  // alias to the same cached result (caller may want a wider/narrower set).
  const cacheKey = `${query}|${limit}`;
  const cache = flags.noCache ? undefined : createRegistryCache();
  const cached = await cache?.getSearch(cacheKey);

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
    await cache?.putSearch(cacheKey, result);
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
    // Fail closed in non-interactive contexts: stdin without a TTY (CI,
    // pipes, automation) can wedge `for await` on stdin until EOF, which
    // looks like a hang. Require an explicit --yes/--json instead.
    if (process.stdin.isTTY !== true) {
      return failFlags(
        flags,
        "Refusing to prompt for confirmation: stdin is not a TTY. Re-run with --yes (or --json, which implies --yes).",
      );
    }
    const confirmed = await promptYesNo("Continue?");
    if (!confirmed) {
      console.log("Aborted.");
      return ExitCode.FAILURE;
    }
  }

  // Mirror loadConfigs resolution: prefer project ./.mcp.json when it
  // exists, then ~/.koi/.mcp.json, else create the project file. This
  // keeps install/uninstall in sync with list/auth/debug/logout — a
  // user whose active MCP setup lives in the home config no longer
  // ends up with split state where install creates a project-local
  // file the rest of the CLI never reads.
  const configPath = resolveActiveMcpJsonPath();
  // For HTTP installs the verify path may complete an OAuth flow that
  // persists both tokens AND a DCR client record; if verify fails we
  // want both wiped. We pass the server URL (not just a derived key)
  // so cleanup can walk the per-server index and delete every owned
  // record, not just the canonical token blob.
  const oauthTarget =
    picked.value.type === "http" && picked.value.url !== undefined
      ? { name: server.name, url: picked.value.url }
      : undefined;
  const result = await installMcpServer({
    server,
    configPath,
    skipVerify: flags.skipVerify,
    deps: {
      verifyConnection: defaultVerifyConnection,
      ...(oauthTarget !== undefined
        ? { clearStoredCredentials: clearAllOAuthStateFor(oauthTarget) }
        : {}),
    },
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
  // Find whichever config file actually contains the entry so uninstall
  // can target home configs, not just the project-local file. A
  // malformed project file aborts here rather than falling through to
  // the home config — see resolveMcpJsonPathContaining for why.
  const resolved = await resolveMcpJsonPathContaining(name);
  if (!resolved.ok) return failFlags(flags, resolved.error);
  const configPath = resolved.path;

  // Read the URL straight from the raw .mcp.json so we can clear OAuth
  // state even when the file is malformed or contains entries the
  // normalizer would reject. Without this, an entry that fails
  // normalization (e.g. unsupported transport, missing env var) would
  // still be removed by `removeServerFromMcpJson`, but stored OAuth
  // tokens would remain — config gone, credentials retained.
  const oauthTarget = await readOAuthTargetFromRawConfig(configPath, name);

  const result = await uninstallMcpServer({
    name,
    configPath,
    ...(oauthTarget !== undefined
      ? { deps: { clearStoredCredentials: clearAllOAuthStateFor(oauthTarget) } }
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
  // Pass a stdout-backed OAuthChannel so the connection's mid-session 401
  // handler can launch the interactive flow if the server actually
  // challenges. We deliberately do NOT proactively call triggerAuth here:
  // every HTTP entry gets an `oauth: {}` block by default (so post-install
  // `koi mcp auth` works), and forcing auth would open a browser for public
  // servers that don't need it. The 401-triggered path runs only when the
  // server actually rejects the unauthenticated listTools call.
  const conn = createOAuthAwareMcpConnection(config.server, undefined, stdoutOAuthChannel());
  try {
    return await conn.listTools();
  } finally {
    await conn.close();
  }
}

function stdoutOAuthChannel(): OAuthChannel {
  // All OAuth status is emitted on stderr so `koi mcp install --json` keeps
  // stdout strictly machine-readable. The user still sees the
  // authorization URL when running interactively (terminals show stderr by
  // default); scripts piping stdout to a parser are unaffected.
  return {
    onAuthRequired(n: AuthRequiredNotification): void {
      process.stderr.write(`\n[oauth] ${n.message}\n`);
      if (n.authUrl !== undefined) {
        process.stderr.write(`[oauth] Open this URL to authorize ${n.provider}:\n  ${n.authUrl}\n`);
      }
    },
    onAuthComplete(n: AuthCompleteNotification): void {
      process.stderr.write(`[oauth] ${n.provider} authorization complete.\n`);
    },
    onAuthFailure(n: AuthFailureNotification): void {
      process.stderr.write(`[oauth] ${n.provider} authorization failed: ${n.reason}\n`);
    },
    submitAuthCode(): void {
      // Local-mode flow only — the loopback callback delivers the code
      // directly. Remote-mode submission is not supported from CLI install.
    },
  };
}

function candidateMcpJsonPaths(): readonly string[] {
  const cwd = process.cwd();
  const home = process.env.HOME ?? ".";
  return [
    resolve(cwd, ".mcp.json"),
    resolve(home, ".koi", ".mcp.json"),
    resolve(home, ".claude", ".mcp.json"),
  ];
}

function resolveActiveMcpJsonPath(): string {
  // Pick the first existing candidate; fall back to project-local for
  // a fresh install.
  for (const candidate of candidateMcpJsonPaths()) {
    if (existsSync(candidate)) return candidate;
  }
  return resolve(process.cwd(), ".mcp.json");
}

async function resolveMcpJsonPathContaining(
  name: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  // Walk candidates in priority order. CRITICAL: a malformed
  // higher-priority file (project ./.mcp.json) must NOT silently
  // fall through to the home config. Running uninstall from a
  // directory with a broken project file would otherwise delete
  // the home entry of the same name. Stop and surface the error
  // so the operator can fix the local file before we touch state
  // they may not have intended to modify.
  for (const candidate of candidateMcpJsonPaths()) {
    if (!existsSync(candidate)) continue;
    let text: string;
    try {
      text = await Bun.file(candidate).text();
    } catch (err: unknown) {
      return {
        ok: false,
        error: `Cannot read ${candidate}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      return {
        ok: false,
        error: `Refusing to fall through: ${candidate} is malformed (${err instanceof Error ? err.message : String(err)}). Fix or remove it before running uninstall.`,
      };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: `Refusing to fall through: ${candidate} did not contain a JSON object. Fix or remove it before running uninstall.`,
      };
    }
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (
      servers !== undefined &&
      (servers === null || typeof servers !== "object" || Array.isArray(servers))
    ) {
      return {
        ok: false,
        error: `Refusing to fall through: ${candidate} has a malformed mcpServers field. Fix it before running uninstall.`,
      };
    }
    if (servers !== undefined && Object.hasOwn(servers, name)) {
      return { ok: true, path: candidate };
    }
    // Well-formed but does not claim `name`: keep searching for an
    // entry in lower-priority files.
  }
  // No candidate file claimed the entry. Default to project-local so the
  // downstream NOT_FOUND error is reported against a sensible path.
  return { ok: true, path: resolve(process.cwd(), ".mcp.json") };
}

interface OAuthTarget {
  readonly name: string;
  readonly url: string;
}

async function readOAuthTargetFromRawConfig(
  configPath: string,
  name: string,
): Promise<OAuthTarget | undefined> {
  // Best-effort, defensive raw read. Cannot rely on `loadMcpJsonFile` because
  // it normalizes/filters entries. We just need {url} for the http entry
  // matching `name` so cleanup can walk its OAuth state.
  try {
    const text = await Bun.file(configPath).text();
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers === null || typeof servers !== "object") return undefined;
    const entry = (servers as Record<string, unknown>)[name];
    if (entry === null || typeof entry !== "object") return undefined;
    const e = entry as { type?: unknown; url?: unknown };
    if ((e.type === undefined || e.type === "http") && typeof e.url === "string") {
      return { name, url: e.url };
    }
  } catch {
    /* malformed file or absent — no OAuth target */
  }
  return undefined;
}

function clearAllOAuthStateFor(target: OAuthTarget): (name: string) => Promise<void> {
  // Storage failures (keychain locked, permission denied, corrupt
  // record) propagate up to the installer/uninstaller, which converts
  // them into a partial-success error so the operator learns that
  // credentials may persist instead of a false "removed" report.
  return async (_name: string): Promise<void> => {
    const storage = createSecureStorage();
    await clearAllOAuthState(storage, target.name, target.url);
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
