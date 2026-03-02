/**
 * @koi/knowledge-vault — Types and constants.
 *
 * Defines the KNOWLEDGE ECS component, configuration types, and internal
 * data structures for the knowledge vault pipeline.
 */

import type { FileSystemBackend, SubsystemToken } from "@koi/core";
import { token } from "@koi/core";
import type { FileSystemScope } from "@koi/scope";
import type { Retriever } from "@koi/search-provider";

// ---------------------------------------------------------------------------
// KNOWLEDGE ECS component token
// ---------------------------------------------------------------------------

/** ECS component token for runtime knowledge vault access. */
export const KNOWLEDGE: SubsystemToken<KnowledgeComponent> =
  token<KnowledgeComponent>("koi.knowledge");

// ---------------------------------------------------------------------------
// Component interface (attached to agent at assembly time)
// ---------------------------------------------------------------------------

/** Component providing query access to indexed knowledge bases. */
export interface KnowledgeComponent {
  readonly sources: readonly KnowledgeSourceInfo[];
  readonly query: (query: string, limit?: number) => Promise<readonly KnowledgeDocument[]>;
  readonly refresh: () => Promise<RefreshResult>;
}

// ---------------------------------------------------------------------------
// Public value types
// ---------------------------------------------------------------------------

/** A single document returned from a knowledge query. */
export interface KnowledgeDocument {
  readonly path: string;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly lastModified: number;
  readonly relevanceScore: number;
}

/** Metadata about a configured knowledge source. */
export interface KnowledgeSourceInfo {
  readonly name: string;
  readonly kind: KnowledgeSourceKind;
  readonly description?: string | undefined;
  readonly documentCount: number;
}

export type KnowledgeSourceKind = "directory" | "index" | "nexus";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Top-level config for createKnowledgeVaultProvider(). */
export interface KnowledgeVaultConfig {
  readonly sources: readonly KnowledgeSourceConfig[];
  /** Token budget for query results. Default: 4000. */
  readonly tokenBudget?: number | undefined;
  /** Minimum relevance score (0–1). Default: 0.0 (include all). */
  readonly relevanceThreshold?: number | undefined;
  /** Max chars indexed per document for BM25. Default: 2000. */
  readonly maxIndexCharsPerDoc?: number | undefined;
  /** Maximum accumulated warnings before truncation. Default: 50. */
  readonly maxWarnings?: number | undefined;
  /** Filesystem scope for path boundary enforcement. Applied to directory sources with backends. */
  readonly scope?: FileSystemScope | undefined;
}

/** Discriminated union of source configurations. */
export type KnowledgeSourceConfig = DirectorySourceConfig | IndexSourceConfig | NexusSourceConfig;

export interface DirectorySourceConfig {
  readonly kind: "directory";
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly path: string;
  /** Glob pattern for file discovery. Default: "**\/*.md" */
  readonly glob?: string | undefined;
  /** Glob patterns to exclude. */
  readonly exclude?: readonly string[] | undefined;
  /** Optional filesystem backend. When absent, uses Bun APIs (local FS). */
  readonly backend?: FileSystemBackend | undefined;
}

export interface IndexSourceConfig {
  readonly kind: "index";
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly backend: Retriever<unknown>;
}

export interface NexusSourceConfig {
  readonly kind: "nexus";
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly endpoint: string;
}

// ---------------------------------------------------------------------------
// Internal value types (used across source modules + orchestration)
// ---------------------------------------------------------------------------

/** A document after parsing, before BM25 scoring. */
export interface ParsedDocument {
  readonly path: string;
  readonly title: string;
  readonly body: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly tags: readonly string[];
  readonly lastModified: number;
  readonly tokens: number;
}

/** Result of scanning a single source. */
export interface ScanResult {
  readonly documents: readonly ParsedDocument[];
  readonly warnings: readonly string[];
}

/** Result of a refresh operation. */
export interface RefreshResult {
  readonly documentCount: number;
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_TOKEN_BUDGET = 4000;
export const DEFAULT_RELEVANCE_THRESHOLD = 0.0;
export const DEFAULT_MAX_INDEX_CHARS = 2000;
export const DEFAULT_MAX_WARNINGS = 50;
export const DEFAULT_BATCH_SIZE = 64;
export const DEFAULT_GLOB = "**/*.md";
