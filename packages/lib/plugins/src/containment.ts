/**
 * Path containment check — ensures resolved paths stay within a root directory.
 * Prevents symlink escapes and ../traversal after realpath resolution.
 */

import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";

/**
 * Resolves a relative path against a root directory, then asserts
 * the resolved path is contained within that root.
 *
 * @param relativePath — path from the manifest (e.g., "./skills/greeting")
 * @param rootDir — absolute path to the plugin root (must itself be resolved)
 * @returns the resolved absolute path, or a PERMISSION error
 */
export async function assertContained(
  relativePath: string,
  rootDir: string,
): Promise<Result<string, KoiError>> {
  const joined = resolve(rootDir, relativePath);

  let resolved: string;
  try {
    resolved = await realpath(joined);
  } catch {
    return {
      ok: false,
      error: {
        code: "PERMISSION",
        message: `Path does not exist or cannot be resolved: ${relativePath}`,
        retryable: false,
        context: { relativePath, rootDir },
      },
    };
  }

  const normalizedRoot = await realpath(rootDir).catch(() => rootDir);
  const rel = relative(normalizedRoot, resolved);
  // Reject if relative path escapes root (starts with ..) or is absolute (different drive on Windows)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      ok: false,
      error: {
        code: "PERMISSION",
        message: `Path escapes plugin root: ${relativePath} resolves to ${resolved}`,
        retryable: false,
        context: { relativePath, rootDir, resolved },
      },
    };
  }

  return { ok: true, value: resolved };
}
