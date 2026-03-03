/**
 * Capability-based handoff target resolution.
 *
 * Connects the AgentRegistry to the bridge's resolveTarget callback,
 * finding a running agent that declares the requested capability.
 */

import type { AgentId, AgentRegistry, HarnessSnapshot } from "@koi/core";

/**
 * Create a resolveTarget callback that queries the registry for a running
 * agent with the given capability.
 *
 * Usage:
 * ```ts
 * handoffBridge: {
 *   harnessStore,
 *   handoffStore,
 *   resolveTarget: createCapabilityResolver(registry, "deployment"),
 * }
 * ```
 */
export function createCapabilityResolver(
  registry: AgentRegistry,
  capability: string,
): (snapshot: HarnessSnapshot) => Promise<AgentId> {
  return async (_snapshot: HarnessSnapshot): Promise<AgentId> => {
    const candidates = await registry.list({
      phase: "running",
      capability,
    });

    const first = candidates[0];
    if (first === undefined) {
      throw new Error(`No running agent found with capability "${capability}"`);
    }

    // Return first match — stable ordering from registry
    return first.agentId;
  };
}
