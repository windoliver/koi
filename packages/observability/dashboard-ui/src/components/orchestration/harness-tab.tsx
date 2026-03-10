/**
 * HarnessTab — phase, session count, task progress, token usage, checkpoint timeline.
 */

import type { CheckpointEntry, HarnessStatus } from "@koi/dashboard-types";
import { useCallback } from "react";
import { useRuntimeView } from "../../hooks/use-runtime-view.js";
import { pauseHarness, resumeHarness } from "../../lib/api-client.js";
import { formatDuration, formatRelativeTime } from "../../lib/format.js";
import { LoadingSkeleton } from "../shared/loading-skeleton.js";

// ---------------------------------------------------------------------------
// Phase indicator
// ---------------------------------------------------------------------------

const PHASE_COLORS: Readonly<Record<string, string>> = {
  idle: "text-[var(--color-muted,#888)]",
  running: "text-blue-400",
  paused: "text-yellow-400",
  completed: "text-green-400",
  failed: "text-red-400",
} as const;

function PhaseIndicator({ status }: { readonly status: HarnessStatus }): React.ReactElement {
  const phaseColor = PHASE_COLORS[status.phase] ?? PHASE_COLORS.idle;

  return (
    <div className="flex items-center gap-3 rounded border border-[var(--color-border,#444)] px-4 py-3">
      <div className="flex items-center gap-2">
        <div
          className={`h-2.5 w-2.5 rounded-full ${
            status.phase === "running" ? "bg-blue-400 animate-pulse" : "bg-[var(--color-muted,#888)]"
          }`}
        />
        <span className={`text-sm font-semibold ${phaseColor}`}>
          {status.phase.charAt(0).toUpperCase() + status.phase.slice(1)}
        </span>
      </div>
      {status.startedAt !== undefined && (
        <span className="text-xs text-[var(--color-muted,#888)]">
          Started {formatRelativeTime(status.startedAt)}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats grid
// ---------------------------------------------------------------------------

function StatsGrid({ status }: { readonly status: HarnessStatus }): React.ReactElement {
  const taskPct = status.taskProgress.total > 0
    ? Math.round((status.taskProgress.completed / status.taskProgress.total) * 100)
    : 0;
  const tokenPct = status.tokenUsage.budget > 0
    ? Math.round((status.tokenUsage.used / status.tokenUsage.budget) * 100)
    : 0;

  return (
    <div className="grid grid-cols-2 gap-3">
      {/* Sessions */}
      <div className="rounded border border-[var(--color-border,#444)] px-3 py-2">
        <div className="text-xs text-[var(--color-muted,#888)]">Sessions</div>
        <div className="text-lg font-semibold text-[var(--color-foreground,#cdd6f4)]">
          {status.sessionCount}
        </div>
      </div>

      {/* Auto-resume */}
      <div className="rounded border border-[var(--color-border,#444)] px-3 py-2">
        <div className="text-xs text-[var(--color-muted,#888)]">Auto-Resume</div>
        <div className={`text-lg font-semibold ${status.autoResumeEnabled ? "text-green-400" : "text-[var(--color-muted,#888)]"}`}>
          {status.autoResumeEnabled ? "On" : "Off"}
        </div>
      </div>

      {/* Task progress */}
      <div className="rounded border border-[var(--color-border,#444)] px-3 py-2">
        <div className="text-xs text-[var(--color-muted,#888)]">Task Progress</div>
        <div className="text-sm font-semibold text-[var(--color-foreground,#cdd6f4)]">
          {status.taskProgress.completed}/{status.taskProgress.total} ({taskPct}%)
        </div>
        <div className="mt-1 h-1.5 w-full rounded-full bg-[var(--color-border,#444)]">
          <div
            className="h-full rounded-full bg-blue-400 transition-all"
            style={{ width: `${taskPct}%` }}
          />
        </div>
      </div>

      {/* Token usage */}
      <div className="rounded border border-[var(--color-border,#444)] px-3 py-2">
        <div className="text-xs text-[var(--color-muted,#888)]">Token Usage</div>
        <div className="text-sm font-semibold text-[var(--color-foreground,#cdd6f4)]">
          {status.tokenUsage.used.toLocaleString()}/{status.tokenUsage.budget.toLocaleString()} ({tokenPct}%)
        </div>
        <div className="mt-1 h-1.5 w-full rounded-full bg-[var(--color-border,#444)]">
          <div
            className={`h-full rounded-full transition-all ${tokenPct > 80 ? "bg-red-400" : "bg-green-400"}`}
            style={{ width: `${Math.min(tokenPct, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checkpoint timeline
// ---------------------------------------------------------------------------

function CheckpointTimeline({
  checkpoints,
}: {
  readonly checkpoints: readonly CheckpointEntry[];
}): React.ReactElement {
  if (checkpoints.length === 0) {
    return (
      <div className="text-center text-xs text-[var(--color-muted,#888)] py-4">
        No checkpoints
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {checkpoints.map((cp) => (
        <div
          key={cp.id}
          className="flex items-center gap-2 rounded border border-[var(--color-border,#333)] px-3 py-1.5"
        >
          <div
            className={`h-2 w-2 rounded-full ${
              cp.type === "hard" ? "bg-red-400" : "bg-yellow-400"
            }`}
          />
          <span className="text-xs font-medium text-[var(--color-foreground,#cdd6f4)]">
            {cp.type === "hard" ? "Hard" : "Soft"}
          </span>
          <span className="text-xs text-[var(--color-muted,#888)]">
            {formatRelativeTime(cp.createdAt)}
          </span>
          {cp.sessionId !== undefined && (
            <span className="text-xs font-mono text-[var(--color-muted,#666)]">
              {cp.sessionId.slice(0, 8)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function HarnessTab(): React.ReactElement {
  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useRuntimeView<HarnessStatus>(
    "/harness/status",
    { refetchInterval: 5_000 },
  );
  const { data: checkpoints, isLoading: cpLoading } = useRuntimeView<readonly CheckpointEntry[]>(
    "/harness/checkpoints",
    { refetchInterval: 10_000 },
  );

  const handlePause = useCallback(() => {
    void pauseHarness().then(() => refetchStatus());
  }, [refetchStatus]);

  const handleResume = useCallback(() => {
    void resumeHarness().then(() => refetchStatus());
  }, [refetchStatus]);

  if (statusLoading) {
    return <div className="p-4"><LoadingSkeleton /></div>;
  }

  if (status === undefined) {
    return (
      <div className="flex h-[300px] items-center justify-center text-xs text-[var(--color-muted,#888)]">
        Harness not available
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Phase + controls */}
      <div className="flex items-center justify-between">
        <PhaseIndicator status={status} />
        <div className="flex gap-2">
          {status.phase === "running" && (
            <button
              type="button"
              className="rounded bg-yellow-600/20 px-3 py-1.5 text-xs font-medium text-yellow-400 hover:bg-yellow-600/30"
              onClick={handlePause}
            >
              Pause
            </button>
          )}
          {status.phase === "paused" && (
            <button
              type="button"
              className="rounded bg-green-600/20 px-3 py-1.5 text-xs font-medium text-green-400 hover:bg-green-600/30"
              onClick={handleResume}
            >
              Resume
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <StatsGrid status={status} />

      {/* Checkpoints */}
      <div>
        <h3 className="mb-2 text-xs font-medium text-[var(--color-muted,#888)]">
          Checkpoints
        </h3>
        {cpLoading ? (
          <LoadingSkeleton />
        ) : (
          <CheckpointTimeline checkpoints={checkpoints ?? []} />
        )}
      </div>
    </div>
  );
}
