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
  // Walk every advertised install candidate before declaring a registry
  // entry non-installable. The previous behavior bailed at the first
  // unusable remote (e.g. one that needs a manual header) even when a
  // perfectly usable package or alternate remote followed it. Now we
  // collect every reject reason and only fail when *no* candidate
  // worked, so a guarded HTTP remote no longer hides a usable npm
  // package alongside it.
  const rejects: string[] = [];

  for (const remote of server.remotes ?? []) {
    const transport = remote.transport?.type ?? "http";
    if (transport !== "http" && transport !== "sse") continue;
    // Refuse plaintext / non-HTTPS remote URLs from the registry. Loopback
    // (127.0.0.1, ::1, localhost) is allowed for local-dev workflows since
    // it never crosses the trust boundary the HTTPS rule is protecting.
    // Anything else — http://, ws://, file://, malformed — is rejected
    // before it can be persisted into .mcp.json.
    const urlCheck = validateRemoteUrl(remote.url);
    if (!urlCheck.ok) {
      rejects.push(`${transport} remote ${remote.url}: ${urlCheck.error}`);
      continue;
    }
    const headersResult = remoteHeaders(remote.headers);
    if (!headersResult.ok) {
      rejects.push(`${transport} remote ${remote.url}: ${headersResult.error.message}`);
      continue;
    }
    const headers = headersResult.value;
    if (transport === "http") {
      // Always include an empty `oauth` block so `koi mcp auth <name>`
      // can run Dynamic Client Registration if the server requires auth.
      // The OAuth provider is only consulted on a 401, so this is inert
      // for servers that don't require authentication.
      const cfg: ExternalServerConfig = {
        type: "http",
        url: remote.url,
        oauth: {},
        ...(headers !== undefined ? { headers } : {}),
      };
      return { ok: true, value: cfg };
    }
    const cfg: ExternalServerConfig = {
      type: "sse",
      url: remote.url,
      ...(headers !== undefined ? { headers } : {}),
    };
    return { ok: true, value: cfg };
  }

  for (const pkg of server.packages ?? []) {
    const stdio = packageToStdio(pkg);
    if (stdio.kind === "ok") return { ok: true, value: stdio.value };
    if (stdio.kind === "reject") {
      rejects.push(`package ${pkg.registryType}:${pkg.identifier}: ${stdio.reason}`);
    }
  }

  if (rejects.length > 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          `Registry entry "${server.name}@${server.version}" has no auto-installable candidate ` +
          `(${rejects.length} candidate${rejects.length === 1 ? "" : "s"} require manual config: ` +
          `${rejects.join("; ")})`,
        retryable: false,
        context: { name: server.name, version: server.version, rejected: rejects },
      },
    };
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

function validateRemoteUrl(raw: string): { ok: true } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "URL is not parseable" };
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  // Loopback is allowed under either http: or https: for local-dev
  // workflows — it never crosses the trust boundary the SSRF check is
  // protecting.
  if (isLoopback) {
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return { ok: true };
    return { ok: false, error: `unsupported URL scheme "${parsed.protocol}"` };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: `unsupported URL scheme "${parsed.protocol}" (expected https:)` };
  }
  // HTTPS but non-loopback. Refuse private / link-local / multicast /
  // reserved IPs by default — registry metadata is being treated as
  // authority to make outbound connections, and a hostile entry should
  // not be able to drive the CLI into the operator's internal network.
  // Hostnames are not resolved here (DNS lookups happen during connect)
  // so we only block IP-literal targets; an attacker who controls
  // public DNS to point at RFC1918 still gets through, but that is a
  // significantly higher bar and out of scope for one-click install.
  if (isPrivateOrReservedIp(host)) {
    return {
      ok: false,
      error: `host ${host} is in a private/reserved range; refuse to install non-public remote`,
    };
  }
  return { ok: true };
}

function isPrivateOrReservedIp(host: string): boolean {
  // IPv4 dotted-quad detection.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const o = v4.slice(1, 5).map((s) => Number.parseInt(s, 10));
    if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    const a = o[0] ?? 0;
    const b = o[1] ?? 0;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback (also caught above)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 0) return true; // 0.0.0.0/8
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  // IPv6 — match common private/reserved prefixes. URLs wrap v6 in
  // brackets which URL.hostname strips; we accept either form.
  const stripped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = stripped.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9")) return true;
  if (lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local fe80::/10
  if (lower.startsWith("ff")) return true; // multicast
  return false;
}

