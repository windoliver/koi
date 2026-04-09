/**
 * Plugin lifecycle operations — install, remove, enable, disable, update, list.
 * All operations return Result<T, KoiError> for expected failures.
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { isPluginId, pluginId } from "./plugin-id.js";
import type { PluginRegistry } from "./registry.js";
import { createPluginRegistry } from "./registry.js";
import { validatePluginManifest } from "./schema.js";
import { readPluginState, writePluginState } from "./state.js";
import type { LoadedPlugin, PluginMeta, PluginRegistryConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginLifecycleConfig {
  readonly userRoot: string;
  readonly registry: PluginRegistry;
}

export interface PluginListEntry {
  readonly meta: PluginMeta;
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateName(name: string): Result<void, KoiError> {
  if (!isPluginId(name)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid plugin name "${name}" — must be kebab-case (a-z, 0-9, hyphens)`,
        retryable: false,
        context: { name },
      },
    };
  }
  return { ok: true, value: undefined };
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function readManifestName(dir: string): Promise<Result<string, KoiError>> {
  const manifestPath = join(dir, "plugin.json");
  let content: string;
  try {
    content = await readFile(manifestPath, "utf-8");
  } catch {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `No plugin.json found at ${manifestPath}`,
        retryable: false,
        context: { manifestPath },
      },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid plugin.json: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
        context: { manifestPath },
      },
    };
  }

  const validated = validatePluginManifest(raw);
  if (!validated.ok) return validated;

  return { ok: true, value: validated.value.name };
}

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

/**
 * Recovers from interrupted update operations.
 * Restores `.backup` dirs when the canonical dir is missing,
 * and cleans up orphaned `.updating` staging dirs.
 */
