/**
 * Shared utilities for CLI commands (start, serve).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentBlock } from "@koi/core";

/**
 * Extracts text from an array of content blocks, joining with newlines.
 */
/**
 * Resolves the dashboard-ui dist directory for serving static SPA assets.
 * Returns undefined if the package is not available (e.g. not built yet).
 */
export function resolveDashboardAssetsDir(): string | undefined {
  try {
    const pkgUrl = import.meta.resolve("@koi/dashboard-ui/package.json");
    const pkgPath = fileURLToPath(pkgUrl);
    return resolve(dirname(pkgPath), "dist");
  } catch {
    return undefined;
  }
}

/**
 * Extracts text from an array of content blocks, joining with newlines.
 */
export function extractTextFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}
