import type { ToolsetDefinition, ToolsetRegistry } from "@koi/core";
import { BUILTIN_TOOLSETS } from "./presets.js";

/** Returns a registry populated with the four built-in presets. */
export function createBuiltinRegistry(): ToolsetRegistry {
  return new Map(BUILTIN_TOOLSETS.map((d) => [d.name, d as ToolsetDefinition]));
}

/**
 * Merges multiple registries into one. Later arguments win on name collision.
 * Passing no arguments returns an empty registry.
 */
export function mergeRegistries(...registries: readonly ToolsetRegistry[]): ToolsetRegistry {
  const merged = new Map<string, ToolsetDefinition>();
  for (const reg of registries) {
    for (const [name, def] of reg) {
      merged.set(name, def);
    }
  }
  return merged;
}
