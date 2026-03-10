/**
 * WorkflowDetailPanel — slide-in panel showing workflow detail on row click.
 *
 * Fetches WorkflowDetail from /temporal/workflows/:id and renders
 * run info, search attributes, memo, and pending activities.
 */

import type { WorkflowDetail } from "@koi/dashboard-types";
import { useRuntimeView } from "../../hooks/use-runtime-view.js";
import { formatDuration, formatRelativeTime } from "../../lib/format.js";
import { useOrchestrationStore } from "../../stores/orchestration-store.js";
import { LoadingSkeleton } from "../shared/loading-skeleton.js";

const STATUS_COLORS: Readonly<Record<string, string>> = {
  running: "text-blue-400",
  completed: "text-green-400",
  failed: "text-red-400",
  cancelled: "text-yellow-400",
  terminated: "text-orange-400",
  timed_out: "text-red-300",
} as const;

function DetailRow({
  label,
  value,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly className?: string | undefined;
}): React.ReactElement {
  return (
    <div className="flex justify-between py-1.5 border-b border-[var(--color-border,#333)]">
      <span className="text-xs text-[var(--color-muted,#888)]">{label}</span>
      <span className={`text-xs font-mono ${className ?? "text-[var(--color-foreground,#cdd6f4)]"}`}>
        {value}
      </span>
    </div>
  );
}

function JsonBlock({ data }: { readonly data: Readonly<Record<string, unknown>> }): React.ReactElement {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return <span className="text-xs text-[var(--color-muted,#888)]">—</span>;
  }
  return (
    <pre className="mt-1 rounded bg-[var(--color-card,#1e1e2e)] p-2 text-[10px] text-[var(--color-foreground,#cdd6f4)] overflow-x-auto">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export function WorkflowDetailPanel({
  workflowId,
  onClose,
}: {
  readonly workflowId: string;
  readonly onClose: () => void;
}): React.ReactElement {
  const lastInvalidatedAt = useOrchestrationStore((s) => s.lastInvalidatedAt);
  const { data: detail, isLoading } = useRuntimeView<WorkflowDetail>(
    `/temporal/workflows/${encodeURIComponent(workflowId)}`,
    { refetchInterval: 5_000, invalidationKey: lastInvalidatedAt },
  );

  return (
    <div className="border-t border-[var(--color-border,#444)] bg-[var(--color-background,#1e1e2e)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border,#444)] px-4 py-2">
        <span className="text-xs font-semibold text-[var(--color-foreground,#cdd6f4)]">
          Workflow Detail
        </span>
        <button
          type="button"
          className="rounded p-1 text-[var(--color-muted,#888)] hover:bg-[var(--color-card,#313244)] hover:text-[var(--color-foreground,#cdd6f4)]"
          onClick={onClose}
          aria-label="Close detail"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {isLoading && <LoadingSkeleton />}

        {!isLoading && detail === undefined && (
          <span className="text-xs text-[var(--color-muted,#888)]">
            Workflow not found
          </span>
        )}

        {detail !== undefined && (
          <div className="flex flex-col gap-3">
            {/* Core info */}
            <div>
              <DetailRow label="Workflow ID" value={detail.workflowId} />
              <DetailRow label="Run ID" value={detail.runId} />
              <DetailRow label="Type" value={detail.workflowType} />
              {detail.entityType !== undefined && (
                <DetailRow label="Entity Type" value={detail.entityType} />
              )}
              <DetailRow
                label="Status"
                value={detail.status}
                className={STATUS_COLORS[detail.status]}
              />
              <DetailRow label="Task Queue" value={detail.taskQueue} />
              <DetailRow label="Started" value={formatRelativeTime(detail.startTime)} />
              {detail.closeTime !== undefined && (
                <DetailRow
                  label="Duration"
                  value={formatDuration(detail.closeTime - detail.startTime)}
                />
              )}
              <DetailRow
                label="Pending Activities"
                value={String(detail.pendingActivities)}
              />
              <DetailRow
                label="Pending Signals"
                value={String(detail.pendingSignals)}
              />
              <DetailRow
                label="Continue-As-New Count"
                value={String(detail.canCount)}
              />
            </div>

            {/* State Refs (when available) */}
            {detail.stateRefs !== undefined && (
              <div>
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-muted,#888)]">
                  State
                </span>
                <div className="mt-1">
                  <DetailRow
                    label="Turns Processed"
                    value={String(detail.stateRefs.turnsProcessed)}
                  />
                  {detail.stateRefs.lastTurnId !== undefined && (
                    <DetailRow
                      label="Last Turn ID"
                      value={detail.stateRefs.lastTurnId}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Search Attributes */}
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-muted,#888)]">
                Search Attributes
              </span>
              <JsonBlock data={detail.searchAttributes} />
            </div>

            {/* Memo */}
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-muted,#888)]">
                Memo
              </span>
              <JsonBlock data={detail.memo} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
