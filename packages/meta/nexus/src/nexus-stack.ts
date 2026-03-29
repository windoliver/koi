/**
 * Main factory composing all Nexus pieces into a single bundle.
 *
 * Creates global backends, agent-scoped provider, and wires disposal.
 * When baseUrl is omitted, auto-starts a local Nexus via embed mode.
 */

import { createNexusClient } from "@koi/nexus-client";
import { createNexusAgentProvider } from "./agent-provider.js";
import { createGlobalBackends } from "./global-backends.js";
import type {
  GlobalBackendOverrides,
  NexusBundle,
  NexusStackConfig,
  ResolvedNexusConnection,
  ResolvedNexusMeta,
} from "./types.js";
import { validateNexusStackConfig } from "./validate-config.js";

/**
 * Creates a complete Nexus stack from a single config.
 *
 * When baseUrl is omitted or empty, auto-starts a local Nexus server
 * using @koi/nexus-embed (embed mode). When baseUrl is provided,
 * connects to the remote Nexus server (remote mode).
 */
export async function createNexusStack(config: NexusStackConfig): Promise<NexusBundle> {
  // let — resolved from embed mode when baseUrl is missing
  let resolvedBaseUrl = config.baseUrl;
  // let justified: may be updated from embed result when caller didn't provide a key
  let resolvedApiKey = config.apiKey ?? "";

  if (!resolvedBaseUrl || resolvedBaseUrl.trim() === "") {
    // Lazy import to avoid loading embed deps when in remote mode
    const { ensureNexusRunning } = await import("@koi/nexus-embed");
    const embedResult = await ensureNexusRunning({
      ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
      ...(config.embedProfile !== undefined ? { profile: config.embedProfile } : {}),
      ...(config.sourceDir !== undefined ? { sourceDir: config.sourceDir } : {}),
    });
    if (!embedResult.ok) {
      throw new Error(embedResult.error.message, { cause: embedResult.error });
    }
    resolvedBaseUrl = embedResult.value.baseUrl;
    // Use embed-provided API key when caller didn't specify one.
    // Docker-based Nexus always requires auth (even embed-lite profiles).
    if (embedResult.value.apiKey !== undefined && resolvedApiKey.length === 0) {
      resolvedApiKey = embedResult.value.apiKey;
      // Propagate to env so downstream consumers (ACE stores, forge, etc.) can use it
      if (process.env.NEXUS_API_KEY === undefined) {
        process.env.NEXUS_API_KEY = resolvedApiKey;
      }
    }
  }

  // Validate the resolved config
  const resolvedConfig = { ...config, baseUrl: resolvedBaseUrl, apiKey: resolvedApiKey };
  const validationResult = validateNexusStackConfig(resolvedConfig);
  if (!validationResult.ok) {
    throw new Error(validationResult.error.message, { cause: validationResult.error });
  }

  // After validation, baseUrl is guaranteed to be a non-empty string.
  // Guard for TypeScript narrowing (validation already checked this).
  if (resolvedBaseUrl === undefined) {
    throw new Error("NexusStackConfig.baseUrl is required and must be a non-empty string");
  }

  const { agentOverrides, optIn } = config;
  const fetchFn = config.fetch;

  // In embed mode (no apiKey), disable global backends that validate non-empty apiKey.
  // These backends (audit, search, registry, pay, scheduler, nameService) will reject
  // apiKey: "" at their config validation boundary. Permissions uses the NexusClient
  // directly and does not validate apiKey, so it stays enabled.
  const overrides: GlobalBackendOverrides =
    resolvedApiKey === ""
      ? {
          ...config.overrides,
          audit: config.overrides?.audit ?? false,
          search: config.overrides?.search ?? false,
          registry: config.overrides?.registry ?? false,
          pay: config.overrides?.pay ?? false,
          scheduler: config.overrides?.scheduler ?? false,
          nameService: config.overrides?.nameService ?? false,
        }
      : (config.overrides ?? {});

  // Build resolved connection (baseUrl guaranteed non-undefined after guard above)
  const resolvedConn: ResolvedNexusConnection = {
    baseUrl: resolvedBaseUrl,
    apiKey: resolvedApiKey,
    ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
  };

  // Shared NexusClient for backends that accept a client directly
  const client = createNexusClient({
    baseUrl: resolvedBaseUrl,
    apiKey: resolvedApiKey,
    ...(fetchFn !== undefined ? { fetch: fetchFn } : {}),
  });

  // Create global backends (registry + nameService are async)
  const backends = await createGlobalBackends(resolvedConn, client, overrides);

  // Create agent-scoped provider
  const { provider, middlewares } = createNexusAgentProvider(
    resolvedConn,
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
    baseUrl: resolvedBaseUrl,
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
