/**
 * Reputation backend — pluggable trust scoring and feedback contract (Layer 0).
 *
 * Defines the shapes for recording interaction feedback, querying computed trust
 * scores, and filtering feedback history. L2 packages implement ReputationBackend
 * for specific backends (in-memory ring buffer, Nexus/EigenTrust, etc.).
 *
 * Fail-closed contract: callers MUST treat a missing score (undefined from
 * getScore) as "unknown" trust level — never as implicitly trusted.
 */

import type { JsonObject } from "./common.js";
import type { AgentId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Trust level — categorical output for routing and governance decisions
// Distinct from TrustTier (forge/brick isolation) in ecs.ts
// ---------------------------------------------------------------------------

/**
 * Discrete trust level derived from a computed reputation score.
 * Ordered from least to most trusted — see REPUTATION_LEVEL_ORDER for
 * the canonical sequence.
 */
export type ReputationLevel =
  | "unknown" // no feedback data for this agent
  | "untrusted" // consistent negative signals
  | "low" // sparse or mixed signals
  | "medium" // moderate positive signal history
  | "high" // strong consistent positive signals
  | "verified"; // externally attested or promoted by governance

/**
 * Canonical ordering of ReputationLevel values from least to most trusted.
 * Use this to avoid hardcoding the sequence in consumers:
 *
 * ```typescript
 * const idx = REPUTATION_LEVEL_ORDER.indexOf(score.level);
 * if (idx >= REPUTATION_LEVEL_ORDER.indexOf("medium")) { ... }
 * ```
 */
export const REPUTATION_LEVEL_ORDER: readonly ReputationLevel[] = Object.freeze([
  "unknown",
  "untrusted",
  "low",
  "medium",
  "high",
  "verified",
] as const);

// ---------------------------------------------------------------------------
// Feedback kind — the semantic signal type for interaction outcomes
// ---------------------------------------------------------------------------

/**
 * Categorical feedback signal. Backends map these to numeric weights
 * using their own algorithm (e.g., EigenTrust normalizes to [0,1]).
 *
 * Start minimal: "positive" | "negative" | "neutral" only.
 * Retraction and dispute kinds (with entry IDs) will be added when
 * the dispute resolution workflow is designed.
 */
export type FeedbackKind = "positive" | "negative" | "neutral";

// ---------------------------------------------------------------------------
// Feedback input — what callers provide to record()
// ---------------------------------------------------------------------------

/**
 * A single trust signal from one agent about another.
 *
 * No numeric score on input — backends derive weights from `kind` using
 * their own algorithm. This avoids the ambiguity of `kind: "positive"` with
 * `score: -0.5`. `kind` is the authoritative semantic signal.
 */
export interface ReputationFeedback {
  /** The agent providing feedback (the observer). */
  readonly sourceId: AgentId;
  /** The agent being evaluated (the subject). */
  readonly targetId: AgentId;
  /** The semantic nature of the trust signal. */
  readonly kind: FeedbackKind;
  /**
   * Optional structured context for the interaction.
   * Useful for domain-specific metadata (session ID, task ID, domain tag).
   * Backends may use context fields for domain-scoped scoring.
   */
  readonly context?: JsonObject | undefined;
  /** Unix timestamp (ms) when the interaction occurred. */
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Score output — the computed trust result returned to callers
// ---------------------------------------------------------------------------

/**
 * The computed trust score for an agent.
 *
 * `score` is the continuous value in [0, 1] — backends derive this from
 * their own algorithm (e.g., EigenTrust eigenvector value, weighted average).
 * `level` is the categorical bucket derived from `score`.
 */
export interface ReputationScore {
  /** The agent this score belongs to. */
  readonly agentId: AgentId;
  /**
   * Continuous trust score in [0, 1].
   * Higher = more trusted. Backends define the specific mapping.
   */
  readonly score: number;
  /** Categorical trust level derived from `score`. */
  readonly level: ReputationLevel;
  /** Total number of feedback entries that contributed to this score. */
  readonly feedbackCount: number;
  /** Unix timestamp (ms) when this score was last computed. */
  readonly computedAt: number;
}

// ---------------------------------------------------------------------------
// Query — filter for feedback history
// ---------------------------------------------------------------------------

/**
 * Default maximum number of feedback entries returned by a single `query()` call.
 * Implementations SHOULD apply this when the caller omits `limit`.
 */
export const DEFAULT_REPUTATION_QUERY_LIMIT = 100;

/**
 * Filter for querying raw feedback entries.
 * All fields are optional — omitting a field means "no constraint on that dimension".
 * Providing no fields (empty filter) returns ALL entries up to `limit` — use with care.
 */
export interface ReputationQuery {
  /** Filter to feedback where this agent is the subject being evaluated. */
  readonly targetId?: AgentId | undefined;
  /** Filter to feedback originating from this agent. */
  readonly sourceId?: AgentId | undefined;
  /** Filter to entries matching any of these kinds. */
  readonly kinds?: readonly FeedbackKind[] | undefined;
  /** Include only entries at or after this Unix timestamp (ms). */
  readonly after?: number | undefined;
  /** Include only entries before this Unix timestamp (ms). */
  readonly before?: number | undefined;
  /** Maximum number of entries to return. */
  readonly limit?: number | undefined;
}

export interface ReputationQueryResult {
  /** Feedback entries matching the query filter. */
  readonly entries: readonly ReputationFeedback[];
  /** True if more entries exist beyond the returned batch (use limit + before/after to paginate). */
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// ReputationBackend — the main contract
// ---------------------------------------------------------------------------

/**
 * Pluggable trust scoring and feedback backend.
 *
 * All fallible operations return `Result<T, KoiError>`.
 * All methods return `T | Promise<T>` — in-memory implementations are sync,
 * database/network implementations are async. Callers must always `await`.
 *
 * **Fail-closed contract**: `getScore()` returns `undefined` for agents with
 * no feedback history. Callers MUST treat `undefined` as `"unknown"` trust
 * level and restrict access accordingly — never treat absence of data as
 * implicit trust.
 */
export interface ReputationBackend {
  /**
   * Record a trust signal from one agent about another.
   * Implementations SHOULD be idempotent for identical (sourceId, targetId, kind, timestamp)
   * tuples to handle retry scenarios.
   */
  readonly record: (
    feedback: ReputationFeedback,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;

  /**
   * Get the current computed trust score for a single agent.
   *
   * Returns `undefined` when no feedback exists for this agent.
   * Callers MUST treat `undefined` as `"unknown"` level — fail closed.
   */
  readonly getScore: (
    targetId: AgentId,
  ) =>
    | Result<ReputationScore | undefined, KoiError>
    | Promise<Result<ReputationScore | undefined, KoiError>>;

  /**
   * Get computed trust scores for multiple agents in a single call.
   *
   * Optional — in-memory backends implement this trivially; network backends
   * use batch requests to avoid N+1 roundtrips (e.g., for trust-aware routing).
   * Callers SHOULD use this when scoring multiple agents simultaneously.
   *
   * Missing entries in the returned map mean no feedback exists for that agent.
   */
  readonly getScores?: (
    targetIds: readonly AgentId[],
  ) =>
    | Result<ReadonlyMap<AgentId, ReputationScore | undefined>, KoiError>
    | Promise<Result<ReadonlyMap<AgentId, ReputationScore | undefined>, KoiError>>;

  /**
   * Query raw feedback entries matching the filter.
   *
   * Returns entries ordered by `timestamp` descending (most recent first).
   * Check `hasMore` to determine if results were truncated.
   */
  readonly query: (
    filter: ReputationQuery,
  ) => Result<ReputationQueryResult, KoiError> | Promise<Result<ReputationQueryResult, KoiError>>;

  /** Close the backend and release resources. */
  readonly dispose?: () => void | Promise<void>;
}
