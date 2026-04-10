/**
 * @koi/rules-loader — Ruleset merging with token budget enforcement.
 *
 * Concatenates loaded files root-first with source markers.
 * Enforces token budget by truncating child (deepest) files first.
 */

import { estimateTokens } from "@koi/token-estimator";

import type { LoadedFile, MergedRuleset } from "./config.js";

/** Format a single file's content block with source marker. */
function formatFileBlock(file: LoadedFile): string {
  return `<!-- source: ${file.path} (depth: ${String(file.depth)}) -->\n${file.content}`;
}

/** Overhead tokens for the wrapper tags and separators. */
const WRAPPER_OVERHEAD = estimateTokens("<project-rules>\n\n</project-rules>");
const SEPARATOR_OVERHEAD = estimateTokens("\n\n---\n\n");

/**
 * Merge loaded files into a single ruleset, enforcing token budget.
 *
 * Files must be ordered root-first (broadest scope first).
 * On budget overflow, child files (highest depth) are dropped first.
 * If even the root file exceeds the budget, its content is truncated.
 */
export function mergeRulesets(files: readonly LoadedFile[], maxTokens: number): MergedRuleset {
  if (files.length === 0) {
    return { content: "", files: [], estimatedTokens: 0, truncated: false };
  }

  // Determine which files fit within the budget (root-first priority)
  let usedTokens = WRAPPER_OVERHEAD;
  const included: LoadedFile[] = [];
  let truncated = false;

  for (const file of files) {
    const separatorCost = included.length > 0 ? SEPARATOR_OVERHEAD : 0;
    const blockTokens = estimateTokens(formatFileBlock(file));
    const totalWithFile = usedTokens + separatorCost + blockTokens;

    if (totalWithFile <= maxTokens) {
      usedTokens = totalWithFile;
      included.push(file);
    } else {
      // This file and all subsequent (deeper) files are dropped
      truncated = true;
      break;
    }
  }

  // If nothing fits (even root exceeds budget), truncate the root file
  const rootFile = files[0];
  if (included.length === 0 && rootFile !== undefined) {
    const block = formatFileBlock(rootFile);
    // Truncate content to fit within budget (rough char estimate)
    const availableTokens = maxTokens - WRAPPER_OVERHEAD;
    const availableChars = Math.max(0, availableTokens * 4); // ~4 chars per token
    const truncatedBlock = block.slice(0, availableChars);

    return {
      content: `<project-rules>\n${truncatedBlock}\n</project-rules>`,
      files: [rootFile.path],
      estimatedTokens: estimateTokens(`<project-rules>\n${truncatedBlock}\n</project-rules>`),
      truncated: true,
    };
  }

  // Assemble the merged content
  const blocks = included.map(formatFileBlock);
  const body = blocks.join("\n\n---\n\n");
  const content = `<project-rules>\n${body}\n</project-rules>`;

  return {
    content,
    files: included.map((f) => f.path),
    estimatedTokens: estimateTokens(content),
    truncated,
  };
}
