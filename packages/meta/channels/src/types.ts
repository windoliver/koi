/**
 * Core types for the @koi/channels L3 meta-package.
 *
 * Mirrors the MiddlewareRegistry/MiddlewareFactory pattern from @koi/starter.
 */

import type { HealthStatus } from "@koi/channel-base";
import type { ChannelAdapter, ChannelConfig, ComponentProvider, JsonObject } from "@koi/core";

/** Runtime options passed to channel factories during resolution. */
export interface ChannelRuntimeOpts {
  /** Connect timeout override. Defaults to 30_000ms. */
  readonly connectTimeoutMs?: number;
  /** Health check timeout override. Defaults to 300_000ms. */
  readonly healthTimeoutMs?: number;
}

/**
 * Factory function that creates a ChannelAdapter from manifest config.
 *
 * Mirrors MiddlewareFactory from @koi/starter — accepts JSON-serializable
 * config from a manifest and optional runtime overrides.
 */
export type ChannelFactory = (
  config: JsonObject,
  opts?: ChannelRuntimeOpts,
) => ChannelAdapter | Promise<ChannelAdapter>;

/** Registry of named channel factories. */
export interface ChannelRegistry {
  /** Looks up a factory by channel name. Returns undefined if not registered. */
  readonly get: (name: string) => ChannelFactory | undefined;
  /** Returns the set of all registered channel names. */
  readonly names: () => ReadonlySet<string>;
}

/** Channel preset — curated sets of adapters for common deployments. */
export type ChannelPreset = "minimal" | "standard" | "full";

/** Configuration for createChannelStack(). */
export interface ChannelStackConfig {
  /** Preset to use as a base set of channels. */
  readonly preset?: ChannelPreset;
  /** Explicit channel declarations from the agent manifest. */
  readonly channels?: readonly ChannelConfig[];
  /** Custom registry override. Defaults to createDefaultChannelRegistry(). */
  readonly registry?: ChannelRegistry;
  /** Connect timeout for all channels. Defaults to 30_000ms. */
  readonly connectTimeoutMs?: number;
  /** Health check timeout for all channels. Defaults to 300_000ms. */
  readonly healthTimeoutMs?: number;
}

/** Result of createChannelStack() — a resolved bundle of channel adapters. */
export interface ChannelBundle {
  /** Map of channel name → resolved adapter. */
  readonly adapters: ReadonlyMap<string, ChannelAdapter>;
  /** ComponentProviders for ECS agent assembly. */
  readonly providers: readonly ComponentProvider[];
  /** Aggregated health check across all channels. */
  readonly healthCheck: () => ReadonlyMap<string, HealthStatus>;
  /** Disconnects all channels and cleans up resources. */
  readonly dispose: () => Promise<void>;
}
