/**
 * @koi/knowledge-vault — L2 ComponentProvider for business context hydration.
 *
 * Hydrates agent context from structured knowledge bases (Obsidian vaults,
 * markdown directories, or indexed stores) using BM25 ranking and
 * token-budget-aware selection.
 */

// Re-exports for consumer convenience (consumers can also import directly)
export type { FileSystemBackend } from "@koi/core";
export type { FileSystemScope } from "@koi/scope";
// BM25 (exported for advanced usage / custom pipelines)
export {
  type BM25Config,
  type BM25Document,
  type BM25Index,
  type BM25Result,
  createBM25Index,
} from "./bm25.js";
// ComponentProvider factory
export { createKnowledgeVaultProvider } from "./component-provider.js";
// Context source adapter for @koi/context integration
export { createKnowledgeSourceResolver } from "./context-source-adapter.js";
// Frontmatter parser (exported for reuse)
export { type FrontmatterResult, parseFrontmatter } from "./frontmatter.js";
// Selector (exported for advanced usage)
export { type SelectionResult, selectWithinBudget } from "./selector.js";
// ECS component token + public types
export {
  DEFAULT_GLOB,
  DEFAULT_MAX_INDEX_CHARS,
  DEFAULT_MAX_WARNINGS,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_TOKEN_BUDGET,
  type DirectorySourceConfig,
  type IndexSourceConfig,
  KNOWLEDGE,
  type KnowledgeComponent,
  type KnowledgeDocument,
  type KnowledgeSourceConfig,
  type KnowledgeSourceInfo,
  type KnowledgeSourceKind,
  type KnowledgeVaultConfig,
  type NexusSourceConfig,
  type RefreshResult,
} from "./types.js";
// Vault service (for advanced usage / context-source adapter)
export { createVaultService, type VaultService } from "./vault-service.js";
