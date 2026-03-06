/**
 * Brick store — persistence contracts for forged artifacts.
 *
 * Backend-agnostic interfaces. Any L2 package can provide a concrete
 * implementation (in-memory, SQLite, Nexus, etc.) by importing only from
 * `@koi/core`.
 */

import type { BrickComposition } from "./brick-composition.js";
import type { BrickId } from "./brick-snapshot.js";
import type { ToolOrigin, ToolPolicy } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";
import type { BrickKind, BrickLifecycle, ForgeScope } from "./forge-types.js";
import type { ContentMarker, DataClassification, ForgeProvenance } from "./provenance.js";

// ---------------------------------------------------------------------------
// Test case (used by ToolArtifact)
// ---------------------------------------------------------------------------

export interface TestCase {
  readonly name: string;
  readonly input: unknown;
  readonly expectedOutput?: unknown;
  readonly shouldThrow?: boolean;
}

/** Runtime failure recorded as a future test input for regression testing. */
export interface CounterExample {
  readonly input: unknown;
  readonly expectedBehavior: string;
  readonly actualBehavior: string;
  readonly recordedAt: number;
}

// ---------------------------------------------------------------------------
// Brick requirements (universal — applies to all forgeable brick kinds)
// ---------------------------------------------------------------------------

export interface BrickRequires {
  /** CLI binaries that must exist on PATH (ALL required). */
  readonly bins?: readonly string[];
  /** Environment variables that must be set (ALL required). */
  readonly env?: readonly string[];
  /** Koi tool brick names that must be resolvable. */
  readonly tools?: readonly string[];
  /** Koi agent brick names that must be resolvable as peer dependencies. */
  readonly agents?: readonly string[];
  /** npm packages required at runtime: package name → exact semver version. */
  readonly packages?: Readonly<Record<string, string>>;
  /** Whether this brick requires network access at runtime. Default: false (no network). */
  readonly network?: boolean;
}

// ---------------------------------------------------------------------------
// Fitness metrics — runtime performance tracking for brick discovery ranking
// ---------------------------------------------------------------------------

/** Bounded sorted-sample buffer for percentile estimation (e.g., P99 latency). */
export interface LatencySampler {
  readonly samples: readonly number[];
  readonly count: number;
  readonly cap: number;
}

/** Runtime fitness metrics tracked per brick for discovery ranking. */
export interface BrickFitnessMetrics {
  readonly successCount: number;
  readonly errorCount: number;
  readonly latency: LatencySampler;
  /** Epoch ms of the most recent usage (success or failure). */
  readonly lastUsedAt: number;
}

// ---------------------------------------------------------------------------
// Drift context — source-file mapping for staleness detection
// ---------------------------------------------------------------------------

/** Tracks which codebase files a brick describes, enabling drift detection. */
export interface BrickDriftContext {
  /** Glob patterns of codebase files this brick describes. */
  readonly sourceFiles: readonly string[];
  /** Git commit hash when drift was last checked. Undefined = never checked. */
  readonly lastCheckedCommit?: string;
  /** Drift score (0–1). 0 = no drift, 1 = all source files changed. */
  readonly driftScore?: number;
}

/** Zero-usage default — immutable singleton for newly forged bricks. */
export const DEFAULT_BRICK_FITNESS: BrickFitnessMetrics = Object.freeze({
  successCount: 0,
  errorCount: 0,
  latency: Object.freeze({ samples: Object.freeze([]) as readonly number[], count: 0, cap: 200 }),
  lastUsedAt: 0,
});

// ---------------------------------------------------------------------------
// Trail strength — stigmergic coordination config + defaults
// ---------------------------------------------------------------------------

/** Default trail strength for newly forged bricks. */
export const DEFAULT_TRAIL_STRENGTH = 0.5 as const;

/** MMAS-bounded evaporation/reinforcement config for trail strength decay. */
export interface TrailConfig {
  /** Evaporation rate ρ ∈ (0, 1). Default: 0.05. */
  readonly evaporationRate: number;
  /** Additive reinforcement per usage. Default: 0.1. */
  readonly reinforcement: number;
  /** MMAS floor — trail strength never decays below this. Default: 0.01. */
  readonly tauMin: number;
  /** MMAS cap — trail strength never exceeds this. Default: 0.95. */
  readonly tauMax: number;
  /** Half-life for exponential decay (days). Default: 7. */
  readonly halfLifeDays: number;
}

