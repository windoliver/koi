/**
 * @koi/file-resolution — Shared file-resolution utilities for content injection middleware (L0u).
 *
 * Reads markdown files or inline text, resolves directory structures,
 * enforces token budgets, and provides low-level file reading helpers.
 *
 * Depends on @koi/core only.
 */

export type { ResolvedDirectory } from "./directory.js";
export { resolveDirectoryContent, SECTION_HEADERS, SOUL_DIR_FILES } from "./directory.js";
export { isDirectory, isInlineContent, readBoundedFile, resolveInputPath } from "./read.js";
export type { ResolveContentOptions, ResolvedContent } from "./resolve-content.js";
export { resolveContent } from "./resolve-content.js";
export type { TruncateResult } from "./tokens.js";
export { CHARS_PER_TOKEN, estimateTokens, truncateToTokenBudget } from "./tokens.js";
