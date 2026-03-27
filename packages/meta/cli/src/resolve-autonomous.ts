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
  AgentMessageInput,
  ComponentProvider,
  EngineMetrics,
  HarnessSnapshot,
  HarnessStatus,
  KoiError,
  KoiMiddleware,
  MailboxComponent,
  PendingFrame,
  RecoveryPlan,
  Result,
  SessionFilter,
  SessionPersistence,
  SessionRecord,
} from "@koi/core";
import { agentId, harnessId } from "@koi/core";
import type { HarnessAdminClientLike } from "@koi/dashboard-api";
import type { StackContribution } from "./contribution-graph.js";

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
// In-memory SessionPersistence (CLI-only, no persistence across restarts)
// ---------------------------------------------------------------------------

function createInMemorySessionPersistence(): SessionPersistence {
  const sessions = new Map<string, SessionRecord>();
  const frames = new Map<string, PendingFrame[]>();

  const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({
    ok: true,
    value,
  });

  const notFound = (
    id: string,
  ): {
    readonly ok: false;
    readonly error: {
      readonly code: "NOT_FOUND";
      readonly message: string;
      readonly retryable: false;
    };
  } => ({
    ok: false,
    error: { code: "NOT_FOUND", message: `Session ${id} not found`, retryable: false },
  });

  return {
    saveSession: (record) => {
      sessions.set(record.sessionId, record);
      return ok(undefined);
    },

    loadSession: (sid) => {
      const record = sessions.get(sid);
      if (record === undefined) return notFound(sid);
      return ok(record);
    },

    removeSession: (sid) => {
      sessions.delete(sid);
      frames.delete(sid);
      return ok(undefined);
    },

    listSessions: (filter?: SessionFilter) => {
      const all = [...sessions.values()];
      if (filter === undefined) return ok(all);
      const filtered = all.filter((s) => {
        if (filter.agentId !== undefined && s.agentId !== filter.agentId) return false;
        return true;
      });
      return ok(filtered);
    },

    savePendingFrame: (frame) => {
      const existing = frames.get(frame.sessionId) ?? [];
      frames.set(frame.sessionId, [...existing, frame]);
      return ok(undefined);
    },

    loadPendingFrames: (sid) => {
      const arr = frames.get(sid) ?? [];
      const sorted = [...arr].sort((a, b) => a.orderIndex - b.orderIndex);
      return ok(sorted);
    },

    clearPendingFrames: (sid) => {
      frames.delete(sid);
      return ok(undefined);
    },

    removePendingFrame: (frameId) => {
      for (const [sid, arr] of frames) {
        const filtered = arr.filter((f) => f.frameId !== frameId);
        if (filtered.length !== arr.length) {
          frames.set(sid, filtered);
        }
      }
      return ok(undefined);
    },

    recover: (): {
      readonly ok: true;
      readonly value: RecoveryPlan;
    } => {
      const allSessions = [...sessions.values()];
      const pendingFrames = new Map<string, readonly PendingFrame[]>();
      for (const [sid, arr] of frames) {
        pendingFrames.set(sid, arr);
      }
      return ok({ sessions: allSessions, pendingFrames, skipped: [] });
    },

    close: () => {
      sessions.clear();
      frames.clear();
    },
  };
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
      { createAutonomousAgent },
      { createLongRunningHarness },
      { createHarnessScheduler },
      { createInMemorySnapshotChainStore },
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

    // Deferred notification target — set after agent assembly via bindNotification().
    // let justified: mutable refs populated post-assembly when mailbox is available.
    let notifyMailbox: MailboxComponent | undefined;
    let notifyInitiatorId: AgentId | undefined;

    const harness = createLongRunningHarness({
      harnessId: hId,
      agentId: aId,
      harnessStore,
      sessionPersistence,
      onCompleted: async (status: HarnessStatus) => {
        const { completedTaskCount, pendingTaskCount } = status.metrics;
        const total = completedTaskCount + pendingTaskCount;
        const summary = `Autonomous plan completed. ${String(completedTaskCount)}/${String(total)} tasks done.`;

        if (notifyMailbox !== undefined && notifyInitiatorId !== undefined) {
          const message: AgentMessageInput = {
            from: aId,
            to: notifyInitiatorId,
            kind: "event",
            type: "autonomous.completed",
            payload: {
              harnessId: status.harnessId,
              phase: status.phase,
              completedTaskCount,
              totalTaskCount: total,
              summary,
            },
            metadata: { mode: "steer" },
          };
          const result = await notifyMailbox.send(message);
          if (!result.ok) {
            process.stderr.write(
              `[autonomous] Failed to send completion notification: ${result.error.message}\n`,
            );
          }
        }
        process.stderr.write(`[autonomous] ✓ ${summary}\n`);
      },
      onFailed: async (status: HarnessStatus, error: KoiError) => {
        const { completedTaskCount, pendingTaskCount } = status.metrics;
        const total = completedTaskCount + pendingTaskCount;
        const summary = `Autonomous plan failed: ${error.message}. ${String(completedTaskCount)}/${String(total)} tasks completed.`;

        if (notifyMailbox !== undefined && notifyInitiatorId !== undefined) {
          const message: AgentMessageInput = {
            from: aId,
            to: notifyInitiatorId,
            kind: "event",
            type: "autonomous.failed",
            payload: {
              harnessId: status.harnessId,
              phase: status.phase,
              completedTaskCount,
              totalTaskCount: total,
              errorCode: error.code,
              errorMessage: error.message,
              summary,
            },
            metadata: { mode: "steer" },
          };
          const result = await notifyMailbox.send(message);
          if (!result.ok) {
            process.stderr.write(
              `[autonomous] Failed to send failure notification: ${result.error.message}\n`,
            );
          }
        }
        process.stderr.write(`[autonomous] ✗ ${summary}\n`);
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

    const agent = createAutonomousAgent({ harness, scheduler });

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
