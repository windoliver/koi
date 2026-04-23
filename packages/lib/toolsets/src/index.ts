/**
 * @koi/toolsets — Named composable tool presets.
 *
 * Provides:
 * - resolveToolset(): recursive resolution with cycle detection
 * - createBuiltinRegistry(): four built-in presets (safe, developer, researcher, minimal)
 * - mergeRegistries(): combine multiple toolset registries
 */

export { createBuiltinRegistry, mergeRegistries } from "./registry.js";
export { resolveToolset } from "./resolve-toolset.js";
