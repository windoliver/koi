/**
 * resolveOrchestrationFromAgent — extract orchestration views from the Agent entity.
 *
 * Queries the Agent's ECS components for known subsystem tokens (SCHEDULER)
 * and scans the component map for harness/task-board instances that match
 * structurally. For Temporal, delegates to resolveTemporalOrWarn. Also
 * accepts optional explicitly-injected instances for autonomous agent mode.
 *
 * Returns orchestration views and commands suitable for createAdminPanelBridge.
 */

import type { Agent } from "@koi/core";
import { SCHEDULER } from "@koi/core";
import type {
  HarnessAdminClientLike,
  SchedulerAdminClientLike,
  TaskBoardAdminClientLike,
} from "@koi/dashboard-api";
import {
  createHarnessAdminAdapter,
  createSchedulerAdminAdapter,
  createTaskBoardAdminAdapter,
} from "@koi/dashboard-api";
import type { CommandDispatcher, RuntimeViewDataSource } from "@koi/dashboard-types";
import type { TemporalAdminResult } from "./resolve-temporal.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ResolveOrchestrationOptions {
  /** The runtime's Agent entity (for ECS component queries). */
  readonly agent?: Agent | undefined;
  /** Pre-resolved Temporal adapter result (from resolveTemporalOrWarn). */
  readonly temporal?: TemporalAdminResult | undefined;
  /** Optional harness instance (from @koi/autonomous or similar). */
  readonly harness?: HarnessAdminClientLike | undefined;
  /** Optional task board instance (from @koi/autonomous or similar). */
  readonly taskBoard?: TaskBoardAdminClientLike | undefined;
  /** Enable verbose logging. */
  readonly verbose?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface OrchestrationResult {
  /** Orchestration views to pass to createAdminPanelBridge. */
  readonly orchestration: {
    readonly temporal?: RuntimeViewDataSource["temporal"];
    readonly scheduler?: RuntimeViewDataSource["scheduler"];
    readonly taskBoard?: RuntimeViewDataSource["taskBoard"];
    readonly harness?: RuntimeViewDataSource["harness"];
  };
  /** Orchestration commands to pass to createAdminPanelBridge. */
  readonly orchestrationCommands: Partial<
    Pick<
      CommandDispatcher,
      | "signalWorkflow"
      | "terminateWorkflow"
      | "pauseSchedule"
      | "resumeSchedule"
      | "deleteSchedule"
      | "retrySchedulerDeadLetter"
      | "pauseHarness"
      | "resumeHarness"
    >
  >;
  /** Whether any orchestration source was found. */
  readonly hasAny: boolean;
}

// ---------------------------------------------------------------------------
// Structural detection helpers
// ---------------------------------------------------------------------------

/** Check if a value structurally matches HarnessAdminClientLike (has status()). */
function isHarnessLike(value: unknown): value is HarnessAdminClientLike {
  if (value === null || value === undefined || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.status !== "function") return false;

  // Verify status() returns something with phase and metrics
  try {
    const status = (obj.status as () => unknown)();
    if (status === null || status === undefined || typeof status !== "object") return false;
    const s = status as Record<string, unknown>;
    return typeof s.phase === "string" && typeof s.metrics === "object" && s.metrics !== null;
  } catch {
    return false;
  }
}

