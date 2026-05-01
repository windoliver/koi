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
    const headersResult = remoteHeaders(httpRemote.headers);
    if (!headersResult.ok) return headersResult;
    const headers = headersResult.value;
    // Always include an empty `oauth` block so `koi mcp auth <name>`
    // can run Dynamic Client Registration if the server requires auth.
    // The OAuth provider is only consulted on a 401, so this is inert
    // for servers that don't require authentication.
    const cfg: ExternalServerConfig = {
      type: "http",
      url: httpRemote.url,
      oauth: {},
      ...(headers !== undefined ? { headers } : {}),
    };
    return { ok: true, value: cfg };
  }
  const sseRemote = server.remotes?.find((r) => r.transport?.type === "sse");
  if (sseRemote !== undefined) {
    const headersResult = remoteHeaders(sseRemote.headers);
    if (!headersResult.ok) return headersResult;
    const headers = headersResult.value;
    const cfg: ExternalServerConfig = {
      type: "sse",
      url: sseRemote.url,
      ...(headers !== undefined ? { headers } : {}),
    };
    return { ok: true, value: cfg };
  }
  for (const pkg of server.packages ?? []) {
    const stdio = packageToStdio(pkg);
    if (stdio.kind === "ok") return { ok: true, value: stdio.value };
    if (stdio.kind === "reject") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Registry entry "${server.name}@${server.version}" requires manual configuration: ${stdio.reason}`,
          retryable: false,
          context: { name: server.name, version: server.version, reason: stdio.reason },
        },
      };
    }
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

interface RegistryHeader {
  readonly name?: string;
  readonly value?: string;
  readonly default?: string;
  readonly isRequired?: boolean;
}

function remoteHeaders(
  headers: readonly unknown[] | undefined,
): Result<Readonly<Record<string, string>> | undefined, KoiError> {
  if (headers === undefined || headers.length === 0) return { ok: true, value: undefined };
  const records = headers.filter((h): h is RegistryHeader => h !== null && typeof h === "object");
  const out: Record<string, string> = {};
  for (const h of records) {
    const concrete = h.value ?? h.default;
    if (concrete === undefined) {
      if (h.isRequired === true) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Registry remote requires header${h.name !== undefined ? ` "${h.name}"` : ""} but no value/default provided. Add it manually.`,
            retryable: false,
            context: { headerName: h.name },
          },
        };
      }
      continue;
    }
    if (h.name !== undefined) out[h.name] = concrete;
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined };
}

type StdioPick =
  | { readonly kind: "ok"; readonly value: ExternalServerConfig }
  | { readonly kind: "skip" }
  | { readonly kind: "reject"; readonly reason: string };

function packageToStdio(pkg: RegistryPackage): StdioPick {
  const version = pkg.version ?? "latest";
  // Registry packages may declare required env vars or non-concrete arguments
  // that need user input. Reject those explicitly so the user knows to edit
  // .mcp.json manually instead of installing a silently broken entry.
  const requiredEnv = collectRequiredEnvNames(pkg.environmentVariables);
  if (requiredEnv.length > 0) {
    return {
      kind: "reject",
      reason: `package declares required environment variables (${requiredEnv.join(", ")}). Set them and add the server manually.`,
    };
  }
  const argRejection = checkArgsResolvable(pkg.runtimeArguments, "runtimeArguments");
  if (argRejection !== undefined) return { kind: "reject", reason: argRejection };
  const pkgArgRejection = checkArgsResolvable(pkg.packageArguments, "packageArguments");
  if (pkgArgRejection !== undefined) return { kind: "reject", reason: pkgArgRejection };

  const runtimeArgs = collectArgValues(pkg.runtimeArguments);
  const packageArgs = collectArgValues(pkg.packageArguments);
  const env = collectEnvDefaults(pkg.environmentVariables);

  if (pkg.registryType === "npm") {
    return makeStdio(
      "npx",
      ["-y", ...runtimeArgs, `${pkg.identifier}@${version}`, ...packageArgs],
      env,
    );
  }
  if (pkg.registryType === "pypi") {
    return makeStdio("uvx", [...runtimeArgs, `${pkg.identifier}==${version}`, ...packageArgs], env);
  }
  if (pkg.registryType === "oci") {
    const image = `${pkg.identifier}:${version}`;
    return makeStdio("docker", ["run", "-i", "--rm", ...runtimeArgs, image, ...packageArgs], env);
  }
  return { kind: "skip" };
}

