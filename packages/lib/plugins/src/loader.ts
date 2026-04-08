/**
 * Plugin discovery — scans source roots for plugin.json manifests.
 */

import { readdir } from "node:fs/promises";
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

  await Promise.all(
    entries.map(async (entry) => {
      const dirPath = join(root.path, entry);
      const manifestPath = join(dirPath, "plugin.json");

      let raw: unknown;
      try {
        const file = Bun.file(manifestPath);
        raw = await file.json();
      } catch {
        // No plugin.json or invalid JSON — skip silently
        return;
      }

      const result = validatePluginManifest(raw);
      if (!result.ok) {
        errors.push({ dirPath, source: root.source, error: result.error });
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
        dirPath,
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
