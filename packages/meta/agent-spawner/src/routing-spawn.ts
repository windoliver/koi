/**
 * Routing SpawnFn — dispatches spawn requests to agent-spawner (sandboxed)
 * or a default in-process SpawnFn based on manifest.sandbox presence.
 *
 * Usage at L3:
 * ```typescript
 * const routingSpawn = createRoutingSpawnFn({
 *   defaultSpawn: myInProcessSpawn,
 *   agentSpawner: createAgentSpawner({ adapter }),
 * });
 * createIpcStack({ spawn: routingSpawn, ... });
 * ```
 */

import type {
  ExternalAgentDescriptor,
  ExternalAgentProtocol,
  ExternalAgentTransport,
  ManifestSandboxConfig,
  SandboxProfile,
  SpawnFn,
  SpawnRequest,
  SpawnResult,
} from "@koi/core";

import type { AgentSpawner } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for creating a routing SpawnFn. */
export interface RoutingSpawnConfig {
  /** Default spawn function for in-process agent execution. */
  readonly defaultSpawn: SpawnFn;
  /** Agent spawner for sandboxed external agent execution. */
  readonly agentSpawner: AgentSpawner;
}

// ---------------------------------------------------------------------------
// Helpers — exported for testing
// ---------------------------------------------------------------------------

/**
 * Extract an ExternalAgentDescriptor from manifest metadata.
 *
 * Returns undefined if the manifest lacks a `command` in metadata,
 * meaning it cannot be spawned as an external CLI agent.
 */
export function mapManifestToDescriptor(
  manifest: SpawnRequest["manifest"],
  agentName: string,
): ExternalAgentDescriptor | undefined {
  if (manifest === undefined) return undefined;

  const meta = manifest.metadata;
  const rawCommand = meta?.command;
  const command = typeof rawCommand === "string" ? rawCommand : undefined;

  if (command === undefined || command.length === 0) {
    return undefined;
  }

  const rawTransport = meta?.transport;
  const transport: ExternalAgentTransport =
    typeof rawTransport === "string" && isValidTransport(rawTransport) ? rawTransport : "cli";

  const rawProtocol = meta?.protocol;
  const protocol: ExternalAgentProtocol | undefined =
    typeof rawProtocol === "string" && isValidProtocol(rawProtocol) ? rawProtocol : undefined;

  return {
    name: agentName,
    transport,
    command,
    capabilities: manifest.capabilities !== undefined ? [...manifest.capabilities] : [],
    source: "manifest",
    ...(protocol !== undefined ? { protocol } : {}),
  };
}

/**
 * Convert ManifestSandboxConfig to SandboxProfile.
 *
 * Defaults: network = deny, empty filesystem/resources.
 */
export function mapSandboxConfigToProfile(config: ManifestSandboxConfig): SandboxProfile {
  return {
    filesystem: config.filesystem ?? {},
    network: config.network ?? { allow: false },
    resources: config.resources ?? {},
  };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isValidTransport(value: string): value is ExternalAgentTransport {
  return value === "cli" || value === "mcp" || value === "a2a";
}

function isValidProtocol(value: string): value is ExternalAgentProtocol {
  return value === "acp" || value === "stdio";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SpawnFn that routes to agent-spawner for sandboxed agents
 * and falls through to a default SpawnFn for in-process agents.
 *
 * Routing decision:
 * - manifest.sandbox defined + manifest.metadata.command present → agent-spawner
 * - Otherwise → defaultSpawn
 */
export function createRoutingSpawnFn(config: RoutingSpawnConfig): SpawnFn {
  return async (request: SpawnRequest): Promise<SpawnResult> => {
    const manifest = request.manifest;

    if (manifest?.sandbox !== undefined) {
      const descriptor = mapManifestToDescriptor(manifest, request.agentName);

      if (descriptor !== undefined) {
        const profile = mapSandboxConfigToProfile(manifest.sandbox);
        const scope = manifest.sandbox.persistence?.scope;
        const result = await config.agentSpawner.spawn(descriptor, request.description, {
          profile,
          ...(scope !== undefined ? { scope } : {}),
        });

        if (result.ok) {
          return { ok: true, output: result.value };
        }
        return { ok: false, error: result.error };
      }
    }

    return config.defaultSpawn(request);
  };
}
