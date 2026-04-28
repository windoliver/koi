import type { ToolsetDefinition, ToolsetRegistry } from "@koi/core";
import { BUILTIN_TOOLSETS } from "./presets.js";

function freezeDef(def: ToolsetDefinition): ToolsetDefinition {
  return Object.freeze({
    name: def.name,
    description: def.description,
    tools: Object.freeze([...def.tools]) as readonly string[],
    includes: Object.freeze([...def.includes]) as readonly string[],
  });
}

function makeRegistry(entries: Iterable<[string, ToolsetDefinition]>): ToolsetRegistry {
  const inner = new Map<string, ToolsetDefinition>(entries);
  // Return a plain ReadonlyMap-compatible object so callers cannot call .set().
  // Definitions are deep-frozen so their arrays cannot be mutated after construction.
  const reg: ToolsetRegistry = Object.freeze({
    get: (key: string) => inner.get(key),
    has: (key: string) => inner.has(key),
    get size() {
      return inner.size;
    },
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
    forEach: (
      cb: (
        value: ToolsetDefinition,
        key: string,
        map: ReadonlyMap<string, ToolsetDefinition>,
      ) => void,
    ) => {
      inner.forEach((v, k) => {
        cb(v, k, reg);
      });
    },
  });
  return reg;
}

/** Returns a registry populated with the four built-in presets. */
export function createBuiltinRegistry(): ToolsetRegistry {
  return makeRegistry(BUILTIN_TOOLSETS.map((d) => [d.name, freezeDef(d)]));
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
  const entries: [string, ToolsetDefinition][] = [];
  const seen = new Set<string>();
  for (const reg of registries) {
    for (const [name, def] of reg) {
      if (!(opts?.allowOverrides ?? false) && seen.has(name)) {
        throw new Error(
          `mergeRegistries: duplicate toolset name "${name}" — preset names are authorization identifiers and silent shadowing is not allowed. Pass { allowOverrides: true } to override explicitly.`,
        );
      }
      seen.add(name);
      entries.push([name, freezeDef(def)]);
    }
  }
  return makeRegistry(entries);
}
