/**
 * Vault service — core orchestration for knowledge vault.
 *
 * Scans sources → builds BM25 index → answers queries with budget selection.
 * Central coordination point between source modules, BM25, and selector.
 */

import type { FileSystemBackend, KoiError, Result, TokenEstimator } from "@koi/core";
import type { FileSystemScope } from "@koi/scope";
import { createScopedFileSystem } from "@koi/scope";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";

import { type BM25Index, createBM25Index } from "./bm25.js";
import { type ScoredDocument, selectWithinBudget } from "./selector.js";
import { scanDirectory } from "./source-directory.js";
import { scanIndex } from "./source-index.js";
import { scanNexus } from "./source-nexus.js";
import type {
  DirectorySourceConfig,
  KnowledgeDocument,
  KnowledgeSourceConfig,
  KnowledgeSourceInfo,
  KnowledgeVaultConfig,
  ParsedDocument,
  RefreshResult,
  ScanResult,
} from "./types.js";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_INDEX_CHARS,
  DEFAULT_MAX_WARNINGS,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_TOKEN_BUDGET,
} from "./types.js";

/** Public interface for querying a knowledge vault. */
export interface VaultService {
  readonly query: (query: string, limit?: number) => Promise<readonly KnowledgeDocument[]>;
  readonly refresh: () => Promise<RefreshResult>;
  readonly sources: readonly KnowledgeSourceInfo[];
}

/**
 * Create a vault service from configuration.
 *
 * Performs initial scan of all sources and builds the BM25 index.
 * Returns `Result` — may fail if all sources fail to load.
 */
