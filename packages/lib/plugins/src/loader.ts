/**
 * Plugin discovery — scans source roots for plugin.json manifests.
 */

import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { pluginId } from "./plugin-id.js";
import { validatePluginManifest } from "./schema.js";
import type {
  DiscoverResult,
  PluginError,
  PluginManifest,
  PluginMeta,
  PluginRegistryConfig,
  PluginSource,
} from "./types.js";
import { SOURCE_PRIORITY as PRIORITY } from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SourceRoot {
  readonly path: string;
  readonly source: PluginSource;
}

function buildSourceRoots(config: PluginRegistryConfig): readonly SourceRoot[] {
  const roots: SourceRoot[] = [];
  if (config.managedRoot !== undefined && config.managedRoot !== null) {
    roots.push({ path: config.managedRoot, source: "managed" });
  }
  if (config.userRoot !== undefined && config.userRoot !== null) {
    roots.push({ path: config.userRoot, source: "user" });
  }
  if (config.bundledRoot !== undefined && config.bundledRoot !== null) {
    roots.push({ path: config.bundledRoot, source: "bundled" });
  }
  return roots;
}

async function scanRoot(
  root: SourceRoot,
  isAvailable: ((manifest: PluginManifest) => boolean) | undefined,
): Promise<{ readonly plugins: readonly PluginMeta[]; readonly errors: readonly PluginError[] }> {
  let entries: readonly string[];
  try {
    entries = await readdir(root.path);
  } catch {
    // Missing root directory — silently skip
    return { plugins: [], errors: [] };
  }

  const plugins: PluginMeta[] = [];
  const errors: PluginError[] = [];

  // Resolve the root itself so containment checks are against the real path
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root.path);
  } catch {
    return { plugins: [], errors: [] };
  }

  await Promise.all(
    entries.map(async (entry) => {
      const dirPath = join(root.path, entry);

      // Reject symlinks that escape the source root
      let resolvedDir: string;
      try {
        resolvedDir = await realpath(dirPath);
      } catch {
        return;
      }
      if (!resolvedDir.startsWith(`${resolvedRoot}/`) && resolvedDir !== resolvedRoot) {
        errors.push({
          dirPath,
          source: root.source,
          error: {
            code: "PERMISSION" as const,
            message: `Plugin directory escapes source root: ${entry}`,
            retryable: false,
            context: { dirPath, resolvedDir, rootPath: resolvedRoot },
          },
        });
        return;
      }

      const manifestPath = join(resolvedDir, "plugin.json");

      let raw: unknown;
      try {
        const file = Bun.file(manifestPath);
        const exists = await file.exists();
        if (!exists) return;
        raw = await file.json();
      } catch (err: unknown) {
        // Manifest exists but is unreadable/malformed — record error
        errors.push({
          dirPath: resolvedDir,
          source: root.source,
          error: {
            code: "VALIDATION" as const,
            message: `Failed to read plugin.json: ${err instanceof Error ? err.message : String(err)}`,
            retryable: false,
            context: { dirPath: resolvedDir },
          },
        });
        return;
      }

      const result = validatePluginManifest(raw);
      if (!result.ok) {
        errors.push({ dirPath: resolvedDir, source: root.source, error: result.error });
        return;
      }

      const manifest = result.value;
      const available = isAvailable ? isAvailable(manifest) : true;

      plugins.push({
        id: pluginId(manifest.name),
        name: manifest.name,
        source: root.source,
        version: manifest.version,
        description: manifest.description,
        dirPath: resolvedDir,
        manifest,
        available,
      });
    }),
  );

  return { plugins, errors };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discovers plugins from all configured source roots.
 *
 * Shadowing: when multiple sources provide a plugin with the same name,
 * the highest-priority source wins (managed > user > bundled).
 *
 * Missing root directories are silently skipped.
 * Per-plugin manifest errors are collected without stopping other plugins.
 */
export async function discoverPlugins(
  config: PluginRegistryConfig,
): Promise<Result<DiscoverResult, KoiError>> {
  const roots = buildSourceRoots(config);
  const results = await Promise.all(roots.map((root) => scanRoot(root, config.isAvailable)));

  const allErrors: PluginError[] = [];
  const byName = new Map<string, PluginMeta>();

  for (const result of results) {
    allErrors.push(...result.errors);
    for (const plugin of result.plugins) {
      const existing = byName.get(plugin.name);
      if (existing === undefined || PRIORITY[plugin.source] < PRIORITY[existing.source]) {
        byName.set(plugin.name, plugin);
      }
    }
  }

  return {
    ok: true,
    value: {
      plugins: [...byName.values()],
      errors: allErrors,
    },
  };
}
