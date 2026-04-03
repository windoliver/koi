/**
 * DRY helper for loading a manifest and exiting on failure.
 *
 * Replaces the 7-line load+check+exit pattern duplicated across
 * demo.ts, up/index.ts, and other command files.
 */

import type { LoadResult } from "@koi/manifest";
import { loadManifest } from "@koi/manifest";
import { EXIT_CONFIG } from "@koi/shutdown";

/**
 * Loads a manifest from the given path, writing an error and exiting
 * if the load fails.
 */
export async function loadManifestOrExit(
  manifestPath: string,
  exitCode?: number,
): Promise<LoadResult> {
  const loadResult = await loadManifest(manifestPath, undefined, {
    rejectUnsupportedHooks: true,
  });
  if (!loadResult.ok) {
    process.stderr.write(`Failed to load manifest: ${loadResult.error.message}\n`);
    process.exit(exitCode ?? EXIT_CONFIG);
  }
  return loadResult.value;
}
