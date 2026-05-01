/**
 * MCP server installer — translates a registry `RegistryServer` into a Koi
 * `.mcp.json` entry, optionally verifies the install with a real connection,
 * and supports a clean uninstall.
 *
 * The connection-verify step is dependency-injected so the CLI layer (which
 * owns the OAuth runtime + secure-storage wiring) controls what "verify"
 * actually means.
 */

import type { KoiError, Result } from "@koi/core";
import type { ExternalServerConfig, ResolvedMcpServerConfig } from "./config.js";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  normalizeMcpServers,
} from "./config.js";
import type { McpToolInfo } from "./connection.js";
import { addServerToMcpJson, removeServerFromMcpJson } from "./mcp-json-write.js";
import type { RegistryPackage, RegistryServer } from "./registry/schema.js";

export interface InstallerDeps {
  readonly verifyConnection?: (
    config: ResolvedMcpServerConfig,
  ) => Promise<Result<readonly McpToolInfo[], KoiError>>;
  readonly clearStoredCredentials?: (name: string) => Promise<void>;
}

export interface InstallOptions {
  readonly server: RegistryServer;
  readonly configPath: string;
  readonly overwrite?: boolean;
  readonly skipVerify?: boolean;
  readonly deps?: InstallerDeps;
}

export interface UninstallOptions {
  readonly name: string;
  readonly configPath: string;
  readonly deps?: Pick<InstallerDeps, "clearStoredCredentials">;
}

export function pickPackageForInstall(
  server: RegistryServer,
): Result<ExternalServerConfig, KoiError> {
  const httpRemote = server.remotes?.find((r) => (r.transport?.type ?? "http") === "http");
  if (httpRemote !== undefined) {
    return { ok: true, value: { type: "http", url: httpRemote.url } };
  }
  const sseRemote = server.remotes?.find((r) => r.transport?.type === "sse");
  if (sseRemote !== undefined) {
    return { ok: true, value: { type: "sse", url: sseRemote.url } };
  }
  for (const pkg of server.packages ?? []) {
    const stdio = packageToStdio(pkg);
    if (stdio !== undefined) return { ok: true, value: stdio };
  }
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message: `Registry entry "${server.name}@${server.version}" has no installable package or remote`,
      retryable: false,
      context: { name: server.name, version: server.version },
    },
  };
}

function packageToStdio(pkg: RegistryPackage): ExternalServerConfig | undefined {
  const version = pkg.version ?? "latest";
  if (pkg.registryType === "npm") {
    return { type: "stdio", command: "npx", args: ["-y", `${pkg.identifier}@${version}`] };
  }
  if (pkg.registryType === "pypi") {
    return { type: "stdio", command: "uvx", args: [`${pkg.identifier}==${version}`] };
  }
  if (pkg.registryType === "oci") {
    const image = `${pkg.identifier}:${version}`;
    return { type: "stdio", command: "docker", args: ["run", "-i", "--rm", image] };
  }
  return undefined;
}

export async function installMcpServer(
  options: InstallOptions,
): Promise<Result<{ readonly entry: ExternalServerConfig }, KoiError>> {
  const picked = pickPackageForInstall(options.server);
  if (!picked.ok) return picked;
  const entry = picked.value;

  const added = await addServerToMcpJson(options.configPath, options.server.name, entry, {
    overwrite: options.overwrite ?? false,
  });
  if (!added.ok) return added;

  if (options.skipVerify === true) {
    return { ok: true, value: { entry } };
  }

  const verify = options.deps?.verifyConnection;
  if (verify === undefined) {
    return { ok: true, value: { entry } };
  }

  const resolved = resolveForVerify(options.server.name, entry);
  if (!resolved.ok) {
    await rollback(options.configPath, options.server.name);
    return resolved;
  }

  const verified = await verify(resolved.value);
  if (!verified.ok) {
    await rollback(options.configPath, options.server.name);
    return {
      ok: false,
      error: {
        ...verified.error,
        message: `Install verification failed for "${options.server.name}": ${verified.error.message}`,
      },
    };
  }

  return { ok: true, value: { entry } };
}

export async function uninstallMcpServer(
  options: UninstallOptions,
): Promise<Result<void, KoiError>> {
  const removed = await removeServerFromMcpJson(options.configPath, options.name);
  if (!removed.ok) return removed;
  const clear = options.deps?.clearStoredCredentials;
  if (clear !== undefined) {
    try {
      await clear(options.name);
    } catch {
      // Best-effort credential cleanup. The mcp.json removal already succeeded.
    }
  }
  return { ok: true, value: undefined };
}

function resolveForVerify(
  name: string,
  entry: ExternalServerConfig,
): Result<ResolvedMcpServerConfig, KoiError> {
  const { servers, rejected } = normalizeMcpServers({ [name]: entry });
  const internal = servers[0];
  if (internal === undefined) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Cannot verify "${name}": ${rejected[0] ?? "transport not supported"}`,
        retryable: false,
        context: { name },
      },
    };
  }
  return {
    ok: true,
    value: {
      name: internal.name,
      server: internal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
    },
  };
}

async function rollback(configPath: string, name: string): Promise<void> {
  // Best-effort rollback. Ignore errors — the install already failed and we
  // don't want to mask the original error with a rollback failure.
  try {
    await removeServerFromMcpJson(configPath, name);
  } catch {
    /* swallow */
  }
}
