/**
 * MCP server configuration types and Zod validation.
 *
 * Uses z.discriminatedUnion on the transport field so that Zod validates
 * transport-specific required fields (command for stdio, url for http/sse)
 * in a single pass. No secondary extraction step needed.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Transport config types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  readonly name: string;
  readonly transport: McpTransportConfig;
  readonly timeoutMs?: number | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly maxReconnectAttempts?: number | undefined;
}

// ---------------------------------------------------------------------------
// Resolved config (defaults applied)
// ---------------------------------------------------------------------------

export interface ResolvedMcpServerConfig {
  readonly name: string;
  readonly transport: McpTransportConfig;
  readonly timeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxReconnectAttempts: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Zod schemas — discriminated union on transport.transport
// ---------------------------------------------------------------------------

const stdioTransportSchema: z.ZodObject<{
  transport: z.ZodLiteral<"stdio">;
  command: z.ZodString;
  args: z.ZodOptional<z.ZodArray<z.ZodString>>;
  env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}> = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1, "stdio transport requires a non-empty command"),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const httpTransportSchema: z.ZodObject<{
  transport: z.ZodLiteral<"http">;
  url: z.ZodString;
  headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}> = z.object({
  transport: z.literal("http"),
  url: z.string().url("http transport requires a valid URL"),
  headers: z.record(z.string(), z.string()).optional(),
});

const sseTransportSchema: z.ZodObject<{
  transport: z.ZodLiteral<"sse">;
  url: z.ZodString;
  headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}> = z.object({
  transport: z.literal("sse"),
  url: z.string().url("sse transport requires a valid URL"),
  headers: z.record(z.string(), z.string()).optional(),
});

export const mcpTransportConfigSchema: z.ZodDiscriminatedUnion<
  [typeof stdioTransportSchema, typeof httpTransportSchema, typeof sseTransportSchema]
> = z.discriminatedUnion("transport", [
  stdioTransportSchema,
  httpTransportSchema,
  sseTransportSchema,
]);

export const mcpServerConfigSchema: z.ZodObject<{
  name: z.ZodString;
  transport: typeof mcpTransportConfigSchema;
  timeoutMs: z.ZodOptional<z.ZodNumber>;
  connectTimeoutMs: z.ZodOptional<z.ZodNumber>;
  maxReconnectAttempts: z.ZodOptional<z.ZodNumber>;
}> = z.object({
  name: z.string().min(1, "server name must not be empty"),
  transport: mcpTransportConfigSchema,
  timeoutMs: z.number().int().positive().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
  maxReconnectAttempts: z.number().int().nonnegative().optional(),
});

export const mcpServerArraySchema: z.ZodArray<typeof mcpServerConfigSchema> = z
  .array(mcpServerConfigSchema)
  .min(1);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates a single server config entry. Returns typed Result. */
export function validateServerConfig(raw: unknown): Result<McpServerConfig, KoiError> {
  return validateWith(mcpServerConfigSchema, raw, "MCP server config");
}

/** Validates an array of server configs. */
export function validateServerConfigs(raw: unknown): Result<readonly McpServerConfig[], KoiError> {
  return validateWith(mcpServerArraySchema, raw, "MCP server configs");
}

// ---------------------------------------------------------------------------
// Config resolution (apply defaults)
// ---------------------------------------------------------------------------

/** Resolves a server config by applying defaults. No re-validation needed. */
export function resolveServerConfig(config: McpServerConfig): ResolvedMcpServerConfig {
  return {
    name: config.name,
    transport: config.transport,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
  };
}
