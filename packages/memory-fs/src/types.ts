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
