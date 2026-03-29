/**
 * resolveAutonomousOrWarn — conditionally bootstrap autonomous agent mode.
 *
 * When the manifest declares `autonomous.enabled: true`, lazily loads
 * @koi/autonomous and its dependencies, creates in-memory stores,
 * and returns the autonomous agent with its harness for orchestration wiring.
 *
 * The harness is wrapped as a HarnessAdminClientLike so the orchestration
 * resolver can create dashboard views. Pause/resume are not exposed through
 * the admin client (they require session context that the admin panel lacks).
 */

import type {
  AgentId,
  ComponentProvider,
  EngineMetrics,
  HarnessSnapshot,
  HarnessStatus,
  KoiError,
  KoiMiddleware,
  MailboxComponent,
  Result,
  SpawnFn,
} from "@koi/core";
import { agentId, harnessId } from "@koi/core";
import type { HarnessAdminClientLike } from "@koi/dashboard-api";
import type { StackContribution } from "./contribution-graph.js";
import { createInMemorySessionPersistence } from "./in-memory-session-persistence.js";

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface AutonomousResult {
  /** Harness wrapped for admin panel consumption. */
  readonly harness: HarnessAdminClientLike;
  /** Middleware to inject into createForgeConfiguredKoi (harness + checkpoint + inbox). */
  readonly middleware: readonly KoiMiddleware[];
  /** Component providers to inject into createForgeConfiguredKoi. */
  readonly providers: readonly ComponentProvider[];
  /** Dispose autonomous agent (scheduler first, then harness). */
  readonly dispose: () => Promise<void>;
  /**
   * Bind the notification target after agent assembly. Once bound, the harness
   * sends a push notification to the initiator's inbox on completion or failure.
   * Call this after createForgeConfiguredKoi() when the mailbox is available.
   */
  readonly bindNotification: (initiatorId: AgentId, mailbox: MailboxComponent) => void;
  /**
   * Pause the harness after a session completes. Transitions active → suspended
   * so the scheduler can resume the next session.
   */
  readonly pauseHarness: (sessionResult: {
    readonly sessionId: string;
    readonly metrics: EngineMetrics;
    readonly summary?: string | undefined;
  }) => Promise<Result<void, KoiError>>;
  /**
   * Bind a session runner callback. Called by the scheduler after resume()
   * to run the engine sub-session. Deferred because the runtime is created
   * after the scheduler.
   */
  readonly bindSessionRunner: (runner: (resumeResult: unknown) => Promise<void>) => void;
  /**
   * Bind a spawn function for delegation bridge dispatch. Once bound, tasks
   * with `delegation: "spawn"` are auto-dispatched to worker agents.
   * Deferred because SpawnFn requires engine runtime context.
   */
  readonly bindSpawn: (spawn: SpawnFn) => void;
  /**
   * Bind a dashboard event callback for real-time TUI task board updates.
   * When bound, task status changes push events via SSE to the TUI.
   * Deferred because the dashboard bridge is created after the autonomous agent.
   */
  readonly bindDashboardEvent: (
    emitter: (event: {
      readonly kind: "taskboard";
      readonly subKind: "task_status_changed";
      readonly taskId: string;
      readonly status: string;
      readonly timestamp: number;
    }) => void,
  ) => void;
}

/** Autonomous resolution result bundled with contribution metadata. */
export interface AutonomousResolutionWithContribution {
  readonly result: AutonomousResult | undefined;
  readonly contribution: StackContribution;
}

// ---------------------------------------------------------------------------
// Manifest detection
// ---------------------------------------------------------------------------

/** Check if the manifest declares autonomous mode via extension field. */
function isAutonomousEnabled(manifest: { readonly autonomous?: unknown }): boolean {
  const autonomous = manifest.autonomous;
  if (autonomous === null || autonomous === undefined || typeof autonomous !== "object") {
    return false;
  }
  const obj = autonomous as Record<string, unknown>;
  return obj.enabled === true;
}

