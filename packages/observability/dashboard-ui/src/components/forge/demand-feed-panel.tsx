/**
 * Demand feed panel — live feed of demand signals + crystallize candidates.
 */

import type { ForgeDashboardEvent } from "@koi/dashboard-types";
import { useForgeStore, useForgeTimeline } from "../../stores/forge-store.js";

const FEED_SUBKINDS = new Set(["demand_detected", "crystallize_candidate"]);

function isFeedEvent(event: ForgeDashboardEvent): boolean {
  return FEED_SUBKINDS.has(event.subKind);
}

function ConfidenceBadge({ value }: { readonly value: number }): React.ReactElement {
  const level = value >= 0.8 ? "high" : value >= 0.5 ? "medium" : "low";
  const colorClass =
    level === "high"
      ? "bg-green-500/10 text-green-600"
      : level === "medium"
        ? "bg-yellow-500/10 text-yellow-600"
        : "bg-red-500/10 text-red-600";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${colorClass}`}>
      {(value * 100).toFixed(0)}%
    </span>
  );
}

export function DemandFeedPanel(): React.ReactElement {
  const events = useForgeTimeline();
  const demandCount = useForgeStore((s) => s.demandCount);
  const crystallizeCount = useForgeStore((s) => s.crystallizeCount);
  const feedEvents = events.filter(isFeedEvent);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
      <h3 className="mb-3 text-sm font-semibold">Demand Feed</h3>
      <div className="mb-3 flex gap-4 text-xs text-[var(--color-muted)]">
        <span>Demands: {demandCount}</span>
        <span>Crystallizations: {crystallizeCount}</span>
      </div>
      {feedEvents.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">No signals detected yet.</p>
      ) : (
        <div className="max-h-48 space-y-2 overflow-y-auto">
          {feedEvents.map((event, i) => (
            <div
              key={`${event.subKind}-${String(event.timestamp)}-${String(i)}`}
              className="flex items-center gap-2 text-xs"
            >
              {event.subKind === "demand_detected" && (
                <>
                  <span className="rounded bg-orange-500/10 px-1.5 py-0.5 font-medium text-orange-600">
                    demand
                  </span>
                  <span className="text-[var(--color-foreground)]">
                    {(event as Extract<ForgeDashboardEvent, { readonly subKind: "demand_detected" }>).triggerKind}
                  </span>
                  <ConfidenceBadge
                    value={(event as Extract<ForgeDashboardEvent, { readonly subKind: "demand_detected" }>).confidence}
                  />
                </>
              )}
              {event.subKind === "crystallize_candidate" && (
                <>
                  <span className="rounded bg-blue-500/10 px-1.5 py-0.5 font-medium text-blue-600">
                    crystallize
                  </span>
                  <span className="text-[var(--color-foreground)]">
                    {(event as Extract<ForgeDashboardEvent, { readonly subKind: "crystallize_candidate" }>).suggestedName}
                  </span>
                  <span className="text-[var(--color-muted)]">
                    {(event as Extract<ForgeDashboardEvent, { readonly subKind: "crystallize_candidate" }>).occurrences}x
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