interface RegistryHeader {
  readonly name?: unknown;
  readonly value?: unknown;
  readonly default?: unknown;
  readonly isRequired?: unknown;
}

/**
 * Coerce a registry-supplied field to a string only when it actually is one.
 * Anything else (numbers, objects, nulls) returns undefined so we never
 * persist non-string args/env/headers into `.mcp.json` — the file's own
 * Zod schema would reject the whole config on the next load.
 */
function asStringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function remoteHeaders(
  headers: readonly unknown[] | undefined,
): Result<Readonly<Record<string, string>> | undefined, KoiError> {
  if (headers === undefined || headers.length === 0) return { ok: true, value: undefined };
  const records = headers.filter((h): h is RegistryHeader => h !== null && typeof h === "object");
  const out: Record<string, string> = {};
  for (const h of records) {
    const name = asStringField(h.name);
    const concrete = asStringField(h.value) ?? asStringField(h.default);
    if (concrete === undefined) {
      if (h.isRequired === true) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Registry remote requires header${name !== undefined ? ` "${name}"` : ""} but no string value/default provided. Add it manually.`,
            retryable: false,
            context: { headerName: name },
          },
        };
      }
      continue;
    }
    if (name === undefined) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Registry remote header has a non-string name field; refusing to install.`,
          retryable: false,
          context: { received: typeof h.name },
        },
      };
    }
    out[name] = concrete;
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
  readonly type?: unknown;
  readonly value?: unknown;
  readonly default?: unknown;
  readonly name?: unknown;
  readonly isRequired?: unknown;
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
    const concrete = asStringField(a.value) ?? asStringField(a.default);
    const name = asStringField(a.name);
    if (concrete === undefined && a.isRequired === true) {
      return `${field} entry${name !== undefined ? ` "${name}"` : ""} requires a string value`;
    }
    // Reject obviously malformed records (non-string `value` when present).
    if (a.value !== undefined && typeof a.value !== "string") {
      return `${field}${name !== undefined ? ` "${name}"` : ""} has a non-string value field`;
    }
  }
  return undefined;
}

function collectArgValues(args: readonly unknown[] | undefined): readonly string[] {
  const out: string[] = [];
  for (const a of asArgRecords(args)) {
    const concrete = asStringField(a.value) ?? asStringField(a.default);
    if (concrete === undefined) continue;
    const type = asStringField(a.type);
    const name = asStringField(a.name);
    if (type === "named" && name !== undefined) {
      out.push(name, concrete);
    } else {
      out.push(concrete);
    }
  }
  return out;
}

interface RegistryEnvVar {
  readonly name?: unknown;
  readonly default?: unknown;
  readonly value?: unknown;
  readonly isRequired?: unknown;
}

function asEnvRecords(vars: readonly unknown[] | undefined): readonly RegistryEnvVar[] {
  if (vars === undefined) return [];
  return vars.filter((v): v is RegistryEnvVar => v !== null && typeof v === "object");
}

function collectRequiredEnvNames(vars: readonly unknown[] | undefined): readonly string[] {
  const out: string[] = [];
  for (const v of asEnvRecords(vars)) {
    const name = asStringField(v.name);
    const hasConcrete =
      asStringField(v.value) !== undefined || asStringField(v.default) !== undefined;
    if (v.isRequired === true && !hasConcrete && name !== undefined) {
      out.push(name);
    }
  }
  return out;
}

