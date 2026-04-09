/**
 * @koi/plugins — Plugin manifest validation, multi-source discovery, and registry.
 */

export { assertContained } from "./containment.js";
export { discoverPlugins } from "./loader.js";
export { isPluginId, pluginId } from "./plugin-id.js";
export type { PluginRegistry } from "./registry.js";
export { createPluginRegistry } from "./registry.js";
export { validatePluginManifest } from "./schema.js";
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
