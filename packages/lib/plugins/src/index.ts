/**
 * @koi/plugins — Plugin manifest validation, multi-source discovery, registry, and lifecycle.
 */

export { assertContained } from "./containment.js";
export type { PluginLifecycleConfig, PluginListEntry } from "./lifecycle.js";
export {
  createGatedRegistry,
  disablePlugin,
  enablePlugin,
  installPlugin,
  listPlugins,
  recoverOrphanedUpdates,
  removePlugin,
  updatePlugin,
} from "./lifecycle.js";
export { discoverPlugins } from "./loader.js";
export { isPluginId, pluginId } from "./plugin-id.js";
export type { PluginRegistry } from "./registry.js";
export { createPluginRegistry } from "./registry.js";
export { validatePluginManifest } from "./schema.js";
export { readPluginState, writePluginState } from "./state.js";
export type {
  DiscoverResult,
  LoadedPlugin,
  PluginError,
  PluginId,
  PluginManifest,
  PluginMeta,
  PluginRegistryConfig,
  PluginSource,
} from "./types.js";
export { SOURCE_PRIORITY } from "./types.js";
