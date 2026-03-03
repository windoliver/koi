/**
 * Unified content resolution — inline text, single file, or directory mode.
 */

import { resolveDirectoryContent } from "./directory.js";
import { isDirectory, isInlineContent, readBoundedFile, resolveInputPath } from "./read.js";
import { estimateTokens, truncateToTokenBudget } from "./tokens.js";

/** Resolved content ready for injection. */
export interface ResolvedContent {
  readonly text: string;
  readonly tokens: number;
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
}

/** Options for resolving content from a manifest config value. */
export interface ResolveContentOptions {
  readonly input: string;
  readonly maxTokens: number;
  readonly label: string;
  readonly basePath: string;
  /** When true, directory inputs are resolved as structured soul directories. Default: false. */
  readonly allowDirectory?: boolean;
}

/**
 * Resolves content from a string input, supporting three modes:
 * - Inline: string containing newlines => used directly
 * - File: path to a single file
 * - Directory: path to a directory with SOUL.md (only when allowDirectory is true)
 *
 * Returns resolved text with token estimation and optional warnings.
 */
export async function resolveContent(options: ResolveContentOptions): Promise<ResolvedContent> {
  const { input, maxTokens, label, basePath, allowDirectory = false } = options;
  const warnings: string[] = [];

  // Inline mode — string contains newlines
  if (isInlineContent(input)) {
    const result = truncateToTokenBudget(input, maxTokens, label);
    if (result.warning !== undefined) warnings.push(result.warning);
    return {
      text: result.text,
      tokens: estimateTokens(result.text),
      sources: ["inline"],
      warnings,
    };
  }

  // Resolve relative paths against basePath
  const resolvedPath = resolveInputPath(input, basePath);

  // Directory mode (only when allowed)
  if (allowDirectory && (await isDirectory(resolvedPath))) {
    const dirResult = await resolveDirectoryContent(resolvedPath, label);
    // Directory missing required SOUL.md => empty text with warnings
    if (dirResult.text.length === 0) {
      return {
        text: "",
        tokens: 0,
        sources: dirResult.sources,
        warnings: dirResult.warnings,
      };
    }
    const truncated = truncateToTokenBudget(dirResult.text, maxTokens, label);
    if (truncated.warning !== undefined) warnings.push(truncated.warning);
    return {
      text: truncated.text,
      tokens: estimateTokens(truncated.text),
      sources: dirResult.sources,
      warnings: [...dirResult.warnings, ...warnings],
    };
  }

  // Single file mode
  const content = await readBoundedFile(resolvedPath);
  if (content === undefined) {
    return {
      text: "",
      tokens: 0,
      sources: [],
      warnings: [`${label} file not found: ${resolvedPath}`],
    };
  }

  if (content.length === 0) {
    warnings.push(`${label} file is empty: ${resolvedPath}`);
  }

  const truncated = truncateToTokenBudget(content, maxTokens, label);
  if (truncated.warning !== undefined) warnings.push(truncated.warning);
  return {
    text: truncated.text,
    tokens: estimateTokens(truncated.text),
    sources: [resolvedPath],
    warnings,
  };
}
