/**
 * Config resolution — merges defaults → preset → user overrides.
 *
 * Pure function, no side effects. Resolves a ChannelStackConfig into
 * a normalized form with explicit channel list and runtime options.
 */

import type { ChannelConfig } from "@koi/core";
import { resolvePreset } from "./presets.js";
import type { ChannelRegistry, ChannelRuntimeOpts, ChannelStackConfig } from "./types.js";

/** Default connect timeout: 30 seconds. */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Default health check timeout: 5 minutes. */
const DEFAULT_HEALTH_TIMEOUT_MS = 300_000;

/** Resolved config after merging defaults, preset, and user overrides. */
export interface ResolvedChannelStackConfig {
  readonly channels: readonly ChannelConfig[];
  readonly registry: ChannelRegistry | undefined;
  readonly runtimeOpts: ChannelRuntimeOpts;
}

/**
 * Resolves a ChannelStackConfig into explicit channels + runtime options.
 *
 * Resolution order:
 * 1. If `channels` is provided, use it directly (preset is ignored)
 * 2. If `preset` is provided without `channels`, expand the preset to
 *    channel declarations with empty options
 * 3. If neither, default to "minimal" preset (CLI only)
 */
export function resolveChannelStackConfig(config: ChannelStackConfig): ResolvedChannelStackConfig {
  const runtimeOpts: ChannelRuntimeOpts = {
    connectTimeoutMs: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    healthTimeoutMs: config.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
  };

  // Explicit channels take priority over preset
  if (config.channels !== undefined && config.channels.length > 0) {
    return { channels: config.channels, registry: config.registry, runtimeOpts };
  }

  // Expand preset to channel declarations with empty options
  const presetName = config.preset ?? "minimal";
  const presetNames = resolvePreset(presetName);
  const channels: readonly ChannelConfig[] = presetNames.map((name) => ({ name }));

  return { channels, registry: config.registry, runtimeOpts };
}
