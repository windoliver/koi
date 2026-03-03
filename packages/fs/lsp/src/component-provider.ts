/**
 * LspComponentProvider — attaches LSP tools as components to agents.
 *
 * Async factory that connects to all LSP servers in parallel, negotiates
 * capabilities, and wraps supported operations as Koi Tool components.
 */

import type { Agent, ComponentProvider, KoiError } from "@koi/core";
import { toolToken } from "@koi/core";
import type { CreateTransportFn, LspClient } from "./client.js";
import { createLspClient } from "./client.js";
import type { LspProviderConfig, LspServerConfig, ResolvedLspServerConfig } from "./config.js";
import { resolveProviderConfig } from "./config.js";
import { detectLspServers } from "./server-detection.js";
import { createLspTools } from "./tool-adapter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LspServerFailure {
  readonly serverName: string;
  readonly error: KoiError;
}

export interface LspComponentProviderResult {
  readonly provider: ComponentProvider;
  readonly clients: readonly LspClient[];
  readonly failures: readonly LspServerFailure[];
}

/** Factory function signature for creating LSP clients (DI for testing). */
export type CreateClientFn = (
  config: ResolvedLspServerConfig,
  maxReconnectAttempts: number,
  connectTimeoutMs: number,
  createTransport?: CreateTransportFn,
) => LspClient;

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

async function connectAndCreateTools(
  serverConfig: ResolvedLspServerConfig,
  connectTimeoutMs: number,
  maxReconnectAttempts: number,
  maxReferences: number,
  maxSymbols: number,
  createClient: CreateClientFn,
): Promise<
  | { readonly client: LspClient; readonly tools: Map<string, unknown> }
  | { readonly failure: LspServerFailure }
> {
  const client = createClient(serverConfig, maxReconnectAttempts, connectTimeoutMs);

  const connectResult = await client.connect();
  if (!connectResult.ok) {
    return {
      failure: {
        serverName: serverConfig.name,
        error: connectResult.error,
      },
    };
  }

  try {
    const tools = new Map<string, unknown>();
    const lspTools = createLspTools(client, serverConfig.name, maxReferences, maxSymbols);

    for (const tool of lspTools) {
      tools.set(toolToken(tool.descriptor.name) as string, tool);
    }

    return { client, tools };
  } catch (error: unknown) {
    await client.close();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Auto-detection merge
// ---------------------------------------------------------------------------

/**
 * Merges auto-detected LSP servers with user-configured servers.
 * User-configured servers take precedence over auto-detected ones (by name).
 */
function mergeAutoDetected(config: LspProviderConfig): LspProviderConfig {
  const detected = detectLspServers();
  if (detected.length === 0) return config;

  const userNames = new Set(config.servers.map((s) => s.name));

  // Derive rootUri from first user-configured server, fallback to cwd
  const rootUri = config.servers[0]?.rootUri ?? `file://${process.cwd()}`;

  const autoServers: readonly LspServerConfig[] = detected
    .filter((d) => !userNames.has(d.name))
    .map((d) => ({
      name: d.name,
      command: d.command,
      args: [...d.args],
      rootUri,
    }));

  if (autoServers.length === 0) return config;

  return {
    ...config,
    servers: [...config.servers, ...autoServers],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Async factory that connects to LSP servers, negotiates capabilities, and
 * returns a ComponentProvider that attaches tools to agents.
 *
 * Failed servers produce warnings in `failures` — they don't prevent
 * successful servers from working.
 */
export async function createLspComponentProvider(
  config: LspProviderConfig,
  createClient: CreateClientFn = createLspClient,
): Promise<LspComponentProviderResult> {
  // Merge auto-detected servers with user-configured ones
  const mergedConfig = config.autoDetect === true ? mergeAutoDetected(config) : config;

  const resolved = resolveProviderConfig(mergedConfig);

  const results = await Promise.allSettled(
    resolved.servers.map((serverConfig) =>
      connectAndCreateTools(
        serverConfig,
        resolved.connectTimeoutMs,
        resolved.maxReconnectAttempts,
        resolved.maxReferences,
        resolved.maxSymbols,
        createClient,
      ),
    ),
  );

  const allTools = new Map<string, unknown>();
  const clients: LspClient[] = [];
  const failures: LspServerFailure[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      failures.push({
        serverName: "unknown",
        error: {
          code: "EXTERNAL",
          message: `Unexpected error: ${String(result.reason)}`,
          retryable: false,
        },
      });
      continue;
    }

    const value = result.value;
    if ("failure" in value) {
      failures.push(value.failure);
    } else {
      clients.push(value.client);
      for (const [key, tool] of value.tools) {
        allTools.set(key, tool);
      }
    }
  }

  const provider: ComponentProvider = {
    name: "lsp",
    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      return allTools;
    },
    detach: async (_agent: Agent): Promise<void> => {
      await Promise.all(clients.map((c) => c.close()));
    },
  };

  return { provider, clients, failures };
}
