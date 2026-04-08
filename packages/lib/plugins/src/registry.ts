/**
 * Plugin registry — Resolver<PluginMeta, LoadedPlugin> conformant.
 *
 * Wraps the loader with caching, inflight dedup, availability filtering,
 * and path containment on load().
 */

import type { KoiError, Resolver, Result } from "@koi/core";
import { assertContained } from "./containment.js";
import { discoverPlugins } from "./loader.js";
import type { LoadedPlugin, PluginError, PluginMeta, PluginRegistryConfig } from "./types.js";

// ---------------------------------------------------------------------------
// PluginRegistry interface
// ---------------------------------------------------------------------------

export interface PluginRegistry extends Resolver<PluginMeta, LoadedPlugin> {
  /** Clears all caches. Next discover() will re-scan the filesystem. */
  readonly invalidate: () => void;
  /** Returns per-plugin errors from the last discovery pass. */
  readonly errors: () => readonly PluginError[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an instance-scoped plugin registry.
 * No global state — discovery cache, load cache, and config are instance-local.
 */
export function createPluginRegistry(config: PluginRegistryConfig = {}): PluginRegistry {
  let discoverPromise: Promise<readonly PluginMeta[]> | undefined;
  let cachedPlugins: ReadonlyMap<string, PluginMeta> | undefined;
  let cachedErrors: readonly PluginError[] = [];
  const loadCache = new Map<string, Promise<Result<LoadedPlugin, KoiError>>>();

  const discover = async (): Promise<readonly PluginMeta[]> => {
    if (discoverPromise !== undefined) {
      return discoverPromise;
    }

    discoverPromise = (async (): Promise<readonly PluginMeta[]> => {
      const result = await discoverPlugins(config);
      if (!result.ok) {
        cachedPlugins = new Map();
        cachedErrors = [];
        return [];
      }

      const byName = new Map<string, PluginMeta>();
      for (const plugin of result.value.plugins) {
        byName.set(plugin.name, plugin);
      }
      cachedPlugins = byName;
      cachedErrors = result.value.errors;

      // Return only available plugins
      return result.value.plugins.filter((p) => p.available);
    })();

    return discoverPromise;
  };

  const load = async (id: string): Promise<Result<LoadedPlugin, KoiError>> => {
    const existing = loadCache.get(id);
    if (existing !== undefined) {
      return existing;
    }

    const promise = (async (): Promise<Result<LoadedPlugin, KoiError>> => {
      // Ensure discovery has run
      await discover();

      const meta = cachedPlugins?.get(id);
      if (meta === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Plugin not found: ${id}`,
            retryable: false,
            context: { pluginId: id },
          },
        };
      }

      // Resolve skill paths with containment check
      const skillPaths: string[] = [];
      for (const relPath of meta.manifest.skills ?? []) {
        const contained = await assertContained(relPath, meta.dirPath);
        if (!contained.ok) {
          return contained;
        }
        skillPaths.push(contained.value);
      }

      // Resolve hooks path
      let hookConfigPath: string | undefined;
      if (meta.manifest.hooks !== undefined) {
        const contained = await assertContained(meta.manifest.hooks, meta.dirPath);
        if (!contained.ok) {
          return contained;
        }
        hookConfigPath = contained.value;
      }

      // Resolve MCP servers path
      let mcpConfigPath: string | undefined;
      if (meta.manifest.mcpServers !== undefined) {
        const contained = await assertContained(meta.manifest.mcpServers, meta.dirPath);
        if (!contained.ok) {
          return contained;
        }
        mcpConfigPath = contained.value;
      }

      const loaded: LoadedPlugin = {
        ...meta,
        skillPaths,
        hookConfigPath,
        mcpConfigPath,
        middlewareNames: meta.manifest.middleware ?? [],
      };

      return { ok: true, value: loaded };
    })();

    loadCache.set(id, promise);
    return promise;
  };

  const invalidate = (): void => {
    discoverPromise = undefined;
    cachedPlugins = undefined;
    cachedErrors = [];
    loadCache.clear();
  };

  const errors = (): readonly PluginError[] => cachedErrors;

  return { discover, load, invalidate, errors };
}
