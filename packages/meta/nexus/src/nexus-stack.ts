/**
 * Main factory composing all Nexus pieces into a single bundle.
 *
 * Creates global backends, agent-scoped provider, and wires disposal.
 */

import { createNexusClient } from "@koi/nexus-client";
import { createNexusAgentProvider } from "./agent-provider.js";
import { createGlobalBackends } from "./global-backends.js";
import type { NexusBundle, NexusStackConfig, ResolvedNexusMeta } from "./types.js";
import { validateNexusStackConfig } from "./validate-config.js";

/**
 * Creates a complete Nexus stack from a single config.
 *
 * - Validates config at the boundary
 * - Creates a shared NexusClient
 * - Initializes global backends in parallel (registry, nameService are async)
 * - Creates an agent-scoped ComponentProvider
 * - Returns a bundle with dispose() for full cleanup
 */
export async function createNexusStack(config: NexusStackConfig): Promise<NexusBundle> {
  const validation = validateNexusStackConfig(config);
  if (!validation.ok) {
    throw new Error(validation.error.message, { cause: validation.error });
  }

  const { baseUrl, apiKey, overrides, agentOverrides, optIn } = config;
  const fetchFn = config.fetch;

  // Shared NexusClient for backends that accept a client directly
  const client = createNexusClient({
    baseUrl,
    apiKey,
    ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
  });

  // Create global backends (registry + nameService are async)
  const backends = await createGlobalBackends(
    { baseUrl, apiKey, ...(fetchFn !== undefined ? { fetch: fetchFn } : {}) },
    client,
    overrides,
  );

  // Create agent-scoped provider
  const { provider, middlewares } = createNexusAgentProvider(
    { baseUrl, apiKey, ...(fetchFn !== undefined ? { fetch: fetchFn } : {}) },
    client,
    agentOverrides,
    optIn,
  );

  // Count active global backends
  const globalBackendCount = [
    backends.registry,
    backends.permissions,
    backends.audit,
    backends.search,
    backends.scheduler,
    backends.pay,
    backends.nameService,
  ].filter((b) => b !== undefined).length;

  const meta: ResolvedNexusMeta = {
    baseUrl,
    globalBackendCount,
    gatewayEnabled: optIn?.gateway !== undefined,
    workspaceEnabled: optIn?.workspace !== undefined,
  };

  // Dispose — best-effort cleanup of all resources
  const dispose = async (): Promise<void> => {
    // Flush audit sink if it has a flush method
    if (backends.audit !== undefined && "flush" in backends.audit) {
      try {
        await (backends.audit as { readonly flush: () => Promise<void> }).flush();
      } catch {
        // Best-effort
      }
    }
  };

  return {
    backends,
    providers: [provider],
    middlewares,
    client,
    config: meta,
    dispose,
  };
}
