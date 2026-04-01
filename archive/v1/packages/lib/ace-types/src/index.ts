/**
 * @koi/ace-types — Shared domain types for ACE (Adaptive Continuous Enhancement).
 *
 * Provides the canonical type definitions used by both @koi/middleware-ace (L2)
 * and @koi/nexus-store (L2) without introducing a cross-L2 dependency.
 *
 * Layer: L0u (depends on @koi/core only).
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

/** Playbook — a consolidated learning artifact. */
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

/** Delta operation produced by the curator. */
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
}