export async function recoverOrphanedUpdates(userRoot: string): Promise<void> {
  let entries: string[];
  try {
    entries = (await readdir(userRoot)).filter(
      (e) => e.endsWith(".backup") || e.endsWith(".updating"),
    );
  } catch {
    return; // userRoot doesn't exist yet — nothing to recover
  }

  for (const entry of entries) {
    const fullPath = join(userRoot, entry);
    if (entry.endsWith(".backup")) {
      const canonicalName = entry.slice(0, -".backup".length);
      const canonicalPath = join(userRoot, canonicalName);
      if (!(await dirExists(canonicalPath))) {
        // Canonical dir missing — restore from backup
        await rename(fullPath, canonicalPath).catch(() => {});
      } else {
        // Both exist — canonical was successfully placed, clean up backup
        await rm(fullPath, { recursive: true, force: true });
      }
    } else if (entry.endsWith(".updating")) {
      // Orphaned staging dir — clean up
      await rm(fullPath, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Installs a plugin by copying from sourcePath into `<userRoot>/<name>/`.
 * Validates manifest after copy (TOCTOU protection). Rolls back on failure.
 */
export async function installPlugin(
  config: PluginLifecycleConfig,
  sourcePath: string,
): Promise<Result<PluginMeta, KoiError>> {
  // Pre-validate source has a readable plugin.json
  const nameResult = await readManifestName(sourcePath);
  if (!nameResult.ok) return nameResult;

  const name = nameResult.value;
  if (!isPluginId(name)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Plugin name "${name}" is not a valid plugin ID (must be kebab-case)`,
        retryable: false,
        context: { name },
      },
    };
  }

  const destPath = join(config.userRoot, name);

  // Check for conflict
  if (await dirExists(destPath)) {
    return {
      ok: false,
      error: {
        code: "CONFLICT",
        message: `Plugin "${name}" is already installed at ${destPath}`,
        retryable: false,
        context: { name, destPath },
      },
    };
  }

  // Ensure userRoot exists
  await mkdir(config.userRoot, { recursive: true });

  // Copy source to userRoot/<name>/
  try {
    await cp(sourcePath, destPath, { recursive: true, dereference: true });
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Failed to copy plugin: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        context: { sourcePath, destPath },
      },
    };
  }

  // Re-validate manifest from the copy (TOCTOU protection)
  const postCopyName = await readManifestName(destPath);
  if (!postCopyName.ok) {
    await rm(destPath, { recursive: true, force: true });
    return postCopyName;
  }
  if (postCopyName.value !== name) {
    await rm(destPath, { recursive: true, force: true });
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Plugin manifest changed during copy: expected "${name}", got "${postCopyName.value}"`,
        retryable: false,
        context: { expected: name, actual: postCopyName.value },
      },
    };
  }

  // Build PluginMeta directly from the validated copy instead of relying on
  // full registry discovery, which can fail if a higher-priority root is down.
  config.registry.invalidate();
  const loadResult = await config.registry.load(name);
  if (loadResult.ok) {
    return { ok: true, value: loadResult.value };
  }

  // Fallback: construct minimal PluginMeta from the validated manifest
  const manifest = validatePluginManifest(
    JSON.parse(await readFile(join(destPath, "plugin.json"), "utf-8")),
  );
  if (!manifest.ok) return manifest;

  const meta: PluginMeta = {
    id: pluginId(name),
    name,
    source: "user",
    version: manifest.value.version,
    description: manifest.value.description,
    dirPath: destPath,
    manifest: manifest.value,
    available: true,
  };
  return { ok: true, value: meta };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Removes a plugin from userRoot and cleans up disabled state.
 * State is cleaned before the destructive delete so that a state-write
 * failure can be surfaced without having already lost the plugin directory.
 */
export async function removePlugin(
  config: PluginLifecycleConfig,
  name: string,
): Promise<Result<void, KoiError>> {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return nameCheck;

  const destPath = join(config.userRoot, name);

  if (!(await dirExists(destPath))) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Plugin "${name}" is not installed in user root`,
        retryable: false,
        context: { name, destPath },
      },
    };
  }

  // Clean up disabled state BEFORE destructive delete so failure is recoverable.
  // Abort if state is unreadable to avoid orphaned tombstones.
  const stateResult = await readPluginState(config.userRoot);
  if (!stateResult.ok) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Cannot read plugin state before removing "${name}": ${stateResult.error.message}`,
        retryable: true,
        context: { name, stateError: stateResult.error.message },
      },
    };
  }
  if (stateResult.value.has(name)) {
    const updated = new Set<string>(stateResult.value);
    updated.delete(name);
    const writeResult = await writePluginState(config.userRoot, updated);
    if (!writeResult.ok) {
      return {
        ok: false,
        error: {
          code: "INTERNAL",
          message: `Cannot clean up disabled state for "${name}": ${writeResult.error.message}. Plugin not removed.`,
          retryable: true,
          context: { name, stateError: writeResult.error.message },
        },
      };
    }
  }

  await rm(destPath, { recursive: true, force: true });

  config.registry.invalidate();
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Enable / Disable
// ---------------------------------------------------------------------------

/**
 * Enables a plugin by removing it from the disabled set. Idempotent.
 * Rejects non-existent plugin names to prevent tombstone state.
 */
export async function enablePlugin(
  config: PluginLifecycleConfig,
  name: string,
): Promise<Result<void, KoiError>> {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return nameCheck;

  // Verify plugin exists to prevent tombstone state for typos
  config.registry.invalidate();
  const plugins = await config.registry.discover();
  if (!plugins.some((p) => p.name === name)) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Plugin "${name}" is not installed — cannot enable`,
        retryable: false,
        context: { name },
      },
    };
  }

  const stateResult = await readPluginState(config.userRoot);
  if (!stateResult.ok) return stateResult;

  if (!stateResult.value.has(name)) {
    return { ok: true, value: undefined }; // Already enabled — no-op
  }

  const updated = new Set<string>(stateResult.value);
  updated.delete(name);
  return writePluginState(config.userRoot, updated);
}

/**
 * Disables a plugin by adding it to the disabled set. Idempotent.
 * Rejects non-existent plugin names to prevent tombstone state.
 */
export async function disablePlugin(
  config: PluginLifecycleConfig,
  name: string,
): Promise<Result<void, KoiError>> {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return nameCheck;

  // Verify plugin exists to prevent tombstone state for typos
  config.registry.invalidate();
  const plugins = await config.registry.discover();
  if (!plugins.some((p) => p.name === name)) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Plugin "${name}" is not installed — cannot disable`,
        retryable: false,
        context: { name },
      },
    };
  }

  const stateResult = await readPluginState(config.userRoot);
  if (!stateResult.ok) return stateResult;

  if (stateResult.value.has(name)) {
    return { ok: true, value: undefined }; // Already disabled — no-op
  }

  const updated = new Set<string>(stateResult.value);
  updated.add(name);
  return writePluginState(config.userRoot, updated);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Updates a plugin by replacing its directory with a new copy.
 * Uses rollback-safe swap with backup directory.
 * Recovers orphaned backups from prior interrupted updates.
 */
