/**
 * TaskNodeDetailPanel — detail panel for a selected Task Board node.
 *
 * Shows taskId, label, status, assignedTo, result, and error when a
 * node is clicked in the DAG view.
 */

import type { TaskBoardNode } from "@koi/dashboard-types";

const STATUS_LABELS: Readonly<Record<string, { readonly text: string; readonly color: string }>> = {
  completed: { text: "Completed", color: "text-green-400" },
  running: { text: "Running", color: "text-blue-400" },
  pending: { text: "Pending", color: "text-[var(--color-muted,#888)]" },
  failed: { text: "Failed", color: "text-red-400" },
} as const;

const DEFAULT_STATUS_LABEL = { text: "Unknown", color: "text-[var(--color-muted,#888)]" } as const;

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

export function TaskNodeDetailPanel({
  node,
  onClose,
}: {
  readonly node: TaskBoardNode;
  readonly onClose: () => void;
}): React.ReactElement {
  const statusLabel = STATUS_LABELS[node.status] ?? DEFAULT_STATUS_LABEL;

  return (
    <div className="border-t border-[var(--color-border,#444)] bg-[var(--color-background,#1e1e2e)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border,#444)] px-4 py-2">
        <span className="text-xs font-semibold text-[var(--color-foreground,#cdd6f4)]">
          Task Detail
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
        <DetailRow label="Task ID" value={node.taskId} />
        <DetailRow label="Label" value={node.label} />
        <DetailRow label="Status" value={statusLabel.text} className={statusLabel.color} />
        {node.assignedTo !== undefined && (
          <DetailRow label="Assigned To" value={node.assignedTo} />
        )}

        {/* Result */}
        {node.result !== undefined && (
          <div className="mt-3">
            <span className="font-mono text-[10px] font-medium uppercase tracking-wider text-[var(--color-muted,#888)]">
              Result
            </span>
            <pre className="mt-1 rounded bg-[var(--color-card,#1e1e2e)] p-2 text-[10px] text-[var(--color-foreground,#cdd6f4)] overflow-x-auto">
              {typeof node.result === "string"
                ? node.result
                : JSON.stringify(node.result, null, 2)}
            </pre>
          </div>
        )}

        {/* Error */}
        {node.error !== undefined && (
          <div className="mt-3">
            <span className="text-[10px] font-medium uppercase tracking-wider text-red-400">
              Error
            </span>
            <pre className="mt-1 rounded bg-red-950/30 border border-red-900/40 p-2 text-[10px] text-red-300 overflow-x-auto">
              {node.error}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
