/**
 * MCP server configuration types and Zod validation.
 *
 * Defines transport-discriminated configs for stdio, HTTP, and SSE servers,
 * plus provider-level config for connection timeouts and reconnection.
 */

import type { KoiError } from "@koi/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type McpServerMode = "tools" | "discover";

export interface StdioTransportConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface HttpTransportConfig {
  readonly transport: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface SseTransportConfig {
  readonly transport: "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export type McpTransportConfig = StdioTransportConfig | HttpTransportConfig | SseTransportConfig;

export interface McpServerConfig {
  readonly name: string;
  readonly transport: McpTransportConfig["transport"];
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly mode?: McpServerMode | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface McpProviderConfig {
  readonly servers: readonly McpServerConfig[];
  readonly connectTimeoutMs?: number | undefined;
  readonly maxReconnectAttempts?: number | undefined;
}

// ---------------------------------------------------------------------------
// Resolved config (defaults applied)
// ---------------------------------------------------------------------------

export interface ResolvedMcpServerConfig {
  readonly name: string;
  readonly transport: Readonly<McpTransportConfig>;
  readonly mode: McpServerMode;
  readonly timeoutMs: number;
}

export interface ResolvedMcpProviderConfig {
  readonly servers: readonly ResolvedMcpServerConfig[];
  readonly connectTimeoutMs: number;
  readonly maxReconnectAttempts: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const mcpServerConfigSchema = z.object({
  name: z.string().min(1),
  transport: z.union([z.literal("stdio"), z.literal("http"), z.literal("sse")]),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  mode: z.union([z.literal("tools"), z.literal("discover")]).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const mcpProviderConfigSchema = z.object({
  servers: z.array(mcpServerConfigSchema).min(1),
  connectTimeoutMs: z.number().int().positive().optional(),
  maxReconnectAttempts: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Zod → KoiError conversion (mirrors manifest/schema.ts pattern)
// ---------------------------------------------------------------------------

function zodToKoiError(zodError: z.ZodError): KoiError {
  const issues = zodError.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));

  return {
    code: "VALIDATION",
    message: `MCP config validation failed: ${issues.map((i) => `${i.path || "root"}: ${i.message}`).join("; ")}`,
    retryable: false,
    context: { issues },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates raw provider config and returns a typed result or throws KoiError. */
export function validateMcpProviderConfig(raw: unknown): McpProviderConfig {
  const result = mcpProviderConfigSchema.safeParse(raw);
  if (!result.success) {
    throw zodToKoiError(result.error);
  }
  return result.data as McpProviderConfig;
}

/** Validates a single server config entry. */
export function validateMcpServerConfig(raw: unknown): McpServerConfig {
  const result = mcpServerConfigSchema.safeParse(raw);
  if (!result.success) {
    throw zodToKoiError(result.error);
  }
  return result.data as McpServerConfig;
}

// ---------------------------------------------------------------------------
// Transport extraction helpers (used by validation refinement)
// ---------------------------------------------------------------------------

function extractTransportConfig(server: McpServerConfig): McpTransportConfig {
  switch (server.transport) {
    case "stdio": {
      if (server.command === undefined) {
        throw {
          code: "VALIDATION",
          message: `MCP server "${server.name}": stdio transport requires "command"`,
          retryable: false,
        } satisfies KoiError;
      }
      return {
        transport: "stdio",
        command: server.command,
        args: server.args,
        env: server.env,
      };
    }
    case "http": {
      if (server.url === undefined) {
        throw {
          code: "VALIDATION",
          message: `MCP server "${server.name}": http transport requires "url"`,
          retryable: false,
        } satisfies KoiError;
      }
      return {
        transport: "http",
        url: server.url,
        headers: server.headers,
      };
    }
    case "sse": {
      if (server.url === undefined) {
        throw {
          code: "VALIDATION",
          message: `MCP server "${server.name}": sse transport requires "url"`,
          retryable: false,
        } satisfies KoiError;
      }
      return {
        transport: "sse",
        url: server.url,
        headers: server.headers,
      };
    }
    default: {
      const _exhaustive: never = server.transport;
      throw {
        code: "VALIDATION",
        message: `Unknown transport type: ${String(_exhaustive)}`,
        retryable: false,
      } satisfies KoiError;
    }
  }
}

// ---------------------------------------------------------------------------
// Config resolution (apply defaults)
// ---------------------------------------------------------------------------

/** Resolves a single server config by extracting transport and applying defaults. */
export function resolveServerConfig(server: McpServerConfig): ResolvedMcpServerConfig {
  return {
    name: server.name,
    transport: extractTransportConfig(server),
    mode: server.mode ?? "tools",
    timeoutMs: server.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** Validates and resolves provider config with defaults applied. */
export function resolveProviderConfig(config: McpProviderConfig): ResolvedMcpProviderConfig {
  return {
    servers: config.servers.map(resolveServerConfig),
    connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
  };
}
