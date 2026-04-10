/**
 * @koi/rules-loader — Git root detection.
 *
 * Walks upward from a given directory until a .git directory is found.
 * Inlined (~20 lines) to avoid depending on @koi/mm/memory-fs (not L0u).
 */

import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Walk from `from` upward to filesystem root.
 * Return the first directory containing `.git`, or `undefined` if none found.
 */
export async function findGitRoot(from: string): Promise<string | undefined> {
  let dir = resolve(from);
  for (;;) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch (e: unknown) {
      if (e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT") {
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
        continue;
      }
      throw e;
    }
  }
}
