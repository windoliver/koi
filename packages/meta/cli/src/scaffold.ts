/**
 * Atomic scaffold writer — writes files to a temp directory, then renames to target.
 * Prevents partial scaffolds on Ctrl+C or disk errors.
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileMap } from "./templates/shared.js";

type ScaffoldOk = { readonly ok: true };
type ScaffoldErr = { readonly ok: false; readonly error: string };
type ScaffoldResult = ScaffoldOk | ScaffoldErr;

export async function writeScaffold(targetDir: string, files: FileMap): Promise<ScaffoldResult> {
  const entries = Object.entries(files);

  if (entries.length === 0) {
    return { ok: false, error: "No files to write" };
  }

  // Check for koi.yaml conflict in existing directory
  if (existsSync(join(targetDir, "koi.yaml"))) {
    return {
      ok: false,
      error: `A koi.yaml already exists in ${targetDir}. Remove it first or choose a different directory.`,
    };
  }

  // Write to temp directory on same filesystem for atomic rename
  const tempDir = join(
    dirname(targetDir),
    `.koi-init-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  try {
    mkdirSync(tempDir, { recursive: true });

    // Write all files to temp directory
    for (const [relativePath, content] of entries) {
      const fullPath = join(tempDir, relativePath);
      const dir = dirname(fullPath);
      mkdirSync(dir, { recursive: true });
      await Bun.write(fullPath, content);
    }

    // Atomic move: if target exists (empty dir), move files into it
    if (existsSync(targetDir)) {
      // Move each file individually into the existing directory
      for (const [relativePath] of entries) {
        const src = join(tempDir, relativePath);
        const dest = join(targetDir, relativePath);
        const destDir = dirname(dest);
        mkdirSync(destDir, { recursive: true });
        renameSync(src, dest);
      }
      rmSync(tempDir, { recursive: true, force: true });
    } else {
      // Atomic rename of entire directory
      renameSync(tempDir, targetDir);
    }

    return { ok: true };
  } catch (err: unknown) {
    // Clean up temp directory on failure
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to scaffold project: ${message}` };
  }
}
