/**
 * LspComponentProvider — attaches LSP tools as components to agents.
 *
 * Async factory that starts background warm-up connects for all LSP servers,
 * negotiates capabilities, and wraps supported operations as Koi Tool components.
 *
 * Supports optional injectable LspClientPool for client reuse across providers.
 *
 * Single-agent design: LSP clients are shared across all attached agents.
 * Detach closes all LSP clients, so only the last agent should trigger
 * detach. Create a separate provider instance per agent if multi-agent
 * use is needed.
 */

import type { Agent, AgentId, ComponentProvider, KoiError } from "@koi/core";
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
 * If `config.pool` is provided, clients are acquired from the pool first
 * and released back on detach instead of closed.
 *
 * Failed servers produce warnings in `failures` — they don't prevent
 * successful servers from working.
 */
export async function createLspComponentProvider(
  config: LspProviderConfig,
  createClient: CreateClientFn = createLspClient,
): Promise<LspComponentProviderResult> {
  const mergedConfig = config.autoDetect === true ? mergeAutoDetected(config) : config;
  const resolved = resolveProviderConfig(mergedConfig);

  const results = await Promise.allSettled(
    resolved.servers.map((serverConfig) => {
      // Try pool first if available
      if (resolved.pool !== undefined) {
        const pooled = resolved.pool.acquire(serverConfig.name);
        if (pooled !== undefined) {
          const tools = new Map<string, unknown>();
          const lspTools = createLspTools(
            pooled,
            serverConfig.name,
            resolved.maxReferences,
            resolved.maxSymbols,
          );
          for (const tool of lspTools) {
            tools.set(toolToken(tool.descriptor.name) as string, tool);
          }
          return Promise.resolve({ client: pooled, tools });
        }
      }

      return connectAndCreateTools(
        serverConfig,
        resolved.connectTimeoutMs,
        resolved.maxReconnectAttempts,
        resolved.maxReferences,
        resolved.maxSymbols,
        createClient,
      );
    }),
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

  // let: ref-count for safe client disposal — only close when last agent detaches
  let refCount = 0;
  // let: track attached agent for single-agent safety check
  let attachedAgent: AgentId | undefined;

  const provider: ComponentProvider = {
    name: "lsp",
    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      if (attachedAgent !== undefined && attachedAgent !== _agent.pid.id) {
        throw new Error(
          `Provider is single-agent; cannot attach agent ${_agent.pid.id} while agent ${attachedAgent} is attached.`,
        );
      }
      refCount++;
      if (attachedAgent === undefined) {
        attachedAgent = _agent.pid.id;
      }
      return allTools;
    },
    detach: async (_agent: Agent): Promise<void> => {
      refCount--;
      if (refCount <= 0) {
        attachedAgent = undefined;
        if (resolved.pool !== undefined) {
          // Return clients to pool instead of closing them
          for (const client of clients) {
            resolved.pool.release(client.serverName(), client);
          }
        } else {
          await Promise.all(clients.map((c) => c.close()));
        }
      }
    },
  };

  return { provider, clients, failures };
}