// ---------------------------------------------------------------------------
// Harness → Admin client wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a LongRunningHarness as HarnessAdminClientLike for the admin panel.
 *
 * Status is forwarded directly (structurally compatible). Pause/resume are
 * NOT exposed — they require session context that the admin panel lacks.
 * The dashboard adapter will show "not supported" for those actions.
 */
function mapHarnessToAdminClient(harness: {
  readonly status: () => unknown;
}): HarnessAdminClientLike {
  // HarnessStatus from core is structurally compatible with HarnessStatusLike.
  // Cast through unknown because the branded types don't directly overlap.
  return {
    status: () => harness.status() as ReturnType<HarnessAdminClientLike["status"]>,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function resolveAutonomousOrWarn(
  manifest: {
    readonly autonomous?: unknown;
    readonly name: string;
  },
  verbose?: boolean,
): Promise<AutonomousResolutionWithContribution> {
  if (!isAutonomousEnabled(manifest)) {
    return {
      result: undefined,
      contribution: {
        id: "autonomous",
        label: "Autonomous",
        enabled: false,
        source: "runtime",
        status: "skipped",
        reason: "autonomous.enabled not set",
        packages: [],
      },
    };
  }

  try {
    // Lazy imports — only loaded when autonomous mode is enabled
    const [
      { createAutonomousAgent, createCompletionNotifier },
      { createLongRunningHarness },
      { createHarnessScheduler },
      { createInMemorySnapshotChainStore, createThreadStore },
    ] = await Promise.all([
      import("@koi/autonomous"),
      import("@koi/long-running"),
      import("@koi/harness-scheduler"),
      import("@koi/snapshot-chain-store"),
    ]);

    const hId = harnessId(`${manifest.name}-harness`);
    const aId = agentId(`${manifest.name}-agent`);

    // In-memory stores for CLI usage
    const harnessStore = createInMemorySnapshotChainStore<HarnessSnapshot>();
    const sessionPersistence = createInMemorySessionPersistence();
    const threadSnapshotStore =
      createInMemorySnapshotChainStore<import("@koi/core").ThreadSnapshot>();
    const threadStore = createThreadStore({ store: threadSnapshotStore });

    // Deferred notification target — set after agent assembly via bindNotification().
    // let justified: mutable refs populated post-assembly when mailbox is available.
    let notifyMailbox: MailboxComponent | undefined;
    let notifyInitiatorId: AgentId | undefined;

    // Deferred spawn function — set after runtime assembly via bindSpawn().
    // let justified: mutable ref populated post-assembly when engine spawn is available.
    let boundSpawn: SpawnFn | undefined;
    // let justified: deferred dashboard event emitter, bound after bridge is created
    type TaskBoardEventEmitter = Parameters<AutonomousResult["bindDashboardEvent"]>[0];
    let boundDashboardEmitter: TaskBoardEventEmitter | undefined;

    const harness = createLongRunningHarness({
      harnessId: hId,
      agentId: aId,
      harnessStore,
      sessionPersistence,
      onCompleted: async (status: HarnessStatus) => {
        if (notifyMailbox !== undefined && notifyInitiatorId !== undefined) {
          const notifier = createCompletionNotifier({
            initiatorId: notifyInitiatorId,
            agentId: aId,
            mailbox: notifyMailbox,
          });
          await notifier.onCompleted(status);
        }
        const { completedTaskCount, pendingTaskCount } = status.metrics;
        const total = completedTaskCount + pendingTaskCount;
        process.stderr.write(
          `[autonomous] ✓ Autonomous plan completed. ${String(completedTaskCount)}/${String(total)} tasks done.\n`,
        );
      },
      onFailed: async (status: HarnessStatus, error: KoiError) => {
        if (notifyMailbox !== undefined && notifyInitiatorId !== undefined) {
          const notifier = createCompletionNotifier({
            initiatorId: notifyInitiatorId,
            agentId: aId,
            mailbox: notifyMailbox,
          });
          await notifier.onFailed(status, error);
        }
        const { completedTaskCount, pendingTaskCount } = status.metrics;
        const total = completedTaskCount + pendingTaskCount;
        process.stderr.write(
          `[autonomous] ✗ Autonomous plan failed: ${error.message}. ${String(completedTaskCount)}/${String(total)} tasks completed.\n`,
        );
      },
    });

    // Deferred session runner — set after runtime assembly via bindSessionRunner().
    // let justified: mutable ref populated post-assembly when runtime is available.
    let boundSessionRunner: ((resumeResult: unknown) => Promise<void>) | undefined;

    const scheduler = createHarnessScheduler({
      harness,
      onResumed: async (resumeResult: unknown) => {
        if (boundSessionRunner === undefined) {
          process.stderr.write(
            "[autonomous] warn: scheduler resumed but session runner not bound — skipping\n",
          );
          return;
        }
        process.stderr.write("[autonomous] scheduler driving sub-session...\n");
        await boundSessionRunner(resumeResult);
      },
    });

    const agent = createAutonomousAgent({
      harness,
      scheduler,
      getSpawn: () => boundSpawn,
      threadStore,
      taskBoardGoalStack: true,
      onTaskBoardEvent: (event) => boundDashboardEmitter?.(event),
    });

    if (verbose) {
      process.stderr.write("Autonomous mode: enabled (in-memory stores)\n");
    }

    const autonomousResult: AutonomousResult = {
      harness: mapHarnessToAdminClient(harness),
      middleware: agent.middleware(),
      providers: agent.providers(),
      dispose: async () => {
        await agent.dispose();
        sessionPersistence.close();
      },
      bindNotification: (initiatorId: AgentId, mailbox: MailboxComponent) => {
        notifyInitiatorId = initiatorId;
        notifyMailbox = mailbox;
      },
      pauseHarness: (sessionResult) => harness.pause(sessionResult),
      bindSessionRunner: (runner) => {
        boundSessionRunner = runner;
      },
      bindSpawn: (spawn: SpawnFn) => {
        boundSpawn = spawn;
      },
      bindDashboardEvent: (emitter) => {
        boundDashboardEmitter = emitter;
      },
    };

    const packages: StackContribution["packages"][number][] = [];
    if (autonomousResult.middleware.length > 0) {
      packages.push({
        id: "@koi/autonomous",
        kind: "middleware",
        source: "static",
        middlewareNames: autonomousResult.middleware.map((m) => m.name),
      });
    }
    if (autonomousResult.providers.length > 0) {
      packages.push({
        id: "@koi/autonomous",
        kind: "provider",
        source: "static",
        providerNames: autonomousResult.providers.map((p) => p.name),
      });
    }
    // Sub-packages
    packages.push(
      {
        id: "@koi/long-running",
        kind: "subsystem",
        source: "static",
        notes: ["harness lifecycle"],
      },
      {
        id: "@koi/harness-scheduler",
        kind: "subsystem",
        source: "static",
        notes: ["task scheduling"],
      },
      {
        id: "@koi/snapshot-chain-store",
        kind: "subsystem",
        source: "static",
        notes: ["session persistence"],
      },
    );

    return {
      result: autonomousResult,
      contribution: {
        id: "autonomous",
        label: "Autonomous",
        enabled: true,
        source: "runtime",
        status: "active",
        packages,
      },
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`warn: autonomous mode failed to initialize: ${msg}\n`);
    return {
      result: undefined,
      contribution: {
        id: "autonomous",
        label: "Autonomous",
        enabled: false,
        source: "runtime",
        status: "failed",
        reason: msg,
        packages: [
          { id: "@koi/autonomous", kind: "subsystem", source: "static", notes: ["not available"] },
        ],
      },
    };
  }
}