function makeStdio(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
): StdioPick {
  const cfg: ExternalServerConfig = {
    type: "stdio",
    command,
    args,
    ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
  };
  return { kind: "ok", value: cfg };
}

interface RegistryArgRecord {
  readonly type?: string;
  readonly value?: string;
  readonly default?: string;
  readonly name?: string;
  readonly isRequired?: boolean;
}

function asArgRecords(args: readonly unknown[] | undefined): readonly RegistryArgRecord[] {
  if (args === undefined) return [];
  return args.filter((a): a is RegistryArgRecord => a !== null && typeof a === "object");
}

function checkArgsResolvable(
  args: readonly unknown[] | undefined,
  field: string,
): string | undefined {
  for (const a of asArgRecords(args)) {
    const concrete = a.value ?? a.default;
    if (concrete === undefined && a.isRequired === true) {
      return `${field} entry${a.name !== undefined ? ` "${a.name}"` : ""} requires a value`;
    }
  }
  return undefined;
}

function collectArgValues(args: readonly unknown[] | undefined): readonly string[] {
  const out: string[] = [];
  for (const a of asArgRecords(args)) {
    const concrete = a.value ?? a.default;
    if (concrete === undefined) continue;
    if (a.type === "named" && a.name !== undefined) {
      out.push(a.name, concrete);
    } else {
      out.push(concrete);
    }
  }
  return out;
}

interface RegistryEnvVar {
  readonly name?: string;
  readonly default?: string;
  readonly value?: string;
  readonly isRequired?: boolean;
}

function asEnvRecords(vars: readonly unknown[] | undefined): readonly RegistryEnvVar[] {
  if (vars === undefined) return [];
  return vars.filter((v): v is RegistryEnvVar => v !== null && typeof v === "object");
}

function collectRequiredEnvNames(vars: readonly unknown[] | undefined): readonly string[] {
  const out: string[] = [];
  for (const v of asEnvRecords(vars)) {
    if (
      v.isRequired === true &&
      v.value === undefined &&
      v.default === undefined &&
      v.name !== undefined
    ) {
      out.push(v.name);
    }
  }
  return out;
}

function collectEnvDefaults(
  vars: readonly unknown[] | undefined,
): Readonly<Record<string, string>> | undefined {
  const out: Record<string, string> = {};
  for (const v of asEnvRecords(vars)) {
    const concrete = v.value ?? v.default;
    if (concrete !== undefined && v.name !== undefined) {
      out[v.name] = concrete;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
    return await failWithRollback(options.configPath, options.server.name, resolved.error);
  }

  const verified = await verify(resolved.value);
  if (!verified.ok) {
    return await failWithRollback(options.configPath, options.server.name, {
      ...verified.error,
      message: `Install verification failed for "${options.server.name}": ${verified.error.message}`,
    });
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

async function failWithRollback(
  configPath: string,
  name: string,
  primaryError: KoiError,
): Promise<Result<never, KoiError>> {
  let rollbackResult: Result<void, KoiError>;
  try {
    rollbackResult = await removeServerFromMcpJson(configPath, name);
  } catch (cause: unknown) {
    rollbackResult = {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `rollback threw: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryable: false,
        cause: cause instanceof Error ? cause : undefined,
        context: { configPath, name },
      },
    };
  }
  if (rollbackResult.ok) {
    return { ok: false, error: primaryError };
  }
  // Rollback failed: surface that the partial install is still on disk so
  // the user can fix it manually instead of silently leaving a broken entry.
  return {
    ok: false,
    error: {
      ...primaryError,
      message:
        `${primaryError.message}. Rollback also failed (${rollbackResult.error.message}); ` +
        `manual cleanup of "${name}" from ${configPath} is required.`,
      context: {
        ...(primaryError.context ?? {}),
        rollbackError: rollbackResult.error.message,
        cleanupRequired: true,
      },
    },
  };
}