/** Frozen default trail config — MMAS bounds [0.01, 0.95]. */
export const DEFAULT_TRAIL_CONFIG: TrailConfig = Object.freeze({
  evaporationRate: 0.05,
  reinforcement: 0.1,
  tauMin: 0.01,
  tauMax: 0.95,
  halfLifeDays: 7,
});

// ---------------------------------------------------------------------------
// Collective memory — cross-run learnings attached to brick artifacts
// ---------------------------------------------------------------------------

/** Category taxonomy for collective memory entries. */
export type CollectiveMemoryCategory =
  | "gotcha" // pitfalls, common mistakes
  | "heuristic" // rules of thumb
  | "preference" // style/approach preferences
  | "correction" // corrected misconceptions
  | "pattern" // discovered reusable patterns
  | "context"; // general domain context

/** Provenance for a collective memory entry. */
export interface CollectiveMemorySource {
  readonly agentId: string;
  readonly runId: string;
  readonly timestamp: number; // epoch ms
}

/** A single learning entry in collective memory. */
export interface CollectiveMemoryEntry {
  readonly id: string;
  readonly content: string;
  readonly category: CollectiveMemoryCategory;
  readonly source: CollectiveMemorySource;
  readonly createdAt: number;
  readonly accessCount: number;
  readonly lastAccessedAt: number;
}

/** Collective memory state attached to a brick artifact. */
export interface CollectiveMemory {
  readonly entries: readonly CollectiveMemoryEntry[];
  readonly totalTokens: number;
  readonly generation: number;
  readonly lastCompactedAt?: number | undefined;
}

/** Config defaults for collective memory thresholds. */
export interface CollectiveMemoryDefaults {
  readonly maxEntries: number;
  readonly maxTokens: number;
  readonly coldAgeDays: number;
  readonly injectionBudget: number;
  readonly dedupThreshold: number;
}

/** Empty collective memory — immutable singleton for newly created bricks. */
export const DEFAULT_COLLECTIVE_MEMORY: CollectiveMemory = Object.freeze({
  entries: Object.freeze([]) as readonly CollectiveMemoryEntry[],
  totalTokens: 0,
  generation: 0,
});

/** Frozen default thresholds for collective memory operations. */
export const COLLECTIVE_MEMORY_DEFAULTS: CollectiveMemoryDefaults = Object.freeze({
  maxEntries: 50,
  maxTokens: 8000,
  coldAgeDays: 30,
  injectionBudget: 2000,
  dedupThreshold: 0.6,
});

// ---------------------------------------------------------------------------
// Brick artifact — discriminated union on `kind`
// ---------------------------------------------------------------------------

export interface BrickArtifactBase {
  /** Content-addressed ID: `sha256:<64-hex-chars>`. Identity IS integrity. */
  readonly id: BrickId;
  readonly kind: BrickKind;
  readonly name: string;
  readonly description: string;
  readonly scope: ForgeScope;
  readonly origin: ToolOrigin;
  readonly policy: ToolPolicy;
  readonly lifecycle: BrickLifecycle;
  readonly provenance: ForgeProvenance;
  readonly version: string;
  readonly tags: readonly string[];
  readonly usageCount: number;
  /** Optional companion files: relative path → content. */
  readonly files?: Readonly<Record<string, string>>;
  /** Runtime requirements for this brick to be usable. */
  readonly requires?: BrickRequires;
  /** Optional JSON Schema describing brick instantiation config parameters. */
  readonly configSchema?: Readonly<Record<string, unknown>>;
  /** Epoch millis of last successful re-verification. Undefined = never re-verified. */
  readonly lastVerifiedAt?: number;
  /** Runtime fitness metrics for discovery ranking. Undefined = never used. */
  readonly fitness?: BrickFitnessMetrics | undefined;
  /** Stigmergic trail strength — decaying signal of collective agent interest. */
  readonly trailStrength?: number | undefined;
  /** Source-file mapping for drift detection. Undefined = no source tracking. */
  readonly driftContext?: BrickDriftContext | undefined;
  /** Composition metadata — how this brick was assembled. Undefined = not composed. */
  readonly composition?: BrickComposition | undefined;
  /** Cross-run learnings accumulated by workers of this brick type. */
  readonly collectiveMemory?: CollectiveMemory | undefined;
}