export async function updatePlugin(
  config: PluginLifecycleConfig,
  name: string,
  sourcePath: string,
): Promise<Result<PluginMeta, KoiError>> {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return nameCheck;

  // Recover from any previous interrupted update before proceeding
  await recoverOrphanedUpdates(config.userRoot);

  const destPath = join(config.userRoot, name);
  const stagingPath = join(config.userRoot, `${name}.updating`);

  if (!(await dirExists(destPath))) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Plugin "${name}" is not installed — cannot update`,
        retryable: false,
        context: { name, destPath },
      },
    };
  }

  // Validate source manifest name matches target
  const nameResult = await readManifestName(sourcePath);
  if (!nameResult.ok) return nameResult;
  if (nameResult.value !== name) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Source manifest name "${nameResult.value}" does not match target plugin "${name}"`,
        retryable: false,
        context: { expected: name, actual: nameResult.value },
      },
    };
  }

  // Clean up any leftover staging directory
  await rm(stagingPath, { recursive: true, force: true });

  // Copy to staging
  try {
    await cp(sourcePath, stagingPath, { recursive: true, dereference: true });
  } catch (err: unknown) {
    await rm(stagingPath, { recursive: true, force: true });
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Failed to stage plugin update: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        context: { sourcePath, stagingPath },
      },
    };
  }

  // Post-copy TOCTOU validation: re-read manifest from staged copy
  const postCopyResult = await readManifestName(stagingPath);
  if (!postCopyResult.ok) {
    await rm(stagingPath, { recursive: true, force: true });
    return postCopyResult;
  }
  if (postCopyResult.value !== name) {
    await rm(stagingPath, { recursive: true, force: true });
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Staged manifest changed during copy: expected "${name}", got "${postCopyResult.value}"`,
        retryable: false,
        context: { expected: name, actual: postCopyResult.value },
      },
    };
  }

  // Rollback-safe swap: backup old → rename staging → clean up backup
  const backupPath = join(config.userRoot, `${name}.backup`);
  await rm(backupPath, { recursive: true, force: true });

  try {
    await rename(destPath, backupPath);
  } catch (err: unknown) {
    await rm(stagingPath, { recursive: true, force: true });
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Failed to back up existing plugin: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        context: { destPath, backupPath },
      },
    };
  }

  try {
    await rename(stagingPath, destPath);
  } catch (err: unknown) {
    // Rollback: restore the backup
    await rename(backupPath, destPath).catch(() => {
      /* best-effort restore — backup is still on disk */
    });
    await rm(stagingPath, { recursive: true, force: true });
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Failed to finalize plugin update: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
        context: { stagingPath, destPath },
      },
    };
  }

  // Swap succeeded — clean up backup
  await rm(backupPath, { recursive: true, force: true });

  // Build PluginMeta directly instead of full registry discovery (see installPlugin)
  config.registry.invalidate();
  const loadResult = await config.registry.load(name);
  if (loadResult.ok) {
    return { ok: true, value: loadResult.value };
  }

  // Fallback: construct minimal PluginMeta from the validated manifest
  const manifest = validatePluginManifest(
    JSON.parse(await readFile(join(destPath, "plugin.json"), "utf-8")),
  );
  if (!manifest.ok) return manifest;

  const meta: PluginMeta = {
    id: pluginId(name),
    name,
    source: "user",
    version: manifest.value.version,
    description: manifest.value.description,
    dirPath: destPath,
    manifest: manifest.value,
    available: true,
  };
  return { ok: true, value: meta };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * Lists all discovered plugins with their enabled/disabled status.
 */
export async function listPlugins(
  config: PluginLifecycleConfig,
): Promise<Result<readonly PluginListEntry[], KoiError>> {
  const stateResult = await readPluginState(config.userRoot);
  if (!stateResult.ok) return stateResult;

  config.registry.invalidate();
  const plugins = await config.registry.discover();

  const entries: readonly PluginListEntry[] = plugins.map((meta) => ({
    meta,
    enabled: !stateResult.value.has(meta.name),
  }));

  return { ok: true, value: entries };
}

// ---------------------------------------------------------------------------
// Gated registry factory
// ---------------------------------------------------------------------------

/**
 * Creates a PluginRegistry that gates discovery by disabled state.
 * Disabled plugins are excluded from discover() and rejected by load().
 *
 * The disabled set is re-read from disk on every discover() and load()
 * call, so enable/disable changes take effect without rebuilding the
 * registry instance. On state read failure, the last known disabled set
 * is preserved (no fail-open or fail-closed extremes).
 */
export function createGatedRegistry(
  registryConfig: PluginRegistryConfig,
  userRoot: string,
): PluginRegistry {
  // Mutable cache — refreshed on each discover()/load() via refreshDisabledState.
  // Starts undefined to distinguish "never read" from "read and empty".
  let disabledCache: ReadonlySet<string> | undefined;

  const gatedConfig: PluginRegistryConfig = {
    ...registryConfig,
    isAvailable: (manifest) => {
      const parentGate = registryConfig.isAvailable;
      if (parentGate !== undefined && !parentGate(manifest)) return false;
      // Before first successful read, disabledCache is undefined.
      // readPluginState returns empty set for ENOENT (first run), so undefined
      // here means a real read failure (corrupt JSON, permission denied).
      // Fail closed: block all plugins until state is readable.
      if (disabledCache === undefined) return false;
      return !disabledCache.has(manifest.name);
    },
  };

  const inner = createPluginRegistry(gatedConfig);

  const refreshDisabledState = async (): Promise<void> => {
    const stateResult = await readPluginState(userRoot);
    if (stateResult.ok) {
      disabledCache = stateResult.value;
    }
    // On failure: keep disabledCache unchanged (last known good state,
    // or undefined if state has never been readable — first-run default)
    inner.invalidate();
  };

  return {
    discover: async (): Promise<readonly PluginMeta[]> => {
      await refreshDisabledState();
      return inner.discover();
    },
    load: async (id: string): Promise<Result<LoadedPlugin, KoiError>> => {
      await refreshDisabledState();
      return inner.load(id);
    },
    invalidate: () => {
      inner.invalidate();
    },
    errors: () => inner.errors(),
  };
}
