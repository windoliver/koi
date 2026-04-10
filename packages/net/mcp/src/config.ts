/**
 * MCP server configuration — three-layer schema pipeline.
 *
 * Layer 1 (External): CC-compatible `.mcp.json` format — `type` discriminator,
 *   record-keyed, accepts all CC transport types + headersHelper/oauth fields.
 * Layer 2 (Internal): Koi convention — `kind` discriminator, named objects,
 *   only supported transports (stdio, http, sse), env vars resolved.
 * Layer 3 (Resolved): Defaults applied, ready for createMcpConnection().
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import { expandEnvVars, expandEnvVarsInRecord } from "./env.js";

// ===========================================================================
// Layer 1 — External Schema (CC-compatible input)
// ===========================================================================

/**
 * Builds all external schemas. Wrapped in a function so that
 * isolatedDeclarations doesn't require explicit annotations on
 * every intermediate schema const.
 */
function buildExternalSchemas() {
  const oauth = z.object({
    clientId: z.string().optional(),
    callbackPort: z.number().int().positive().optional(),
    authServerMetadataUrl: z.string().url().optional(),
    xaa: z.boolean().optional(),
  });

  const stdio = z.object({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  });

  const sse = z.object({
    type: z.literal("sse"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: oauth.optional(),
  });

  const http = z.object({
    type: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
    oauth: oauth.optional(),
  });

  const ws = z.object({
    type: z.literal("ws"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    headersHelper: z.string().optional(),
  });

  const sdk = z.object({ type: z.literal("sdk"), name: z.string() });

  const sseIde = z.object({
    type: z.literal("sse-ide"),
    url: z.string(),
    ideName: z.string(),
    ideRunningInWindows: z.boolean().optional(),
  });

  const wsIde = z.object({
    type: z.literal("ws-ide"),
    url: z.string(),
    ideName: z.string(),
    authToken: z.string().optional(),
    ideRunningInWindows: z.boolean().optional(),
  });

  const claudeAiProxy = z.object({
    type: z.literal("claudeai-proxy"),
    url: z.string(),
    id: z.string(),
  });

  // Stdio last — its `type` is optional, so it's the fallback.
  const serverConfig = z.union([sse, http, ws, sdk, sseIde, wsIde, claudeAiProxy, stdio]);

  const mcpJson = z.object({
    mcpServers: z.record(z.string(), serverConfig),
  });

  return {
    serverConfig: serverConfig as z.ZodType<ExternalServerConfig>,
    mcpJson: mcpJson as z.ZodType<McpJsonConfig>,
  };
}

/** CC-compatible server config (all CC transport types). */
export interface ExternalServerConfig {
  readonly type?: "stdio" | "sse" | "http" | "ws" | "sdk" | "sse-ide" | "ws-ide" | "claudeai-proxy";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly headersHelper?: string;
  readonly oauth?: {
    readonly clientId?: string;
    readonly callbackPort?: number;
    readonly authServerMetadataUrl?: string;
    readonly xaa?: boolean;
  };
  readonly name?: string;
  readonly id?: string;
  readonly ideName?: string;
  readonly authToken?: string;
  readonly ideRunningInWindows?: boolean;
}

/** CC-compatible `.mcp.json` top-level structure. */
export interface McpJsonConfig {
  readonly mcpServers: Readonly<Record<string, ExternalServerConfig>>;
}

const _schemas: {
  serverConfig: z.ZodType<ExternalServerConfig>;
  mcpJson: z.ZodType<McpJsonConfig>;
} = buildExternalSchemas();

/** CC-compatible server config Zod schema. */
export const externalServerConfigSchema: z.ZodType<ExternalServerConfig> = _schemas.serverConfig;
/** CC-compatible `.mcp.json` Zod schema. */
export const mcpJsonSchema: z.ZodType<McpJsonConfig> = _schemas.mcpJson;

// ===========================================================================
// Layer 2 — Internal Config (Koi convention)
// ===========================================================================

/** Supported transport kinds in Koi (subset of CC's transport types). */
export type McpTransportKind = "stdio" | "http" | "sse";

export interface StdioServerConfig {
  readonly kind: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface McpOAuthExternalConfig {
  readonly clientId?: string | undefined;
  readonly callbackPort?: number | undefined;
  readonly authServerMetadataUrl?: string | undefined;
}

export interface HttpServerConfig {
  readonly kind: "http";
  readonly name: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly oauth?: McpOAuthExternalConfig | undefined;
}

export interface SseServerConfig {
  readonly kind: "sse";
  readonly name: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig | SseServerConfig;

// ===========================================================================
// Layer 3 — Resolved Config (defaults applied)
// ===========================================================================

export interface ResolvedMcpServerConfig {
  readonly name: string;
  readonly server: McpServerConfig;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxReconnectAttempts: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;

// ===========================================================================
// Normalization: External → Internal
// ===========================================================================

/** Transport types that Koi supports. Others are silently filtered. */
const SUPPORTED_TYPES: ReadonlySet<string> = new Set(["stdio", "http", "sse"]);

export interface NormalizeResult {
  readonly servers: readonly McpServerConfig[];
  /** Servers with unsupported transport types (ws, sdk, etc.). */
  readonly unsupported: readonly string[];
  /** Servers that use unimplemented auth features (headersHelper, oauth). */
  readonly rejected: readonly string[];
}

/**
 * Normalizes a CC-compatible mcpServers record into Koi's internal format.
 * Filters unsupported transport types and expands env vars.
 */
export function normalizeMcpServers(
  mcpServers: Readonly<Record<string, ExternalServerConfig>>,
): NormalizeResult {
  const servers: McpServerConfig[] = [];
  const unsupported: string[] = [];
  const rejected: string[] = [];

  for (const [name, config] of Object.entries(mcpServers)) {
    const transportType = config.type ?? "stdio";

    if (!SUPPORTED_TYPES.has(transportType)) {
      unsupported.push(`${name} (${transportType})`);
      continue;
    }

    // Reject configs using auth features that are not yet implemented.
    // Silently dropping these would cause opaque 401/403 failures at runtime.
    if (config.headersHelper !== undefined) {
      rejected.push(`${name}: headersHelper is not yet supported`);
      continue;
    }
    // OAuth is supported for HTTP transport only. SSE transport does not
    // inject auth headers, so OAuth + SSE would silently fail with 401.
    if (config.oauth !== undefined && (config.type ?? "stdio") !== "http") {
      rejected.push(
        `${name}: OAuth is only supported with HTTP transport (not ${config.type ?? "stdio"})`,
      );
      continue;
    }
    // clientId is required for OAuth — dynamic client registration not yet supported
    if (config.oauth !== undefined && config.oauth.clientId === undefined) {
      rejected.push(
        `${name}: OAuth requires clientId (dynamic client registration not yet supported)`,
      );
      continue;
    }

    const result = normalizeOne(name, config);
    if (result === undefined) continue;
    if ("rejection" in result) {
      rejected.push(result.rejection);
      continue;
    }
    servers.push(result.server);
  }

  return { servers, unsupported, rejected };
}

/**
 * Normalizes a single CC external config into a Koi internal config.
 * Returns undefined for unsupported types.
 * Returns a rejection string if required env vars are missing.
 */
function normalizeOne(
  name: string,
  config: ExternalServerConfig,
): { readonly server: McpServerConfig } | { readonly rejection: string } | undefined {
  const type = config.type ?? "stdio";
  const allMissing: string[] = [];

  function expand(value: string): string {
    const { expanded, missing } = expandEnvVars(value);
    allMissing.push(...missing);
    return expanded;
  }

  function expandRecord(record: Record<string, string>): Record<string, string> {
    const { expanded, missing } = expandEnvVarsInRecord(record);
    allMissing.push(...missing);
    return expanded;
  }

  switch (type) {
    case "stdio": {
      const c = config as { command: string; args?: string[]; env?: Record<string, string> };
      const env = c.env !== undefined ? expandRecord(c.env) : undefined;
      const server: McpServerConfig = {
        kind: "stdio",
        name,
        command: expand(c.command),
        args: c.args !== undefined && c.args.length > 0 ? c.args : undefined,
        env: env !== undefined && Object.keys(env).length > 0 ? env : undefined,
      };
      if (allMissing.length > 0) {
        return { rejection: `${name}: missing env vars: ${allMissing.join(", ")}` };
      }
      return { server };
    }
    case "http": {
      const c = config as {
        url: string;
        headers?: Record<string, string>;
        oauth?: { clientId?: string; callbackPort?: number; authServerMetadataUrl?: string };
      };
      const headers = c.headers !== undefined ? expandRecord(c.headers) : undefined;
      const oauth: McpOAuthExternalConfig | undefined =
        c.oauth !== undefined
          ? {
              clientId: c.oauth.clientId,
              callbackPort: c.oauth.callbackPort,
              authServerMetadataUrl: c.oauth.authServerMetadataUrl,
            }
          : undefined;
      const server: McpServerConfig = {
        kind: "http",
        name,
        url: expand(c.url),
        headers: headers !== undefined && Object.keys(headers).length > 0 ? headers : undefined,
        oauth,
      };
      if (allMissing.length > 0) {
        return { rejection: `${name}: missing env vars: ${allMissing.join(", ")}` };
      }
      return { server };
    }
    case "sse": {
      const c = config as { url: string; headers?: Record<string, string> };
      const headers = c.headers !== undefined ? expandRecord(c.headers) : undefined;
      const server: McpServerConfig = {
        kind: "sse",
        name,
        url: expand(c.url),
        headers: headers !== undefined && Object.keys(headers).length > 0 ? headers : undefined,
      };
      if (allMissing.length > 0) {
        return { rejection: `${name}: missing env vars: ${allMissing.join(", ")}` };
      }
      return { server };
    }
    default:
      return undefined;
  }
}

// ===========================================================================
// Validation
// ===========================================================================

/** Validates a CC-compatible `.mcp.json` config object. */
export function validateMcpJson(raw: unknown): Result<McpJsonConfig, KoiError> {
  return validateWith(mcpJsonSchema, raw, ".mcp.json");
}

// ===========================================================================
// Resolution (apply defaults)
// ===========================================================================

export interface ResolveOptions {
  readonly timeoutMs?: number | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly maxReconnectAttempts?: number | undefined;
}

export function resolveServerConfig(
  server: McpServerConfig,
  options?: ResolveOptions,
): ResolvedMcpServerConfig {
  return {
    name: server.name,
    server,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    connectTimeoutMs: options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    maxReconnectAttempts: options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
  };
}
