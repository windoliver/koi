/**
 * @koi/rules-loader — File loading.
 *
 * Reads a single rules file from disk and returns its content with a token
 * estimate. Returns Result — file-not-found is an expected failure.
 */

import { readFile, stat } from "node:fs/promises";
import type { KoiError, Result } from "@koi/core";
import { estimateTokens } from "@koi/token-estimator";

import type { DiscoveredFile, LoadedFile } from "./config.js";

/**
 * Read a single rules file from disk.
 * Returns `Result<LoadedFile, KoiError>` — ENOENT is expected, not thrown.
 */
export async function loadRulesFile(file: DiscoveredFile): Promise<Result<LoadedFile, KoiError>> {
  try {
    const content = await readFile(file.path, "utf-8");
    const fileStat = await stat(file.path);
    const tokens = estimateTokens(content);

    return {
      ok: true,
      value: {
        path: file.path,
        depth: file.depth,
        content,
        estimatedTokens: tokens,
        mtimeMs: fileStat.mtimeMs,
      },
    };
  } catch (e: unknown) {
    const code =
      e !== null && typeof e === "object" && "code" in e ? (e as { code: string }).code : undefined;
    const koiCode = code === "ENOENT" ? "NOT_FOUND" : "EXTERNAL";
    const message =
      code === "ENOENT"
        ? `Rules file not found: ${file.path}`
        : `Failed to read rules file: ${file.path} (${code ?? "unknown error"})`;
    const error: KoiError = {
      code: koiCode,
      message,
      retryable: false,
      context: { path: file.path },
    };
    return { ok: false, error };
  }
}

/**
 * Load all discovered rules files. Skips files that fail to load (logs warning).
 * Returns successfully loaded files in the same order as input.
 */
export async function loadAllRulesFiles(
  files: readonly DiscoveredFile[],
): Promise<readonly LoadedFile[]> {
  const loaded: LoadedFile[] = [];

  for (const file of files) {
    const result = await loadRulesFile(file);
    if (result.ok) {
      loaded.push(result.value);
    } else {
      console.warn(`[rules-loader] Skipping ${file.path}: ${result.error.message}`);
    }
  }

  return loaded;
}
