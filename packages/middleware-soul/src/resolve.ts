/**
 * Soul/user content resolution — thin wrappers around @koi/file-resolution.
 *
 * Delegates to `resolveContent()` from `@koi/file-resolution` with the
 * appropriate `allowDirectory` flag for each use case.
 */

import type { ResolvedContent as FileResolvedContent } from "@koi/file-resolution";
import { resolveContent } from "@koi/file-resolution";

/** Resolved soul/user content ready for injection. */
export type ResolvedContent = FileResolvedContent;

/** Options for resolving a soul or user field from manifest config. */
export interface ResolveOptions {
  readonly input: string;
  readonly maxTokens: number;
  readonly label: "soul" | "user";
  readonly basePath: string;
}

/**
 * Resolves soul content from a manifest config value.
 *
 * Supports three input modes:
 * - Inline: string containing newlines => used directly
 * - File: path to a single .md file
 * - Directory: path to a directory with SOUL.md (required), STYLE.md, INSTRUCTIONS.md (optional)
 */
export async function resolveSoulContent(options: ResolveOptions): Promise<ResolvedContent> {
  return resolveContent({ ...options, allowDirectory: true });
}

/**
 * Resolves user content from a manifest config value.
 *
 * Same as soul resolution but:
 * - No directory mode (user is always a single file or inline)
 * - Missing file => warning + empty result (not an error)
 */
export async function resolveUserContent(options: ResolveOptions): Promise<ResolvedContent> {
  return resolveContent({ ...options, allowDirectory: false });
}
