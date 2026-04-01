/**
 * Brick timeline panel — chronological list of brick lifecycle events.
 */

import type { ForgeDashboardEvent } from "@koi/dashboard-types";
import { useForgeTimeline } from "../../stores/forge-store.js";

const LIFECYCLE_SUBKINDS = new Set([
  "brick_forged",
  "brick_demand_forged",
  "brick_deprecated",
  "brick_promoted",
  "brick_quarantined",
]);

function isLifecycleEvent(event: ForgeDashboardEvent): boolean {
  return LIFECYCLE_SUBKINDS.has(event.subKind);
}

function formatSubKind(subKind: string): string {
  return subKind.replaceAll("_", " ");
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function BrickTimelinePanel(): React.ReactElement {
  const events = useForgeTimeline();
  const lifecycleEvents = events.filter(isLifecycleEvent);

  if (lifecycleEvents.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <h3 className="mb-2 text-sm font-semibold">Brick Timeline</h3>
        <p className="text-xs text-[var(--color-muted)]">No forge activity yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
      <h3 className="mb-3 text-sm font-semibold">Brick Timeline</h3>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {lifecycleEvents.map((event, i) => (
          <div
            key={`${event.subKind}-${String(event.timestamp)}-${String(i)}`}
            className="flex items-start gap-2 text-xs"
          >
            <span className="shrink-0 text-[var(--color-muted)]">
              {formatTimestamp(event.timestamp)}
            </span>
            <span className="rounded bg-[var(--color-primary)]/10 px-1.5 py-0.5 font-medium text-[var(--color-primary)]">
              {formatSubKind(event.subKind)}
            </span>
            {"brickId" in event && (
              <span className="truncate text-[var(--color-foreground)]">
                {(event as { readonly brickId: string }).brickId}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