function collectEnvDefaults(
  vars: readonly unknown[] | undefined,
): Readonly<Record<string, string>> | undefined {
  const out: Record<string, string> = {};
  for (const v of asEnvRecords(vars)) {
    const concrete = asStringField(v.value) ?? asStringField(v.default);
    const name = asStringField(v.name);
    if (concrete !== undefined && name !== undefined) {
      out[name] = concrete;
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

  // Verify-before-commit: previously the entry was written first and
  // verification followed. That window made install non-atomic — other
  // Koi processes (CLI, TUI) could observe an unverified entry while a
  // long-running OAuth flow stalled. Now we resolve + verify against
  // the picked entry without touching `.mcp.json`, then write only on
  // success. No rollback needed for verify failure; the file was never
  // mutated.

  if (options.skipVerify !== true) {
    const verify = options.deps?.verifyConnection;
    if (verify !== undefined) {
      const resolved = resolveForVerify(options.server.name, entry);
      if (!resolved.ok) {
        return await abortWithCredentialCleanup(
          options.server.name,
          resolved.error,
          options.deps?.clearStoredCredentials,
        );
      }
      const verified = await verify(resolved.value);
      if (!verified.ok) {
        return await abortWithCredentialCleanup(
          options.server.name,
          {
            ...verified.error,
            message: `Install verification failed for "${options.server.name}": ${verified.error.message}`,
          },
          options.deps?.clearStoredCredentials,
        );
      }
    }
  }

  // Verification succeeded (or was skipped). Commit to .mcp.json.
  const added = await addServerToMcpJson(options.configPath, options.server.name, entry, {
    overwrite: options.overwrite ?? false,
  });
  if (!added.ok) {
    // CONFLICT requires care. If the existing entry targets the SAME
    // URL/transport as ours, this is the concurrent-install race —
    // the winner owns the now-shared OAuth state and we must NOT
    // clean up. If the existing entry is a different target with the
    // same name (version skew, different transport), then any tokens
    // we persisted during verify belong to OUR target, not the
    // winner's, and orphan-cleanup is the right call.
    if (added.error.code === "CONFLICT") {
      const sameTarget = await existingEntryMatchesTarget(
        options.configPath,
        options.server.name,
        entry,
      );
      if (sameTarget) return { ok: false, error: added.error };
    }
    return await abortWithCredentialCleanup(
      options.server.name,
      added.error,
      options.deps?.clearStoredCredentials,
    );
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
    } catch (cause: unknown) {
      // Config removal succeeded but credential cleanup failed — the
      // server is gone from .mcp.json but live OAuth material may still
      // exist on disk/keychain. Surface the partial-success state so
      // operators can complete cleanup manually.
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message:
            `Removed "${options.name}" from ${options.configPath} but credential cleanup ` +
            `failed: ${cause instanceof Error ? cause.message : String(cause)}. ` +
            `Stored OAuth material may persist; clear it manually.`,
          retryable: false,
          cause: cause instanceof Error ? cause : undefined,
          context: {
            name: options.name,
            configPath: options.configPath,
            credentialCleanupFailed: true,
          },
        },
      };
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

async function existingEntryMatchesTarget(
  configPath: string,
  name: string,
  target: ExternalServerConfig,
): Promise<boolean> {
  // Best-effort raw read. On any error (file gone, malformed, race
  // with another writer) we conservatively return `false` so the
  // caller treats the conflict as a different-target situation and
  // runs cleanup — leaking creds is worse than wiping our own.
  try {
    const text = await Bun.file(configPath).text();
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return false;
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (servers === null || typeof servers !== "object") return false;
    const existing = (servers as Record<string, unknown>)[name];
    if (existing === null || typeof existing !== "object") return false;
    const e = existing as { type?: unknown; url?: unknown; command?: unknown };
    if (target.type === "http" || target.type === "sse") {
      const eType = (e.type as string | undefined) ?? "http";
      return eType === target.type && e.url === target.url;
    }
    // stdio
    return e.command === target.command;
  } catch {
    return false;
  }
}

/**
 * Verify-before-commit aborts never wrote to .mcp.json, so there is
 * nothing to roll back. We only need to wipe credentials that
 * verification (e.g. an OAuth flow) may have persisted before the
 * outer failure was decided. If credential cleanup itself fails,
 * surface it — silent failure here means a "cleanly aborted" install
 * can still leave an authorized server on disk/keychain.
 */
async function abortWithCredentialCleanup(
  name: string,
  primaryError: KoiError,
  clearCredentials?: (name: string) => Promise<void>,
): Promise<Result<never, KoiError>> {
  if (clearCredentials === undefined) {
    return { ok: false, error: primaryError };
  }
  let credentialError: string | undefined;
  try {
    await clearCredentials(name);
  } catch (cause: unknown) {
    credentialError = cause instanceof Error ? cause.message : String(cause);
  }
  if (credentialError === undefined) {
    return { ok: false, error: primaryError };
  }
  return {
    ok: false,
    error: {
      ...primaryError,
      message:
        `${primaryError.message}. Credential cleanup failed (${credentialError}); ` +
        `stored OAuth material may persist.`,
      context: {
        ...(primaryError.context ?? {}),
        credentialCleanupFailed: true,
        credentialError,
      },
    },
  };
}
