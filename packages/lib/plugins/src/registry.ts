/**
 * Plugin registry — Resolver<PluginMeta, LoadedPlugin> conformant.
 *
 * Wraps the loader with caching, inflight dedup, availability filtering,
 * and path containment on load().
 */

import { readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { KoiError, Resolver, Result } from "@koi/core";
import { assertContained } from "./containment.js";
import { discoverPlugins } from "./loader.js";
import { validatePluginManifest } from "./schema.js";
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

  const discover = async (): Promise<readonly PluginMeta[]> => {
    if (discoverPromise !== undefined) {
      return discoverPromise;
    }

    discoverPromise = (async (): Promise<readonly PluginMeta[]> => {
      try {
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

        // If any errors are retryable, don't cache this discovery so next call re-scans
        const hasRetryable = result.value.errors.some((e) => e.error.retryable);
        if (hasRetryable) {
          discoverPromise = undefined;
        }

        // Return only available plugins
        return result.value.plugins.filter((p) => p.available);
      } catch (err: unknown) {
        // Clear cached promise so next call retries — but surface the error
        discoverPromise = undefined;
        cachedPlugins = new Map();
        cachedErrors = [
          {
            dirPath: "",
            source: "bundled",
            error: {
              code: "INTERNAL",
              message: `Discovery failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
              retryable: true,
              context: {},
            },
          },
        ];
        return [];
      }
    })();

    return discoverPromise;
  };

  const load = async (id: string): Promise<Result<LoadedPlugin, KoiError>> => {
    // Every load() re-validates from disk — no caching of loaded plugins.
    // This ensures TOCTOU protection and reflects current filesystem state.

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

    // Unavailable plugins occupy their name slot but cannot be loaded — no FS access
    if (!meta.available) {
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

    // TOCTOU guard: re-resolve the plugin directory to detect post-discovery swaps
    let currentDirPath: string;
    try {
      currentDirPath = await realpath(meta.dirPath);
    } catch {
      return {
        ok: false,
        error: {
          code: "PERMISSION",
          message: `Plugin directory no longer resolvable: ${meta.dirPath}`,
          retryable: false,
          context: { pluginId: id, dirPath: meta.dirPath },
        },
      };
    }
    if (currentDirPath !== meta.dirPath) {
      return {
        ok: false,
        error: {
          code: "PERMISSION",
          message: `Plugin directory changed since discovery (possible symlink swap): ${id}`,
          retryable: false,
          context: { pluginId: id, expected: meta.dirPath, actual: currentDirPath },
        },
      };
    }

    // Re-validate source root containment — detect root retargeting
    const sourceRoot =
      meta.source === "managed"
        ? config.managedRoot
        : meta.source === "user"
          ? config.userRoot
          : config.bundledRoot;
    if (sourceRoot !== undefined && sourceRoot !== null) {
      const containedInRoot = await assertContained(
        relative(sourceRoot, meta.dirPath) || ".",
        sourceRoot,
      );
      if (!containedInRoot.ok) {
        return {
          ok: false,
          error: {
            code: "PERMISSION",
            message: `Plugin directory is no longer contained in its source root: ${id}`,
            retryable: false,
            context: { pluginId: id, dirPath: meta.dirPath, sourceRoot },
          },
        };
      }
    }

    // Re-read and re-validate manifest from disk — use fresh manifest for path resolution
    let freshManifest: typeof meta.manifest;
    try {
      const manifestContent = await readFile(join(meta.dirPath, "plugin.json"), "utf-8");
      const rawManifest: unknown = JSON.parse(manifestContent);
      const revalidated = validatePluginManifest(rawManifest);
      if (!revalidated.ok) {
        return revalidated;
      }
      if (revalidated.value.name !== meta.name) {
        return {
          ok: false,
          error: {
            code: "PERMISSION",
            message: `Plugin manifest identity changed since discovery: expected "${meta.name}", got "${revalidated.value.name}"`,
            retryable: false,
            context: { pluginId: id, expected: meta.name, actual: revalidated.value.name },
          },
        };
      }
      freshManifest = revalidated.value;
    } catch (err: unknown) {
      // Distinguish I/O failures (retryable) from other errors
      const isIoError =
        err instanceof Error &&
        "code" in err &&
        typeof (err as { code: unknown }).code === "string";
      return {
        ok: false,
        error: {
          code: isIoError ? "INTERNAL" : "PERMISSION",
          message: `Plugin manifest unreadable at load time: ${err instanceof Error ? err.message : String(err)}`,
          retryable: isIoError,
          context: { pluginId: id, dirPath: meta.dirPath },
        },
      };
    }

    // Re-evaluate availability against the fresh manifest
    let freshAvailable = true;
    if (config.isAvailable) {
      try {
        freshAvailable = config.isAvailable(freshManifest);
      } catch {
        freshAvailable = false;
      }
    }
    if (!freshAvailable) {
      return {
        ok: false,
        error: {
          code: "PERMISSION",
          message: `Plugin is not available (load-time check): ${id}`,
          retryable: false,
          context: { pluginId: id, source: meta.source },
        },
      };
    }

    // Resolve paths using the fresh manifest (not stale discovery-time manifest)
    const skillPaths: string[] = [];
    for (const relPath of freshManifest.skills ?? []) {
      const contained = await assertContained(relPath, meta.dirPath);
      if (!contained.ok) {
        return contained;
      }
      skillPaths.push(contained.value);
    }

    let hookConfigPath: string | undefined;
    if (freshManifest.hooks !== undefined) {
      const contained = await assertContained(freshManifest.hooks, meta.dirPath);
      if (!contained.ok) {
        return contained;
      }
      hookConfigPath = contained.value;
    }

    let mcpConfigPath: string | undefined;
    if (freshManifest.mcpServers !== undefined) {
      const contained = await assertContained(freshManifest.mcpServers, meta.dirPath);
      if (!contained.ok) {
        return contained;
      }
      mcpConfigPath = contained.value;
    }

    const loaded: LoadedPlugin = {
      id: meta.id,
      name: freshManifest.name,
      source: meta.source,
      version: freshManifest.version,
      description: freshManifest.description,
      dirPath: meta.dirPath,
      manifest: freshManifest,
      available: freshAvailable,
      skillPaths,
      hookConfigPath,
      mcpConfigPath,
      middlewareNames: freshManifest.middleware ?? [],
    };

    return { ok: true, value: loaded };
  };

  const invalidate = (): void => {
    discoverPromise = undefined;
    cachedPlugins = undefined;
    cachedErrors = [];
  };

  const errors = (): readonly PluginError[] => cachedErrors;

  return { discover, load, invalidate, errors };
}
