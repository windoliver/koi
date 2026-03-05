/**
 * Channel stack factory — resolves manifest channel declarations into
 * a ChannelBundle with adapters, providers, health check, and dispose.
 *
 * This is the main entry point for wiring channels from a manifest.
 */

import type { HealthStatus } from "@koi/channel-base";
import type { ChannelAdapter, ComponentProvider } from "@koi/core";
import { createDefaultChannelRegistry } from "./channel-registry.js";
import { resolveChannelStackConfig } from "./config-resolution.js";
import type { ChannelBundle, ChannelStackConfig } from "./types.js";

/**
 * Creates a ChannelBundle from a ChannelStackConfig.
 *
 * Resolves each manifest channel declaration → ChannelAdapter using the
 * registry. Returns adapters, ECS ComponentProviders, aggregated health
 * check, and a dispose function.
 */
export async function createChannelStack(config: ChannelStackConfig): Promise<ChannelBundle> {
  const resolved = resolveChannelStackConfig(config);
  const registry = resolved.registry ?? createDefaultChannelRegistry();

  // Resolve each manifest channel declaration → ChannelAdapter
  const adapters = new Map<string, ChannelAdapter>();
  for (const channelConfig of resolved.channels) {
    const factory = registry.get(channelConfig.name);
    if (factory === undefined) {
      throw new Error(
        `Unknown channel: "${channelConfig.name}". Available: ${[...registry.names()].join(", ")}`,
      );
    }
    const adapter = await factory(channelConfig.options ?? {}, resolved.runtimeOpts);
    adapters.set(channelConfig.name, adapter);
  }

  // Build ComponentProviders — one per channel for ECS agent assembly
  const providers: readonly ComponentProvider[] = [...adapters.entries()].map(
    ([name, adapter]): ComponentProvider => ({
      name: `channel:${name}`,
      attach: async () => new Map([[`channel:${name}`, adapter]]),
      detach: async () => {
        await adapter.disconnect();
      },
    }),
  );

  // Aggregated health check across all channels
  const healthCheck = (): ReadonlyMap<string, HealthStatus> => {
    const results = new Map<string, HealthStatus>();
    for (const [name, adapter] of adapters) {
      // Access healthCheck if present (added in channel-base hardening)
      const check = (adapter as { readonly healthCheck?: () => HealthStatus }).healthCheck;
      if (check !== undefined) {
        results.set(name, check());
      } else {
        // Adapters without healthCheck report unknown status
        results.set(name, { healthy: true, lastEventAt: 0 });
      }
    }
    return results;
  };

  // Dispose — disconnect all channels
  const dispose = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const [name, adapter] of adapters) {
      try {
        await adapter.disconnect();
      } catch (e: unknown) {
        errors.push(new Error(`Failed to disconnect channel "${name}"`, { cause: e }));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more channels failed to disconnect");
    }
  };

  return { adapters, providers, healthCheck, dispose };
}
