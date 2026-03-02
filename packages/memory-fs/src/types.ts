import type { MemoryComponent } from "@koi/core";

// ---------------------------------------------------------------------------
// Storage-internal fact (NOT exported from package public API)
// ---------------------------------------------------------------------------

export interface MemoryFact {
  readonly id: string;
  readonly fact: string;
  readonly category: string;
  readonly timestamp: string;
  readonly status: "active" | "superseded";
  readonly supersededBy: string | null;
  readonly relatedEntities: readonly string[];
  readonly lastAccessed: string;
  readonly accessCount: number;
  readonly causalParents?: readonly string[] | undefined;
  readonly causalChildren?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// DI contracts for search (local function types, no @koi/search import)
// ---------------------------------------------------------------------------

export interface FsSearchRetriever {
  readonly retrieve: (query: string, limit: number) => Promise<readonly FsSearchHit[]>;
}

export interface FsSearchIndexer {
  readonly index: (docs: readonly FsIndexDoc[]) => Promise<void>;
  readonly remove: (ids: readonly string[]) => Promise<void>;
}

export interface FsSearchHit {
  readonly id: string;
  readonly score: number;
  readonly content: string;
}

export interface FsIndexDoc {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Merge handler DI contract
// ---------------------------------------------------------------------------

/**
 * Callback that merges two related facts into a single enriched fact.
 *
 * Called when an incoming fact has Jaccard similarity in `[mergeThreshold, dedupThreshold)`.
 * Return the merged text string, or `undefined` to fall through to supersede logic.
 */
export type MergeHandler = (existing: string, incoming: string) => Promise<string | undefined>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface FsMemoryConfig {
  readonly baseDir: string;
  readonly retriever?: FsSearchRetriever | undefined;
  readonly indexer?: FsSearchIndexer | undefined;
  readonly dedupThreshold?: number | undefined;
  readonly freqProtectThreshold?: number | undefined;
  readonly decayHalfLifeDays?: number | undefined;
  readonly maxSummaryFacts?: number | undefined;
  readonly entityHopDecay?: number | undefined; // default 0.5
  readonly maxEntityHops?: number | undefined; // default 1
  readonly perEntityCap?: number | undefined; // default 10
  /** Handler for merging related (but not duplicate) facts. Memory-fs stays LLM-agnostic. */
  readonly mergeHandler?: MergeHandler | undefined;
  /** Jaccard threshold below dedupThreshold to trigger merge. Default 0.4. */
  readonly mergeThreshold?: number | undefined;
  /** Enable composite salience scoring for recall ranking. Default true. */
  readonly salienceEnabled?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Public return type
// ---------------------------------------------------------------------------

export interface FsMemory {
  readonly component: MemoryComponent;
  readonly rebuildSummaries: () => Promise<void>;
  readonly getTierDistribution: () => Promise<TierDistribution>;
  readonly listEntities: () => Promise<readonly string[]>;
  readonly close: () => Promise<void>;
}

export interface TierDistribution {
  readonly hot: number;
  readonly warm: number;
  readonly cold: number;
  readonly total: number;
}

// ---------------------------------------------------------------------------
// Fact-store internal interface
// ---------------------------------------------------------------------------

export type FactUpdates = Partial<
  Pick<
    MemoryFact,
    "lastAccessed" | "accessCount" | "status" | "supersededBy" | "causalParents" | "causalChildren"
  >
>;

export interface FactStore {
  readonly readFacts: (entity: string) => Promise<readonly MemoryFact[]>;
  readonly appendFact: (entity: string, fact: MemoryFact) => Promise<void>;
  readonly updateFact: (entity: string, id: string, updates: FactUpdates) => Promise<void>;
  readonly listEntities: () => Promise<readonly string[]>;
  readonly close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal scored candidate (shared by recall pipeline and cross-entity)
// ---------------------------------------------------------------------------

export interface ScoredCandidate {
  readonly fact: MemoryFact;
  readonly entity: string;
  readonly score: number;
}
