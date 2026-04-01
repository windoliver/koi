/**
 * createForgeDelegation — wires @koi/agent-discovery and @koi/agent-spawner
 * into the two optional ForgeDeps callbacks: discoverAgent + spawnCodingAgent.
 *
 * Lives in the L3 @koi/forge bundle because it imports from two L2 peers.
 */

import type { DiscoveryHandle, DiscoverySource } from "@koi/agent-discovery";
import { createDiscovery, createPathSource } from "@koi/agent-discovery";
import type { AgentSpawner } from "@koi/agent-spawner";
import { createAgentSpawner } from "@koi/agent-spawner";
import type { ExternalAgentDescriptor, KoiError, Result, SandboxAdapter } from "@koi/core";
import type { DelegateOptions, ForgeDeps } from "@koi/forge-tools";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ForgeDelegationConfig {
  /** Sandbox adapter used to create isolated containers. */
  readonly adapter: SandboxAdapter;
  /** Working directory inside the sandbox. */
  readonly cwd?: string | undefined;
  /** Environment variables to inject into the sandbox. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Maximum concurrent agent delegations. Default: 2. */
  readonly maxConcurrentDelegations?: number | undefined;
  /** Maximum stdout bytes to capture before truncation. Default: 10 MB. */
  readonly maxOutputBytes?: number | undefined;
  /** Discovery cache TTL in milliseconds. Default: 60,000. */
  readonly cacheTtlMs?: number | undefined;
  /** Override discovery sources (defaults to PATH scanner). Useful for testing. */
  readonly discoverySources?: readonly DiscoverySource[] | undefined;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ForgeDelegation {
  /** Discovers an agent by name — compatible with ForgeDeps.discoverAgent. */
  readonly discoverAgent: NonNullable<ForgeDeps["discoverAgent"]>;
  /** Spawns a coding agent — compatible with ForgeDeps.spawnCodingAgent. */
  readonly spawnCodingAgent: NonNullable<ForgeDeps["spawnCodingAgent"]>;
  /** Release underlying sandbox resources. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ForgeDelegation that bridges @koi/agent-discovery and
 * @koi/agent-spawner into ForgeDeps-compatible callbacks.
 */
export function createForgeDelegation(config: ForgeDelegationConfig): ForgeDelegation {
  const sources: readonly DiscoverySource[] = config.discoverySources ?? [createPathSource()];
  const discovery: DiscoveryHandle = createDiscovery(
    sources,
    config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
  );

  const spawner: AgentSpawner = createAgentSpawner({
    adapter: config.adapter,
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.env !== undefined ? { env: config.env } : {}),
    ...(config.maxConcurrentDelegations !== undefined
      ? { maxConcurrentDelegations: config.maxConcurrentDelegations }
      : {}),
    ...(config.maxOutputBytes !== undefined ? { maxOutputBytes: config.maxOutputBytes } : {}),
  });

  const discoverAgent = async (
    name: string,
  ): Promise<Result<ExternalAgentDescriptor, KoiError>> => {
    if (name.length === 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Agent name must not be empty",
          retryable: false,
        },
      };
    }
    const agents = await discovery.discover();
    const found = agents.find((a) => a.name === name);
    if (found === undefined) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: `External agent "${name}" not found on this system`,
          retryable: false,
          context: { agentName: name },
        },
      };
    }
    return { ok: true, value: found };
  };

  const spawnCodingAgent = async (
    agent: ExternalAgentDescriptor,
    prompt: string,
    options: DelegateOptions,
  ): Promise<Result<string, KoiError>> => {
    return spawner.spawn(agent, prompt, {
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  };

  return {
    discoverAgent,
    spawnCodingAgent,
    dispose: async (): Promise<void> => {
      await spawner.dispose();
    },
  };
}
