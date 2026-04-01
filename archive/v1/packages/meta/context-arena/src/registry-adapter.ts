/**
 * Registry adapter — bridges @koi/context-arena into @koi/starter's
 * manifest-driven middleware resolution.
 *
 * Registers under name "context-arena" in a MiddlewareRegistry-compatible
 * entries map. The factory reads `preset` and `contextWindowSize` from
 * manifest options, merges with a pre-supplied base config, and delegates
 * to createContextArena().
 *
 * Note: The MiddlewareFactory contract returns a single KoiMiddleware, so
 * only the compactor middleware is returned as the "primary". The full bundle
 * (all 3 middleware + providers) is available via getBundle() after invocation.
 */

import type { KoiMiddleware, MiddlewareConfig } from "@koi/core";
import { createContextArena } from "./arena-factory.js";
import type { ContextArenaBundle, ContextArenaConfig, ContextArenaPreset } from "./types.js";

/**
 * Factory function compatible with @koi/starter's MiddlewareRegistry.
 * Defined locally to avoid an L3→L3 dependency on @koi/starter.
 */
export type ContextArenaMiddlewareFactory = (
  config: MiddlewareConfig,
) => KoiMiddleware | Promise<KoiMiddleware>;

const VALID_PRESETS = new Set<string>(["conservative", "balanced", "aggressive"]);

/** Type guard for ContextArenaPreset values. */
function isContextArenaPreset(value: string): value is ContextArenaPreset {
  return VALID_PRESETS.has(value);
}

/** Base config without manifest-driven fields (preset, contextWindowSize). */
export type ContextArenaBaseConfig = Omit<ContextArenaConfig, "preset" | "contextWindowSize">;

/**
 * Creates a MiddlewareFactory entries map for use with @koi/starter's
 * createMiddlewareRegistry.
 *
 * The returned map has a single entry: `"context-arena"` → factory.
 * The factory reads `preset` and `contextWindowSize` from the manifest's
 * `options` field and merges with the provided base config.
 *
 * After the factory is called, the full bundle can be retrieved via
 * `getBundle()` on the returned object.
 */
export function createContextArenaEntries(baseConfig: ContextArenaBaseConfig): {
  readonly entries: ReadonlyMap<string, ContextArenaMiddlewareFactory>;
  readonly getBundle: () => ContextArenaBundle | undefined;
} {
  // let justified: set once when factory is invoked, read by getBundle()
  let bundle: ContextArenaBundle | undefined;

  const factory: ContextArenaMiddlewareFactory = async (config: MiddlewareConfig) => {
    const options: Readonly<Record<string, unknown>> = config.options ?? {};
    const rawPreset = options.preset;
    const preset =
      typeof rawPreset === "string" && isContextArenaPreset(rawPreset) ? rawPreset : undefined;
    const rawWindowSize = options.contextWindowSize;
    const contextWindowSize = typeof rawWindowSize === "number" ? rawWindowSize : undefined;

    const arenaConfig: ContextArenaConfig = {
      ...baseConfig,
      ...(preset !== undefined ? { preset } : {}),
      ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
    };

    bundle = await createContextArena(arenaConfig);

    // Return the compactor middleware by name (not array index).
    // Full bundle (all 3 middleware + providers) available via getBundle().
    const compactorMiddleware = bundle.middleware.find((mw) => mw.name === "koi:compactor");
    if (compactorMiddleware === undefined) {
      throw new Error("Expected compactor middleware in arena bundle");
    }
    return compactorMiddleware;
  };

  const entries: ReadonlyMap<string, ContextArenaMiddlewareFactory> = new Map([
    ["context-arena", factory],
  ]);

  return {
    entries,
    getBundle: (): ContextArenaBundle | undefined => bundle,
  };
}