export async function createVaultService(
  config: KnowledgeVaultConfig,
  estimator?: TokenEstimator,
): Promise<Result<VaultService, KoiError>> {
  const est = estimator ?? HEURISTIC_ESTIMATOR;
  const tokenBudget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const relevanceThreshold = config.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const maxIndexChars = config.maxIndexCharsPerDoc ?? DEFAULT_MAX_INDEX_CHARS;
  const maxWarnings = config.maxWarnings ?? DEFAULT_MAX_WARNINGS;

  const vaultScope = config.scope;

  // Mutable state — rebuilt on refresh()
  // let is required — state rebuilt on refresh
  let state = await buildState(config.sources, maxIndexChars, maxWarnings, est, vaultScope);

  function query(queryText: string, limit?: number): Promise<readonly KnowledgeDocument[]> {
    if (queryText.trim() === "") {
      return Promise.resolve([]);
    }

    const bm25Results = state.index.search(queryText, limit ?? 100);

    // Map BM25 results to scored documents
    const scored: ScoredDocument[] = [];
    for (const r of bm25Results) {
      if (r.score < relevanceThreshold) continue;

      const doc = state.docMap.get(r.id);
      if (doc === undefined) continue;

      const sourceIdx = state.sourceIndexMap.get(r.id) ?? 0;
      scored.push({
        document: {
          path: doc.path,
          title: doc.title,
          content: doc.body,
          tags: doc.tags,
          lastModified: doc.lastModified,
          relevanceScore: r.score,
        },
        sourceIndex: sourceIdx,
      });
    }

    const selection = selectWithinBudget(scored, state.sourceInfos, tokenBudget, est);

    const results = limit !== undefined ? selection.selected.slice(0, limit) : selection.selected;

    return Promise.resolve(results);
  }

  async function refresh(): Promise<RefreshResult> {
    state = await buildState(config.sources, maxIndexChars, maxWarnings, est, vaultScope);
    return {
      documentCount: state.totalDocs,
      warnings: state.warnings,
    };
  }

  return {
    ok: true,
    value: {
      query,
      refresh,
      get sources(): readonly KnowledgeSourceInfo[] {
        return state.sourceInfos;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Internal state management
// ---------------------------------------------------------------------------

interface VaultState {
  readonly index: BM25Index;
  readonly docMap: ReadonlyMap<string, ParsedDocument>;
  readonly sourceIndexMap: ReadonlyMap<string, number>;
  readonly sourceInfos: readonly KnowledgeSourceInfo[];
  readonly warnings: readonly string[];
  readonly totalDocs: number;
}

async function buildState(
  sources: readonly KnowledgeSourceConfig[],
  maxIndexChars: number,
  maxWarnings: number,
  estimator: TokenEstimator,
  scope?: FileSystemScope | undefined,
): Promise<VaultState> {
  const allWarnings: string[] = [];
  const sourceInfos: KnowledgeSourceInfo[] = [];
  const sourceIndexMap = new Map<string, number>();
  const docMap = new Map<string, ParsedDocument>();

  // Internal keys are namespaced by source index to avoid collisions
  // when multiple sources have documents with the same relative path
  const internalKeys: string[] = [];

  const scanResults = await Promise.allSettled(
    sources.map((source) => scanSource(source, maxIndexChars, maxWarnings, estimator, scope)),
  );

  for (const [i, result] of scanResults.entries()) {
    const sourceConfig = sources[i]!;
    if (result.status === "fulfilled") {
      const scan = result.value;
      for (const doc of scan.documents) {
        const key = `${String(i)}:${doc.path}`;
        sourceIndexMap.set(key, i);
        docMap.set(key, doc);
        internalKeys.push(key);
      }
      for (const w of scan.warnings) {
        if (allWarnings.length < maxWarnings) {
          allWarnings.push(w);
        }
      }
      sourceInfos.push({
        name: sourceConfig.name ?? `${sourceConfig.kind}-${String(i)}`,
        kind: sourceConfig.kind,
        description: sourceConfig.description,
        documentCount: scan.documents.length,
      });
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      if (allWarnings.length < maxWarnings) {
        allWarnings.push(`Source "${sourceConfig.name ?? sourceConfig.kind}" failed: ${reason}`);
      }
      sourceInfos.push({
        name: sourceConfig.name ?? `${sourceConfig.kind}-${String(i)}`,
        kind: sourceConfig.kind,
        description: sourceConfig.description,
        documentCount: 0,
      });
    }
  }

  // Build BM25 index using internal keys as document IDs
  const bm25Docs: {
    readonly id: string;
    readonly text: string;
    readonly titleText: string;
    readonly tagText: string;
  }[] = [];
  for (const key of internalKeys) {
    const doc = docMap.get(key);
    if (doc === undefined) continue;
    bm25Docs.push({
      id: key,
      text: doc.body,
      titleText: doc.title,
      tagText: doc.tags.join(" "),
    });
  }

  const index = createBM25Index(bm25Docs);

  return {
    index,
    docMap,
    sourceIndexMap,
    sourceInfos,
    warnings: allWarnings,
    totalDocs: internalKeys.length,
  };
}

async function scanSource(
  config: KnowledgeSourceConfig,
  maxIndexChars: number,
  maxWarnings: number,
  estimator: TokenEstimator,
  scope?: FileSystemScope | undefined,
): Promise<ScanResult> {
  switch (config.kind) {
    case "directory": {
      const effectiveConfig = wrapDirectoryBackendWithScope(config, scope);
      return scanDirectory(effectiveConfig, {
        maxIndexCharsPerDoc: maxIndexChars,
        maxWarnings,
        batchSize: DEFAULT_BATCH_SIZE,
        estimator,
      });
    }
    case "index":
      return scanIndex(config, 1000);
    case "nexus":
      return scanNexus(config, 1000);
  }
}

/**
 * Wrap a directory source's backend with scope enforcement when both are present.
 *
 * Returns the config unchanged if either backend or scope is absent.
 */
function wrapDirectoryBackendWithScope(
  config: DirectorySourceConfig,
  scope: FileSystemScope | undefined,
): DirectorySourceConfig {
  if (config.backend === undefined || scope === undefined) {
    return config;
  }
  const scopedBackend: FileSystemBackend = createScopedFileSystem(config.backend, scope);
  return { ...config, backend: scopedBackend };
}
