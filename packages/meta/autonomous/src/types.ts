/**
 * Types for @koi/autonomous — coordinated autonomous agent composition.
 */

import type {
  AgentResolver,
  CheckpointPolicy,
  ComponentProvider,
  ForgeStore,
  InboxPolicy,
  KoiMiddleware,
  ThreadStore,
} from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness } from "@koi/long-running";

// ---------------------------------------------------------------------------
// Factory input — accept pre-constructed parts (instance-based)
// ---------------------------------------------------------------------------

export interface AutonomousAgentParts {
  /** The long-running harness managing multi-session lifecycle. */
  readonly harness: LongRunningHarness;
  /** The scheduler that auto-resumes the harness when suspended. */
  readonly scheduler: HarnessScheduler;
  /** Optional compactor middleware for context compaction. */
  readonly compactorMiddleware?: KoiMiddleware | undefined;
  /** Optional collective memory middleware for cross-run learning persistence. */
  readonly collectiveMemoryMiddleware?: KoiMiddleware | undefined;
  /** Optional report middleware for post-run summaries and progress tracking. */
  readonly reportMiddleware?: KoiMiddleware | undefined;
  /** Optional event-trace middleware for per-event tracing and mid-turn rewind. */
  readonly eventTraceMiddleware?: KoiMiddleware | undefined;
  /** Optional thread store for persistent checkpoint support. */
  readonly threadStore?: ThreadStore | undefined;
  /** Checkpoint policy override. Defaults to DEFAULT_CHECKPOINT_POLICY. */
  readonly checkpointPolicy?: CheckpointPolicy | undefined;
  /** Inbox policy override. Defaults to DEFAULT_INBOX_POLICY. */
  readonly inboxPolicy?: InboxPolicy | undefined;
  /** Optional agent resolver for dynamic agent discovery (forge-backed). */
  readonly agentResolver?: AgentResolver | undefined;
  /** Optional forge store for creating catalog-backed resolvers. */
  readonly forgeStore?: ForgeStore | undefined;
  /** Optional health recorder for spawn fitness tracking. */
  readonly healthRecorder?: import("./spawn-fitness-wrapper.js").SpawnHealthRecorder | undefined;
  /** Optional goal-stack middleware for intra-session goal tracking. */
  readonly goalStackMiddleware?: readonly KoiMiddleware[] | undefined;
  /**
   * When true, automatically wires a full goal-stack (reminder + anchor + planning)
   * with task-board-aware sources and drift detection, using the harness's live task
   * board as the snapshot source. Includes the write_plan tool via the "autonomous" preset.
   * Ignored when goalStackMiddleware is provided (caller has full control in that case).
   */
  readonly taskBoardGoalStack?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Autonomous agent — composed output
// ---------------------------------------------------------------------------

export interface AutonomousAgent {
  /** The underlying harness. */
  readonly harness: LongRunningHarness;
  /** The scheduler managing auto-resume. */
  readonly scheduler: HarnessScheduler;
  /** Collect all middleware (harness + checkpoint + inbox + optional compactor). */
  readonly middleware: () => readonly KoiMiddleware[];
  /** Component providers (inbox, plan_autonomous). */
  readonly providers: () => readonly ComponentProvider[];
  /** Dispose all parts in correct order (scheduler first, then harness). */
  readonly dispose: () => Promise<void>;
  /** Agent resolver -- auto-created from forgeStore if not provided explicitly. */
  readonly agentResolver?: AgentResolver | undefined;
}
