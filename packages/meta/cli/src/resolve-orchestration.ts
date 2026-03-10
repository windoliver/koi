/**
 * resolveOrchestrationFromAgent — extract orchestration views from the Agent entity.
 *
 * Queries the Agent's ECS components for known subsystem tokens (SCHEDULER)
 * and wraps them in dashboard-compatible adapters. For Temporal, delegates to
 * resolveTemporalOrWarn. For harness/task-board, accepts optional injected
 * instances (since they're created by @koi/autonomous, not attached as tokens).
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

  // 3. Task Board — injected from autonomous agent builder
  if (options.taskBoard !== undefined) {
    const adapter = createTaskBoardAdminAdapter(options.taskBoard);
    orchestration.taskBoard = adapter.views;

    if (options.verbose) {
      process.stderr.write("Orchestration: task board wired\n");
    }
  }

  // 4. Harness — injected from autonomous agent builder
  if (options.harness !== undefined) {
    const adapter = createHarnessAdminAdapter(options.harness);
    orchestration.harness = adapter.views;
    Object.assign(commands, adapter.commands);

    if (options.verbose) {
      process.stderr.write("Orchestration: harness wired\n");
    }
  }

  const hasAny =
    orchestration.temporal !== undefined ||
    orchestration.scheduler !== undefined ||
    orchestration.taskBoard !== undefined ||
    orchestration.harness !== undefined;

  return { orchestration, orchestrationCommands: commands, hasAny };
}
