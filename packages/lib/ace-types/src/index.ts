/**
 * @koi/ace-types — Shared domain types for ACE (Adaptive Continuous Enhancement).
 *
 * Provides the canonical type definitions used by @koi/middleware-ace (L2)
 * and any ACE-aware stores without introducing a cross-L2 dependency.
 *
 * Layer: L0u (depends on @koi/core only).
 *
 * Tracks issue #1715. Includes the AGP-derived provenance / evaluation /
 * promotion-gate surface so playbook evolution stays gated, reversible,
 * and version-lineaged from the start.
 */

import type { JsonObject } from "@koi/core/common";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";

// ---------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------

/** Trajectory entry — one per model/tool call within a session. */
export interface TrajectoryEntry {
  readonly turnIndex: number;
  readonly timestamp: number;
  readonly kind: "model_call" | "tool_call";
  readonly identifier: string;
  readonly outcome: "success" | "failure" | "retry";
  readonly durationMs: number;
  readonly metadata?: JsonObject;
  readonly bulletIds?: readonly string[];
}

/** Half-open trajectory range `[fromStepIndex, toStepIndex)` used as provenance. */
export interface TrajectoryRange {
  readonly sessionId: string;
  readonly fromStepIndex: number;
  readonly toStepIndex: number;
}

/** Running stats per unique identifier (incremental aggregation). */
export interface AggregatedStats {
  readonly identifier: string;
  readonly kind: "model_call" | "tool_call";
  readonly successes: number;
  readonly failures: number;
  readonly retries: number;
  readonly totalDurationMs: number;
  readonly invocations: number;
  readonly lastSeenMs: number;
}

// ---------------------------------------------------------------------------
// Playbooks
// ---------------------------------------------------------------------------

export type PlaybookSource = "curated" | "manual" | "imported";

/** Playbook — a consolidated learning artifact (flat, stat-pipeline shape). */
export interface Playbook {
  readonly id: string;
  readonly title: string;
  readonly strategy: string;
  readonly tags: readonly string[];
  readonly confidence: number;
  readonly source: PlaybookSource;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sessionCount: number;
  /** Monotonic version. Bumped on every committed mutation. */
  readonly version: number;
  /** Provenance for the most recent commit (omitted for v0 / seeded entries). */
  readonly provenance?: PlaybookProvenance;
}

/** Structured playbook with sections and credit-assigned bullets. */
export interface StructuredPlaybook {
  readonly id: string;
  readonly title: string;
  readonly sections: readonly PlaybookSection[];
  readonly tags: readonly string[];
  readonly source: PlaybookSource;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sessionCount: number;
  /** Watermark: highest stepIndex that has been reflected on. */
  readonly lastReflectedStepIndex?: number;
  /** Monotonic version. Bumped on every committed mutation. */
  readonly version: number;
  /** Provenance for the most recent commit (omitted for v0 / seeded entries). */
  readonly provenance?: PlaybookProvenance;
}

/** Named section within a structured playbook. */
export interface PlaybookSection {
  readonly name: string;
  readonly slug: string;
  readonly bullets: readonly PlaybookBullet[];
}

