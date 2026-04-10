/**
 * @koi/rules-loader — Hierarchical project rules file injection (L0u).
 *
 * Discovers, loads, merges, and injects project rules files (CLAUDE.md,
 * AGENTS.md, .koi/context.md) into the agent's system prompt.
 */

export {
  DEFAULT_MAX_TOKENS,
  DEFAULT_SCAN_PATHS,
  type DiscoveredFile,
  type LoadedFile,
  type MergedRuleset,
  type ResolvedConfig,
  type RulesLoaderConfig,
  resolveConfig,
  type ScanPath,
  validateRulesLoaderConfig,
} from "./config.js";

export { discoverRulesFiles } from "./discover.js";
export { findGitRoot } from "./find-git-root.js";
export { loadAllRulesFiles, loadRulesFile } from "./load.js";
export { mergeRulesets } from "./merge.js";
export { createRulesMiddleware } from "./middleware.js";
