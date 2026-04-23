import type { ToolsetDefinition, ToolsetRegistry } from "@koi/core";
import { BUILTIN_TOOLSETS } from "./presets.js";

/** Returns a registry populated with the four built-in presets. */
export function createBuiltinRegistry(): ToolsetRegistry {
  return new Map(BUILTIN_TOOLSETS.map((d) => [d.name, d as ToolsetDefinition]));
}

export interface MergeRegistriesOptions {
  /** Allow later registries to overwrite earlier entries on name collision. Default: false. */
  readonly allowOverrides?: boolean;
}

/**
 * Merges multiple registries into one.
 *
 * By default throws on any name collision — preset names are authorization identifiers
 * and silent shadowing can widen an agent's tool access. Pass `{ allowOverrides: true }`
 * when you intentionally want to replace a preset (e.g., operator customization).
 * Passing no registries returns an empty registry.
 */
export function mergeRegistries(
  registries: readonly ToolsetRegistry[],
  opts?: MergeRegistriesOptions,
): ToolsetRegistry {
  const merged = new Map<string, ToolsetDefinition>();
  for (const reg of registries) {
    for (const [name, def] of reg) {
      if (!(opts?.allowOverrides ?? false) && merged.has(name)) {
        throw new Error(
          `mergeRegistries: duplicate toolset name "${name}" — preset names are authorization identifiers and silent shadowing is not allowed. Pass { allowOverrides: true } to override explicitly.`,
        );
      }
      merged.set(name, def);
    }
  }
  return merged;
}