/** Individual bullet with credit-assignment counters. */
export interface PlaybookBullet {
  readonly id: string;
  readonly content: string;
  readonly helpful: number;
  readonly harmful: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Curation
// ---------------------------------------------------------------------------

/** Curation result — what the curator produces from a session. */
export interface CurationCandidate {
  readonly identifier: string;
  readonly kind: "model_call" | "tool_call";
  readonly score: number;
  readonly stats: AggregatedStats;
}

/** Feedback signal from turn metadata. */
export interface AceFeedback {
  readonly rating?: number;
  readonly tags?: readonly string[];
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// Reflector
// ---------------------------------------------------------------------------

/** Input to the reflector for trajectory analysis. */
export interface ReflectorInput {
  readonly trajectory: readonly TrajectoryEntry[];
  /** Rich trajectory steps for deeper LLM reflection. When present, the
   *  reflector prompt uses these instead of the compact trajectory entries. */
  readonly richTrajectory?: readonly RichTrajectoryStep[];
  readonly citedBulletIds: readonly string[];
  readonly outcome: "success" | "failure" | "mixed";
  readonly playbook: StructuredPlaybook;
}

/** Output of the reflector: root cause analysis + bullet credit assignment. */
export interface ReflectionResult {
  readonly rootCause: string;
  readonly keyInsight: string;
  readonly bulletTags: readonly BulletTag[];
}

/** Credit assignment tag for a single bullet. */
export interface BulletTag {
  readonly id: string;
  readonly tag: "helpful" | "harmful" | "neutral";
}

// ---------------------------------------------------------------------------
// Curator
// ---------------------------------------------------------------------------

/** Delta operation produced by the curator. Reversible at version granularity. */
export type CuratorOperation =
  | { readonly kind: "add"; readonly section: string; readonly content: string }
  | {
      readonly kind: "merge";
      readonly bulletIds: readonly [string, string];
      readonly content: string;
    }
  | { readonly kind: "prune"; readonly bulletId: string };

/** Input to the curator for playbook delta generation. */
export interface CuratorInput {
  readonly playbook: StructuredPlaybook;
  readonly reflection: ReflectionResult;
  readonly tokenBudget: number;
}

// ---------------------------------------------------------------------------
// Provenance / Evaluation / Promotion gate (AGP)
// ---------------------------------------------------------------------------

/** Pointer back to the trajectory window and proposal/evaluation that produced a commit. */
export interface PlaybookProvenance {
  readonly sourceTrajectoryRange: TrajectoryRange;
  readonly proposalId: string;
  readonly evaluationId: string;
  readonly committedAt: number;
}

/** A pending playbook change awaiting evaluation. */
export interface PlaybookProposal {
  readonly id: string;
  readonly playbookId: string;
  /** Version the proposal was generated against. Used for concurrency checks. */
  readonly baseVersion: number;
  readonly operations: readonly CuratorOperation[];
  readonly sourceTrajectoryRange: TrajectoryRange;
  readonly reflection: ReflectionResult;
  readonly createdAt: number;
}

export type EvaluationVerdict = "promote" | "reject" | "rollback";

/** Evidence for whether a proposal meets promotion thresholds. */
export interface PlaybookEvaluation {
  readonly id: string;
  readonly proposalId: string;
  readonly verdict: EvaluationVerdict;
  /** Threshold metrics keyed by name (e.g. {"helpfulRate": 0.62, "tokenDelta": 240}). */
  readonly metrics: Readonly<Record<string, number>>;
  /** Why the verdict was reached. */
  readonly notes?: string;
  readonly evaluatedAt: number;
}

/** Threshold config for the promotion gate. "No evidence, no commit." */
export interface PromotionThresholds {
  readonly minHelpfulRate: number;
  readonly maxHarmfulRate: number;
  readonly minTrials: number;
  /** Optional max token-budget delta accepted for a single commit. */
  readonly maxTokenDelta?: number;
}

// ---------------------------------------------------------------------------
// Store interfaces
// ---------------------------------------------------------------------------

/** TrajectoryStore — append-heavy, per-session trajectory storage. */
export interface TrajectoryStore {
  readonly append: (sessionId: string, entries: readonly TrajectoryEntry[]) => Promise<void>;
  readonly getSession: (sessionId: string) => Promise<readonly TrajectoryEntry[]>;
  readonly listSessions: (options?: {
    readonly limit?: number;
    readonly before?: number;
  }) => Promise<readonly string[]>;
}

/** PlaybookStore — read-heavy, versioned playbook storage. */
export interface PlaybookStore {
  readonly get: (id: string) => Promise<Playbook | undefined>;
  readonly list: (options?: {
    readonly tags?: readonly string[];
    readonly minConfidence?: number;
  }) => Promise<readonly Playbook[]>;
  readonly save: (playbook: Playbook) => Promise<void>;
  readonly remove: (id: string) => Promise<boolean>;
}

/** StructuredPlaybookStore — read-heavy, structured playbook storage. */
export interface StructuredPlaybookStore {
  readonly get: (id: string) => Promise<StructuredPlaybook | undefined>;
  readonly list: (options?: {
    readonly tags?: readonly string[];
  }) => Promise<readonly StructuredPlaybook[]>;
  readonly save: (playbook: StructuredPlaybook) => Promise<void>;
  readonly remove: (id: string) => Promise<boolean>;
  /** Fetch a prior version (for rollback). Implementations without lineage
   *  return `undefined`. */
  readonly getVersion?: (id: string, version: number) => Promise<StructuredPlaybook | undefined>;
}

/** Append-only log of proposals + their evaluations (immutable lineage). */
export interface PlaybookProposalStore {
  readonly recordProposal: (proposal: PlaybookProposal) => Promise<void>;
  readonly recordEvaluation: (evaluation: PlaybookEvaluation) => Promise<void>;
  readonly getProposal: (id: string) => Promise<PlaybookProposal | undefined>;
  readonly listProposals: (playbookId: string) => Promise<readonly PlaybookProposal[]>;
}
