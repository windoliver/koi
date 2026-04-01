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
  SpawnFn,
  ThreadStore,
} from "@koi/core";
import type { HarnessScheduler } from "@koi/harness-scheduler";
import type { LongRunningHarness } from "@koi/long-running";

// ---------------------------------------------------------------------------
// Logger — thin interface for operational logging (retry, reconciliation, etc.)
// ---------------------------------------------------------------------------

export interface AutonomousLogger {
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
  readonly debug?: ((message: string) => void) | undefined;
}

/** Default logger that writes to stderr with [autonomous] prefix. */
export function createStderrLogger(): AutonomousLogger {
  return {
    warn: (msg: string) => process.stderr.write(`[autonomous] ${msg}\n`),
    error: (msg: string) => process.stderr.write(`[autonomous] ERROR: ${msg}\n`),
    debug: (msg: string) => process.stderr.write(`[autonomous] ${msg}\n`),
  };
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
  /**
   * Optional auto-harness middleware stack for failure-driven middleware synthesis.
   * When provided, includes the policy-cache middleware and wires the synthesis
   * callback into the forge pipeline. Requires forgeStore to also be provided.
   * Created via createAutoHarnessStack() from @koi/auto-harness.
   */
  readonly autoHarnessMiddleware?: readonly KoiMiddleware[] | undefined;
  /**
   * Optional spawn function getter for delegation bridge dispatch. When the
   * getter returns a SpawnFn, tasks with `delegation: "spawn"` are auto-dispatched
   * to worker agents via the delegation bridge. Deferred via getter because SpawnFn
   * requires engine runtime context that isn't available at construction time.
   */
  readonly getSpawn?: (() => SpawnFn | undefined) | undefined;
  /** Optional logger for autonomous operational messages (retry, reconciliation, etc.). Defaults to stderr. */
  readonly logger?: AutonomousLogger | undefined;
  /**
   * Optional callback to emit dashboard events (SSE → TUI).
   * When provided, task status changes are pushed so the TUI task board
   * view updates in real-time without polling.
   *
   * Structural type to avoid importing @koi/dashboard-types — the caller
   * (CLI) bridges to the actual DashboardEvent union.
   */
  readonly onTaskBoardEvent?:
    | ((event: {
        readonly kind: "taskboard";
        readonly subKind: "task_status_changed";
        readonly taskId: string;
        readonly status: string;
        readonly timestamp: number;
      }) => void)
    | undefined;
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
  /** Dispose all parts in correct order (bridge abort, scheduler, harness). */
  readonly dispose: () => Promise<void>;
  /** Agent resolver -- auto-created from forgeStore if not provided explicitly. */
  readonly agentResolver?: AgentResolver | undefined;
}
