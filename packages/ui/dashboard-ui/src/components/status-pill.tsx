import type { ReactElement } from "react";

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  completed: "Completed",
  error: "Error",
  failed: "Failed",
  idle: "Idle",
  offline: "Offline",
  queued: "Queued",
  running: "Running",
  success: "Success",
  warning: "Warning",
};

export function StatusPill({ status }: { status: string }): ReactElement {
  return (
    <span className={`status-pill status-pill--${status}`} aria-label={`Status: ${status}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}
