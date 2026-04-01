/**
 * @koi/channels — Channel adapter registry and manifest-driven channel resolution.
 *
 * L3 meta-package that provides:
 * - ChannelRegistry for named channel factory lookup
 * - createDefaultChannelRegistry() with all 14 built-in adapters
 * - createChannelStack() for manifest-driven channel resolution
 * - Presets (minimal, standard, full) for common deployments
 *
 * Consumers add the L2 channel packages they need to their own package.json.
 * This package only references them via devDependencies for types/testing.
 */

// Registry
export {
  createChannelRegistry,
  createDefaultChannelRegistry,
} from "./channel-registry.js";
// Stack factory
export { createChannelStack } from "./channel-stack.js";
// Config resolution
export type { ResolvedChannelStackConfig } from "./config-resolution.js";
export { resolveChannelStackConfig } from "./config-resolution.js";
// Presets
export { resolvePreset } from "./presets.js";
// Types
export type {
  ChannelBundle,
  ChannelFactory,
  ChannelPreset,
  ChannelRegistry,
  ChannelRuntimeOpts,
  ChannelStackConfig,
} from "./types.js";
