/**
 * Harness admin adapter for the Koi dashboard.
 *
 * Wraps a structurally-typed LongRunningHarness to produce dashboard-compatible
 * views (RuntimeViewDataSource['harness']) and commands (pauseHarness,
 * resumeHarness).
 *
 * Uses structural typing to avoid direct dependency on @koi/long-running —
 * the consumer injects a compatible harness at runtime.
 *
 * L2 package: imports from @koi/core and @koi/dashboard-types only.
 */

import type { KoiError, Result } from "@koi/core";
import type {
  CheckpointEntry,
  CommandDispatcher,
  HarnessStatus as DashboardHarnessStatus,
  RuntimeViewDataSource,
} from "@koi/dashboard-types";

// ---------------------------------------------------------------------------
// Structural types (loose coupling — no @koi/long-running import)
// ---------------------------------------------------------------------------

/** Minimal shape of harness metrics from the core HarnessStatus. */
export interface HarnessMetricsLike {
  readonly totalSessions: number;
  readonly totalTurns: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly completedTaskCount: number;
  readonly pendingTaskCount: number;
  readonly elapsedMs: number;
}

/** Minimal shape of a core HarnessStatus. */
export interface HarnessStatusLike {
  readonly harnessId: string;
  readonly phase: "idle" | "active" | "suspended" | "completed" | "failed";
  readonly currentSessionSeq: number;
  readonly metrics: HarnessMetricsLike;
  readonly startedAt?: number | undefined;
}

/** Minimal shape of a harness snapshot (checkpoint). */
export interface HarnessSnapshotLike {
  readonly harnessId: string;
  readonly phase: string;
  readonly sessionSeq: number;
  readonly checkpointedAt: number;
}

/** Structural interface for the backing harness. */
export interface HarnessAdminClientLike {
  readonly status: () => HarnessStatusLike;
  /** Pause the harness (suspend execution). */
  readonly pause?: (() => void | Promise<void>) | undefined;
  /** Resume the harness from suspended state. */
  readonly resume?: (() => void | Promise<void>) | undefined;
}

/** Extended interface that includes checkpoint listing. */
export interface HarnessAdminClientWithCheckpoints extends HarnessAdminClientLike {
  readonly listCheckpoints: () =>
    | readonly HarnessSnapshotLike[]
    | Promise<readonly HarnessSnapshotLike[]>;
}

// ---------------------------------------------------------------------------
// Adapter result
// ---------------------------------------------------------------------------

export interface HarnessAdminAdapter {
  readonly views: NonNullable<RuntimeViewDataSource["harness"]>;
  readonly commands: Required<Pick<CommandDispatcher, "pauseHarness" | "resumeHarness">>;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/** Map core HarnessPhase to dashboard phase. */
function mapPhase(phase: HarnessStatusLike["phase"]): DashboardHarnessStatus["phase"] {
  switch (phase) {
    case "idle":
      return "idle";
    case "active":
      return "running";
    case "suspended":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

function mapStatusToDashboard(status: HarnessStatusLike): DashboardHarnessStatus {
  const totalTasks = status.metrics.completedTaskCount + status.metrics.pendingTaskCount;
  const totalTokens = status.metrics.totalInputTokens + status.metrics.totalOutputTokens;

  return {
    phase: mapPhase(status.phase),
    sessionCount: status.currentSessionSeq,
    taskProgress: {
      completed: status.metrics.completedTaskCount,
      total: totalTasks,
    },
    tokenUsage: {
      used: totalTokens,
      budget: 0, // Budget not tracked in core harness status
    },
    autoResumeEnabled: false, // Not tracked in core status
    ...(status.startedAt !== undefined ? { startedAt: status.startedAt } : {}),
  };
}

function mapSnapshotToCheckpoint(snap: HarnessSnapshotLike): CheckpointEntry {
  return {
    id: `${snap.harnessId}:${String(snap.sessionSeq)}`,
    type: "hard",
    createdAt: snap.checkpointedAt,
    sessionId: String(snap.sessionSeq),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHarnessAdminAdapter(client: HarnessAdminClientLike): HarnessAdminAdapter {
  const hasCheckpoints =
    "listCheckpoints" in client && typeof client.listCheckpoints === "function";

  const views: NonNullable<RuntimeViewDataSource["harness"]> = {
    getStatus(): DashboardHarnessStatus {
      return mapStatusToDashboard(client.status());
    },

    async getCheckpoints(): Promise<readonly CheckpointEntry[]> {
      if (!hasCheckpoints) return [];
      const snapshots = await (client as HarnessAdminClientWithCheckpoints).listCheckpoints();
      return snapshots.map(mapSnapshotToCheckpoint);
    },
  };

  const commands: HarnessAdminAdapter["commands"] = {
    async pauseHarness(): Promise<Result<void, KoiError>> {
      if (client.pause === undefined) {
        return {
          ok: false,
          error: { code: "PERMISSION", message: "Pause not supported", retryable: false },
        };
      }
      await client.pause();
      return { ok: true, value: undefined };
    },

    async resumeHarness(): Promise<Result<void, KoiError>> {
      if (client.resume === undefined) {
        return {
          ok: false,
          error: { code: "PERMISSION", message: "Resume not supported", retryable: false },
        };
      }
      await client.resume();
      return { ok: true, value: undefined };
    },
  };

  return { views, commands };
}
