/**
 * LSP server configuration types and Zod validation.
 *
 * Defines per-server config (command, args, rootUri) and provider-level
 * config for timeouts and reconnection. Auto-detects languageId from
 * file extension if omitted.
 */

import type { KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface LspServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly rootUri: string;
  readonly languageId?: string | undefined;
  readonly initializationOptions?: unknown;
  readonly timeoutMs?: number | undefined;
}

export interface LspProviderConfig {
  readonly servers: readonly LspServerConfig[];
  readonly autoDetect?: boolean | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly maxReconnectAttempts?: number | undefined;
  readonly maxReferences?: number | undefined;
  readonly maxSymbols?: number | undefined;
}

// ---------------------------------------------------------------------------
// Resolved config (defaults applied)
// ---------------------------------------------------------------------------

export interface ResolvedLspServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly rootUri: string;
  readonly languageId: string | undefined;
  readonly initializationOptions: unknown;
  readonly timeoutMs: number;
}

export interface ResolvedLspProviderConfig {
  readonly servers: readonly ResolvedLspServerConfig[];
  readonly autoDetect: boolean;
  readonly connectTimeoutMs: number;
  readonly maxReconnectAttempts: number;
  readonly maxReferences: number;
  readonly maxSymbols: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const DEFAULT_MAX_REFERENCES = 100;
const DEFAULT_MAX_SYMBOLS = 50;

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const lspServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  rootUri: z.string().min(1),
  languageId: z.string().min(1).optional(),
  initializationOptions: z.unknown().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const lspProviderConfigSchema = z.object({
  servers: z.array(lspServerConfigSchema).min(1),
  autoDetect: z.boolean().optional(),
  connectTimeoutMs: z.number().int().positive().optional(),
  maxReconnectAttempts: z.number().int().nonnegative().optional(),
  maxReferences: z.number().int().positive().optional(),
  maxSymbols: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates raw LSP provider config. Returns Result. */
export function validateLspConfig(raw: unknown): Result<LspProviderConfig, KoiError> {
  return validateWith(lspProviderConfigSchema, raw, "LSP config validation failed");
}

// ---------------------------------------------------------------------------
// Config resolution (apply defaults)
// ---------------------------------------------------------------------------

/** Resolves a single server config by applying defaults. */
export function resolveServerConfig(server: LspServerConfig): ResolvedLspServerConfig {
  return {
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
    rootUri: server.rootUri,
    languageId: server.languageId,
    initializationOptions: server.initializationOptions,
    timeoutMs: server.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** Validates and resolves provider config with defaults applied. */
export function resolveProviderConfig(config: LspProviderConfig): ResolvedLspProviderConfig {
  return {
    servers: config.servers.map(resolveServerConfig),
    autoDetect: config.autoDetect ?? false,
    connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
    maxReferences: config.maxReferences ?? DEFAULT_MAX_REFERENCES,
    maxSymbols: config.maxSymbols ?? DEFAULT_MAX_SYMBOLS,
  };
}
