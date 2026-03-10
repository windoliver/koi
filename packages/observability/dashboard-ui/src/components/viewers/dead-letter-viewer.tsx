/**
 * DeadLetterViewer — renders dead letter queue entry files.
 *
 * Shows the dead letter metadata (original event, failure reason, retry count,
 * last attempted) and a "Retry" button (placeholder that logs to console).
 */

import { useState } from "react";
import { AlertTriangle, RotateCcw, Clock } from "lucide-react";

interface DeadLetterData {
  readonly originalEvent?: unknown;
  readonly failureReason?: string;
  readonly retryCount?: number;
  readonly lastAttemptedAt?: number;
  readonly createdAt?: number;
  readonly subscription?: string;
  readonly eventKind?: string;
  readonly [key: string]: unknown;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

export function DeadLetterViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  const [retryLog, setRetryLog] = useState<string | null>(null);

  let data: DeadLetterData;
  try {
    data = JSON.parse(content) as DeadLetterData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse dead letter entry: {path}
      </div>
    );
  }

  const handleRetry = (): void => {
    console.log(`[DeadLetter] Retry requested for: ${path}`);
    setRetryLog("Retry triggered");
    setTimeout(() => setRetryLog(null), 2000);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <AlertTriangle className="h-4 w-4 text-yellow-500" />
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
        {data.eventKind !== undefined && (
          <span className="rounded bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-600">
            {data.eventKind}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {/* Metadata card */}
        <div className="mb-4 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
          <div className="grid gap-3">
            {data.failureReason !== undefined && (
              <div className="text-sm">
                <span className="text-xs text-[var(--color-muted)]">Failure Reason</span>
                <div className="mt-0.5 font-medium text-red-500">{data.failureReason}</div>
              </div>
            )}
            <div className="flex flex-wrap gap-4 text-xs text-[var(--color-muted)]">
              {data.retryCount !== undefined && (
                <span className="flex items-center gap-1">
                  <RotateCcw className="h-3 w-3" />
                  Retries: {data.retryCount}
                </span>
              )}
              {data.lastAttemptedAt !== undefined && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Last Attempted: {formatTimestamp(data.lastAttemptedAt)}
                </span>
              )}
              {data.createdAt !== undefined && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Created: {formatTimestamp(data.createdAt)}
                </span>
              )}
              {data.subscription !== undefined && (
                <span>Subscription: {data.subscription}</span>
              )}
            </div>
          </div>
        </div>

        {/* Retry button */}
        <div className="mb-4 flex items-center gap-2">
          <button
            type="button"
            onClick={handleRetry}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-muted)]/10"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry
          </button>
          {retryLog !== null && (
            <span className="text-xs text-[var(--color-muted)]">{retryLog}</span>
          )}
        </div>

        {/* Original event */}
        {data.originalEvent !== undefined && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)]">Original Event</h3>
            <pre className="overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
              {JSON.stringify(data.originalEvent, null, 2)}
            </pre>
          </div>
        )}

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
            Full Entry JSON
          </summary>
          <pre className="mt-2 overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
            {JSON.stringify(data, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