export interface ToolArtifact extends BrickArtifactBase {
  readonly kind: "tool";
  readonly implementation: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly testCases?: readonly TestCase[];
  readonly counterexamples?: readonly CounterExample[];
}

export interface SkillArtifact extends BrickArtifactBase {
  readonly kind: "skill";
  readonly content: string;
}

export interface AgentArtifact extends BrickArtifactBase {
  readonly kind: "agent";
  readonly manifestYaml: string;
}

export interface ImplementationArtifact extends BrickArtifactBase {
  readonly kind: "middleware" | "channel";
  readonly implementation: string;
  readonly testCases?: readonly TestCase[];
  readonly counterexamples?: readonly CounterExample[];
}

// ---------------------------------------------------------------------------
// Composite pipeline types
// ---------------------------------------------------------------------------

/** Typed I/O port for pipeline composition — structural JSON Schema descriptor. */
export interface BrickPort {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

/** A single step in a composite pipeline, linking brick to its I/O ports. */
export interface PipelineStep {
  readonly brickId: BrickId;
  readonly inputPort: BrickPort;
  readonly outputPort: BrickPort;
}

/** A composite brick: ordered pipeline of steps with typed I/O ports. */
export interface CompositeArtifact extends BrickArtifactBase {
  readonly kind: "composite";
  readonly steps: readonly PipelineStep[];
  readonly exposedInput: BrickPort;
  readonly exposedOutput: BrickPort;
  /** Kind of the last step — used for ECS component resolution. */
  readonly outputKind: BrickKind;
}

export type BrickArtifact =
  | ToolArtifact
  | SkillArtifact
  | AgentArtifact
  | ImplementationArtifact
  | CompositeArtifact;

// ---------------------------------------------------------------------------
// Forge query (structured search)
// ---------------------------------------------------------------------------

export interface ForgeQuery {
  readonly kind?: BrickKind;
  readonly scope?: ForgeScope;
  /** Filter by sandbox status. Omit to match both sandboxed and unsandboxed bricks. */
  readonly sandbox?: boolean;
  readonly lifecycle?: BrickLifecycle;
  readonly tags?: readonly string[];
  /** Matches against `provenance.metadata.agentId`. */
  readonly createdBy?: string;
  readonly classification?: DataClassification;
  readonly contentMarkers?: readonly ContentMarker[];
  /** Case-insensitive substring match against brick name and description. */
  readonly text?: string;
  readonly limit?: number;
  /** Sort order for results. Default: "fitness". */
  readonly orderBy?: "fitness" | "recency" | "usage" | "trailStrength";
  /** Minimum fitness score threshold (0–1). Bricks scoring below are excluded. */
  readonly minFitnessScore?: number;
  /** Minimum trail strength threshold (0–1). Bricks below are excluded. */
  readonly minTrailStrength?: number;
}

// ---------------------------------------------------------------------------
// Brick update (partial field overwrite)
// ---------------------------------------------------------------------------

export interface BrickUpdate {
  readonly lifecycle?: BrickLifecycle;
  readonly policy?: ToolPolicy;
  readonly scope?: ForgeScope;
  readonly usageCount?: number;
  readonly tags?: readonly string[] | undefined;
  /** Epoch millis of last successful re-verification. */
  readonly lastVerifiedAt?: number;
  /** Updated fitness metrics (replaces entire fitness object). */
  readonly fitness?: BrickFitnessMetrics | undefined;
  /** Updated trail strength. */
  readonly trailStrength?: number | undefined;
  /** Updated drift context (replaces entire drift context object). */
  readonly driftContext?: BrickDriftContext | undefined;
  /** Updated collective memory (replaces entire collective memory object). */
  readonly collectiveMemory?: CollectiveMemory | undefined;
}

/** Compile-time check: every key of BrickUpdate must exist on BrickArtifactBase. */
type _AssertUpdateSubset =
  Exclude<keyof BrickUpdate, keyof BrickArtifactBase> extends never ? true : never;
const _checkSubset: _AssertUpdateSubset = true;
void _checkSubset; // suppress unused-variable lint

// ---------------------------------------------------------------------------
// ForgeStore — repository interface for brick persistence
// ---------------------------------------------------------------------------

export interface ForgeStore {
  readonly save: (brick: BrickArtifact) => Promise<Result<void, KoiError>>;
  readonly load: (id: BrickId) => Promise<Result<BrickArtifact, KoiError>>;
  readonly search: (query: ForgeQuery) => Promise<Result<readonly BrickArtifact[], KoiError>>;
  readonly remove: (id: BrickId) => Promise<Result<void, KoiError>>;
  readonly update: (id: BrickId, updates: BrickUpdate) => Promise<Result<void, KoiError>>;
  readonly exists: (id: BrickId) => Promise<Result<boolean, KoiError>>;
  /**
   * Optional scope-aware promotion — moves a brick between storage tiers.
   * Not all backends support tiered storage; filesystem overlay stores do.
   * When available, promote_forge wires scope metadata changes to physical tier moves.
   */
  readonly promote?: (id: BrickId, targetScope: ForgeScope) => Promise<Result<void, KoiError>>;
  /**
   * Atomic scope promotion with metadata update.
   * Moves brick to target scope's tier AND applies metadata changes in a single operation.
   * Prevents partial state where brick is moved but metadata is stale.
   *
   * Optional: not all store backends support tiered storage with atomic promotion.
   */
  readonly promoteAndUpdate?: (
    id: BrickId,
    targetScope: ForgeScope,
    updates: BrickUpdate,
  ) => Promise<Result<void, KoiError>>;
  /** Optional typed watch for store mutations. Returns unsubscribe. */
  readonly watch?: (listener: (event: StoreChangeEvent) => void) => () => void;
  /** Clean up resources (filesystem watchers, timers). Not all backends hold resources. */
  readonly dispose?: () => void;
}

// ---------------------------------------------------------------------------
// Store change notification — pluggable cross-agent invalidation
// ---------------------------------------------------------------------------

/** Describes what changed in the store. */
export type StoreChangeKind = "saved" | "updated" | "removed" | "promoted" | "quarantined";

/** Notification payload for store mutations. */
export interface StoreChangeEvent {
  readonly kind: StoreChangeKind;
  readonly brickId: BrickId;
  /** The scope after the change (if applicable). */
  readonly scope?: ForgeScope;
  /** Policy change details (for "promoted" and "quarantined" kinds). */
  readonly policyChange?: { readonly from: ToolPolicy; readonly to: ToolPolicy };
  /** Human-readable reason for the change (e.g., quarantine cause). */
  readonly reason?: string;
}

/**
 * Pluggable notification interface for cross-agent cache invalidation.
 *
 * Sync implementations (in-memory event bus) return void.
 * Async implementations (Nexus pub/sub, Redis) return Promise<void>.
 * Subscribers receive targeted change events for delta-based invalidation.
 */
export interface StoreChangeNotifier {
  /** Emit a change event after a store mutation. */
  readonly notify: (event: StoreChangeEvent) => void | Promise<void>;
  /** Subscribe to change events. Returns unsubscribe function. */
  readonly subscribe: (listener: (event: StoreChangeEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Advisory lock — orthogonal to ForgeStore, for backends that support it
// ---------------------------------------------------------------------------

declare const __lockBrand: unique symbol;

export type LockHandle = string & { readonly [__lockBrand]: "LockHandle" };

export type LockMode = "shared" | "exclusive";

export interface LockRequest {
  readonly resource: string;
  readonly mode: LockMode;
  readonly ttlMs: number;
}

export interface AdvisoryLock {
  readonly acquire: (request: LockRequest) => Promise<Result<LockHandle, KoiError>>;
  readonly release: (handle: LockHandle) => Promise<Result<void, KoiError>>;
}
