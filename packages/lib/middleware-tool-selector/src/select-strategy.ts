/**
 * Built-in selection strategies for the tool-selector middleware.
 *
 * Two factories:
 * - `createKeywordSelectTools` — score tools by query keyword overlap with
 *   `name + description`, returning names sorted by descending score.
 * - `createTagSelectTools` — deterministic include/exclude filter on
 *   `ToolDescriptor.tags`. Ignores the query.
 */

import type { ToolDescriptor } from "@koi/core";

/** Function signature shared by both built-in strategies and caller-supplied selectors. */
export type SelectToolsFn = (
  query: string,
  tools: readonly ToolDescriptor[],
) => Promise<readonly string[]>;

/** Minimum query term length — short tokens (e.g., "to", "a") are too noisy to score on. */
const MIN_TERM_LENGTH = 2;

function tokenize(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > MIN_TERM_LENGTH);
}

/**
 * Creates a keyword-scoring selectTools function.
 *
 * Splits the query into terms (length > 2) and scores each tool by counting
 * how many terms appear in `${name} ${description}`. Returns tool names sorted
 * by descending score; tools with score 0 are dropped. When the query has no
 * scoreable terms, every tool name is returned in input order.
 */
export function createKeywordSelectTools(): SelectToolsFn {
  return async (query, tools) => {
    const terms = tokenize(query);
    if (terms.length === 0) {
      return tools.map((t) => t.name);
    }

    const scored = tools.map((tool) => {
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      const score = terms.reduce((acc, term) => acc + (haystack.includes(term) ? 1 : 0), 0);
      return { name: tool.name, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.name);
  };
}

/**
 * Creates a tag-based selectTools function.
 *
 * - `includeTags` (AND): tool must carry every listed tag. Tools without any
 *   tags are dropped when this filter is active.
 * - `excludeTags` (ANY): tool is dropped if it carries any listed tag.
 * - Both `undefined` (or empty) means "no filter" — all tools pass through.
 *
 * Filtering is deterministic; the `query` argument is ignored.
 */
export function createTagSelectTools(
  includeTags: readonly string[] | undefined,
  excludeTags: readonly string[] | undefined,
): SelectToolsFn {
  const hasInclude = includeTags !== undefined && includeTags.length > 0;
  const hasExclude = excludeTags !== undefined && excludeTags.length > 0;

  return async (_query, tools) =>
    tools
      .filter((tool) => keepTool(tool, includeTags, excludeTags, hasInclude, hasExclude))
      .map((t) => t.name);
}

function keepTool(
  tool: ToolDescriptor,
  includeTags: readonly string[] | undefined,
  excludeTags: readonly string[] | undefined,
  hasInclude: boolean,
  hasExclude: boolean,
): boolean {
  const toolTags = tool.tags;

  if (hasInclude && includeTags !== undefined) {
    if (toolTags === undefined) return false;
    if (!includeTags.every((tag) => toolTags.includes(tag))) return false;
  }

  if (hasExclude && excludeTags !== undefined && toolTags !== undefined) {
    if (excludeTags.some((tag) => toolTags.includes(tag))) return false;
  }

  return true;
}
