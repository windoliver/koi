/**
 * Plugin discovery — scans source roots for plugin.json manifests.
 */

import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
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

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

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
): Promise<{
  readonly plugins: readonly PluginMeta[];
  readonly errors: readonly PluginError[];
  readonly rootFailed: boolean;
}> {
  let entries: readonly string[];
  try {
    entries = await readdir(root.path);
  } catch (err: unknown) {
    // ENOENT = root doesn't exist yet — silently skip
    if (isEnoent(err)) return { plugins: [], errors: [], rootFailed: false };
    // Other errors (EACCES, EIO, etc.) — surface so higher-tier failures are visible
    return {
      plugins: [],
      rootFailed: true,
      errors: [
        {
          dirPath: root.path,
          source: root.source,
          error: {
            code: "INTERNAL" as const,
            message: `Cannot read plugin root: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true,
            context: { rootPath: root.path },
          },
        },
      ],
    };
  }

  const plugins: PluginMeta[] = [];
  const errors: PluginError[] = [];

  // Resolve the root itself so containment checks are against the real path
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root.path);
  } catch (err: unknown) {
    if (isEnoent(err)) return { plugins: [], errors: [], rootFailed: false };
    return {
      plugins: [],
      rootFailed: true,
      errors: [
        {
          dirPath: root.path,
          source: root.source,
          error: {
            code: "INTERNAL" as const,
            message: `Cannot resolve plugin root: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true,
            context: { rootPath: root.path },
          },
        },
      ],
    };
  }

  await Promise.all(
    entries.map(async (entry) => {
      const dirPath = join(root.path, entry);

      // Reject symlinks that escape the source root
      let resolvedDir: string;
      try {
        resolvedDir = await realpath(dirPath);
      } catch (err: unknown) {
        if (!isEnoent(err)) {
          errors.push({
            dirPath,
            source: root.source,
            error: {
              code: "INTERNAL" as const,
              message: `Cannot resolve plugin directory: ${err instanceof Error ? err.message : String(err)}`,
              retryable: true,
              context: { dirPath },
            },
          });
        }
        return;
      }
      const rel = relative(resolvedRoot, resolvedDir);
      if (rel.startsWith("..") || isAbsolute(rel)) {
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
      let content: string;
      try {
        content = await readFile(manifestPath, "utf-8");
      } catch (err: unknown) {
        // ENOENT = no plugin.json — not a plugin directory, skip silently
        if (isEnoent(err)) return;
        // Other read errors (EACCES, EIO) — record as retryable to block lower-tier takeover
        errors.push({
          dirPath: resolvedDir,
          source: root.source,
          pluginName: basename(resolvedDir),
          error: {
            code: "INTERNAL" as const,
            message: `Cannot read plugin.json: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true,
            context: { dirPath: resolvedDir },
          },
        });
        return;
      }
      try {
        raw = JSON.parse(content);
      } catch (err: unknown) {
        // Malformed JSON — non-retryable validation error
        errors.push({
          dirPath: resolvedDir,
          source: root.source,
          pluginName: basename(resolvedDir),
          error: {
            code: "VALIDATION" as const,
            message: `Invalid plugin.json: ${err instanceof Error ? err.message : String(err)}`,
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

      // Enforce directory name === manifest name for reliable fail-closed shadowing
      const dirName = basename(resolvedDir);
      if (dirName !== manifest.name) {
        errors.push({
          dirPath: resolvedDir,
          source: root.source,
          pluginName: manifest.name,
          error: {
            code: "VALIDATION" as const,
            message: `Plugin directory "${dirName}" does not match manifest name "${manifest.name}"`,
            retryable: false,
            context: { dirPath: resolvedDir, dirName, manifestName: manifest.name },
          },
        });
        return;
      }

      let available = true;
      if (isAvailable) {
        try {
          available = isAvailable(manifest);
        } catch (err: unknown) {
          available = false;
          errors.push({
            dirPath: resolvedDir,
            source: root.source,
            error: {
              code: "INTERNAL" as const,
              message: `isAvailable() threw for plugin "${manifest.name}": ${err instanceof Error ? err.message : String(err)}`,
              retryable: true,
              context: { pluginName: manifest.name, dirPath: resolvedDir },
            },
          });
        }
      }

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

  // Detect same-tier duplicate manifest names — evict ALL copies (fail closed)
  const nameCounts = new Map<string, string[]>(); // name → list of dirPaths
  for (const plugin of plugins) {
    const dirs = nameCounts.get(plugin.name) ?? [];
    dirs.push(plugin.dirPath);
    nameCounts.set(plugin.name, dirs);
  }
  const duplicateNames = new Set<string>();
  for (const [name, dirs] of nameCounts) {
    if (dirs.length > 1) {
      duplicateNames.add(name);
      errors.push({
        dirPath: dirs.join(", "),
        source: root.source,
        pluginName: name,
        error: {
          code: "CONFLICT" as const,
          message: `Duplicate plugin name "${name}" in ${root.source} root: ${dirs.join(", ")}`,
          retryable: false,
          context: { pluginName: name, directories: dirs },
        },
      });
    }
  }
  // Filter out all copies of duplicate names
  const deduped = plugins.filter((p) => !duplicateNames.has(p.name));

  return { plugins: deduped, errors, rootFailed: false };
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
  // Track sources where the entire root failed — all lower-tier plugins are suppressed
  const failedRootSources = new Set<PluginSource>();
  // Track per-plugin names that failed at higher-priority tiers
  const failedNameAtTier = new Map<string, PluginSource>();

  // Roots are ordered by priority (managed first, bundled last) in buildSourceRoots
  for (const result of results) {
    allErrors.push(...result.errors);

    // If the entire root failed, suppress all lower tiers from providing any plugins
    if (result.rootFailed) {
      for (const err of result.errors) {
        failedRootSources.add(err.source);
      }
      continue;
    }

    // Record per-plugin failed names at this tier's priority
    // Use pluginName (from validated manifest) when available, fallback to directory basename
    for (const err of result.errors) {
      const name = err.pluginName ?? basename(err.dirPath);
      if (name && !failedNameAtTier.has(name)) {
        failedNameAtTier.set(name, err.source);
      }
    }

    for (const plugin of result.plugins) {
      // Fail closed: if any higher-priority root failed entirely, suppress lower-tier plugins
      let suppressed = false;
      for (const failedSource of failedRootSources) {
        if (PRIORITY[failedSource] < PRIORITY[plugin.source]) {
          suppressed = true;
          break;
        }
      }
      if (suppressed) continue;

      // Fail closed: if a higher-priority tier had a per-plugin error for this name
      const failedSource = failedNameAtTier.get(plugin.name);
      if (failedSource !== undefined && PRIORITY[failedSource] < PRIORITY[plugin.source]) {
        continue;
      }

      // Unavailable plugins still occupy their name slot to prevent lower-tier takeover
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
