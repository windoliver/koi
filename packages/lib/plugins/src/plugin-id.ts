/**
 * PluginId branded type constructor and type guard.
 */

import type { PluginId } from "./types.js";

/**
 * Creates a branded PluginId from a plugin name.
 */
export function pluginId(name: string): PluginId {
  return name as PluginId;
}

/**
 * Type guard — checks if a string is a valid PluginId shape.
 * Validates kebab-case format matching the manifest schema.
 */
export function isPluginId(value: string): value is PluginId {
  return /^[a-z][a-z0-9-]*$/.test(value);
}
