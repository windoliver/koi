/**
 * EventDetailViewer — renders a single event detail view.
 *
 * Shows event metadata (kind, subKind, timestamp, agentId) in a header card,
 * then full payload below as formatted JSON.
 */

import { Zap, Clock, User, Tag } from "lucide-react";

interface EventDetailData {
  readonly kind?: string;
  readonly subKind?: string;
  readonly timestamp?: number;
  readonly agentId?: string;
  readonly payload?: unknown;
  readonly [key: string]: unknown;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

export function EventDetailViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let event: EventDetailData;
  try {
    event = JSON.parse(content) as EventDetailData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse event: {path}
      </div>
    );
  }

  // Separate known metadata from payload
  const { kind, subKind, timestamp, agentId, payload, ...rest } = event;
  const payloadData = payload !== undefined ? payload : rest;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Zap className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
        {kind !== undefined && (
          <span className="rounded bg-[var(--color-primary)]/10 px-2 py-0.5 text-xs text-[var(--color-primary)]">
            {kind}
            {subKind !== undefined && `.${subKind}`}
          </span>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {/* Metadata card */}
        <div className="mb-4 rounded-lg border border-[var(--color-border)] p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {kind !== undefined && (
              <div className="flex items-center gap-2 text-xs">
                <Tag className="h-3.5 w-3.5 text-[var(--color-muted)]" />
                <span className="text-[var(--color-muted)]">Kind:</span>
                <span className="font-medium">{kind}</span>
              </div>
            )}
            {subKind !== undefined && (
              <div className="flex items-center gap-2 text-xs">
                <Tag className="h-3.5 w-3.5 text-[var(--color-muted)]" />
                <span className="text-[var(--color-muted)]">SubKind:</span>
                <span className="font-medium">{subKind}</span>
              </div>
            )}
            {timestamp !== undefined && (
              <div className="flex items-center gap-2 text-xs">
                <Clock className="h-3.5 w-3.5 text-[var(--color-muted)]" />
                <span className="text-[var(--color-muted)]">Timestamp:</span>
                <span className="font-medium">{formatTimestamp(timestamp)}</span>
              </div>
            )}
            {agentId !== undefined && (
              <div className="flex items-center gap-2 text-xs">
                <User className="h-3.5 w-3.5 text-[var(--color-muted)]" />
                <span className="text-[var(--color-muted)]">Agent:</span>
                <span className="font-mono font-medium">{agentId}</span>
              </div>
            )}
          </div>
        </div>

        {/* Full payload */}
        <div>
          <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)]">Payload</h3>
          <pre className="overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
            {JSON.stringify(payloadData, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}