/** Check if a value structurally matches TaskBoardAdminClientLike (has all() and completed()). */
function isTaskBoardLike(value: unknown): value is TaskBoardAdminClientLike {
  if (value === null || value === undefined || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.all === "function" && typeof obj.completed === "function";
}

/**
 * Derive a TaskBoardAdminClientLike from a HarnessAdminClientLike.
 * Extracts the task board snapshot from harness status and wraps it
 * in the adapter interface.
 */
function deriveTaskBoardFromHarness(
  harness: HarnessAdminClientLike,
): TaskBoardAdminClientLike | undefined {
  try {
    // Verify the harness has a taskBoard shape at resolve time
    const status = harness.status();
    const s = status as unknown as Record<string, unknown>;
    const board = s.taskBoard as
      | { readonly items?: unknown; readonly results?: unknown }
      | undefined;
    if (board === undefined || board === null) return undefined;
    if (!Array.isArray(board.items)) return undefined;

    // Return LAZY closures that read the CURRENT harness state on each call.
    // The initial check above validates the shape, but all()/completed() must
    // re-read harness.status().taskBoard to reflect live plan progress —
    // otherwise the snapshot is frozen at resolve time (before any plan exists).
    return {
      all: () => {
        const current = harness.status() as unknown as Record<string, unknown>;
        const tb = current.taskBoard as { readonly items?: unknown } | undefined;
        return (tb?.items ?? []) as unknown as ReturnType<TaskBoardAdminClientLike["all"]>;
      },
      completed: () => {
        const current = harness.status() as unknown as Record<string, unknown>;
        const tb = current.taskBoard as { readonly results?: unknown } | undefined;
        return Array.isArray(tb?.results)
          ? (tb.results as unknown as ReturnType<TaskBoardAdminClientLike["completed"]>)
          : [];
      },
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function resolveOrchestrationFromAgent(
  options: ResolveOrchestrationOptions,
): OrchestrationResult {
  const orchestration: {
    temporal?: RuntimeViewDataSource["temporal"];
    scheduler?: RuntimeViewDataSource["scheduler"];
    taskBoard?: RuntimeViewDataSource["taskBoard"];
    harness?: RuntimeViewDataSource["harness"];
  } = {};

  const commands: OrchestrationResult["orchestrationCommands"] = {};

  // Track resolved sources for task-board derivation
  // let justified: set in step 3 or 4, read in step 5 for harness→taskBoard derivation
  let resolvedHarness: HarnessAdminClientLike | undefined;

  // 1. Temporal — pass through from resolveTemporalOrWarn
  if (options.temporal !== undefined) {
    orchestration.temporal = options.temporal.views;
    Object.assign(commands, options.temporal.commands);
  }

  // 2. Scheduler — query Agent ECS component (SCHEDULER token)
  if (options.agent !== undefined) {
    const schedulerComponent = options.agent.component(SCHEDULER);
    if (schedulerComponent !== undefined) {
      // SchedulerComponent is structurally compatible — query/stats/pause/resume match.
      // Cast through unknown because branded types in TaskFilter don't overlap with
      // the adapter's loose { status?: string } filter shape.
      const adapter = createSchedulerAdminAdapter(
        schedulerComponent as unknown as SchedulerAdminClientLike,
      );
      orchestration.scheduler = adapter.views;
      Object.assign(commands, adapter.commands);

      if (options.verbose) {
        process.stderr.write("Orchestration: scheduler wired from agent component\n");
      }
    }
  }

  // 3. Harness — prefer explicit injection, then scan agent components
  if (options.harness !== undefined) {
    resolvedHarness = options.harness;
  } else if (options.agent !== undefined) {
    // Scan agent components for anything that looks like a harness
    const components = options.agent.components();
    for (const [, value] of components) {
      if (isHarnessLike(value)) {
        resolvedHarness = value;
        break;
      }
    }
  }

  if (resolvedHarness !== undefined) {
    const adapter = createHarnessAdminAdapter(resolvedHarness);
    orchestration.harness = adapter.views;
    Object.assign(commands, adapter.commands);

    if (options.verbose) {
      process.stderr.write("Orchestration: harness wired\n");
    }
  }

  // 4. Task Board — prefer explicit injection, then scan agent components,
  //    then derive from harness status (harness.status().taskBoard)
  if (options.taskBoard !== undefined) {
    const adapter = createTaskBoardAdminAdapter(options.taskBoard);
    orchestration.taskBoard = adapter.views;

    if (options.verbose) {
      process.stderr.write("Orchestration: task board wired\n");
    }
  } else if (options.agent !== undefined) {
    // Scan agent components for anything that looks like a task board
    const components = options.agent.components();
    for (const [, value] of components) {
      if (isTaskBoardLike(value)) {
        const adapter = createTaskBoardAdminAdapter(value);
        orchestration.taskBoard = adapter.views;

        if (options.verbose) {
          process.stderr.write("Orchestration: task board wired from agent component\n");
        }
        break;
      }
    }
  }

  // 5. If task board is still not found but harness is available,
  //    derive task board from harness status (HarnessStatus.taskBoard)
  if (orchestration.taskBoard === undefined && resolvedHarness !== undefined) {
    const derived = deriveTaskBoardFromHarness(resolvedHarness);
    if (derived !== undefined) {
      const adapter = createTaskBoardAdminAdapter(derived);
      orchestration.taskBoard = adapter.views;

      if (options.verbose) {
        process.stderr.write("Orchestration: task board derived from harness status\n");
      }
    }
  }

  const hasAny =
    orchestration.temporal !== undefined ||
    orchestration.scheduler !== undefined ||
    orchestration.taskBoard !== undefined ||
    orchestration.harness !== undefined;

  return { orchestration, orchestrationCommands: commands, hasAny };
}
