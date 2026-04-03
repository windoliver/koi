/**
 * SubscriptionViewer — renders subscription position files.
 *
 * Shows subscription name, current position, lag, and last updated
 * in a card layout.
 */

import { Bookmark, Clock } from "lucide-react";

interface SubscriptionData {
  readonly name?: string;
  readonly subscriptionId?: string;
  readonly position?: number;
  readonly lag?: number;
  readonly lastUpdatedAt?: number;
  readonly streamId?: string;
  readonly filter?: unknown;
  readonly [key: string]: unknown;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

export function SubscriptionViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let data: SubscriptionData;
  try {
    data = JSON.parse(content) as SubscriptionData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse subscription: {path}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Bookmark className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {data.name ?? data.subscriptionId ?? path.split("/").pop()}
        </span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Position */}
          <div className="rounded-lg border border-[var(--color-border)] p-3">
            <div className="text-xs text-[var(--color-muted)]">Current Position</div>
            <div className="mt-1 text-lg font-medium font-mono">
              {data.position !== undefined ? data.position : "-"}
            </div>
          </div>

          {/* Lag */}
          <div className="rounded-lg border border-[var(--color-border)] p-3">
            <div className="text-xs text-[var(--color-muted)]">Lag</div>
            <div className={`mt-1 text-lg font-medium font-mono ${
              data.lag !== undefined && data.lag > 0
                ? "text-yellow-600"
                : "text-green-600"
            }`}>
              {data.lag !== undefined ? data.lag : "-"}
            </div>
          </div>

          {/* Last Updated */}
          {data.lastUpdatedAt !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex items-center gap-1 text-xs text-[var(--color-muted)]">
                <Clock className="h-3 w-3" />
                Last Updated
              </div>
              <div className="mt-1 text-sm font-medium">
                {formatTimestamp(data.lastUpdatedAt)}
              </div>
            </div>
          )}

          {/* Stream ID */}
          {data.streamId !== undefined && (
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <div className="text-xs text-[var(--color-muted)]">Stream</div>
              <div className="mt-1 text-sm font-mono font-medium">{data.streamId}</div>
            </div>
          )}
        </div>

        {/* Filter config */}
        {data.filter !== undefined && (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)]">Filter</h3>
            <pre className="overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
              {JSON.stringify(data.filter, null, 2)}
            </pre>
          </div>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
            Raw JSON
          </summary>
          <pre className="mt-2 overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
            {JSON.stringify(data, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
