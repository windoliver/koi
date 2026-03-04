/**
 * Types for @koi/autonomous — coordinated autonomous agent composition.
 */

import type {
  AgentId,
  AgentRegistry,
  CheckpointPolicy,
  ComponentProvider,
  HandoffEvent,
  HandoffId,
  HarnessSnapshot,
  HarnessSnapshotStore,
  InboxPolicy,
  KoiError,
  KoiMiddleware,
  Result,
  ThreadStore,
} from "@koi/core";
import type { HandoffStore } from "@koi/handoff";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness } from "@koi/long-running";

// ---------------------------------------------------------------------------
// Harness → Handoff bridge config
// ---------------------------------------------------------------------------

/**
 * Config for the harness-to-handoff bridge.
 *
 * Exactly one target strategy must be provided:
 * - `targetAgentId` — static target agent
 * - `resolveTarget` — custom dynamic resolution callback
 * - `registry` + `targetCapability` — capability-based discovery via AgentRegistry
 */
export interface HarnessHandoffBridgeConfig {
  readonly harnessStore: HarnessSnapshotStore;
  readonly handoffStore: HandoffStore;
  /** Static target. Mutually exclusive with resolveTarget and targetCapability. */
  readonly targetAgentId?: AgentId | undefined;
  /** Dynamic target resolution. Called at bridge fire time with the completed snapshot. */
  readonly resolveTarget?: ((snapshot: HarnessSnapshot) => AgentId | Promise<AgentId>) | undefined;
  /** AgentRegistry for capability-based discovery. Use with targetCapability. */
  readonly registry?: AgentRegistry | undefined;
  /** Capability string to match. Use with registry. */
  readonly targetCapability?: string | undefined;
  /** What the next agent should do. Defaults to generated summary. */
  readonly nextPhaseInstructions?: string | undefined;
  readonly onEvent?: ((event: HandoffEvent) => void) | undefined;
}

/** Bridge handle — call onHarnessCompleted() when harness reaches "completed". */
export interface HarnessHandoffBridge {
  readonly onHarnessCompleted: () => Promise<Result<HandoffId, KoiError>>;
  readonly hasFired: () => boolean;
}

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
  /** Optional thread store for persistent checkpoint support. */
  readonly threadStore?: ThreadStore | undefined;
  /** Checkpoint policy override. Defaults to DEFAULT_CHECKPOINT_POLICY. */
  readonly checkpointPolicy?: CheckpointPolicy | undefined;
  /** Inbox policy override. Defaults to DEFAULT_INBOX_POLICY. */
  readonly inboxPolicy?: InboxPolicy | undefined;
  /** Optional harness-to-handoff bridge config. */
  readonly handoffBridge?: HarnessHandoffBridgeConfig | undefined;
  /**
   * When true (default when handoffBridge is configured), auto-fires the bridge
   * when the scheduler reaches "stopped" phase. Set to false to opt out.
   */
  readonly autoFireBridge?: boolean | undefined;
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
  /** Optional harness-to-handoff bridge handle. */
  readonly handoffBridge?: HarnessHandoffBridge | undefined;
}
